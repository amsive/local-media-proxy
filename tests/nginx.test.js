/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
	buildManagedNginxConfig,
	hasManagedInclude,
	isMissingNginxMasterProcess,
	reloadNginxInPlace,
	reloadNginxWithFallback,
	removeManagedInclude,
	upsertManagedInclude,
} = require('../lib/nginx');
const { ORIGIN_REQUEST_USER_AGENT } = require('../lib/constants');
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

test('builds a local-first, read-only, privacy-preserving HTTPS proxy', () => {
	const config = buildManagedNginxConfig(secureOrigin, '/tmp/local origin-ca.pem');

	assert.match(config, /Managed route revision: upload-assets-v2/);
	assert.match(config, /location ~\* "\^\/wp-content\/uploads\//);
	assert.match(config, /if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/);
	assert.match(config, /if \(\$http_transfer_encoding != ""\) \{ return 400; \}/);
	assert.match(config, /if \(\$http_content_length !~ \^\(\?:\|0\)\$\) \{ return 400; \}/);
	assert.match(config, /if \(\$request_uri !~\* "\^\/wp-content\/uploads\/"\) \{ return 400; \}/);
	assert.match(config, /\$request_uri ~\* .*%\(\?:25\|2f\|5c\|3f\|23/);
	assert.match(config, /\$request_uri ~\* "\^\/wp-content\/uploads\/\(\?:\/\|\[\^\?\]\*\/\/\)"/);
	assert.match(config, /try_files \$uri @local_media_proxy;/);
	assert.ok(config.indexOf('try_files $uri') < config.indexOf('if ($uri ~*'));
	assert.ok(config.indexOf('if ($uri ~*') < config.indexOf('proxy_pass https://'));
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
	assert.match(config, /proxy_hide_header Set-Cookie;/);
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
	const routeLine = config.split('\n').find((line) => line.startsWith('location ~*')) ?? '';

	assert.match(routeLine, /wp-content\/uploads/);
	assert.match(routeLine, /A-Za-z0-9/);
	assert.doesNotMatch(routeLine, /avif|jpe|webp|pdf|mp4|futuremedia/i);
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

test('main delegates stale-master recovery through the guarded Nginx reload helper', () => {
	const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
	assert.match(mainSource, /reloadNginxWithFallback\(/);
	assert.match(
		mainSource,
		/const targetServiceRunning = \(\): boolean => \{[\s\S]{0,180}hasRunningProcess\(site, serviceName\)[\s\S]{0,180}if \(shouldRefreshRuntime\(/,
	);
	assert.match(mainSource, /await siteProcessManager\.restartSiteService\(site, serviceName\)/);
	assert.match(mainSource, /return siteProcessManager\.hasRunningProcess\(site, serviceName\)/);
	assert.match(mainSource, /siteProcessManager\.getSiteStatus\(site\) === 'running'[\s\S]{0,120}siteProcessManager\.hasRunningProcess\(site\)/);
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
