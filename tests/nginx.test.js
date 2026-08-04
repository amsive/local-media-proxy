/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	buildManagedNginxConfig,
	compileAndValidateNginxConfig,
	compiledNginxSiteHasCanonicalManagedInclude,
	hasManagedInclude,
	isMissingNginxMasterProcess,
	removeManagedInclude,
	nginxCompiledConfigMatches,
	nginxCompiledPaths,
	refreshNginxService,
	upsertManagedInclude,
} = require('../lib/nginx');
const {
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
} = require('../lib/constants');
const { COMPILED_INCLUDE_TOMBSTONE } = require('../lib/compiled-config');
const {
	NGINX_HARD_BLOCKED_UPLOAD_ASSET_URI_PATTERN,
	NGINX_UPLOAD_ASSET_URI_PATTERN,
} = require('../lib/asset-policy');
const { validateAndNormalizeOrigin } = require('../lib/validation');

const secureOrigin = validateAndNormalizeOrigin({
	originEnvironment: 'production',
	originIp: '192.0.2.10',
	originSource: 'wpengine',
	originTlsHostname: 'example-production.wpengine.com',
	siteUrl: 'https://example-production.example.com',
});

const service = {
	bin: { nginx: '/opt/local/nginx' },
	configPath: '/sites/example site/conf/nginx',
	runPath: '/sites/example site/run/nginx',
};

function nginxManagedFixture(runtimeService, managed = true) {
	const compiled = nginxCompiledPaths(runtimeService);
	const main = 'events {}\nhttp {\n\tinclude site.conf;\n}\n';
	const site = managed
		? [
			'server {',
			`    ${MANAGED_MARKER_START}`,
			'    include includes/local-media-proxy.conf;',
			`    ${MANAGED_MARKER_END}`,
			'}',
			'',
		].join('\n')
		: 'server {\n}\n';
	const include = managed ? '# exact managed Nginx route\n' : null;
	return { compiled, include, main, site };
}

async function writeCompiledNginxFixture(runtimeService, managed = true) {
	const fixture = nginxManagedFixture(runtimeService, managed);
	await fsPromises.mkdir(path.join(runtimeService.configPath, 'includes'), { recursive: true });
	await Promise.all([
		fsPromises.writeFile(fixture.compiled.main, fixture.main),
		fsPromises.writeFile(fixture.compiled.site, fixture.site),
		fixture.include === null
			? fsPromises.rm(fixture.compiled.include, { force: true })
			: fsPromises.writeFile(fixture.compiled.include, fixture.include),
	]);
	return fixture;
}

