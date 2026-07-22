/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const test = require('node:test');
const selfsigned = require('selfsigned');
const {
	originResponseOutcome,
	originProbeErrorReason,
	probeOrigin,
	trustedCertificateAuthoritiesPem,
} = require('../lib/origin');
const { ORIGIN_REQUEST_USER_AGENT } = require('../lib/constants');
const { validateAndNormalizeOrigin } = require('../lib/validation');

test('classifies only 2xx responses as verified', () => {
	assert.equal(originResponseOutcome(200), 'success');
	assert.equal(originResponseOutcome(204), 'success');
	assert.equal(originResponseOutcome(301), 'warning');
	assert.equal(originResponseOutcome(401), 'warning');
	assert.equal(originResponseOutcome(500), 'warning');
});

test('uses Site URL-only error context for Apache hostname mode', () => {
	const origin = validateAndNormalizeOrigin({
		originIp: '',
		siteUrl: 'https://media.example.com:8443',
	}, { requiresOriginIp: false });
	const refused = new Error('refused');
	refused.code = 'ECONNREFUSED';
	const message = originProbeErrorReason(refused, origin);
	assert.match(message, /Site URL https:\/\/media\.example\.com:8443 refused/);
	assert.doesNotMatch(message, /Remote IP/);
});

test('classifies probe failures into safe workflow-aware messages', () => {
	const secureOrigin = validateAndNormalizeOrigin({
		originIp: '192.0.2.10',
		siteUrl: 'https://example.com',
	});
	const wpEngineOrigin = validateAndNormalizeOrigin({
		originEnvironment: 'production',
		originIp: '2001:db8::10',
		originSource: 'wpengine',
		originTlsHostname: 'example-production.wpengine.com',
		siteUrl: 'https://example.com:8443',
	});
	const insecureOrigin = validateAndNormalizeOrigin({
		originIp: '198.51.100.20',
		siteUrl: 'http://example.com:8080',
	});
	const cases = [
		{
			code: 'EPROTO',
			expected: 'The HTTPS handshake failed for Site URL https://example.com and Remote IP address 192.0.2.10. Check that the address serves this hostname over HTTPS.',
			name: 'TLS or SNI handshake',
			origin: secureOrigin,
		},
		{
			code: 'ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME',
			expected: 'The HTTPS handshake failed for Site URL https://example.com and Remote IP address 192.0.2.10. Check that the address serves this hostname over HTTPS.',
			name: 'unrecognized SNI hostname',
			origin: secureOrigin,
		},
		{
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
			expected: 'The HTTPS certificate for Site URL https://example.com:8443 and Remote IP address [2001:db8::10]:8443 does not match the expected hostname. Check that both fields identify the same site.',
			name: 'certificate hostname mismatch',
			origin: wpEngineOrigin,
		},
		{
			code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
			expected: 'The HTTPS certificate for Site URL https://example.com and Remote IP address 192.0.2.10 is not trusted. Check the certificate chain on the remote server.',
			name: 'self-signed certificate',
			origin: secureOrigin,
		},
		{
			code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			expected: 'The HTTPS certificate for Site URL https://example.com and Remote IP address 192.0.2.10 is not trusted. Check the certificate chain on the remote server.',
			name: 'incomplete certificate chain',
			origin: secureOrigin,
		},
		{
			code: 'CERT_HAS_EXPIRED',
			expected: 'The HTTPS certificate for Site URL https://example.com and Remote IP address 192.0.2.10 has expired. Renew the remote certificate before trying again.',
			name: 'expired certificate',
			origin: secureOrigin,
		},
		{
			code: 'CERT_NOT_YET_VALID',
			expected: "The HTTPS certificate for Site URL https://example.com and Remote IP address 192.0.2.10 is not valid yet. Check the remote certificate dates and this computer's clock.",
			name: 'not-yet-valid certificate',
			origin: secureOrigin,
		},
		{
			code: 'ECONNREFUSED',
			expected: 'Remote IP address 198.51.100.20:8080 refused the connection for Site URL http://example.com:8080. Check that the address and port accept HTTP connections.',
			name: 'refused connection',
			origin: insecureOrigin,
		},
		{
			code: 'EHOSTUNREACH',
			expected: 'Remote IP address 192.0.2.10 is unreachable for Site URL https://example.com. Check the address and network access.',
			name: 'unreachable host',
			origin: secureOrigin,
		},
		{
			code: 'ENETUNREACH',
			expected: 'Remote IP address [2001:db8::10]:8443 is unreachable for Site URL https://example.com:8443. Check the address and network access.',
			name: 'unreachable network',
			origin: wpEngineOrigin,
		},
		{
			code: 'ECONNRESET',
			expected: 'The connection for Site URL https://example.com and Remote IP address 192.0.2.10 was reset before the check completed. Try again or check the remote server.',
			name: 'reset connection',
			origin: secureOrigin,
		},
		{
			code: 'ETIMEDOUT',
			expected: 'Connection timed out for Site URL https://example.com and Remote IP address 192.0.2.10. Check the address, port, and network access.',
			name: 'operating-system timeout',
			origin: secureOrigin,
		},
		{
			code: 'EUNKNOWN',
			expected: 'Could not reach Site URL https://example.com and Remote IP address 192.0.2.10. Check both fields and try again.',
			name: 'unknown failure',
			origin: secureOrigin,
		},
	];

	for (const entry of cases) {
		const technicalError = Object.assign(
			new Error('BoringSSL failure at /build/ssl.cc; DNS:private.example.com, DNS:other.example.com'),
			{ code: entry.code },
		);
		const message = originProbeErrorReason(technicalError, entry.origin);

		assert.equal(message, entry.expected, entry.name);
		assert.doesNotMatch(message, /BoringSSL|\/build\/|DNS:|private\.example|E[A-Z_]{3,}/, entry.name);
		assert.doesNotMatch(message, /example-production\.wpengine\.com/, entry.name);
	}
});

