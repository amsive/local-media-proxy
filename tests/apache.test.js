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
	apacheCompiledConfigMatches,
	apacheMasterProcessExists,
	apacheConfigReferencesInclude,
	apacheMediaPathIsProxyEligible,
	apacheModulePath,
	buildManagedApacheConfig,
	compileAndValidateApacheConfig,
	hasApacheManagedBlock,
	hasCompleteApacheManagedBlock,
	inspectApacheRuntimeCapabilities,
	removeApacheManagedBlock,
	refreshApacheService,
	upsertApacheInclude,
	upsertApacheModules,
} = require('../lib/apache');
const {
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
} = require('../lib/constants');
const { validateAndNormalizeOrigin } = require('../lib/validation');

const httpd = '/opt/Local/lightning-services/apache-2.4.43+11/bin/darwin-arm64/bin/httpd';
const secureOrigin = validateAndNormalizeOrigin({
	originIp: '',
	siteUrl: 'https://media.example.com:8443',
}, { requiresOriginIp: false });

function apacheManagedFixture(service) {
	const includePath = path.join(service.configPath, 'includes', 'local-media-proxy.conf');
	const managedInclude = [
		MANAGED_MARKER_START,
		'# exact managed route',
		MANAGED_MARKER_END,
		'',
	].join('\n');
	const managedModules = [
		MANAGED_MARKER_START,
		'<IfModule !proxy_http_module>',
		'\tLoadModule proxy_http_module "/opt/Local/modules/mod_proxy_http.so"',
		'</IfModule>',
		MANAGED_MARKER_END,
		'',
	].join('\n');
	const virtualHost = (port) => [
		`<VirtualHost *:${port}>`,
		MANAGED_MARKER_START,
		'Protocols http/1.1',
		`IncludeOptional "${includePath}"`,
		MANAGED_MARKER_END,
		'</VirtualHost>',
	].join('\n');
	const managedSite = `${virtualHost(10000)}\n${virtualHost(10001)}\n`;
	const cleanSite = '<VirtualHost *:10000>\n</VirtualHost>\n<VirtualHost *:10001>\n</VirtualHost>\n';
	const main = [
		`Include "${path.join(service.configPath, 'modules.conf')}"`,
		`Include "${path.join(service.configPath, 'site.conf')}"`,
		'',
	].join('\n');
	return { cleanSite, includePath, main, managedInclude, managedModules, managedSite };
}

