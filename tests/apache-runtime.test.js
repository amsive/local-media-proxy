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
	const backend = http.createServer((incoming, response) => {
		backendRequests.push({
			headers: incoming.headers,
			method: incoming.method,
			url: incoming.url,
		});
		const isRangeFixture = incoming.url.includes('/range.') || incoming.url.includes('/head.');
		response.statusCode = incoming.url.includes('not-found') ? 404 : 200;
		response.setHeader(
			'Content-Type',
			incoming.url.includes('/active.futuremedia')
				? 'text/html'
				: isRangeFixture ? 'application/octet-stream' : 'text/plain',
		);
		response.setHeader('Content-Disposition', 'inline; filename="asset.example"');
		response.setHeader('Set-Cookie', 'origin_session=private; HttpOnly');
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
				response.end(selected);
				return;
			}
			response.setHeader('Content-Length', String(rangeBody.length));
			response.end(rangeBody);
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
			headers: { Authorization: 'Bearer local', Cookie: 'local=cookie' },
		});
		assert.equal(local.statusCode, 200);
		assert.equal(local.body, 'local-body');
		assert.equal(local.headers['x-local-only'], 'preserved');
		assert.equal(local.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);
		const localBlockedType = await request(frontendPort, '/wp-content/uploads/local.js');
		assert.equal(localBlockedType.statusCode, 200);
		assert.equal(localBlockedType.body, 'local-script-body');
		assert.equal(localBlockedType.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);

		const missing = await request(frontendPort, '/wp-content/uploads/missing.JPG', {
			headers: {
				Authorization: 'Bearer private',
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
		assert.equal(missing.headers['content-disposition'], 'inline; filename="asset.example"');
		assert.equal(missing.headers['set-cookie'], undefined);
		assert.equal(backendRequests.length, 1);
		assert.equal(backendRequests[0].headers.host, `127.0.0.1:${backendAddress.port}`);
		assert.equal(backendRequests[0].headers['user-agent'], ORIGIN_REQUEST_USER_AGENT);
		for (const header of [
			'authorization',
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
		assert.equal(activeResponse.headers['content-type'], 'text/html');
		assert.equal(
			activeResponse.headers['content-security-policy'],
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		assert.equal(activeResponse.headers['x-content-type-options'], 'nosniff');
		assert.equal(activeResponse.headers['x-local-media-proxy'], 'origin');
		const beforeRejectedRequests = backendRequests.length;

		const blockedMethod = await request(frontendPort, '/wp-content/uploads/method.JPG', {
			body: 'blocked',
			headers: { 'Content-Length': '7' },
			method: 'POST',
		});
		assert.equal(blockedMethod.statusCode, 405);
		assert.equal(backendRequests.length, beforeRejectedRequests);

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
			'/wp-content/uploads/app.js',
			'/wp-content/uploads/app.js.futuremedia',
			'/wp-content/uploads/program.wasm.futuremedia',
			'/wp-content/uploads/shell.PHP.jpg',
			'/wp-content/uploads/shell.php;.jpg',
			'/wp-content/uploads/shell.php%3B.jpg',
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

		const rangedVideo = await request(frontendPort, '/wp-content/uploads/range.mp4', {
			headers: {
				Authorization: 'Bearer private',
				Cookie: 'private=cookie',
				'If-Range': '"fixture-etag"',
				Range: 'bytes=2-5',
			},
		});
		assert.equal(rangedVideo.statusCode, 206);
		assert.equal(rangedVideo.body, '2345');
		assert.equal(rangedVideo.headers['accept-ranges'], 'bytes');
		assert.equal(rangedVideo.headers['content-range'], 'bytes 2-5/10');
		assert.equal(rangedVideo.headers['content-length'], '4');
		assert.equal(rangedVideo.headers['content-type'], 'application/octet-stream');
		assert.equal(rangedVideo.headers['content-disposition'], 'inline; filename="asset.example"');
		assert.equal(rangedVideo.headers['x-local-media-proxy'], 'origin');
		assert.equal(rangedVideo.headers['x-content-type-options'], 'nosniff');
		assert.equal(
			rangedVideo.headers['content-security-policy'],
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		assert.equal(rangedVideo.headers['set-cookie'], undefined);
		assert.equal(backendRequests.at(-1).headers.range, 'bytes=2-5');
		assert.equal(backendRequests.at(-1).headers['if-range'], '"fixture-etag"');
		assert.equal(backendRequests.at(-1).headers.authorization, undefined);
		assert.equal(backendRequests.at(-1).headers.cookie, undefined);

		const rangedAudio = await request(frontendPort, '/wp-content/uploads/range.mp3', {
			headers: { Range: 'bytes=0-1' },
		});
		assert.equal(rangedAudio.statusCode, 206);
		assert.equal(rangedAudio.body, '01');
		assert.equal(rangedAudio.headers['content-range'], 'bytes 0-1/10');

		const unsatisfiedPdf = await request(frontendPort, '/wp-content/uploads/range.pdf', {
			headers: { Range: 'bytes=99-' },
		});
		assert.equal(unsatisfiedPdf.statusCode, 416);
		assert.equal(unsatisfiedPdf.body, '');
		assert.equal(unsatisfiedPdf.headers['content-range'], 'bytes */10');
		assert.equal(unsatisfiedPdf.headers['x-local-media-proxy'], 'origin');
		assert.equal(unsatisfiedPdf.headers['set-cookie'], undefined);

		const headVideo = await request(frontendPort, '/wp-content/uploads/head.webm', {
			method: 'HEAD',
		});
		assert.equal(headVideo.statusCode, 200);
		assert.equal(headVideo.body, '');
		assert.equal(headVideo.headers['content-length'], '10');
		assert.equal(headVideo.headers['accept-ranges'], 'bytes');
		assert.equal(headVideo.headers['x-local-media-proxy'], 'origin');
		assert.equal(headVideo.headers['set-cookie'], undefined);
		assert.equal(backendRequests.at(-1).method, 'HEAD');
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
