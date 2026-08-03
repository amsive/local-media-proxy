/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ORIGIN_REQUEST_USER_AGENT } = require('../lib/constants');
const { buildManagedNginxConfig } = require('../lib/nginx');
const { validateAndNormalizeOrigin } = require('../lib/validation');

const runtimeNginx = process.env.LOCAL_MEDIA_PROXY_NGINX_BIN;

function nginxQuote(value) {
	return `"${value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')}"`;
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
		const outgoing = http.request({
			headers: options.headers,
			host: '127.0.0.1',
			method: options.method ?? 'GET',
			path: requestPath,
			port,
		}, (response) => {
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

async function waitForNginx(port, processHandle, stderr) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (processHandle.exitCode !== null) {
			throw new Error(`Nginx exited during startup: ${stderr()}`);
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
	throw new Error(`Nginx did not begin listening: ${stderr()}`);
}

test('official Local Nginx runtime preserves local files and safely proxies only eligible misses', {
	skip: runtimeNginx ? false : 'Set LOCAL_MEDIA_PROXY_NGINX_BIN to an official Local Nginx binary.',
}, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-nginx-runtime-'));
	const backendRequests = [];
	const rangeBody = Buffer.from('0123456789', 'utf8');
	const contentTypes = {
		css: 'text/css',
		mp3: 'audio/mpeg',
		mp4: 'video/mp4',
		pdf: 'application/pdf',
		svg: 'image/svg+xml',
		webm: 'video/webm',
		woff2: 'font/woff2',
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
		response.statusCode = pathname.includes('not-found') ? 404 : 200;
		response.setHeader(
			'Content-Type',
			pathname.endsWith('/active.futuremedia')
				? 'text/html'
				: isRangeFixture ? contentTypes[extension] : 'text/plain',
		);
		response.setHeader('Content-Disposition', `inline; filename="asset.${extension}"`);
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
				response.end(incoming.method === 'HEAD' ? undefined : selected);
				return;
			}
			response.setHeader('Content-Length', String(rangeBody.length));
			response.end(incoming.method === 'HEAD' ? undefined : rangeBody);
			return;
		}
		response.end(`backend:${incoming.url}`);
	});
	let nginx;
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
			originIp: '127.0.0.1',
			siteUrl: `http://example.com:${backendAddress.port}`,
		});
		const managedConfig = buildManagedNginxConfig(origin);
		const configPath = path.join(root, 'nginx.conf');
		await fs.writeFile(configPath, [
			'worker_processes 1;',
			`pid ${nginxQuote(path.join(root, 'nginx.pid'))};`,
			'error_log stderr notice;',
			'events { worker_connections 64; }',
			'http {',
			'\taccess_log off;',
			'\tdefault_type application/octet-stream;',
			'\tserver {',
			`\t\tlisten 127.0.0.1:${frontendPort};`,
			'\t\tserver_name localhost;',
			`\t\troot ${nginxQuote(documentRoot)};`,
			'\t\tlocation = /ready { return 204; }',
			managedConfig.split('\n').map((line) => `\t\t${line}`).join('\n'),
			'\t}',
			'}',
			'',
		].join('\n'));

		let nginxStderr = '';
		nginx = spawn(runtimeNginx, ['-p', `${root}/`, '-c', configPath, '-g', 'daemon off;'], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		nginx.stderr.on('data', (chunk) => { nginxStderr += chunk.toString('utf8'); });
		await waitForNginx(frontendPort, nginx, () => nginxStderr);

		const local = await request(frontendPort, '/wp-content/uploads/local.JPG', {
			headers: { Authorization: 'Bearer local', Cookie: 'local=cookie' },
		});
		assert.equal(local.statusCode, 200);
		assert.equal(local.body, 'local-body');
		assert.equal(local.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);
		const localBlockedType = await request(frontendPort, '/wp-content/uploads/local.js');
		assert.equal(localBlockedType.statusCode, 200);
		assert.equal(localBlockedType.body, 'local-script-body');
		assert.equal(localBlockedType.headers['x-local-media-proxy'], undefined);
		assert.equal(backendRequests.length, 0);

		const missing = await request(
			frontendPort,
			'/wp-content/uploads/new.futuremedia?cache=one%20two&size=large',
			{
				headers: {
					Accept: 'application/private',
					Authorization: 'Bearer private',
					Cookie: 'private=cookie',
					'If-Range': '"fixture-etag"',
					Origin: 'https://private.example.com',
					'Proxy-Authorization': 'Basic private',
					Range: 'bytes=2-5',
					Referer: 'https://private.example.com/path',
					'X-API-Key': 'private',
					'X-Auth-Token': 'private',
					'X-CSRF-Token': 'private',
					'X-Forwarded-For': '192.0.2.50',
					'X-Random-Header': 'private',
					'X-WP-Nonce': 'private',
				},
			},
		);
		assert.equal(missing.statusCode, 200);
		assert.equal(
			missing.body,
			'backend:/wp-content/uploads/new.futuremedia?cache=one%20two&size=large',
		);
		assert.equal(missing.headers['x-local-media-proxy'], 'origin');
		assert.equal(missing.headers['x-content-type-options'], 'nosniff');
		assert.equal(
			missing.headers['content-security-policy'],
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		assert.equal(missing.headers['content-type'], 'text/plain');
		assert.equal(missing.headers['content-disposition'], 'inline; filename="asset.futuremedia"');
		assert.equal(missing.headers['set-cookie'], undefined);
		assert.equal(backendRequests.length, 1);
		assert.equal(backendRequests[0].url, '/wp-content/uploads/new.futuremedia?cache=one%20two&size=large');
		assert.deepEqual(
			Object.keys(backendRequests[0].headers).sort(),
			['host', 'if-range', 'range', 'user-agent'],
		);
		assert.equal(backendRequests[0].headers.host, `example.com:${backendAddress.port}`);
		assert.equal(backendRequests[0].headers['user-agent'], ORIGIN_REQUEST_USER_AGENT);
		assert.equal(backendRequests[0].headers.range, 'bytes=2-5');
		assert.equal(backendRequests[0].headers['if-range'], '"fixture-etag"');

		const notFound = await request(frontendPort, '/wp-content/uploads/not-found.futuremedia');
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

		const beforeRawNormalization = backendRequests.length;
		for (const unsafePath of [
			'//wp-content/uploads/unsafe.futuremedia',
			'/x/../wp-content/uploads/unsafe.futuremedia',
			'/%2fwp-content/uploads/unsafe.futuremedia',
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

		const beforeBlocked = backendRequests.length;
		for (const blockedPath of [
			'/wp-content/uploads/shell.PHP.jpg',
			'/wp-content/uploads/app.js',
			'/wp-content/uploads/index.html',
			'/wp-content/uploads/index.html.futuremedia',
			'/wp-content/uploads/app.js.futuremedia',
			'/wp-content/uploads/program.wasm.futuremedia',
		]) {
			const blocked = await request(frontendPort, blockedPath);
			assert.equal(blocked.statusCode, 404, blockedPath);
			assert.equal(backendRequests.length, beforeBlocked, blockedPath);
		}

		for (const [extension, contentType] of Object.entries(contentTypes)) {
			const ranged = await request(frontendPort, `/wp-content/uploads/range.${extension}`, {
				headers: {
					Authorization: 'Bearer private',
					Cookie: 'private=cookie',
					'If-Range': '"fixture-etag"',
					Range: 'bytes=2-5',
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
			assert.equal(ranged.headers['set-cookie'], undefined, extension);
			assert.equal(backendRequests.at(-1).headers.range, 'bytes=2-5', extension);
			assert.equal(backendRequests.at(-1).headers['if-range'], '"fixture-etag"', extension);
			assert.equal(backendRequests.at(-1).headers.authorization, undefined, extension);
			assert.equal(backendRequests.at(-1).headers.cookie, undefined, extension);

			const unsatisfied = await request(frontendPort, `/wp-content/uploads/range.${extension}`, {
				headers: { Range: 'bytes=99-' },
			});
			assert.equal(unsatisfied.statusCode, 416, extension);
			assert.equal(unsatisfied.body, '', extension);
			assert.equal(unsatisfied.headers['content-range'], 'bytes */10', extension);
			assert.equal(unsatisfied.headers['content-type'], contentType, extension);
			assert.equal(unsatisfied.headers['x-local-media-proxy'], 'origin', extension);
			assert.equal(unsatisfied.headers['x-content-type-options'], 'nosniff', extension);
			assert.equal(unsatisfied.headers['set-cookie'], undefined, extension);

			const head = await request(frontendPort, `/wp-content/uploads/head.${extension}`, {
				method: 'HEAD',
			});
			assert.equal(head.statusCode, 200, extension);
			assert.equal(head.body, '', extension);
			assert.equal(head.headers['content-length'], '10', extension);
			assert.equal(head.headers['accept-ranges'], 'bytes', extension);
			assert.equal(head.headers['content-type'], contentType, extension);
			assert.equal(head.headers['content-disposition'], `inline; filename="asset.${extension}"`, extension);
			assert.equal(head.headers['x-local-media-proxy'], 'origin', extension);
			assert.equal(head.headers['x-content-type-options'], 'nosniff', extension);
			assert.equal(head.headers['set-cookie'], undefined, extension);
			assert.equal(backendRequests.at(-1).method, 'HEAD', extension);
		}
	} finally {
		if (nginx && nginx.exitCode === null) {
			nginx.kill('SIGTERM');
			await once(nginx, 'exit');
		}
		if (backend.listening) {
			backend.close();
			await once(backend, 'close');
		}
		await fs.rm(root, { force: true, recursive: true });
	}
});