test('builds a trust bundle from standard and published origin CA roots', () => {
	const pem = trustedCertificateAuthoritiesPem();
	const certificates = pem.match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
	) || [];
	const fingerprints = certificates.map(
		(certificate) => new X509Certificate(certificate).fingerprint256,
	);
	assert.ok(certificates.length > 100);
	assert.ok(certificates.length <= 256);
	assert.ok(Buffer.byteLength(pem, 'utf8') <= 512 * 1024);
	assert.equal(new Set(fingerprints).size, certificates.length);
	assert.equal(trustedCertificateAuthoritiesPem(), pem);
	assert.match(pem, /END CERTIFICATE/);
});

test('uses a fixed non-visitor-identifying User-Agent for connection checks', async (context) => {
	let receivedUserAgent;
	const server = http.createServer((request, response) => {
		receivedUserAgent = request.headers['user-agent'];
		response.writeHead(receivedUserAgent === ORIGIN_REQUEST_USER_AGENT ? 200 : 403);
		response.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `http://localhost:${address.port}`,
	});
	const result = await probeOrigin(origin);

	assert.equal(result.statusCode, 200);
	assert.equal(receivedUserAgent, ORIGIN_REQUEST_USER_AGENT);
});

test('bundles the exact published Cloudflare Origin CA trust anchors', () => {
	const bundle = fs.readFileSync(
		path.resolve(__dirname, '../resources/cloudflare-origin-ca.pem'),
		'utf8',
	);
	const certificates = bundle.match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
	) || [];
	const fingerprints = certificates
		.map((certificate) => new X509Certificate(certificate).fingerprint256)
		.sort();

	assert.deepEqual(fingerprints, [
		'AA:63:69:7A:22:76:4B:67:B2:13:4C:E1:4C:B5:69:0E:A3:36:94:0B:93:98:61:13:F4:95:45:91:78:32:D8:0D',
		'D3:C7:E8:5C:91:70:7F:C0:A1:2A:BC:5D:88:26:67:47:AA:4F:A8:E7:B1:62:F6:33:FF:B3:C9:D9:89:94:76:20',
	].sort());

	const trustedFingerprints = (
		trustedCertificateAuthoritiesPem().match(
			/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
		) || []
	).map((certificate) => new X509Certificate(certificate).fingerprint256);
	for (const fingerprint of fingerprints) {
		assert.equal(
			trustedFingerprints.filter((candidate) => candidate === fingerprint).length,
			1,
		);
	}
});

test('rejects an arbitrary matching-host self-signed certificate', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: 'localhost' }],
		{
			days: 1,
			extensions: [{
				altNames: [{ type: 2, value: 'localhost' }],
				name: 'subjectAltName',
			}],
			keySize: 2048,
		},
	);
	const server = https.createServer({ cert: credentials.cert, key: credentials.private });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `https://localhost:${address.port}`,
	});
	await assert.rejects(probeOrigin(origin), (error) => {
		assert.match(error.message, /HTTPS certificate .* is not trusted/);
		assert.doesNotMatch(error.message, /self-signed/i);
		assert.match(error.cause?.message ?? '', /self-signed certificate/i);
		return true;
	});
});