test('builds a local-first, read-only, privacy-preserving HTTPS proxy', () => {
	const config = buildManagedNginxConfig(secureOrigin, '/tmp/local origin-ca.pem');

	assert.match(config, /Managed route revision: upload-assets-v3/);
	assert.match(config, /location ~\* "\^\(\?!/);
	assert.match(config, /\/wp-content\/uploads\//);
	assert.match(config, /if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/);
	assert.match(config, /if \(\$http_transfer_encoding != ""\) \{ return 400; \}/);
	assert.match(config, /if \(\$http_content_length !~ \^\(\?:\|0\)\$\) \{ return 400; \}/);
	assert.match(config, /if \(\$request_uri !~\* "\^\/wp-content\/uploads\/"\) \{ return 400; \}/);
	assert.match(config, /\$request_uri ~\* .*%\(\?:25\|2f\|5c\|3f\|23/);
	assert.match(config, /\$request_uri ~\* .*x5c/);
	assert.match(config, /\$request_uri ~\* "\^\/wp-content\/uploads\/\(\?:\/\|\[\^\?\]\*\/\/\)"/);
	assert.match(config, /try_files \$uri @local_media_proxy;/);
	assert.ok(config.indexOf('try_files $uri') < config.indexOf('if ($uri ~*'));
	assert.ok(config.indexOf('if ($uri ~*') < config.indexOf('proxy_pass https://'));
	assert.match(config, /if \(\$http_sec_fetch_dest ~\* .*script.*\) \{ return 404; \}/i);
	const fetchDestinationGuard = config.split('\n')
		.find((line) => line.includes('$http_sec_fetch_dest')) ?? '';
	assert.doesNotMatch(fetchDestinationGuard, /object|embed|frame|iframe|fencedframe/i);
	assert.ok(config.indexOf('try_files $uri') < config.indexOf('if ($http_sec_fetch_dest ~*'));
	assert.ok(config.indexOf('if ($http_sec_fetch_dest ~*') < config.indexOf('proxy_pass https://'));
	assert.doesNotMatch(config, /limit_except/);
	assert.equal((config.match(/\$request_method/g) ?? []).length, 1);
	assert.match(config, /proxy_pass https:\/\/192\.0\.2\.10:443;/);
	assert.match(config, /proxy_set_header Host "example-production\.example\.com";/);
	assert.match(config, new RegExp(`proxy_set_header User-Agent "${ORIGIN_REQUEST_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}";`));
	assert.match(config, /proxy_ssl_name "example-production\.wpengine\.com";/);
	assert.match(config, /proxy_ssl_verify on;/);
	assert.match(config, /proxy_ssl_trusted_certificate "\/tmp\/local origin-ca\.pem";/);
	assert.match(config, /proxy_pass_request_headers off;/);
	assert.match(config, /proxy_pass_request_body off;/);
	assert.match(config, /proxy_set_header Range \$http_range;/);
	assert.match(config, /proxy_set_header If-Range \$http_if_range;/);
	assert.match(config, /proxy_set_header Sec-Fetch-Dest "";/);
	assert.match(config, /proxy_set_header Content-Length "";/);
	assert.match(config, /proxy_set_header Cookie "";/);
	assert.match(config, /proxy_set_header Authorization "";/);
	assert.match(config, /proxy_set_header Origin "";/);
	assert.match(config, /proxy_set_header Forwarded "";/);
	assert.match(config, /proxy_set_header X-Real-IP "";/);
	for (const header of [
		'X-Remote-IP',
		'X-Remote-Addr',
		'X-Client-IP',
		'X-Cluster-Client-IP',
		'X-Originating-IP',
		'X-Original-Forwarded-For',
		'True-Client-IP',
		'CF-Connecting-IP',
		'Fastly-Client-IP',
		'X-WP-Nonce',
		'X-API-Key',
		'X-Auth-Token',
		'X-CSRF-Token',
	]) {
		assert.match(config, new RegExp(`proxy_set_header ${header} "";`));
	}
	assert.match(config, /proxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Buffering X-Accel-Charset;/);
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
		assert.match(config, new RegExp(`proxy_hide_header ${header};`));
	}
	assert.match(config, /add_header Content-Security-Policy "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'" always;/);
	assert.match(config, /proxy_buffering off;/);
	assert.deepEqual(
		config.split('\n')
			.filter((line) => /proxy_set_header .*\$http_/.test(line))
			.map((line) => line.trim()),
		[
			'proxy_set_header Range $http_range;',
			'proxy_set_header If-Range $http_if_range;',
		],
	);
	assert.doesNotMatch(config, /\$http_user_agent/);
	assert.doesNotMatch(config, /location \/ \{/);
});

test('uses a default-allow upload route while blocking active and sensitive misses', () => {
	const config = buildManagedNginxConfig(secureOrigin, '/tmp/origin-ca.pem');
	const routeLines = config.split('\n').filter((line) => line.startsWith('location ~*'));
	const routeLine = routeLines.find((line) => line.includes('(?!')) ?? '';
	const route = new RegExp(NGINX_UPLOAD_ASSET_URI_PATTERN, 'i');
	const hardBlockedRoute = new RegExp(NGINX_HARD_BLOCKED_UPLOAD_ASSET_URI_PATTERN, 'i');

	assert.equal(routeLines.length, 3);
	assert.ok(config.indexOf('return 404; }') < config.indexOf('try_files $uri'));
	assert.ok(config.lastIndexOf('try_files $uri =404; }') > config.indexOf('try_files $uri @local_media_proxy'));
	assert.match(routeLine, /wp-content\/uploads/);
	assert.match(routeLine, /\(\?!/);
	assert.match(routeLine, /A-Za-z0-9/);
	assert.doesNotMatch(routeLine, /avif|jpe|webp|pdf|mp4|futuremedia/i);
	assert.equal(route.test('/wp-content/uploads/new.futuremedia'), true);
	assert.equal(route.test('/wp-content/uploads/shell.php'), false);
	assert.equal(route.test('/wp-content/uploads/shell.php/image.jpg'), false);
	assert.equal(route.test('/wp-content/uploads/active.html.jpg'), false);
	assert.equal(hardBlockedRoute.test('/wp-content/uploads/local.php'), true);
	assert.equal(hardBlockedRoute.test('/wp-content/uploads/nested/shell.php/image.jpg'), true);
	assert.equal(hardBlockedRoute.test('/wp-content/uploads/.hidden/image.jpg'), true);
	assert.equal(hardBlockedRoute.test('/wp-content/uploads/local.js'), false);
	for (const token of ['php', 'html', 'wasm', 'exe', 'sqlite', 'backup']) {
		assert.match(config, new RegExp(token, 'i'));
	}
	assert.match(config, /proxy_pass https:[^\n]+;\n/);
	assert.doesNotMatch(config, /proxy_pass https:[^\n]+\/wp-content/);
});

test('requires a trust bundle for HTTPS but omits TLS directives for HTTP', () => {
	assert.throws(() => buildManagedNginxConfig(secureOrigin), /certificate authority bundle/);

	const httpOrigin = validateAndNormalizeOrigin({
		originIp: '192.0.2.10',
		siteUrl: 'http://origin.example.com',
	});
	const config = buildManagedNginxConfig(httpOrigin);
	assert.match(config, /proxy_pass http:\/\/192\.0\.2\.10:80;/);
	assert.doesNotMatch(config, /proxy_ssl_/);
});

test('formats an IPv6 proxy target safely', () => {
	const origin = validateAndNormalizeOrigin({
		originIp: '2001:db8::10',
		siteUrl: 'https://origin.example.com',
	});
	assert.match(
		buildManagedNginxConfig(origin, '/tmp/ca.pem'),
		/proxy_pass https:\/\/\[2001:db8::10\]:443;/,
	);
});

test('adds and removes one idempotent managed include block', () => {
	const original = [
		'server {',
		'    #',
		'    # WordPress Rules',
		'    #',
		'    include includes/wordpress-single.conf;',
		'}',
		'',
	].join('\n');
	const applied = upsertManagedInclude(original);

	assert.equal(upsertManagedInclude(applied), applied);
	assert.equal(hasManagedInclude(applied), true);
	assert.equal(removeManagedInclude(applied), original);
	assert.equal((applied.match(/BEGIN Local Media Proxy/g) || []).length, 1);
});

test('places the managed include before an older custom media proxy location', () => {
	const customized = [
		'server {',
		'\troot "{{root}}";',
		'',
		'\t# Try images locally, then proxy to the original server.',
		'\tlocation ~* \\.(?:jpe?g|gif|png|svg)$ {',
		'\t\ttry_files $uri @proxyoriginal;',
		'\t}',
		'',
		'\tlocation @proxyoriginal {',
		'\t\tproxy_set_header Host "media.example.com";',
		'\t\tproxy_pass http://198.51.100.10;',
		'\t}',
		'',
		'\t#',
		'\t# WordPress Rules',
		'\t#',
		'\tinclude includes/wordpress-single.conf;',
		'}',
		'',
	].join('\n');
	const applied = upsertManagedInclude(customized);

	assert.ok(applied.indexOf('BEGIN Local Media Proxy') < applied.indexOf('location ~*'));
	assert.equal(removeManagedInclude(applied), customized);
	assert.equal(upsertManagedInclude(applied), applied);
});

test('preserves CRLF line endings in the injected block', () => {
	const original = 'server {\r\n\tlocation / {}\r\n}\r\n';
	const applied = upsertManagedInclude(original);
	assert.match(applied, /managed\)\r\n    include/);
	assert.equal(removeManagedInclude(applied), original);
});

test('targeted Nginx compilation verifies exact compiled files then syntax once', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-compile-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'compiled', 'nginx'),
			configVariables: { port: 10000 },
			env: { LOCAL_NGINX_TEST: '1' },
			runPath: path.join(root, 'run', 'nginx'),
				siteConfigTemplatePath: path.join(root, 'templates', 'nginx'),
			};
			await fsPromises.mkdir(runtimeService.configPath, { recursive: true });
			await fsPromises.mkdir(runtimeService.runPath, { recursive: true });
		const expected = nginxManagedFixture(runtimeService, true);
		const calls = [];
		const compiler = {
			compileConfigTemplates: async (...args) => {
				calls.push(['compile', ...args]);
				await writeCompiledNginxFixture(runtimeService, true);
			},
		};
		await compileAndValidateNginxConfig(
			{ id: 'site-a' },
			runtimeService,
			compiler,
			async (...args) => {
				calls.push(['exec', ...args]);
				return '';
			},
			expected.include,
		);

		assert.deepEqual(calls[0].slice(2), [
			runtimeService.siteConfigTemplatePath,
			runtimeService.configPath,
			runtimeService.configVariables,
		]);
		assert.deepEqual(calls.slice(1).map((call) => call[2][0]), ['-t']);
		for (const call of calls.slice(1)) {
			assert.equal(call[1], runtimeService.bin.nginx);
			assert.deepEqual(call[2].slice(1), [
				'-c',
				expected.compiled.main,
				'-p',
				runtimeService.runPath,
			]);
			assert.equal(call[3].timeout, 10_000);
			assert.equal(call[3].windowsHide, true);
			assert.equal(call[3].env.LOCAL_NGINX_TEST, '1');
		}
		assert.equal(compiledNginxSiteHasCanonicalManagedInclude(expected.site), true);
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('clean Nginx compilation replaces only an unreferenced regular orphan with an inert tombstone', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-cleanup-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'compiled', 'nginx'),
			configVariables: {},
			runPath: path.join(root, 'run', 'nginx'),
			siteConfigTemplatePath: path.join(root, 'templates', 'nginx'),
		};
		await fsPromises.mkdir(runtimeService.configPath, { recursive: true });
		await fsPromises.mkdir(runtimeService.runPath, { recursive: true });
		const managed = await writeCompiledNginxFixture(runtimeService, true);
		const clean = nginxManagedFixture(runtimeService, false);
		const compileRoots = [];
		const compileCalls = [];
		const writeCleanCoreFilesWithoutPruningIncludes = async (
			site,
			templatesDirectory,
			destinationDirectory,
			configVariables,
		) => {
			compileCalls.push([
				site,
				templatesDirectory,
				destinationDirectory,
				configVariables,
			]);
			compileRoots.push(templatesDirectory);
			if (templatesDirectory === runtimeService.siteConfigTemplatePath) {
				await Promise.all([
					fsPromises.writeFile(clean.compiled.main, clean.main),
					fsPromises.writeFile(clean.compiled.site, clean.site),
				]);
				return;
			}
			const tombstoneTemplate = await fsPromises.readFile(
				path.join(templatesDirectory, 'includes', 'local-media-proxy.conf.hbs'),
				'utf8',
			);
			await fsPromises.writeFile(clean.compiled.include, tombstoneTemplate);
		};
		const targetSite = { id: 'site-a' };
		const compiler = {
			compileConfigTemplates: writeCleanCoreFilesWithoutPruningIncludes,
		};
		const commands = [];
		await compileAndValidateNginxConfig(
			targetSite,
			runtimeService,
			compiler,
			async (_command, args) => {
				commands.push(args[0]);
				return '';
			},
			null,
		);
		assert.deepEqual(commands, ['-t']);
		assert.equal(
			await fsPromises.readFile(managed.compiled.include, 'utf8'),
			COMPILED_INCLUDE_TOMBSTONE,
		);
		assert.equal(compileRoots.length, 2);
		assert.equal(compileRoots[0], runtimeService.siteConfigTemplatePath);
		assert.equal(compileCalls[1][0], targetSite);
		assert.equal(compileCalls[1][2], runtimeService.configPath);
		assert.equal(compileCalls[1][3], runtimeService.configVariables);
		await assert.rejects(fsPromises.lstat(compileRoots[1]), { code: 'ENOENT' });
		assert.equal(await nginxCompiledConfigMatches(runtimeService, null), true);
		await fsPromises.appendFile(managed.compiled.include, '# changed tombstone\n');
		assert.equal(await nginxCompiledConfigMatches(runtimeService, null), false);

		await fsPromises.writeFile(managed.compiled.include, managed.include);
		let referenceCompilerCalls = 0;
		await assert.rejects(
			compileAndValidateNginxConfig(
				{ id: 'site-a' },
				runtimeService,
				{
					compileConfigTemplates: async () => {
						referenceCompilerCalls += 1;
						await Promise.all([
							fsPromises.writeFile(clean.compiled.main, clean.main),
							fsPromises.writeFile(
								clean.compiled.site,
								`${clean.site}include includes/local-media-proxy.conf;\n`,
							),
						]);
					},
				},
				async () => '',
				null,
			),
			/retained a managed Nginx configuration after cleanup/,
		);
		assert.equal(referenceCompilerCalls, 1);
		assert.equal(await fsPromises.readFile(managed.compiled.include, 'utf8'), managed.include);

		await fsPromises.writeFile(managed.compiled.include, managed.include);
		let current = true;
		let temporaryTemplatesDirectory;
		await assert.rejects(
			compileAndValidateNginxConfig(
				{ id: 'site-a' },
				runtimeService,
				{
					compileConfigTemplates: async (...args) => {
						const templatesDirectory = args[1];
						await writeCleanCoreFilesWithoutPruningIncludes(...args);
						if (templatesDirectory !== runtimeService.siteConfigTemplatePath) {
							temporaryTemplatesDirectory = templatesDirectory;
							current = false;
						}
					},
				},
				async () => '',
				null,
				() => {
					if (!current) {
						throw new Error('lifecycle changed before orphan cleanup');
					}
				},
			),
			/lifecycle changed before orphan cleanup/,
		);
		assert.equal(
			await fsPromises.readFile(managed.compiled.include, 'utf8'),
			COMPILED_INCLUDE_TOMBSTONE,
		);
		await assert.rejects(fsPromises.lstat(temporaryTemplatesDirectory), { code: 'ENOENT' });

		const outside = path.join(root, 'outside-managed-include.conf');
		await fsPromises.writeFile(outside, managed.include);
		await fsPromises.rm(managed.compiled.include, { force: true });
		await fsPromises.symlink(outside, managed.compiled.include);
		let unsafeCompilerCalls = 0;
		await assert.rejects(
			compileAndValidateNginxConfig(
				{ id: 'site-a' },
				runtimeService,
				{
					compileConfigTemplates: async () => { unsafeCompilerCalls += 1; },
				},
				async () => '',
				null,
			),
			/unsafe compiled Nginx managed include/,
		);
		assert.equal(unsafeCompilerCalls, 0);
		assert.equal(await fsPromises.readFile(outside, 'utf8'), managed.include);

		await fsPromises.rm(managed.compiled.include, { force: true });
		await fsPromises.rm(path.dirname(managed.compiled.include), { recursive: true });
		const outsideIncludes = path.join(root, 'outside-includes');
		await fsPromises.mkdir(outsideIncludes);
		await fsPromises.writeFile(
			path.join(outsideIncludes, path.basename(managed.compiled.include)),
			managed.include,
		);
		await fsPromises.symlink(outsideIncludes, path.dirname(managed.compiled.include));
		await assert.rejects(
			compileAndValidateNginxConfig(
				{ id: 'site-a' },
				runtimeService,
				{ compileConfigTemplates: async () => { unsafeCompilerCalls += 1; } },
				async () => '',
				null,
			),
			/unsafe compiled Nginx managed include/,
		);
		assert.equal(unsafeCompilerCalls, 0);
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('preflights every known Nginx compiled output before the first compiler call', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-output-preflight-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'compiled', 'nginx'),
			configVariables: {},
			runPath: path.join(root, 'run', 'nginx'),
			siteConfigTemplatePath: path.join(root, 'templates', 'nginx'),
		};
		await fsPromises.mkdir(runtimeService.runPath, { recursive: true });
		const expected = nginxManagedFixture(runtimeService, true);
		for (const [name, target] of [
			['main', expected.compiled.main],
			['site', expected.compiled.site],
			['include', expected.compiled.include],
		]) {
			await fsPromises.rm(runtimeService.configPath, { force: true, recursive: true });
			await writeCompiledNginxFixture(runtimeService, true);
			const outside = path.join(root, `outside-${name}.conf`);
			const outsideBytes = `outside ${name}\n`;
			await fsPromises.writeFile(outside, outsideBytes);
			await fsPromises.rm(target, { force: true });
			await fsPromises.symlink(outside, target);
			let compilerCalls = 0;
			await assert.rejects(
				compileAndValidateNginxConfig(
					{ id: 'site-a' },
					runtimeService,
					{ compileConfigTemplates: async () => { compilerCalls += 1; } },
					async () => '',
					expected.include,
				),
				/unsafe compiled Nginx (?:main configuration|site configuration|managed include)/,
			);
			assert.equal(compilerCalls, 0, `${name} must fail before compilation`);
			assert.equal(await fsPromises.readFile(outside, 'utf8'), outsideBytes);
		}
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('passive Nginx parity rejects stale, unloaded, and symlinked compiled state without writing', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-parity-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'authoritative-compiled-root'),
			configVariables: {},
			runPath: path.join(root, 'run'),
			siteConfigTemplatePath: path.join(root, 'templates'),
		};
		const expected = await writeCompiledNginxFixture(runtimeService, true);
		const before = await fsPromises.readFile(expected.compiled.include, 'utf8');
		assert.equal(await nginxCompiledConfigMatches(runtimeService, expected.include), true);
		assert.equal(await fsPromises.readFile(expected.compiled.include, 'utf8'), before);

		const unrelatedSiteConfig = path.join(root, 'unrelated', 'site.conf');
		await fsPromises.writeFile(
			expected.compiled.main,
			`events {}\nhttp {\n\tinclude "${unrelatedSiteConfig}";\n}\n`,
		);
		assert.equal(
			await nginxCompiledConfigMatches(runtimeService, expected.include),
			false,
			'an unrelated absolute path ending in site.conf must not satisfy authoritative parity',
		);

		await writeCompiledNginxFixture(runtimeService, true);
		await fsPromises.appendFile(
			expected.compiled.site,
			`include "includes/${path.basename(expected.compiled.include)}";\n`,
		);
		assert.equal(
			await nginxCompiledConfigMatches(runtimeService, expected.include),
			false,
			'a quoted duplicate managed include must not converge',
		);

		await writeCompiledNginxFixture(runtimeService, true);
		await fsPromises.appendFile(
			expected.compiled.main,
			`include "${expected.compiled.include}";\n`,
		);
		assert.equal(
			await nginxCompiledConfigMatches(runtimeService, expected.include),
			false,
			'an absolute duplicate managed include in the main config must not converge',
		);

		await writeCompiledNginxFixture(runtimeService, true);
		await fsPromises.writeFile(expected.compiled.main, 'events {}\nhttp {}\n');
		assert.equal(await nginxCompiledConfigMatches(runtimeService, expected.include), false);

		await writeCompiledNginxFixture(runtimeService, true);
		await fsPromises.appendFile(expected.compiled.include, '# stale directive\n');
		assert.equal(await nginxCompiledConfigMatches(runtimeService, expected.include), false);

		await writeCompiledNginxFixture(runtimeService, true);
		const outside = path.join(root, 'outside');
		await fsPromises.mkdir(outside);
		await fsPromises.writeFile(path.join(outside, 'local-media-proxy.conf'), expected.include);
		await fsPromises.rm(path.join(runtimeService.configPath, 'includes'), { recursive: true });
		await fsPromises.symlink(outside, path.join(runtimeService.configPath, 'includes'));
		await assert.rejects(
			nginxCompiledConfigMatches(runtimeService, expected.include),
			/unsafe compiled Nginx path/,
		);

		const realParent = path.join(root, 'real-compiled-parent');
		const realService = { ...runtimeService, configPath: path.join(realParent, 'nginx') };
		const realExpected = await writeCompiledNginxFixture(realService, true);
		const linkedParent = path.join(root, 'linked-compiled-parent');
		await fsPromises.symlink(realParent, linkedParent);
		await assert.rejects(
			nginxCompiledConfigMatches(
				{ ...runtimeService, configPath: path.join(linkedParent, 'nginx') },
				realExpected.include,
			),
			/unsafe compiled Nginx root/,
			'compiled roots with a symlinked ancestor must fail closed',
		);

		assert.equal(await nginxCompiledConfigMatches(
			{ ...runtimeService, configPath: path.join(root, 'absent-compiled-root') },
			null,
		), true, 'disabled stopped sites may have no compiled output');
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('Nginx validation fences compilation and syntax and rejects inexact compiled files', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-guards-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'compiled', 'nginx'),
			configVariables: {},
			runPath: path.join(root, 'run', 'nginx'),
				siteConfigTemplatePath: path.join(root, 'templates', 'nginx'),
			};
			await fsPromises.mkdir(runtimeService.configPath, { recursive: true });
			await fsPromises.mkdir(runtimeService.runPath, { recursive: true });
		const expected = nginxManagedFixture(runtimeService, true);
		const runGuardScenario = async (mutationPoint) => {
			let current = true;
			const commands = [];
			const assertCurrent = () => {
				if (!current) {
					throw new Error('server identity changed');
				}
			};
			await assert.rejects(compileAndValidateNginxConfig(
				{ id: 'site-a' },
				runtimeService,
				{
					compileConfigTemplates: async () => {
						await writeCompiledNginxFixture(runtimeService, true);
						if (mutationPoint === 'compile') {
							current = false;
						}
					},
				},
				async (_command, args) => {
					commands.push(args[0]);
					if (mutationPoint === args[0]) {
						current = false;
					}
					return '';
				},
				expected.include,
				assertCurrent,
			), /server identity changed/);
			return commands;
		};
		assert.deepEqual(await runGuardScenario('compile'), []);
		assert.deepEqual(await runGuardScenario('-t'), ['-t']);

		let execCallsForInexactState = 0;
		const staleIncludeCompiler = {
			compileConfigTemplates: async () => {
				await writeCompiledNginxFixture(runtimeService, true);
				await fsPromises.appendFile(expected.compiled.include, '# stale directive\n');
			},
		};
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			runtimeService,
			staleIncludeCompiler,
			async () => { execCallsForInexactState += 1; return ''; },
			expected.include,
		), /did not compile the expected managed Nginx configuration/);
		assert.equal(execCallsForInexactState, 0);

		const duplicateIncludeCompiler = {
			compileConfigTemplates: async () => {
				await writeCompiledNginxFixture(runtimeService, true);
				await fsPromises.appendFile(
					expected.compiled.site,
					'include includes/local-media-proxy.conf;\n',
				);
			},
		};
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			runtimeService,
			duplicateIncludeCompiler,
			async () => { execCallsForInexactState += 1; return ''; },
			expected.include,
		), /did not compile the expected managed Nginx configuration/);
		assert.equal(execCallsForInexactState, 0);

		const compiler = {
			compileConfigTemplates: async () => {
				await writeCompiledNginxFixture(runtimeService, true);
			},
		};

		const realRunRoot = path.join(root, 'real-run');
		const symlinkRunRoot = path.join(root, 'symlink-run');
		await fsPromises.mkdir(realRunRoot);
		await fsPromises.symlink(realRunRoot, symlinkRunRoot);
		let execCalls = 0;
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			{ ...runtimeService, runPath: symlinkRunRoot },
			compiler,
			async () => { execCalls += 1; return ''; },
			expected.include,
		), /unsafe Nginx runtime root/);
		assert.equal(execCalls, 0);

		const realRunParent = path.join(root, 'real-run-parent');
		await fsPromises.mkdir(path.join(realRunParent, 'nginx'), { recursive: true });
		const linkedRunParent = path.join(root, 'linked-run-parent');
		await fsPromises.symlink(realRunParent, linkedRunParent);
		execCalls = 0;
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			{ ...runtimeService, runPath: path.join(linkedRunParent, 'nginx') },
			compiler,
			async () => { execCalls += 1; return ''; },
			expected.include,
		), /unsafe Nginx runtime root/);
		assert.equal(execCalls, 0);
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('Nginx refresh uses one native reload and one exact stale-master recovery without polling', async () => {
	const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-refresh-')));
	try {
		const runtimeService = {
			bin: { nginx: '/opt/Local/nginx' },
			configPath: path.join(root, 'compiled', 'nginx'),
			configVariables: {},
			env: { LOCAL_NGINX_TEST_ENV: 'authoritative' },
			runPath: path.join(root, 'run', 'nginx'),
			siteConfigTemplatePath: path.join(root, 'templates', 'nginx'),
		};
		await fsPromises.mkdir(runtimeService.configPath, { recursive: true });
		await fsPromises.mkdir(runtimeService.runPath, { recursive: true });
		const expected = nginxManagedFixture(runtimeService, true);
		let pidContents = '4242\n';
		const compiler = {
			compileConfigTemplates: async () => {
				await writeCompiledNginxFixture(runtimeService, true);
				const logsPath = path.join(runtimeService.runPath, 'logs');
				await fsPromises.rm(logsPath, { force: true, recursive: true });
				await fsPromises.mkdir(logsPath, { recursive: true });
				const pidFile = path.join(logsPath, 'nginx.pid');
				if (pidContents === null) {
					await fsPromises.rm(pidFile, { force: true });
				} else {
					await fsPromises.writeFile(pidFile, pidContents);
				}
			},
		};
		const run = async ({
			isSiteRunning = () => true,
			onCommand = async () => undefined,
			onReload = async () => undefined,
			options = {},
		} = {}) => {
			const calls = [];
			let signalOptions;
			const result = await refreshNginxService(
				{ id: 'site-a' },
				runtimeService,
				compiler,
				async (_command, args, execOptions) => {
					calls.push(args);
					await onCommand(args[0]);
					if (args[0] === '-s') {
						signalOptions = execOptions;
						await onReload();
					}
					return '';
				},
				expected.include,
				isSiteRunning,
				options,
			);
			return { calls, result, signalOptions };
		};

		const success = await run();
		assert.equal(success.result, true);
		assert.deepEqual(success.calls.map((args) => args[0]), ['-t', '-s']);
		assert.deepEqual(success.calls[1], [
			'-s', 'reload',
			'-c', path.join(runtimeService.configPath, 'nginx.conf'),
			'-p', runtimeService.runPath,
		]);
		assert.equal(success.signalOptions.env.LOCAL_NGINX_TEST_ENV, 'authoritative');

		pidContents = null;
		const stopped = await run({
			isSiteRunning: () => false,
		});
		assert.equal(stopped.result, false);
		assert.deepEqual(stopped.calls.map((args) => args[0]), ['-t']);

		for (const invalidPid of [null, 'not-a-pid\n', '1\n']) {
			pidContents = invalidPid;
			assert.equal((await run()).result, true);
		}
		pidContents = '4242\n';

		const staleMasterError = Object.assign(new Error('reload failed'), {
			stderr: 'nginx: [error] kill(4242, 1) failed (3: No such process)',
		});
		let validationRestartCalls = 0;
		await assert.rejects(
			run({
				onCommand: async (commandName) => {
					if (commandName === '-t') throw staleMasterError;
				},
				options: {
					restartService: async () => { validationRestartCalls += 1; },
				},
			}),
			/reload failed/,
		);
		assert.equal(validationRestartCalls, 0);

		let restartCalls = 0;
		const recovered = await run({
			onReload: async () => { throw staleMasterError; },
			options: {
				restartService: async () => { restartCalls += 1; },
			},
		});
		assert.equal(recovered.result, true);
		assert.deepEqual(recovered.calls.map((args) => args[0]), ['-t', '-s']);
		assert.equal(restartCalls, 1);

		let nonStaleRestartCalls = 0;
		await assert.rejects(
			run({
				onReload: async () => { throw new Error('reload failed'); },
				options: {
					restartService: async () => { nonStaleRestartCalls += 1; },
				},
			}),
			/could not gracefully reload this site's validated configuration/,
		);
		assert.equal(nonStaleRestartCalls, 0);

		let runningChecks = 0;
		await assert.rejects(
			run({
				isSiteRunning: () => {
					runningChecks += 1;
					return runningChecks === 1;
				},
				onReload: async () => { throw staleMasterError; },
				options: {
					restartService: async () => { restartCalls += 1; },
				},
			}),
			/site stopped before recovery/,
		);
		assert.equal(restartCalls, 1);

		await assert.rejects(
			run({
				onReload: async () => { throw staleMasterError; },
				options: {
					restartService: async () => {
						restartCalls += 1;
						throw new Error('restart failed');
					},
				},
			}),
			/share Local's main log and the site's Nginx error log/,
		);
		assert.equal(restartCalls, 2);

		const changedPidAfterReload = await run({
			onReload: async () => fsPromises.writeFile(
				path.join(runtimeService.runPath, 'logs', 'nginx.pid'),
				'5252\n',
			),
		});
		assert.equal(changedPidAfterReload.result, true);
		assert.deepEqual(
			changedPidAfterReload.calls.map((args) => args[0]),
			['-t', '-s'],
			'refresh must not poll or revalidate the process after a successful reload signal',
		);
		pidContents = '4242\n';

		let current = true;
		const assertCurrent = () => { if (!current) throw new Error('lifecycle changed'); };
		await assert.rejects(run({
			onCommand: async (commandName) => {
				if (commandName === '-t') current = false;
			},
			options: { assertCurrent },
		}), /lifecycle changed/);
		current = true;
		await assert.rejects(run({
			onReload: async () => { throw staleMasterError; },
			options: {
				assertCurrent,
				restartService: async () => { current = false; },
			},
		}), /lifecycle changed/);
		current = true;
		await assert.rejects(run({
			onReload: async () => { current = false; },
			options: { assertCurrent },
		}), /lifecycle changed/);
	} finally {
		await fsPromises.rm(root, { force: true, recursive: true });
	}
});

