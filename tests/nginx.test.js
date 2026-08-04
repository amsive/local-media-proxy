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
	reloadNginxInPlace,
	reloadNginxWithFallback,
	removeManagedInclude,
	nginxCompiledConfigMatches,
	nginxCompiledPaths,
	upsertManagedInclude,
} = require('../lib/nginx');
const {
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
} = require('../lib/constants');
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
	const section = (filePath, content) => `# configuration file ${filePath}:\n${content}`;
	const dump = [
		section(compiled.main, main),
		section(compiled.site, site),
		...(include === null ? [] : [section(compiled.include, include)]),
	].join('\n');
	return { compiled, dump, include, main, site };
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

test('targeted Nginx compilation verifies exact files, syntax, and loaded dump', async () => {
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
				return args[1][0] === '-T' ? expected.dump : '';
			},
			expected.include,
		);

		assert.deepEqual(calls[0].slice(2), [
			runtimeService.siteConfigTemplatePath,
			runtimeService.configPath,
			runtimeService.configVariables,
		]);
		assert.deepEqual(calls.slice(1).map((call) => call[2][0]), ['-t', '-T']);
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

test('Nginx validation fences each phase and rejects an inexact or duplicated -T section', async () => {
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
					return args[0] === '-T' ? expected.dump : '';
				},
				expected.include,
				assertCurrent,
			), /server identity changed/);
			return commands;
		};
		assert.deepEqual(await runGuardScenario('compile'), []);
		assert.deepEqual(await runGuardScenario('-t'), ['-t']);
		assert.deepEqual(await runGuardScenario('-T'), ['-t', '-T']);

		const compiler = {
			compileConfigTemplates: async () => {
				await writeCompiledNginxFixture(runtimeService, true);
			},
		};
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			runtimeService,
			compiler,
			async (_command, args) => args[0] === '-T'
				? expected.dump.replace(expected.include, `${expected.include}# stale directive\n`)
				: '',
			expected.include,
		), /exact compiled configuration/);
		await assert.rejects(compileAndValidateNginxConfig(
			{ id: 'site-a' },
			runtimeService,
			compiler,
			async (_command, args) => args[0] === '-T'
				? `${expected.dump}\n# configuration file ${expected.compiled.include}:\n${expected.include}`
				: '',
			expected.include,
		), /exact compiled configuration/);

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

test('validates the compiled config before reloading Nginx in place', async () => {
	const calls = [];
	const execFilePromise = async (...args) => {
		calls.push(args);
		return '';
	};

	await reloadNginxInPlace(service, execFilePromise);

	const configFile = path.join(service.configPath, 'nginx.conf');
	assert.deepEqual(calls, [
		[
			service.bin.nginx,
			['-t', '-c', configFile, '-p', service.runPath],
			{ timeout: 10_000, windowsHide: true },
		],
		[
			service.bin.nginx,
			['-s', 'reload', '-c', configFile, '-p', service.runPath],
			{ timeout: 10_000, windowsHide: true },
		],
	]);
});

test('does not reload when Nginx rejects the compiled config', async () => {
	let callCount = 0;
	const configError = new Error('nginx: configuration file test failed');

	await assert.rejects(
		reloadNginxInPlace(service, async () => {
			callCount += 1;
			throw configError;
		}),
		configError,
	);
	assert.equal(callCount, 1);
});

test('propagates a reload failure after successful validation', async () => {
	let callCount = 0;
	const reloadError = new Error('nginx: invalid PID number');

	await assert.rejects(
		reloadNginxInPlace(service, async () => {
			callCount += 1;
			if (callCount === 2) {
				throw reloadError;
			}
			return '';
		}),
		reloadError,
	);
	assert.equal(callCount, 2);
});

test('restarts only the Nginx service when its validated reload finds a stale master PID', async () => {
	const calls = [];
	let restartCount = 0;
	const result = await reloadNginxWithFallback(
		service,
		async (_command, args) => {
			calls.push(args);
			if (args[0] === '-s') {
				const error = new Error('nginx: [alert] kill(83412, 1) failed (3: No such process)');
				error.stderr = 'nginx: [alert] kill(83412, 1) failed (3: No such process)';
				throw error;
			}
			return '';
		},
		async () => {
			restartCount += 1;
			return true;
		},
	);

	assert.equal(result, 'restarted');
	assert.equal(restartCount, 1);
	assert.deepEqual(calls.map((args) => args[0]), ['-t', '-s']);
});