async function writeCompiledApacheFixture(service, managed = true) {
	const fixture = apacheManagedFixture(service);
	await fs.mkdir(path.join(service.configPath, 'includes'), { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(service.configPath, 'apache2.conf'), fixture.main),
		fs.writeFile(
			path.join(service.configPath, 'modules.conf'),
			managed ? fixture.managedModules : '# clean modules\n',
		),
		fs.writeFile(
			path.join(service.configPath, 'site.conf'),
			managed ? fixture.managedSite : fixture.cleanSite,
		),
		managed
			? fs.writeFile(fixture.includePath, fixture.managedInclude)
			: fs.rm(fixture.includePath, { force: true }),
	]);
	return fixture;
}

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
	assert.match(applied, /mod_setenvif\.so/);
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
			fs.writeFile(path.join(platformRoot, 'modules', 'mod_setenvif.so'), ''),
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
	assert.match(config, /<LocationMatch[^>]+>\n\tProxyAddHeaders Off\n\tProxyErrorOverride Off\n\tProxyPreserveHost Off/);
	assert.equal((config.match(/ProxyAddHeaders Off/g) ?? []).length, 1);
	assert.equal((config.match(/ProxyErrorOverride Off/g) ?? []).length, 1);
	assert.equal((config.match(/ProxyPreserveHost Off/g) ?? []).length, 1);
	assert.match(config, /Managed route revision: upload-assets-v3/);
	assert.match(config, /SSLProxyEngine On/);
	assert.match(config, /SSLProxyVerify require/);
	assert.match(config, /SSLProxyVerifyDepth 5/);
	assert.match(config, /SSLProxyCheckPeerName on/);
	assert.match(config, /SSLProxyCACertificateFile "\/site\/conf\/apache\/origin ca\.pem"/);
	assert.match(config, /RewriteRule "\^\/\(wp-content\/uploads\//);
	assert.ok(config.includes('\\.'));
	assert.ok(!config.includes('\\\\.'));
	assert.match(config, /RewriteCond %\{REQUEST_METHOD\} !\^\(\?:GET\|HEAD\)\$$/m);
	assert.doesNotMatch(config, /RewriteCond %\{REQUEST_METHOD\}[^\n]*\[NC\]/);
	assert.match(config, /RewriteCond %\{HTTP:Transfer-Encoding\} !\^\$/);
	assert.match(config, /RewriteCond %\{HTTP:Content-Length\} !\^\(\?:\|0\)\$/);
	assert.match(config, /SetEnvIfNoCase .*Host.*If-Range.*Range.*User-Agent.* "\.\+" LOCAL_MEDIA_PROXY_UNKNOWN_HEADER=1/);
	assert.match(config, /RewriteCond %\{ENV:LOCAL_MEDIA_PROXY_UNKNOWN_HEADER\} =1/);
	assert.match(config, /RewriteCond %\{THE_REQUEST\} "!\\s\/wp-content\/uploads\/" \[NC\]/);
	assert.match(config, /RewriteCond %\{THE_REQUEST\} .*x5c/);
	assert.match(config, /RewriteCond "%\{DOCUMENT_ROOT\}\/\$1" !-f/);
	assert.match(config, /RewriteCond %\{HTTP:Sec-Fetch-Dest\} .*script.* \[NC\]/i);
	const fetchDestinationGuard = config.split('\n')
		.find((line) => line.includes('HTTP:Sec-Fetch-Dest')) ?? '';
	assert.doesNotMatch(fetchDestinationGuard, /object|embed|frame|iframe|fencedframe/i);
	assert.ok(
		config.indexOf('RewriteCond %{HTTP:Sec-Fetch-Dest}') <
		config.indexOf('[P,L,NE,QSA'),
	);
	assert.ok(config.indexOf('RewriteCond $1') < config.indexOf('RewriteCond "%{DOCUMENT_ROOT}/$1" !-f'));
	assert.ok(
		config.indexOf('RewriteCond "%{DOCUMENT_ROOT}/$1" !-f') <
		config.indexOf('RewriteCond %{ENV:LOCAL_MEDIA_PROXY_UNKNOWN_HEADER} =1'),
	);
	assert.match(config, /RewriteCond "%\{DOCUMENT_ROOT\}\/\$1" !-f\nRewriteCond \$1 .*php/);
	assert.ok(config.indexOf('RewriteCond $1') < config.indexOf('[P,L,NE,QSA'));
	assert.ok(config.includes('"https://media.example.com:8443/$1"'));
	assert.match(config, /\[P,L,NE,QSA,NC,E=LOCAL_MEDIA_PROXY_ORIGIN:1\]/);
	assert.doesNotMatch(config, /192\.0\.2\./);
	assert.doesNotMatch(config, /ProxyPassReverse|^[\t ]*Redirect\b/m);
	for (const header of [
		'Set-Cookie',
		'Clear-Site-Data',
		'Service-Worker-Allowed',
		'Content-Security-Policy',
		'Content-Security-Policy-Report-Only',
		'Location',
		'X-Content-Type-Options',
		'X-Local-Media-Proxy',
		'Report-To',
		'Reporting-Endpoints',
		'NEL',
	]) {
		assert.match(config, new RegExp(`Header unset ${header} env=LOCAL_MEDIA_PROXY_ORIGIN`));
		assert.match(config, new RegExp(`Header always unset ${header} env=LOCAL_MEDIA_PROXY_ORIGIN`));
	}
	assert.match(config, /Header always set X-Local-Media-Proxy "origin" env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, /Header always set X-Content-Type-Options "nosniff" env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, /Header always set Content-Security-Policy "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'" env=LOCAL_MEDIA_PROXY_ORIGIN/);
	assert.match(config, new RegExp(`RequestHeader set User-Agent "${ORIGIN_REQUEST_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" env=LOCAL_MEDIA_PROXY_ORIGIN`));
	for (const line of config.split('\n').filter((line) => line.includes('RequestHeader '))) {
		assert.match(line, /env=LOCAL_MEDIA_PROXY_ORIGIN$/, `local request header mutation was not proxy-conditioned: ${line}`);
	}
	for (const sensitiveHeader of [
		'X-WP-Nonce',
		'X-API-Key',
		'X-Auth-Token',
		'X-CSRF-Token',
		'X-Playback-Session-Id',
	]) {
		assert.match(config, new RegExp(`RequestHeader unset ${sensitiveHeader} env=LOCAL_MEDIA_PROXY_ORIGIN`));
	}
	for (const visitorHeader of [
		'Accept',
		'Accept-Language',
		'Baggage',
		'Sec-CH-UA',
		'Sec-Fetch-Dest',
		'Sec-Fetch-Site',
		'Sentry-Trace',
		'Traceparent',
		'X-Request-ID',
	]) {
		assert.match(config, new RegExp(`RequestHeader unset ${visitorHeader} env=LOCAL_MEDIA_PROXY_ORIGIN`));
	}
	for (const unsafeProxyHeader of [
		'X-HTTP-Method-Override',
		'X-Original-URL',
		'X-Forwarded-Client-Cert',
		'X-Access-Token',
		'CF-Access-Client-Secret',
	]) {
		assert.match(config, new RegExp(`RequestHeader unset ${unsafeProxyHeader} env=LOCAL_MEDIA_PROXY_ORIGIN`));
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
		'/wp-content/uploads/app/image.jpg',
		'/wp-content/uploads/config/image.jpg',
		'/wp-content/uploads/js/image.jpg',
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
		'/wp-content/uploads/index.shtm',
		'/wp-content/uploads/program.exe',
		'/wp-content/uploads/database.sqlite',
		'/wp-content/uploads/shell.php/image.jpg',
		'/wp-content/uploads/shell.php123/image.jpg',
		'/wp-content/uploads/photo.jpg:preview.futuremedia',
		'/wp-content/uploads/photo.jpg%3Apreview.futuremedia',
		'/wp-content/uploads/photo\\name.jpg',
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
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-')));
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
			await fs.mkdir(service.configPath, { recursive: true });
			const calls = [];
		const expected = apacheManagedFixture(service);
		const compiler = {
			compileConfigTemplates: async (...args) => {
				calls.push(['compile', ...args]);
				await writeCompiledApacheFixture(service, true);
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
			expected.managedInclude,
			expected.managedModules,
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
		assert.equal(await fs.readFile(path.join(service.configPath, 'apache2.conf'), 'utf8'), expected.main);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test('compiled Apache parity requires exact main, module, vhost, include, and path state', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-parity-')));
	try {
		const service = {
			bin: { httpd },
			configPath: path.join(root, 'compiled', 'apache'),
			configVariables: {},
			runPath: path.join(root, 'run'),
			siteConfigTemplatePath: path.join(root, 'templates', 'apache'),
		};
		const expected = await writeCompiledApacheFixture(service, true);
		assert.equal(await apacheCompiledConfigMatches(
			service,
			expected.managedInclude,
			expected.managedModules,
		), true);

		await fs.writeFile(
			path.join(service.configPath, 'apache2.conf'),
			`Include "${path.join(service.configPath, 'modules.conf')}"\n`,
		);
		assert.equal(await apacheCompiledConfigMatches(
			service,
			expected.managedInclude,
			expected.managedModules,
		), false, 'the main config must load the exact compiled site');

		await writeCompiledApacheFixture(service, true);
		await fs.writeFile(
			path.join(service.configPath, 'modules.conf'),
			expected.managedModules.replace('mod_proxy_http.so', 'mod_wrong.so'),
		);
		assert.equal(await apacheCompiledConfigMatches(
			service,
			expected.managedInclude,
			expected.managedModules,
		), false, 'marker-shaped but incorrect modules must not converge');

		await writeCompiledApacheFixture(service, true);
		const oneManagedVhost = expected.managedSite.slice(
			0,
			expected.managedSite.indexOf('<VirtualHost *:10001>'),
		);
		await fs.writeFile(
			path.join(service.configPath, 'site.conf'),
			`${oneManagedVhost}<VirtualHost *:10001>\n</VirtualHost>\n`,
		);
		assert.equal(await apacheCompiledConfigMatches(
			service,
			expected.managedInclude,
			expected.managedModules,
		), false, 'every compiled VirtualHost must end with one canonical managed include');

		for (const duplicateInclude of [
			`IncludeOptional "${expected.includePath}"`,
			`includeoptional ${expected.includePath}`,
			`Include ${expected.includePath}`,
		]) {
			await writeCompiledApacheFixture(service, true);
			await fs.appendFile(
				path.join(service.configPath, 'site.conf'),
				`${duplicateInclude}\n`,
			);
			assert.equal(await apacheCompiledConfigMatches(
				service,
				expected.managedInclude,
				expected.managedModules,
			), false, `duplicate reference must not converge: ${duplicateInclude}`);
		}

		await writeCompiledApacheFixture(service, true);
		await fs.appendFile(
			path.join(service.configPath, 'apache2.conf'),
			`IncludeOptional ${expected.includePath}\n`,
		);
		assert.equal(await apacheCompiledConfigMatches(
			service,
			expected.managedInclude,
			expected.managedModules,
		), false, 'the main config must not load the managed include directly');

		const outside = path.join(root, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'local-media-proxy.conf'), expected.managedInclude);
		await fs.rm(path.join(service.configPath, 'includes'), { recursive: true });
		await fs.symlink(outside, path.join(service.configPath, 'includes'));
		await assert.rejects(
			apacheCompiledConfigMatches(
				service,
				expected.managedInclude,
				expected.managedModules,
			),
			/unsafe compiled Apache path/,
		);

		const realParent = path.join(root, 'real-compiled-parent');
		const realService = { ...service, configPath: path.join(realParent, 'apache') };
		const realExpected = await writeCompiledApacheFixture(realService, true);
		const linkedParent = path.join(root, 'linked-compiled-parent');
		await fs.symlink(realParent, linkedParent);
		await assert.rejects(
			apacheCompiledConfigMatches(
				{ ...service, configPath: path.join(linkedParent, 'apache') },
				realExpected.managedInclude,
				realExpected.managedModules,
			),
			/unsafe compiled Apache root/,
			'compiled roots with a symlinked ancestor must fail closed',
		);

		assert.equal(await apacheCompiledConfigMatches(
			{ ...service, configPath: path.join(root, 'absent-compiled-root') },
			null,
			null,
		), true, 'a clean disabled stopped site may have no compiled output yet');
		assert.equal(hasCompleteApacheManagedBlock(MANAGED_MARKER_START), false);
		assert.equal(hasCompleteApacheManagedBlock(MANAGED_MARKER_END), false);
		assert.equal(hasCompleteApacheManagedBlock(expected.managedInclude), true);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test('Apache refresh is bounded, site-scoped, and never hard-restarts Local-managed workers', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-refresh-')));
	try {
		const service = {
			bin: { httpd },
			configPath: path.join(root, 'run', 'apache'),
			configVariables: {},
			runPath: path.join(root, 'run'),
				siteConfigTemplatePath: path.join(root, 'conf', 'apache'),
			};
			await fs.mkdir(service.configPath, { recursive: true });
			let compileManaged = true;
		let pidContents = '4242\n';
		const expected = apacheManagedFixture(service);
		const compiler = {
			compileConfigTemplates: async () => {
				await writeCompiledApacheFixture(service, compileManaged);
				await fs.mkdir(path.join(service.runPath, 'logs'), { recursive: true });
				const pidFile = path.join(service.runPath, 'logs', 'httpd.pid');
				if (pidContents === null) {
					await fs.rm(pidFile, { force: true });
				} else {
					await fs.writeFile(pidFile, pidContents);
				}
			},
		};
		const alwaysRunningOptions = {
			expectedManagedInclude: expected.managedInclude,
			expectedManagedModules: expected.managedModules,
			masterProcessExists: () => true,
		};
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
			{ ...alwaysRunningOptions, masterProcessExists: () => false },
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
				...alwaysRunningOptions,
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
				...alwaysRunningOptions,
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

			compileManaged = true;
			const realRunParent = path.join(root, 'real-run-parent');
			await fs.mkdir(path.join(realRunParent, 'apache'), { recursive: true });
			const linkedRunParent = path.join(root, 'linked-run-parent');
			await fs.symlink(realRunParent, linkedRunParent);
			commandCalls = [];
			await assert.rejects(refreshApacheService(
				{ id: 'site-a' },
				{ ...service, runPath: path.join(linkedRunParent, 'apache') },
				compiler,
				async (_command, args) => { commandCalls.push(args); return ''; },
				true,
				() => true,
				() => true,
				alwaysRunningOptions,
			), /unsafe Apache runtime root/);
			assert.deepEqual(commandCalls.map((args) => args[0]), ['-t']);
		} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test('Apache refresh fences every compile, validation, PID, reload, and readiness phase', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-guards-')));
	try {
		const service = {
			bin: { httpd },
			configPath: path.join(root, 'compiled', 'apache'),
			configVariables: {},
			runPath: path.join(root, 'run'),
				siteConfigTemplatePath: path.join(root, 'templates', 'apache'),
			};
			await fs.mkdir(service.configPath, { recursive: true });
			const expected = apacheManagedFixture(service);
		const runScenario = async (mutationPoint) => {
			let current = true;
			let serviceChecks = 0;
			let waits = 0;
			const commands = [];
			const assertCurrent = () => {
				if (!current) {
					throw new Error('server identity changed');
				}
			};
			const compiler = {
				compileConfigTemplates: async () => {
					await writeCompiledApacheFixture(service, true);
					await fs.mkdir(path.join(service.runPath, 'logs'), { recursive: true });
					await fs.writeFile(path.join(service.runPath, 'logs', 'httpd.pid'), '4242\n');
					if (mutationPoint === 'compile') {
						current = false;
					}
				},
			};
			await assert.rejects(refreshApacheService(
				{ id: 'site-a' },
				service,
				compiler,
				async (_command, args) => {
					commands.push(args[0]);
					if (mutationPoint === args[0]) {
						current = false;
					}
					return '';
				},
				true,
				() => true,
				() => {
					serviceChecks += 1;
					return mutationPoint !== 'wait' || serviceChecks === 1;
				},
				{
					assertCurrent,
					attempts: 2,
					expectedManagedInclude: expected.managedInclude,
					expectedManagedModules: expected.managedModules,
					intervalMs: 0,
					masterProcessExists: () => true,
					wait: async () => {
						waits += 1;
						if (mutationPoint === 'wait') {
							current = false;
						}
					},
				},
			), /server identity changed/);
			return { commands, waits };
		};

		assert.deepEqual((await runScenario('compile')).commands, []);
		assert.deepEqual((await runScenario('-t')).commands, ['-t']);
		assert.deepEqual((await runScenario('-k')).commands, ['-t', '-k']);
		const waitResult = await runScenario('wait');
		assert.deepEqual(waitResult.commands, ['-t', '-k']);
		assert.equal(waitResult.waits, 1);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
