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
	const backend = http.createServer((incoming, response) => {
		backendRequests.push({
			headers: incoming.headers,
			method: incoming.method,
			url: incoming.url,
		});
		response.statusCode = incoming.url.includes('not-found') ? 404 : 200;
		response.setHeader('Content-Type', 'text/plain');
		response.setHeader('Set-Cookie', 'origin_session=private; HttpOnly');
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
		await fs.writeFile(path.join(uploads, 'local.JPG'), 'local-body');

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

		const missing = await request(frontendPort, '/wp-content/uploads/missing.JPG', {
			headers: {
				Authorization: 'Bearer private',
				Cookie: 'private=cookie',
				'Proxy-Authorization': 'Basic private',
				'X-API-Key': 'private',
				'X-Auth-Token': 'private',
				'X-CSRF-Token': 'private',
				'X-Forwarded-For': '192.0.2.50',
				'X-WP-Nonce': 'private',
			},
		});
		assert.equal(missing.statusCode, 200);
		assert.equal(missing.body, 'backend:/wp-content/uploads/missing.JPG');
		assert.equal(missing.headers['x-local-media-proxy'], 'origin');
		assert.equal(missing.headers['x-content-type-options'], 'nosniff');
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

		const blockedMethod = await request(frontendPort, '/wp-content/uploads/method.JPG', {
			body: 'blocked',
			headers: { 'Content-Length': '7' },
			method: 'POST',
		});
		assert.equal(blockedMethod.statusCode, 405);
		assert.equal(backendRequests.length, 2);

		const blockedBody = await request(frontendPort, '/wp-content/uploads/body.JPG', {
			body: 'blocked',
			headers: { 'Content-Length': '7' },
		});
		assert.equal(blockedBody.statusCode, 400);
		assert.equal(backendRequests.length, 2);

		const blockedChunkedBody = await request(frontendPort, '/wp-content/uploads/chunked.JPG', {
			body: 'blocked',
			headers: { 'Transfer-Encoding': 'chunked' },
		});
		assert.equal(blockedChunkedBody.statusCode, 400);
		assert.equal(backendRequests.length, 2);

		for (const unsafePath of [
			'/wp-content/uploads/%252e%252e/secret.JPG',
			'/wp-content/uploads/a%252fb.JPG',
			'/wp-content/uploads/photo%2541.JPG',
		]) {
			const blocked = await request(frontendPort, unsafePath);
			assert.equal(blocked.statusCode, 400, unsafePath);
			assert.equal(backendRequests.length, 2, unsafePath);
		}
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