test('verifies two consecutive probes without reusing stale TLS state', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: 'localhost' }],
		{
			days: 1,
			extensions: [
				{ cA: true, name: 'basicConstraints' },
				{
					altNames: [{ type: 2, value: 'localhost' }],
					name: 'subjectAltName',
				},
			],
			keySize: 2048,
		},
	);
	const server = https.createServer({ cert: credentials.cert, key: credentials.private }, (_request, response) => {
		response.writeHead(200);
		response.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `https://localhost:${address.port}`,
	});
	const lfCertificate = credentials.cert.replace(/\r\n/g, '\n');
	const crlfCertificate = lfCertificate.replace(/\n/g, '\r\n');
	const first = await probeOrigin(origin, {
		certificateAuthorities: [lfCertificate, crlfCertificate],
	});
	const second = await probeOrigin(origin, {
		certificateAuthorities: [crlfCertificate, lfCertificate],
	});

	assert.equal(first.statusCode, 200);
	assert.equal(second.statusCode, 200);
	assert.equal(first.certificate?.fingerprint256, second.certificate?.fingerprint256);
	assert.equal(first.trustedCertificateAuthoritiesPem, second.trustedCertificateAuthoritiesPem);
	assert.equal(first.trustedCertificateAuthoritiesPem.includes('\r'), false);
	assert.equal(
		(first.trustedCertificateAuthoritiesPem.match(/BEGIN CERTIFICATE/g) || []).length,
		1,
	);
});

test('verifies a WP Engine TLS hostname while retaining the primary-domain Host header', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: 'origin.wpengine.com' }],
		{
			days: 1,
			extensions: [
				{ cA: true, name: 'basicConstraints' },
				{
					altNames: [{ type: 2, value: 'origin.wpengine.com' }],
					name: 'subjectAltName',
				},
			],
			keySize: 2048,
		},
	);
	let receivedHost;
	let receivedServername;
	let receivedUserAgent;
	const server = https.createServer({ cert: credentials.cert, key: credentials.private }, (request, response) => {
		receivedHost = request.headers.host;
		receivedServername = request.socket.servername;
		receivedUserAgent = request.headers['user-agent'];
		response.writeHead(200);
		response.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originEnvironment: 'production',
		originIp: '127.0.0.1',
		originSource: 'wpengine',
		originTlsHostname: 'origin.wpengine.com',
		siteUrl: `https://primary.example:${address.port}`,
	});
	const result = await probeOrigin(origin, { certificateAuthorities: [credentials.cert] });

	assert.equal(result.statusCode, 200);
	assert.equal(receivedHost, `primary.example:${address.port}`);
	assert.equal(receivedServername, 'origin.wpengine.com');
	assert.equal(receivedUserAgent, ORIGIN_REQUEST_USER_AGENT);
});

test('rejects malformed or excessive trusted certificate authority input before connecting', async () => {
	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: 'https://localhost:1',
	});

	await assert.rejects(
		probeOrigin(origin, { certificateAuthorities: ['not a certificate'] }),
		(error) => {
			assert.match(error.message, /Could not reach Site URL/);
			assert.doesNotMatch(error.message, /certificate authority entry/i);
			assert.match(error.cause?.message ?? '', /trusted certificate authority entry is invalid/i);
			return true;
		},
	);
	await assert.rejects(
		probeOrigin(origin, { certificateAuthorities: ['x'.repeat(1024 * 1024 + 1)] }),
		(error) => {
			assert.match(error.message, /Could not reach Site URL/);
			assert.doesNotMatch(error.message, /safe limits/i);
			assert.match(error.cause?.message ?? '', /trusted certificate authority bundle exceeds safe limits/i);
			return true;
		},
	);
});

test('rejects a primary-domain certificate when WP Engine TLS identity requires the CNAME', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: 'primary.example' }],
		{
			days: 1,
			extensions: [
				{ cA: true, name: 'basicConstraints' },
				{
					altNames: [{ type: 2, value: 'primary.example' }],
					name: 'subjectAltName',
				},
			],
			keySize: 2048,
		},
	);
	const server = https.createServer({ cert: credentials.cert, key: credentials.private });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originEnvironment: 'production',
		originIp: '127.0.0.1',
		originSource: 'wpengine',
		originTlsHostname: 'origin.wpengine.com',
		siteUrl: `https://primary.example:${address.port}`,
	});
	await assert.rejects(
		probeOrigin(origin, { certificateAuthorities: [credentials.cert] }),
		(error) => {
			assert.match(error.message, /does not match the expected hostname/);
			assert.doesNotMatch(error.message, /altnames|origin\.wpengine\.com/i);
			assert.match(error.cause?.message ?? '', /not in the cert's altnames/i);
			return true;
		},
	);
});

