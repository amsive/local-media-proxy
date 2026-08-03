/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	apacheMasterProcessExists,
	apacheConfigReferencesInclude,
	apacheMediaPathIsProxyEligible,
	apacheModulePath,
	buildManagedApacheConfig,
	compileAndValidateApacheConfig,
	hasApacheManagedBlock,
	inspectApacheRuntimeCapabilities,
	removeApacheManagedBlock,
	refreshApacheService,
	upsertApacheInclude,
	upsertApacheModules,
} = require('../lib/apache');
const { ORIGIN_REQUEST_USER_AGENT } = require('../lib/constants');
const { validateAndNormalizeOrigin } = require('../lib/validation');

const httpd = '/opt/Local/lightning-services/apache-2.4.43+11/bin/darwin-arm64/bin/httpd';
const secureOrigin = validateAndNormalizeOrigin({
	originIp: '',
	siteUrl: 'https://media.example.com:8443',
}, { requiresOriginIp: false });

test('Apache master liveness treats EPERM as present, ESRCH as absent, and propagates unexpected errors', () => {
	const errorWithCode = (code) => {
		const error = new Error(code);
		error.code = code;
		return error;
	};
	assert.equal(apacheMasterProcessExists(4242, () => { throw errorWithCode('EPERM'); }), true);
	assert.equal(apacheMasterProcessExists(4242, () => { throw errorWithCode('ESRCH'); }), false);
	assert.throws(
		() => apacheMasterProcessExists(4242, () => { throw errorWithCode('EACCES'); }),
		/EACCES/,
	);
});

test('verifies the exact compiled include target across mixed Windows separators', () => {
	const compiled = [
		'<VirtualHost *:80>',
		'IncludeOptional "C:\\Local\\run\\apache/includes/local-media-proxy.conf"',
		'</VirtualHost>',
	].join('\n');
	assert.equal(
		apacheConfigReferencesInclude(compiled, 'C:\\Local\\run\\apache\\includes\\local-media-proxy.conf'),
		true,
	);
	assert.equal(
		apacheConfigReferencesInclude(compiled, 'C:\\Local\\run\\apache\\includes\\different.conf'),
		false,
	);
});

