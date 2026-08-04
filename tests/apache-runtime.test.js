/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const {
	apacheModulePath,
	buildManagedApacheConfig,
} = require('../lib/apache');
const { ORIGIN_REQUEST_USER_AGENT } = require('../lib/constants');
const { validateAndNormalizeOrigin } = require('../lib/validation');

const runtimeHttpd = process.env.LOCAL_MEDIA_PROXY_APACHE_HTTPD;
const strippedResponseHeaders = [
	'clear-site-data',
	'content-security-policy-report-only',
	'location',
	'nel',
	'report-to',
	'reporting-endpoints',
	'service-worker-allowed',
	'set-cookie',
	'x-accel-redirect',
];

function apachePath(value) {
	return value.replace(/\\/g, '/').replace(/"/g, '\\"');
}

async function openPort() {
	const server = net.createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const { port } = address;
	server.close();
	await once(server, 'close');
	return port;
}

function request(port, requestPath, options = {}) {
	return new Promise((resolve, reject) => {
		const requestOptions = {
			headers: options.headers,
			host: '127.0.0.1',
			method: options.method ?? 'GET',
			path: requestPath,
			port,
		};
		const outgoing = http.request(requestOptions, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => resolve({
				body: Buffer.concat(chunks).toString('utf8'),
				headers: response.headers,
				statusCode: response.statusCode,
			}));
		});
		outgoing.on('error', reject);
		if (options.body) {
			outgoing.write(options.body);
		}
		outgoing.end();
	});
}

function rawMethodRequest(port, method, requestPath) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		let response = '';
		socket.setEncoding('utf8');
		socket.on('connect', () => {
			socket.end(
				`${method} ${requestPath} HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${port}\r\n` +
				'Connection: close\r\n\r\n',
			);
		});
		socket.on('data', (chunk) => {
			response += chunk;
		});
		socket.on('error', reject);
		socket.on('end', () => {
			const match = response.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
			if (!match) {
				reject(new Error(`Invalid raw HTTP response: ${response.slice(0, 80)}`));
				return;
			}
			resolve({ statusCode: Number(match[1]) });
		});
	});
}