test('Nginx stale-master recovery matches only the native reload error', () => {
	assert.equal(isMissingNginxMasterProcess(Object.assign(new Error('reload failed'), {
		stderr: 'nginx: [error] kill(4242, 1) failed (3: No such process)',
	})), true);
	assert.equal(isMissingNginxMasterProcess(Object.assign(new Error('reload failed'), {
		stderr: 'nginx: [emerg] invalid configuration',
	})), false);
});

test('main compiles, validates, and reloads Nginx using only the targeted site status', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const compileAndReload = mainSource.slice(
		mainSource.indexOf('const compileAndReload = async'),
		mainSource.indexOf('const runtimeCleanupUnavailableReason'),
	);
	const nginxPath = compileAndReload.slice(
		compileAndReload.indexOf('const targetSiteRunning'),
	);
	assert.match(compileAndReload, /refreshNginxService\(/);
	assert.match(
		nginxPath,
		/const targetSiteRunning = \(\): boolean => \{[\s\S]{0,180}getSiteStatus\(site\) === 'running'/,
	);
	assert.doesNotMatch(nginxPath, /targetServiceRunning/);
	assert.equal(
		(compileAndReload.match(/refreshNginxService\(/g) ?? []).length,
		1,
	);
	assert.match(nginxPath, /expectedManagedInclude,[\s\S]{0,80}targetSiteRunning,[\s\S]{0,200}restartService/);
	assert.match(compileAndReload, /recoverStaleNginxMaster = false/);
	assert.match(nginxPath, /restartService: recoverStaleNginxMaster \? async \(\) =>/);
	assert.match(nginxPath, /const processName = 'nginx'/);
	assert.match(nginxPath, /restartSiteService\(site, processName\)/);
	assert.match(nginxPath, /hasRunningProcess\(site, processName\)/);
	assert.equal((nginxPath.match(/restartSiteService\(/g) ?? []).length, 1);
	assert.doesNotMatch(compileAndReload, /reloadNginxWithFallback|reloadNginxInPlace|compileServiceConfigs/);
});

test('main limits stale-master service restart recovery to interactive settings changes', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const interactiveRecoveryCalls = mainSource.match(
		/compileAndReload\(\s*site,\s*server,\s*(?:true|false),\s*\(\) => assertServerTransactionCurrent\(siteId, transaction\),\s*true,\s*\)/g,
	) ?? [];
	assert.equal(interactiveRecoveryCalls.length, 3);

	const reconciliation = mainSource.slice(
		mainSource.indexOf('const reconcileSite = async'),
		mainSource.indexOf('const cancelDeferredReconciliation'),
	);
	assert.doesNotMatch(
		reconciliation,
		/compileAndReload\(\s*site,\s*server,\s*(?:true|false),\s*assertReconciliationTransactionCurrent,\s*true,/,
	);
	const rollback = mainSource.slice(
		mainSource.indexOf('const rollbackTransaction = async'),
		mainSource.indexOf('const abortForGlobalLifecycle'),
	);
	assert.notEqual(rollback, '');
	assert.doesNotMatch(
		rollback,
		/compileAndReload\([\s\S]{0,180}assertRollbackTransactionCurrent,\s*true,/,
	);
});

test('main binds separate WP Engine TLS identities to the selected Local site', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const reconciliation = mainSource.slice(
		mainSource.indexOf('const reconcileSite = async'),
		mainSource.indexOf('const cancelDeferredReconciliation'),
	);
	assert.match(mainSource, /testOrigin = async \([\s\S]{0,160}siteId: string,[\s\S]{0,160}signal: AbortSignal/);
	assert.match(mainSource, /if \(server\.kind === 'nginx'\) \{\s*await assertAuthoritativeWpEngineIdentity\(site, normalizedInput\)/);
	assert.match(mainSource, /authoritative = await getAuthoritativeWpEngineOrigin\(\s*site,/);
	assert.match(reconciliation, /wpEngineStoredProvenanceMatches\([\s\S]{0,160}settings\.originWpEngineInstallId,[\s\S]{0,80}settings\.originWpEngineSiteId/);
	assert.doesNotMatch(reconciliation, /assertAuthoritativeWpEngineIdentity|assertStoredWpEngineConnection|getAuthoritativeWpEngineOrigin|wpEngineCapi/);
	assert.match(mainSource, /shouldRetainWpEngineSettingsAfterVerificationError\(error\)/);
});

test('main scopes cancellable probes to the renderer, site, and token', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const testHandler = mainSource.match(
		/ipcMain\.handle\(IPC_CHANNELS\.testOrigin,[\s\S]+?\n\t\}\);/,
	)?.[0] ?? '';
	const cancelHandler = mainSource.match(
		/ipcMain\.handle\(IPC_CHANNELS\.cancelOriginTest,[\s\S]+?\n\t\}\);/,
	)?.[0] ?? '';
	assert.match(testHandler, /siteId: unknown/);
	assert.match(testHandler, /const validatedSiteId = requireSiteId\(siteId\)/);
	assert.match(testHandler, /originProbeKey\(event\.sender\.id, validatedSiteId, token\)/);
	assert.match(testHandler, /testOrigin\(validatedSiteId, input, controller\.signal\)/);
	assert.match(mainSource, /probeOrigin\(origin, \{[\s\S]{0,120}allowWpEngineTlsFallback: server\.kind === 'nginx',[\s\S]{0,80}signal,/);
	assert.match(mainSource, /IPC_CHANNELS\.cancelOriginTest/);
	assert.match(mainSource, /controller\.abort\(\)/);
	assert.match(mainSource, /tlsHostname: server\.kind === 'nginx'[\s\S]{0,100}probe\.verifiedTlsHostname \?\? origin\.tlsHostname[\s\S]{0,60}origin\.hostname/);
	assert.match(cancelHandler, /siteId: unknown/);
	assert.match(cancelHandler, /const validatedSiteId = requireSiteId\(siteId\)/);
	assert.match(cancelHandler, /originProbeKey\(event\.sender\.id, validatedSiteId, token\)/);
	assert.doesNotMatch(cancelHandler, /requireSite\(siteId\)/);
});

test('main logs technical probe causes without returning them over IPC', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const testHandler = mainSource.match(
		/ipcMain\.handle\(IPC_CHANNELS\.testOrigin,[\s\S]+?\n\t\}\);/,
	)?.[0] ?? '';
	const applyHandler = mainSource.match(
		/IPC_CHANNELS\.applySettings,[\s\S]+?\n\t\);/,
	)?.[0] ?? '';

	assert.match(mainSource, /error\.cause !== undefined[\s\S]{0,120}Cause: \$\{errorMessage\(error\.cause\)\}/);
	assert.match(testHandler, /Origin test[\s\S]{0,180}errorLogMessage\(error\)/);
	assert.match(testHandler, /throw new Error\(errorMessage\(error\)\)/);
	assert.doesNotMatch(testHandler, /throw new Error\(errorLogMessage\(error\)\)/);
	assert.match(applyHandler, /Unable to apply settings[\s\S]{0,120}errorLogMessage\(error\)/);
	assert.match(applyHandler, /throw new Error\(errorMessage\(error\)\)/);
	assert.doesNotMatch(applyHandler, /throw new Error\(errorLogMessage\(error\)\)/);
});