test('inserts one idempotent managed include inside each VirtualHost and preserves CRLF/custom content', () => {
	const original = [
		'# custom global',
		'<VirtualHost *:80>',
		'\t# custom HTTP rule',
		'</VirtualHost>',
		'<VirtualHost *:443>',
		'\t# custom HTTPS rule',
		'</VirtualHost>',
		'',
	].join('\r\n');
	const applied = upsertApacheInclude(original);

	assert.equal(upsertApacheInclude(applied), applied);
	assert.equal((applied.match(/BEGIN Local Media Proxy/g) ?? []).length, 2);
	assert.equal((applied.match(/IncludeOptional "\{\{ configPath \}\}\/includes\/local-media-proxy\.conf"/g) ?? []).length, 2);
	assert.match(applied, /custom HTTP rule\r\n# BEGIN Local Media Proxy/);
	assert.ok(applied.indexOf('IncludeOptional') < applied.indexOf('</VirtualHost>'));
	assert.equal(removeApacheManagedBlock(applied), original);
	assert.throws(() => upsertApacheInclude('# no vhost\n'), /VirtualHost block/);
});

test('derives guarded module paths from the exact Local +11 platform archive layout', () => {
	assert.equal(
		apacheModulePath(httpd, 'mod_proxy_http.so'),
		'/opt/Local/lightning-services/apache-2.4.43+11/bin/darwin-arm64/modules/mod_proxy_http.so',
	);
	assert.equal(
		apacheModulePath('C:\\Local\\lightning-services\\apache-2.4.43+11\\bin\\win32\\bin\\httpd.exe', 'mod_headers.so'),
		'C:\\Local\\lightning-services\\apache-2.4.43+11\\bin\\win32\\modules\\mod_headers.so',
	);
	assert.throws(
		() => apacheModulePath('bin/darwin-arm64/bin/httpd', 'mod_proxy_http.so'),
		/relative Apache service binary path/,
	);
	assert.throws(
		() => apacheModulePath('/opt/Local/apache/httpd', 'mod_proxy_http.so'),
		/unexpected Apache service binary layout/,
	);

	const original = '# human module\r\nLoadModule rewrite_module "existing/mod_rewrite.so"\r\n';
	const applied = upsertApacheModules(original, httpd, true);
	assert.equal(upsertApacheModules(applied, httpd, true), applied);
	assert.match(applied, /<IfModule !proxy_http_module>\r\n\tLoadModule proxy_http_module "\/opt\/Local\/lightning-services\/apache-2\.4\.43\+11\/bin\/darwin-arm64\/modules\/mod_proxy_http\.so"/);
	assert.match(applied, /mod_headers\.so/);
	assert.match(applied, /mod_ssl\.so/);
	const windowsApplied = upsertApacheModules(
		'# human module\n',
		'C:\\Local\\lightning-services\\apache-2.4.43+11\\bin\\win32\\bin\\httpd.exe',
		false,
	);
	assert.match(windowsApplied, /LoadModule proxy_http_module "C:\/Local\/lightning-services\/apache-2\.4\.43\+11\/bin\/win32\/modules\/mod_proxy_http\.so"/);
	assert.doesNotMatch(windowsApplied, /C:\\\\Local/);
	assert.equal(removeApacheManagedBlock(applied), original);
});

test('reports HTTPS capability from the validated Local bundle platform instead of host architecture', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-capability-'));
	try {
		const platformRoot = path.join(root, 'apache-2.4.43+11', 'bin', 'darwin-x64');
		const binary = path.join(platformRoot, 'bin', 'httpd');
		await fs.mkdir(path.dirname(binary), { recursive: true });
		await fs.mkdir(path.join(platformRoot, 'modules'), { recursive: true });
		await Promise.all([
			fs.writeFile(binary, ''),
			fs.writeFile(path.join(platformRoot, 'modules', 'mod_proxy_http.so'), ''),
			fs.writeFile(path.join(platformRoot, 'modules', 'mod_headers.so'), ''),
		]);
		const capabilities = await inspectApacheRuntimeCapabilities(binary);
		assert.equal(capabilities.http, true);
		assert.equal(capabilities.https, false);
		assert.match(capabilities.reason, /darwin-x64/);
		assert.doesNotMatch(capabilities.reason, new RegExp(`${process.platform}/${process.arch}`));
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test('builds a fixed-host local-first Apache proxy with guarded methods, bodies, headers, and TLS', () => {
	const config = buildManagedApacheConfig(secureOrigin, '/site/conf/apache/origin ca.pem');

	assert.match(config, /ProxyRequests Off/);
	assert.match(config, /ProxyAddHeaders Off/);
	assert.match(config, /ProxyPreserveHost Off/);
	assert.match(config, /Managed route revision: upload-assets-v2/);
	assert.match(config, /SSLProxyEngine On/);
	assert.match(config, /SSLProxyVerify require/);
	assert.match(config, /SSLProxyVerifyDepth 5/);
	assert.match(config, /SSLProxyCheckPeerName on/);
	assert.match(config, /SSLProxyCACertificateFile "\/site\/conf\/apache\/origin ca\.pem"/);
	assert.match(config, /RewriteRule "\^\/\(wp-content\/uploads\//);
	assert.ok(config.includes('\\.'));
	assert.ok(!config.includes('\\\\.'));
	assert.match(config, /RewriteCond %\{REQUEST_METHOD\} !\^\(\?:GET\|HEAD\)\$/);
	assert.match(config, /RewriteCond %\{HTTP:Transfer-Encoding\} !\^\$/);
	assert.match(config, /RewriteCond %\{HTTP:Content-Length\} !\^\(\?:\|0\)\$/);
	assert.match(config, /RewriteCond "%\{DOCUMENT_ROOT\}\/\$1" !-f/);
	assert.ok(config.indexOf('RewriteCond $1') < config.indexOf('RewriteCond "%{DOCUMENT_ROOT}/$1" !-f'));
	assert.match(config, /RewriteCond "%\{DOCUMENT_ROOT\}\/\$1" !-f\nRewriteCond \$1 .*php/);
	assert.ok(config.indexOf('RewriteCond $1') < config.indexOf('[P,L,NE,QSA'));
	assert.ok(config.includes('"https://media.example.com:8443/$1"'));
	assert.match(config, /\[P,L,NE,QSA,NC,E=LOCAL_MEDIA_PROXY_ORIGIN:1\]/);
	assert.doesNotMatch(config, /192\.0\.2\./);
	assert.doesNotMatch(config, /ProxyPassReverse|Redirect/);
	assert.match(config, /Header unset Set-Cookie env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, /Header always unset Set-Cookie env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, /Header always set X-Local-Media-Proxy "origin" env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, /Header always set X-Content-Type-Options "nosniff" env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, new RegExp(`RequestHeader set User-Agent "${ORIGIN_REQUEST_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" env=LOCAL_MEDIA_PROXY_ORIGIN`));
	for (const line of config.split('\n').filter((line) => line.includes('RequestHeader '))) {
		assert.match(line, /env=LOCAL_MEDIA_PROXY_ORIGIN$/, `local request header mutation was not proxy-conditioned: ${line}`);
	}
	for (const sensitiveHeader of ['X-WP-Nonce', 'X-API-Key', 'X-Auth-Token', 'X-CSRF-Token']) {
		assert.match(config, new RegExp(`RequestHeader unset ${sensitiveHeader} env=LOCAL_MEDIA_PROXY_ORIGIN`));
	}
	assert.doesNotMatch(config, /RequestHeader unset (?:Range|If-Range)/);
});

test('shares the future-tolerant asset policy and rejects unsafe paths before the local-file check', () => {
	for (const requestPath of [
		'/wp-content/uploads/2026/07/photo.jpg',
		'/wp-content/uploads/photo%41.webp',
		'/wp-content/uploads/icons/logo.svg',
		'/wp-content/uploads/download.pdf',
		'/wp-content/uploads/movie.mp4',
		'/wp-content/uploads/data.json',
		'/wp-content/uploads/new.futuremedia',
	]) {
		assert.equal(apacheMediaPathIsProxyEligible(requestPath), true, requestPath);
	}
	for (const requestPath of [
		'wp-content/uploads/photo.jpg',
		'/wp-content/uploads/../secret.jpg',
		'/wp-content/uploads/%2e%2e/secret.jpg',
		'/wp-content/uploads/%252e%252e/secret.jpg',
		'/wp-content/uploads/a%2fb.jpg',
		'/wp-content/uploads/a%5cb.jpg',
		'/wp-content/uploads/a%20photo.webp',
		'/wp-content/uploads/photo%2541.jpg',
		'/wp-content/uploads/photo.jpg?target=https://other.example.com',
		'/wp-content/uploads/photo.jpg#fragment',
		'/wp-content/uploads/shell.php.jpg',
		'/wp-content/uploads/index.html',
		'/wp-content/uploads/program.exe',
		'/wp-content/uploads/database.sqlite',
		'/other/uploads/photo.jpg',
	]) {
		assert.equal(apacheMediaPathIsProxyEligible(requestPath), false, requestPath);
	}

	const config = buildManagedApacheConfig(secureOrigin, '/site/ca.pem');
	assert.match(config, /RewriteRule "\^\/\(wp-content\/uploads\//);
	const locationMatch = config.split('\n').find((line) => line.startsWith('<LocationMatch')) ?? '';
	assert.doesNotMatch(locationMatch, /avif|jpe|webp|pdf|mp4|futuremedia/i);
	for (const line of config.split('\n').filter((line) => line.startsWith('RewriteRule '))) {
		assert.match(line, /\[[^\]]*NC[^\]]*\]$/);
	}
	assert.match(config, /%\(\?:25\)\*\(\?:2f\|5c\|3f\|23\|00\)/);
	assert.match(config, /RewriteCond \$1 "%" \[OR\]/);
	assert.match(config, /RewriteCond %\{THE_REQUEST\} .*%\(\?:25\|2f\|5c\|3f\|23/);
	assert.ok(config.indexOf('RewriteCond $1') < config.indexOf('RewriteCond "%{DOCUMENT_ROOT}/$1" !-f'));
});

test('requires Apache hostname mode and a trust bundle for HTTPS', () => {
	assert.throws(() => buildManagedApacheConfig({
		...secureOrigin,
		originIp: '192.0.2.10',
	}, '/site/ca.pem'), /hostname-based origin routing/);
	assert.throws(() => buildManagedApacheConfig(secureOrigin), /certificate authority bundle/);

	const httpOrigin = validateAndNormalizeOrigin({
		originIp: '',
		siteUrl: 'http://media.example.com',
	}, { requiresOriginIp: false });
	const config = buildManagedApacheConfig(httpOrigin);
	assert.doesNotMatch(config, /SSLProxy/);
	assert.ok(config.includes('"http://media.example.com/$1"'));
});

test('targeted compilation verifies managed markers before httpd syntax validation', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-'));
	try {
		const service = {
			bin: { httpd },
			configPath: path.join(root, 'run', 'apache'),
			configVariables: { port: 10000 },
			env: {
				LD_LIBRARY_PATH: '/opt/Local/lightning-services/apache-2.4.43+11/lib',
				PATH: '/opt/Local/lightning-services/apache-2.4.43+11/bin',
			},
			runPath: path.join(root, 'run'),
			siteConfigTemplatePath: path.join(root, 'conf', 'apache'),
		};
		const calls = [];
		const compiler = {
			compileConfigTemplates: async (...args) => {
				calls.push(['compile', ...args]);
				await fs.mkdir(path.join(service.configPath, 'includes'), { recursive: true });
				const managed = '# BEGIN Local Media Proxy (managed)\n# END Local Media Proxy (managed)\n';
				const compiledSite = `${managed}IncludeOptional "${path.join(service.configPath, 'includes', 'local-media-proxy.conf')}"\n`;
				await Promise.all([
					fs.writeFile(path.join(service.configPath, 'apache2.conf'), '# compiled global\n'),
					fs.writeFile(path.join(service.configPath, 'modules.conf'), managed),
					fs.writeFile(path.join(service.configPath, 'site.conf'), compiledSite),
					fs.writeFile(path.join(service.configPath, 'includes', 'local-media-proxy.conf'), managed),
				]);
			},
		};
		await compileAndValidateApacheConfig(
			{ id: 'site-a' },
			service,
			compiler,
			async (...args) => {
				calls.push(['exec', ...args]);
				return '';
			},
			true,
		);
		assert.deepEqual(calls[0].slice(2), [
			service.siteConfigTemplatePath,
			service.configPath,
			service.configVariables,
		]);
		assert.equal(calls[1][0], 'exec');
		assert.equal(calls[1][1], httpd);
		assert.deepEqual(calls[1][2], ['-t', '-f', path.join(service.configPath, 'apache2.conf')]);
		assert.equal(calls[1][3].timeout, 10_000);
		assert.equal(calls[1][3].windowsHide, true);
		assert.equal(calls[1][3].env.LD_LIBRARY_PATH, service.env.LD_LIBRARY_PATH);
		assert.equal(calls[1][3].env.PATH, service.env.PATH);
		const inheritedKey = Object.keys(process.env).find((key) => !(key in service.env));
		assert.ok(inheritedKey);
		assert.equal(calls[1][3].env[inheritedKey], process.env[inheritedKey]);
		assert.equal(hasApacheManagedBlock(await fs.readFile(path.join(service.configPath, 'site.conf'), 'utf8')), true);
		assert.equal(await fs.readFile(path.join(service.configPath, 'apache2.conf'), 'utf8'), '# compiled global\n');
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test('Apache refresh is bounded, site-scoped, and never hard-restarts Local-managed workers', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-refresh-'));
	try {
		const service = {
			bin: { httpd },
			configPath: path.join(root, 'run', 'apache'),
			configVariables: {},
			runPath: path.join(root, 'run'),
			siteConfigTemplatePath: path.join(root, 'conf', 'apache'),
		};
		let compileManaged = true;
		let pidContents = '4242\n';
		const compiler = {
			compileConfigTemplates: async () => {
				await Promise.all([
					fs.mkdir(path.join(service.configPath, 'includes'), { recursive: true }),
					fs.mkdir(path.join(service.runPath, 'logs'), { recursive: true }),
				]);
				const managed = '# BEGIN Local Media Proxy (managed)\n# END Local Media Proxy (managed)\n';
				const compiledSite = compileManaged
					? `${managed}IncludeOptional "${path.join(service.configPath, 'includes', 'local-media-proxy.conf')}"\n`
					: '# clean site\n';
				await Promise.all([
					fs.writeFile(path.join(service.configPath, 'apache2.conf'), '# compiled global\n'),
					fs.writeFile(path.join(service.configPath, 'modules.conf'), compileManaged ? managed : '# clean modules\n'),
					fs.writeFile(path.join(service.configPath, 'site.conf'), compiledSite),
					fs.writeFile(path.join(service.configPath, 'includes', 'local-media-proxy.conf'), managed),
				]);
				const pidFile = path.join(service.runPath, 'logs', 'httpd.pid');
				if (pidContents === null) {
					await fs.rm(pidFile, { force: true });
				} else {
					await fs.writeFile(pidFile, pidContents);
				}
			},
		};
		const alwaysRunningOptions = { masterProcessExists: () => true };
		let commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => {
				commandCalls.push(args);
				throw new Error('apache syntax error');
			},
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /apache syntax error/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		commandCalls = [];
		assert.equal(await refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => false,
			() => false,
			alwaysRunningOptions,
		), false);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => false,
			alwaysRunningOptions,
		), /no longer reports this site's Apache service as running/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		pidContents = null;
		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /master PID is unavailable for this site/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		pidContents = ' 4242\n';
		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /master PID is unavailable for this site/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		pidContents = '1\n';
		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /master PID is unavailable for this site/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		pidContents = '4242\n';
		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => true,
			{ masterProcessExists: () => false },
		), /master PID is stale for this site/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);

		commandCalls = [];
		let commandOptions;
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args, options) => {
				commandCalls.push(args);
				if (args[0] === '-k') {
					commandOptions = options;
					const error = new Error('command timed out');
					error.code = 'ETIMEDOUT';
					throw error;
				}
				return '';
			},
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /could not gracefully reload this site's validated configuration/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);
		assert.deepEqual(commandCalls[1], [
			'-k',
			'graceful',
			'-f',
			path.join(service.configPath, 'apache2.conf'),
		]);
		assert.equal(commandOptions.timeout, 10_000);
		assert.equal(commandOptions.windowsHide, true);

		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => {
				commandCalls.push(args);
				if (args[0] === '-k') {
					await fs.writeFile(path.join(service.runPath, 'logs', 'httpd.pid'), 'not-a-pid\n');
				}
				return '';
			},
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /master PID disappeared after the graceful reload/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);

		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => {
				commandCalls.push(args);
				if (args[0] === '-k') {
					await fs.writeFile(path.join(service.runPath, 'logs', 'httpd.pid'), '5252\n');
				}
				return '';
			},
			true,
			() => true,
			() => true,
			alwaysRunningOptions,
		), /master process changed unexpectedly during the graceful reload/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);

		let readinessChecks = 0;
		let readinessWaits = 0;
		commandCalls = [];
		assert.equal(await refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => {
				readinessChecks += 1;
				return readinessChecks === 1 || readinessChecks === 3;
			},
			{
				attempts: 3,
				intervalMs: 0,
				masterProcessExists: () => true,
				wait: async () => { readinessWaits += 1; },
			},
		), true);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);
		assert.equal(readinessChecks, 3);
		assert.equal(readinessWaits, 1);

		readinessChecks = 0;
		commandCalls = [];
		await assert.rejects(refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			true,
			() => true,
			() => {
				readinessChecks += 1;
				return readinessChecks === 1;
			},
			{
				attempts: 3,
				intervalMs: 0,
				masterProcessExists: () => true,
				wait: async () => undefined,
			},
		), /did not keep this site's Apache master running/);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);
		assert.equal(readinessChecks, 4);

		compileManaged = false;
		commandCalls = [];
		assert.equal(await refreshApacheService(
			{ id: 'site-a' },
			service,
			compiler,
			async (_command, args) => { commandCalls.push(args); return ''; },
			false,
			() => true,
			() => true,
			alwaysRunningOptions,
		), true);
		assert.deepEqual(commandCalls.map((args) => args[0]), ['-t', '-k']);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