test('does not restart the Nginx service for configuration or unrelated reload failures', async () => {
	let restartCount = 0;
	const restartService = async () => {
		restartCount += 1;
		return true;
	};

	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async () => {
				throw new Error('nginx: configuration file test failed');
			},
			restartService,
		),
		/configuration file test failed/,
	);
	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async (_command, args) => {
				if (args[0] === '-s') {
					throw new Error('nginx: permission denied');
				}
				return '';
			},
			restartService,
		),
		/permission denied/,
	);

	assert.equal(restartCount, 0);
});

test('never restarts when validation reports stale-PID text', async () => {
	let restartCount = 0;

	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async () => {
				throw new Error('nginx: [alert] kill(83412, 1) failed (3: No such process)');
			},
			async () => {
				restartCount += 1;
				return true;
			},
		),
		/No such process/,
	);
	assert.equal(restartCount, 0);
});

test('propagates a targeted restart failure after a stale master PID', async () => {
	const restartError = new Error('Local could not restart Nginx');

	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async (_command, args) => {
				if (args[0] === '-s') {
					throw new Error('nginx: [alert] kill(83412, 1) failed (3: No such process)');
				}
				return '';
			},
			async () => {
				throw restartError;
			},
		),
		restartError,
	);
});

test('fails when Local reports success without starting the targeted Nginx process', async () => {
	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async (_command, args) => {
				if (args[0] === '-s') {
					throw new Error('nginx: [alert] kill(83412, 1) failed (3: No such process)');
				}
				return '';
			},
			async () => false,
		),
		/Local did not start the Nginx service/,
	);
});

test('does not restart Nginx when the Local site stops after reload validation', async () => {
	let restartCount = 0;
	await assert.rejects(
		reloadNginxWithFallback(
			service,
			async (_command, args) => {
				if (args[0] === '-s') {
					throw new Error('nginx: [alert] kill(83412, 1) failed (3: No such process)');
				}
				return '';
			},
			async () => {
				restartCount += 1;
				return true;
			},
			() => false,
		),
		/site is no longer running/,
	);
	assert.equal(restartCount, 0);
});

test('recognizes a stale Nginx master PID in command stderr', () => {
	const error = new Error('Command failed');
	error.stderr = 'nginx: [alert] kill(123, 1) failed (3: No such process)';

	assert.equal(isMissingNginxMasterProcess(error), true);
	assert.equal(isMissingNginxMasterProcess(new Error('nginx: invalid PID number')), false);
});

test('supports consecutive validation and reload operations', async () => {
	const calls = [];
	const execFilePromise = async (_command, args) => {
		calls.push(args);
		return '';
	};

	await reloadNginxInPlace(service, execFilePromise);
	await reloadNginxInPlace(service, execFilePromise);

	assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
		['-t', '-c'],
		['-s', 'reload'],
		['-t', '-c'],
		['-s', 'reload'],
	]);
});

test('fails closed when Local does not expose an Nginx binary', async () => {
	await assert.rejects(
		reloadNginxInPlace({ ...service, bin: undefined }, async () => ''),
		/Local did not provide an Nginx binary/,
	);
});

test('main compiles, validates, and restarts only the targeted running Nginx service', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	const compileAndReload = mainSource.slice(
		mainSource.indexOf('const compileAndReload = async'),
		mainSource.indexOf('const runtimeCleanupUnavailableReason'),
	);
	assert.match(compileAndReload, /compileAndValidateNginxConfig\(/);
	assert.match(
		compileAndReload,
		/const targetServiceRunning = \(\): boolean => \{[\s\S]{0,180}hasRunningProcess\(site, serviceName\)[\s\S]{0,180}const targetWasRunning = targetServiceRunning\(\)[\s\S]{0,160}siteStatus === 'running' && !targetWasRunning[\s\S]{0,260}if \(shouldRefreshRuntime\(siteStatus, targetWasRunning\)\)/,
	);
	assert.equal(
		(compileAndReload.match(/restartSiteService\(site, serviceName\)/g) ?? []).length,
		1,
	);
	assert.match(compileAndReload, /assertCurrent\(\);[\s\S]{0,100}restartSiteService\(site, serviceName\)[\s\S]{0,100}assertCurrent\(\)/);
	assert.doesNotMatch(compileAndReload, /reloadNginxWithFallback|reloadNginxInPlace|compileServiceConfigs/);
});

test('main binds separate WP Engine TLS identities to the selected Local site', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	assert.match(mainSource, /testOrigin = async \([\s\S]{0,160}siteId: string,[\s\S]{0,160}signal: AbortSignal/);
	assert.match(mainSource, /if \(server\.kind === 'nginx'\) \{\s*await assertAuthoritativeWpEngineIdentity\(site, normalizedInput\)/);
	assert.match(mainSource, /authoritative = await getAuthoritativeWpEngineOrigin\(\s*site,/);
	assert.match(mainSource, /await assertStoredWpEngineConnection\(site, settings\)/);
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