async function waitForApache(port, processHandle, stderr) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (processHandle.exitCode !== null) {
			throw new Error(`Apache exited during startup: ${stderr()}`);
		}
		try {
			await request(port, '/ready');
			return;
		} catch (error) {
			if (!error || typeof error !== 'object' || error.code !== 'ECONNREFUSED') {
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Apache did not begin listening: ${stderr()}`);
}

test('official Apache +11 runtime preserves local files and safely proxies only eligible misses', {
	skip: runtimeHttpd ? false : 'Set LOCAL_MEDIA_PROXY_APACHE_HTTPD to an official Local Apache +11 httpd binary.',
}, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-runtime-'));
	const backendRequests = [];
	const rangeBody = Buffer.from('0123456789', 'utf8');
	const contentTypes = {
		mp3: 'audio/mpeg',
		mp4: 'video/mp4',
		pdf: 'application/pdf',
		svg: 'image/svg+xml',
		webm: 'video/webm',
	};
	const backend = http.createServer((incoming, response) => {
		backendRequests.push({
			headers: incoming.headers,
			method: incoming.method,
			url: incoming.url,
		});
		const pathname = new URL(incoming.url, 'http://example.com').pathname;
		const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
		const isRangeFixture = Object.hasOwn(contentTypes, extension);
		response.statusCode = incoming.url.includes('not-found') ? 404 : 200;
		if (pathname.endsWith('/redirect.futuremedia')) {
			response.statusCode = 302;
			response.setHeader('Location', 'https://outside.example.com/active.js');
		}
		response.setHeader(
			'Content-Type',
			incoming.url.includes('/active.futuremedia')
				? 'application/javascript'
				: isRangeFixture ? contentTypes[extension] : 'text/plain',
		);
		response.setHeader('Content-Disposition', `inline; filename="asset.${extension}"`);
		response.setHeader('Set-Cookie', 'origin_session=private; HttpOnly');
		response.setHeader('Clear-Site-Data', '"*"');
		response.setHeader('Content-Security-Policy', 'default-src *');
		response.setHeader('Content-Security-Policy-Report-Only', 'default-src *');
		response.setHeader('NEL', '{"report_to":"origin"}');
		response.setHeader('Report-To', '{"group":"origin"}');
		response.setHeader('Reporting-Endpoints', 'origin="https://reports.example.com"');
		response.setHeader('Service-Worker-Allowed', '/');
		response.setHeader('X-Accel-Redirect', '/local-secret');
		response.setHeader('X-Content-Type-Options', 'unsafe-origin-value');
		response.setHeader('X-Local-Media-Proxy', 'spoofed-origin-value');
		if (isRangeFixture) {
			response.setHeader('Accept-Ranges', 'bytes');
			const range = incoming.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
			if (range) {
				const start = Number(range[1]);
				const requestedEnd = range[2] ? Number(range[2]) : rangeBody.length - 1;
				if (start >= rangeBody.length || requestedEnd < start) {
					response.statusCode = 416;
					response.setHeader('Content-Range', `bytes */${rangeBody.length}`);
					response.setHeader('Content-Length', '0');
					response.end();
					return;
				}
				const end = Math.min(requestedEnd, rangeBody.length - 1);
				const selected = rangeBody.subarray(start, end + 1);
				response.statusCode = 206;
				response.setHeader('Content-Range', `bytes ${start}-${end}/${rangeBody.length}`);
				response.setHeader('Content-Length', String(selected.length));
				response.end(incoming.method === 'HEAD' ? undefined : selected);
				return;
			}
			response.setHeader('Content-Length', String(rangeBody.length));
			response.end(incoming.method === 'HEAD' ? undefined : rangeBody);
			return;
		}
		response.end(`backend:${incoming.url}`);
	});
	let apache;
	try {
		backend.listen(0, '127.0.0.1');
		await once(backend, 'listening');
		const backendAddress = backend.address();
		assert.ok(backendAddress && typeof backendAddress === 'object');
		const frontendPort = await openPort();
		const documentRoot = path.join(root, 'htdocs');
		const uploads = path.join(documentRoot, 'wp-content', 'uploads');
		await fs.mkdir(uploads, { recursive: true });
		await Promise.all([
			fs.writeFile(path.join(uploads, 'local.JPG'), 'local-body'),
			fs.writeFile(path.join(uploads, 'local.js'), 'local-script-body'),
			fs.writeFile(path.join(documentRoot, 'local-secret'), 'must-not-be-served'),
		]);

		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: `http://127.0.0.1:${backendAddress.port}`,
		}, { requiresOriginIp: false });
		const managedConfig = buildManagedApacheConfig(origin);
		const modules = [
			['authz_core_module', 'mod_authz_core.so'],
			['unixd_module', 'mod_unixd.so'],
			['rewrite_module', 'mod_rewrite.so'],
			['proxy_module', 'mod_proxy.so'],
			['proxy_http_module', 'mod_proxy_http.so'],
			['headers_module', 'mod_headers.so'],
			['setenvif_module', 'mod_setenvif.so'],
		].map(([identifier, filename]) => (
			`LoadModule ${identifier} "${apachePath(apacheModulePath(runtimeHttpd, filename))}"`
		));
		const configPath = path.join(root, 'httpd.conf');
		await fs.writeFile(configPath, [
			`ServerRoot "${apachePath(root)}"`,
			'ServerName localhost',
			`PidFile "${apachePath(path.join(root, 'httpd.pid'))}"`,
			`ErrorLog "${apachePath(path.join(root, 'error.log'))}"`,
			`Listen 127.0.0.1:${frontendPort}`,
			...modules,
			`<VirtualHost 127.0.0.1:${frontendPort}>`,
			`DocumentRoot "${apachePath(documentRoot)}"`,
			`<Directory "${apachePath(documentRoot)}">`,
			'Require all granted',
			'</Directory>',
			'<Files "local.JPG">',
			'Header set X-Local-Only "preserved"',
			'</Files>',
			'ProxyAddHeaders On',
			'ProxyErrorOverride On',
			'ProxyPreserveHost On',
			`ProxyPass "/unrelated-proxy/" "http://127.0.0.1:${backendAddress.port}/unrelated-proxy/"`,
			managedConfig,
			'</VirtualHost>',
			'',
		].join('\n'));

		let apacheStderr = '';
		apache = spawn(runtimeHttpd, ['-DFOREGROUND', '-f', configPath], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		apache.stderr.on('data', (chunk) => { apacheStderr += chunk.toString('utf8'); });
		await waitForApache(frontendPort, apache, () => apacheStderr);

		const local = await request(frontendPort, '/wp-content/uploads/local.JPG', {
			headers: {
				Authorization: 'Bearer local',
				Cookie: 'local=cookie',
				'X-Unrecognized-Local-Only': 'preserved-locally',
			},
		});
		assert.equal(local.statusCode, 200);
		assert.equal(local.body, 'local-body');
		assert.equal(local.headers['x-local-only'], 'preserved');
		assert.equal(local.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);

		for (const [unknownHeader, value] of [
			['Bespoke-Credential', 'private'],
			['X-Future-Browser-Identity', 'private'],
			['X-Random-Extension-Token', 'private'],
		]) {
			const beforeUnknown = backendRequests.length;
			const rejected = await request(frontendPort, '/wp-content/uploads/unknown-header.futuremedia', {
				headers: { [unknownHeader]: value },
			});
			assert.equal(rejected.statusCode, 400, unknownHeader);
			assert.equal(backendRequests.length, beforeUnknown, unknownHeader);
		}
		const outsideRoute = await request(frontendPort, '/outside-upload-route.futuremedia', {
			headers: { 'Bespoke-Credential': 'private' },
		});
		assert.equal(outsideRoute.statusCode, 404);
		assert.equal(backendRequests.length, 0);
		const localBlockedType = await request(frontendPort, '/wp-content/uploads/local.js');
		assert.equal(localBlockedType.statusCode, 200);
		assert.equal(localBlockedType.body, 'local-script-body');
		assert.equal(localBlockedType.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);

		const missing = await request(frontendPort, '/wp-content/uploads/missing.JPG', {
			headers: {
				Accept: 'application/private',
				'Accept-Language': 'private-language',
				Authorization: 'Bearer private',
				Baggage: 'private=baggage',
				Cookie: 'private=cookie',
				'Proxy-Authorization': 'Basic private',
				'X-API-Key': 'private',
				'X-Auth-Token': 'private',
				'X-CSRF-Token': 'private',
				'X-Forwarded-For': '192.0.2.50',
				'X-HTTP-Method-Override': 'POST',
				'X-Original-URL': '/private',
				'X-Forwarded-Client-Cert': 'private',
				'X-Access-Token': 'private',
				'CF-Access-Client-Secret': 'private',
				'X-WP-Nonce': 'private',
				'Sec-CH-UA': 'private-client-hint',
				'Sec-Fetch-Dest': 'image',
				'Sec-Fetch-Site': 'same-origin',
				'Sentry-Trace': 'private-trace',
				Traceparent: '00-private',
				'X-Request-ID': 'private-request',
			},
		});
		assert.equal(missing.statusCode, 200);
		assert.equal(missing.body, 'backend:/wp-content/uploads/missing.JPG');
		assert.equal(missing.headers['x-local-media-proxy'], 'origin');
		assert.equal(missing.headers['x-content-type-options'], 'nosniff');
		assert.equal(
			missing.headers['content-security-policy'],
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		assert.equal(missing.headers['content-disposition'], 'inline; filename="asset.jpg"');
		for (const header of strippedResponseHeaders) {
			assert.equal(missing.headers[header], undefined, header);
		}
		assert.equal(backendRequests.length, 1);
		assert.equal(backendRequests[0].headers.host, `127.0.0.1:${backendAddress.port}`);
		assert.equal(backendRequests[0].headers['user-agent'], ORIGIN_REQUEST_USER_AGENT);
		assert.deepEqual(
			Object.keys(backendRequests[0].headers).sort(),
			['connection', 'host', 'user-agent'],
		);
		for (const header of [
			'accept',
			'accept-language',
			'authorization',
			'baggage',
			'cookie',
			'proxy-authorization',
			'x-api-key',
			'x-auth-token',
			'x-csrf-token',
			'x-forwarded-for',
			'x-http-method-override',
			'x-original-url',
			'x-forwarded-client-cert',
			'x-access-token',
			'cf-access-client-secret',
			'x-wp-nonce',
			'sec-ch-ua',
			'sec-fetch-dest',
			'sec-fetch-site',
			'sentry-trace',
			'traceparent',
			'x-request-id',
		]) {
			assert.equal(backendRequests[0].headers[header], undefined, header);
		}

		const notFound = await request(frontendPort, '/wp-content/uploads/not-found.JPG');
		assert.equal(notFound.statusCode, 404);
		assert.equal(notFound.headers['x-local-media-proxy'], 'origin');
		assert.equal(notFound.headers['x-content-type-options'], 'nosniff');
		assert.equal(notFound.headers['set-cookie'], undefined);
		assert.equal(backendRequests.length, 2);

		const activeResponse = await request(frontendPort, '/wp-content/uploads/active.futuremedia');
		assert.equal(activeResponse.statusCode, 200);
		assert.equal(activeResponse.headers['content-type'], 'application/javascript');
		assert.equal(
			activeResponse.headers['content-security-policy'],
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		assert.equal(activeResponse.headers['x-content-type-options'], 'nosniff');
		assert.equal(activeResponse.headers['x-local-media-proxy'], 'origin');

		const beforeActiveDestinations = backendRequests.length;
		for (const destination of [
			'audioworklet',
			'paintworklet',
			'SCRIPT',
			'serviceworker',
			'sharedworker',
			'worker',
			'xslt',
		]) {
			const blocked = await request(
				frontendPort,
				`/wp-content/uploads/active-${destination.toLowerCase()}.futuremedia`,
				{ headers: { 'Sec-Fetch-Dest': destination } },
			);
			assert.equal(blocked.statusCode, 404, destination);
			assert.equal(backendRequests.length, beforeActiveDestinations, destination);
		}
		for (const [assetPath, destination, contentType] of [
			['/wp-content/uploads/object.pdf', 'object', 'application/pdf'],
			['/wp-content/uploads/embed.svg', 'embed', 'image/svg+xml'],
			['/wp-content/uploads/frame.pdf', 'iframe', 'application/pdf'],
		]) {
			const allowed = await request(frontendPort, assetPath, {
				headers: { 'Sec-Fetch-Dest': destination },
			});
			assert.equal(allowed.statusCode, 200, destination);
			assert.equal(allowed.headers['content-type'], contentType, destination);
			assert.equal(allowed.headers['x-local-media-proxy'], 'origin', destination);
			assert.equal(backendRequests.at(-1).headers['sec-fetch-dest'], undefined, destination);
		}

		const redirect = await request(frontendPort, '/wp-content/uploads/redirect.futuremedia');
		assert.equal(redirect.statusCode, 302);
		assert.equal(redirect.headers.location, undefined);
		assert.equal(redirect.headers['x-local-media-proxy'], 'origin');
		assert.equal(backendRequests.length, beforeActiveDestinations + 4);

		const beforeRawNormalization = backendRequests.length;
		for (const unsafePath of [
			'//wp-content/uploads/unsafe.futuremedia',
			'/x/../wp-content/uploads/unsafe.futuremedia',
			'/%77p-content/uploads/unsafe.futuremedia',
			'/wp-content/uploads/unsafe\\path.futuremedia',
			'/wp-content/uploads/unsafe.jpg:preview.futuremedia',
			'/wp-content/uploads/unsafe.jpg%3Apreview.futuremedia',
		]) {
			const blocked = await request(frontendPort, unsafePath);
			assert.ok(blocked.statusCode >= 400, unsafePath);
			assert.equal(backendRequests.length, beforeRawNormalization, unsafePath);
		}
		const beforeRejectedRequests = backendRequests.length;

		const blockedMethod = await request(frontendPort, '/wp-content/uploads/method.JPG', {
			body: 'blocked',
			headers: { 'Content-Length': '7' },
			method: 'POST',
		});
		assert.equal(blockedMethod.statusCode, 405);
		assert.equal(backendRequests.length, beforeRejectedRequests);
		for (const method of ['get', 'head']) {
			const lowercaseMethod = await rawMethodRequest(
				frontendPort,
				method,
				'/wp-content/uploads/lowercase-method.futuremedia',
			);
			assert.ok(lowercaseMethod.statusCode >= 400, method);
			assert.ok(lowercaseMethod.statusCode < 500, method);
			assert.equal(backendRequests.length, beforeRejectedRequests, method);
		}

		const blockedBody = await request(frontendPort, '/wp-content/uploads/body.JPG', {
			body: 'blocked',
			headers: { 'Content-Length': '7' },
		});
		assert.equal(blockedBody.statusCode, 400);
		assert.equal(backendRequests.length, beforeRejectedRequests);

		const blockedChunkedBody = await request(frontendPort, '/wp-content/uploads/chunked.JPG', {
			body: 'blocked',
			headers: { 'Transfer-Encoding': 'chunked' },
		});
		assert.equal(blockedChunkedBody.statusCode, 400);
		assert.equal(backendRequests.length, beforeRejectedRequests);

		for (const unsafePath of [
			'/wp-content/uploads/%252e%252e/secret.JPG',
			'/wp-content/uploads/a%252fb.JPG',
			'/wp-content/uploads/photo%2541.JPG',
		]) {
			const blocked = await request(frontendPort, unsafePath);
			assert.equal(blocked.statusCode, 400, unsafePath);
			assert.equal(backendRequests.length, beforeRejectedRequests, unsafePath);
		}

		const queryString = await request(
			frontendPort,
			'/wp-content/uploads/new.futuremedia?cache=one%20two&size=large',
		);
		assert.equal(queryString.statusCode, 200);
		assert.equal(
			queryString.body,
			'backend:/wp-content/uploads/new.futuremedia?cache=one%20two&size=large',
		);
		assert.equal(queryString.headers['x-local-media-proxy'], 'origin');
		assert.equal(backendRequests.at(-1).url, '/wp-content/uploads/new.futuremedia?cache=one%20two&size=large');

		const beforeBlocked = backendRequests.length;
		for (const blockedPath of [
			'/wp-content/uploads/index.html',
			'/wp-content/uploads/index.html.futuremedia',
			'/wp-content/uploads/index.shtm',
			'/wp-content/uploads/app.js',
			'/wp-content/uploads/app.js.futuremedia',
			'/wp-content/uploads/program.wasm.futuremedia',
			'/wp-content/uploads/shell.PHP.jpg',
			'/wp-content/uploads/shell.php;.jpg',
			'/wp-content/uploads/shell.php%3B.jpg',
			'/wp-content/uploads/shell.php/image.jpg',
			'/wp-content/uploads/shell.php123/image.jpg',
			'/wp-content/uploads/program.exe',
			'/wp-content/uploads/web.config',
			'/wp-content/uploads/database.sqlite',
			'/wp-content/uploads/site.backup',
			'/wp-content/uploads/.hidden.pdf',
			'/wp-content/uploads/no-extension',
		]) {
			const blocked = await request(frontendPort, blockedPath);
			assert.equal(blocked.statusCode, 404, blockedPath);
			assert.equal(backendRequests.length, beforeBlocked, blockedPath);
		}

		for (const allowedPath of [
			'/wp-content/uploads/html-guide.pdf',
			'/wp-content/uploads/node-js-handbook.pdf',
			'/wp-content/uploads/wasm-talk.mp4',
			'/wp-content/uploads/app/image.jpg',
			'/wp-content/uploads/config/image.jpg',
			'/wp-content/uploads/js/image.jpg',
		]) {
			const allowed = await request(frontendPort, allowedPath);
			assert.equal(allowed.statusCode, 200, allowedPath);
			assert.equal(allowed.headers['x-local-media-proxy'], 'origin', allowedPath);
		}

		for (const [extension, contentType] of Object.entries(contentTypes)) {
			const ranged = await request(frontendPort, `/wp-content/uploads/range.${extension}`, {
				headers: {
					Authorization: 'Bearer private',
					Cookie: 'private=cookie',
					'If-Range': '"fixture-etag"',
					Range: 'bytes=2-5',
					'X-Playback-Session-Id': 'private-playback-session',
				},
			});
			assert.equal(ranged.statusCode, 206, extension);
			assert.equal(ranged.body, '2345', extension);
			assert.equal(ranged.headers['accept-ranges'], 'bytes', extension);
			assert.equal(ranged.headers['content-range'], 'bytes 2-5/10', extension);
			assert.equal(ranged.headers['content-length'], '4', extension);
			assert.equal(ranged.headers['content-type'], contentType, extension);
			assert.equal(ranged.headers['content-disposition'], `inline; filename="asset.${extension}"`, extension);
			assert.equal(ranged.headers['x-local-media-proxy'], 'origin', extension);
			assert.equal(ranged.headers['x-content-type-options'], 'nosniff', extension);
			assert.equal(
				ranged.headers['content-security-policy'],
				"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
				extension,
			);
			for (const header of strippedResponseHeaders) {
				assert.equal(ranged.headers[header], undefined, `${extension}:${header}`);
			}
			assert.equal(backendRequests.at(-1).headers.range, 'bytes=2-5', extension);
			assert.equal(backendRequests.at(-1).headers['if-range'], '"fixture-etag"', extension);
			assert.equal(backendRequests.at(-1).headers.authorization, undefined, extension);
			assert.equal(backendRequests.at(-1).headers.cookie, undefined, extension);
			assert.equal(backendRequests.at(-1).headers['x-playback-session-id'], undefined, extension);
			assert.deepEqual(
				Object.keys(backendRequests.at(-1).headers).sort(),
				['connection', 'host', 'if-range', 'range', 'user-agent'],
				extension,
			);

			const unsatisfied = await request(frontendPort, `/wp-content/uploads/range.${extension}`, {
				headers: { Range: 'bytes=99-' },
			});
			assert.equal(unsatisfied.statusCode, 416, extension);
			assert.equal(unsatisfied.body, '', extension);
			assert.equal(unsatisfied.headers['content-range'], 'bytes */10', extension);
			assert.equal(unsatisfied.headers['content-type'], contentType, extension);
			assert.equal(unsatisfied.headers['x-local-media-proxy'], 'origin', extension);

			const head = await request(frontendPort, `/wp-content/uploads/head.${extension}`, {
				method: 'HEAD',
			});
			assert.equal(head.statusCode, 200, extension);
			assert.equal(head.body, '', extension);
			assert.equal(head.headers['content-length'], '10', extension);
			assert.equal(head.headers['accept-ranges'], 'bytes', extension);
			assert.equal(head.headers['content-type'], contentType, extension);
			assert.equal(head.headers['x-local-media-proxy'], 'origin', extension);
			assert.equal(backendRequests.at(-1).method, 'HEAD', extension);
		}

		const beforeUnrelatedProxy = backendRequests.length;
		const unrelatedProxy = await request(frontendPort, '/unrelated-proxy/fixture.futuremedia');
		assert.equal(unrelatedProxy.statusCode, 200);
		assert.equal(backendRequests.length, beforeUnrelatedProxy + 1);
		assert.equal(backendRequests.at(-1).url, '/unrelated-proxy/fixture.futuremedia');
		assert.equal(backendRequests.at(-1).headers.host, `127.0.0.1:${frontendPort}`);
		assert.ok(backendRequests.at(-1).headers['x-forwarded-for']);
		const unrelatedError = await request(frontendPort, '/unrelated-proxy/not-found.futuremedia');
		assert.equal(unrelatedError.statusCode, 404);
		assert.doesNotMatch(unrelatedError.body, /^backend:/);
		assert.equal(unrelatedError.headers['x-local-media-proxy'], undefined);
	} finally {
		if (apache && apache.exitCode === null) {
			apache.kill('SIGTERM');
			await once(apache, 'exit');
		}
		if (backend.listening) {
			backend.close();
			await once(backend, 'close');
		}
		await fs.rm(root, { force: true, recursive: true });
	}
});