test('uses a wall-clock deadline and reports a human-readable timeout', async (context) => {
	const server = http.createServer(() => {
		// Accept the request without returning headers to simulate a stalled origin.
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `http://localhost:${address.port}`,
	});
	const startedAt = Date.now();
	await assert.rejects(probeOrigin(origin, { timeoutMs: 40 }), (error) => {
		assert.match(error.message, /Connection timed out after 0\.04 seconds\./);
		assert.match(error.message, /Site URL .* Remote IP address/);
		assert.ok(error.cause instanceof Error);
		return true;
	});
	assert.ok(Date.now() - startedAt < 1_000);
});

test('humanizes an operating-system ETIMEDOUT error code', () => {
	const error = Object.assign(
		new Error('connect ETIMEDOUT 192.0.2.10:443'),
		{ code: 'ETIMEDOUT' },
	);
	assert.equal(originProbeErrorReason(error), 'Connection timed out.');
});

test('cancels a stalled origin probe without waiting for its deadline', async (context) => {
	const server = http.createServer(() => {
		// Keep the request open until the client aborts it.
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `http://localhost:${address.port}`,
	});
	const controller = new AbortController();
	const probe = probeOrigin(origin, { signal: controller.signal });
	setTimeout(() => controller.abort(), 30);

	await assert.rejects(probe, (error) => {
		assert.equal(error.message, 'Connection test stopped.');
		assert.ok(error.cause instanceof Error);
		return true;
	});
});

test('does not connect when a probe signal is already aborted', async (context) => {
	let connections = 0;
	const server = http.createServer((_request, response) => response.end());
	server.on('connection', () => {
		connections += 1;
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const controller = new AbortController();
	controller.abort();
	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `http://localhost:${address.port}`,
	});
	await assert.rejects(
		probeOrigin(origin, { signal: controller.signal }),
		(error) => {
			assert.equal(error.message, 'Connection test stopped.');
			assert.ok(error.cause instanceof Error);
			return true;
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(connections, 0);
});

test('retries a chain-valid manual WP Engine origin with a verified provider TLS name', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: '*.wpengine.com' }],
		{
			days: 1,
			extensions: [
				{ cA: true, name: 'basicConstraints' },
				{
					altNames: [{ type: 2, value: '*.wpengine.com' }],
					name: 'subjectAltName',
				},
			],
			keySize: 2048,
		},
	);
	let receivedHost;
	let receivedServername;
	const server = https.createServer({ cert: credentials.cert, key: credentials.private }, (request, response) => {
		receivedHost = request.headers.host;
		receivedServername = request.socket.servername;
		response.writeHead(200);
		response.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		originSource: 'manual',
		siteUrl: `https://primary.example:${address.port}`,
	});
	const result = await probeOrigin(origin, { certificateAuthorities: [credentials.cert] });

	assert.equal(result.statusCode, 200);
	assert.equal(result.verifiedTlsHostname, 'origin.wpengine.com');
	assert.equal(receivedHost, `primary.example:${address.port}`);
	assert.equal(receivedServername, 'origin.wpengine.com');
});

test('does not use the WP Engine fallback for an unrelated trusted certificate', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: 'unrelated.example' }],
		{
			days: 1,
			extensions: [
				{ cA: true, name: 'basicConstraints' },
				{
					altNames: [{ type: 2, value: 'unrelated.example' }],
					name: 'subjectAltName',
				},
			],
			keySize: 2048,
		},
	);
	const server = https.createServer({ cert: credentials.cert, key: credentials.private });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `https://primary.example:${address.port}`,
	});
	await assert.rejects(
		probeOrigin(origin, { certificateAuthorities: [credentials.cert] }),
		(error) => {
			assert.match(error.message, /does not match the expected hostname/);
			assert.doesNotMatch(error.message, /altnames|unrelated\.example/i);
			assert.match(error.cause?.message ?? '', /not in the cert's altnames/i);
			return true;
		},
	);
});

test('does not use the WP Engine fallback for an untrusted wildcard certificate', async (context) => {
	const credentials = await selfsigned.generate(
		[{ name: 'commonName', value: '*.wpengine.com' }],
		{
			days: 1,
			extensions: [{
				altNames: [{ type: 2, value: '*.wpengine.com' }],
				name: 'subjectAltName',
			}],
			keySize: 2048,
		},
	);
	const server = https.createServer({ cert: credentials.cert, key: credentials.private });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, 'object');

	const origin = validateAndNormalizeOrigin({
		originIp: '127.0.0.1',
		siteUrl: `https://primary.example:${address.port}`,
	});
	await assert.rejects(probeOrigin(origin), (error) => {
		assert.match(error.message, /HTTPS certificate .* is not trusted/);
		assert.doesNotMatch(error.message, /self-signed/i);
		assert.match(error.cause?.message ?? '', /self-signed certificate/i);
		return true;
	});
});
