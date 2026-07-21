/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	siteUrlsAreEquivalent,
	sanitizeDisabledSettings,
	validateAndNormalizeOrigin,
	validateAndNormalizeSiteUrl,
	validateSettingsInput,
} = require('../lib/validation');

test('normalizes a secure site origin and IPv4 address', () => {
	assert.deepEqual(
		validateAndNormalizeOrigin({
			originIp: ' 192.0.2.10 ',
			siteUrl: 'HTTPS://Example-Site.WPEngine.com/',
		}),
		{
			hostHeader: 'example-site.wpengine.com',
			hostname: 'example-site.wpengine.com',
			originIp: '192.0.2.10',
			port: 443,
			siteUrl: 'https://example-site.wpengine.com',
			protocol: 'https:',
			tlsHostname: 'example-site.wpengine.com',
		},
	);
});

test('separates a WP Engine Site URL from its validated TLS hostname', () => {
	assert.deepEqual(
		validateAndNormalizeOrigin({
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'Example-Production.WPEngine.com.',
			siteUrl: 'https://example-production.example.com',
		}),
		{
			hostHeader: 'example-production.example.com',
			hostname: 'example-production.example.com',
			originIp: '192.0.2.10',
			port: 443,
			protocol: 'https:',
			siteUrl: 'https://example-production.example.com',
			tlsHostname: 'example-production.wpengine.com',
		},
	);
});

test('allows only the verified WP Engine fallback identity for manual origins', () => {
	assert.deepEqual(
		validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://media.example.com',
		}),
		{
			hostHeader: 'media.example.com',
			hostname: 'media.example.com',
			originIp: '192.0.2.10',
			port: 443,
			protocol: 'https:',
			siteUrl: 'https://media.example.com',
			tlsHostname: 'origin.wpengine.com',
		},
	);
	assert.throws(
		() => validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'example-staging.wpengine.com',
			siteUrl: 'https://media.example.com',
		}),
		/only the verified WP Engine TLS fallback hostname/,
	);
	assert.throws(
		() => validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'http://media.example.com',
		}),
		/requires an HTTPS Site URL/,
	);
});

test('requires fresh WP Engine metadata for a custom Site URL missing its TLS hostname', () => {
	assert.throws(
		() => validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			siteUrl: 'https://example-production.example.com',
		}),
		/fresh auto-population/,
	);
	assert.equal(
		validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			siteUrl: 'https://example-production.wpengine.com',
		}).tlsHostname,
		'example-production.wpengine.com',
	);
});

test('treats Site URLs with and without a trailing slash identically', () => {
	assert.deepEqual(
		validateAndNormalizeSiteUrl('https://example.com'),
		validateAndNormalizeSiteUrl('https://example.com/'),
	);
	assert.equal(siteUrlsAreEquivalent('https://example.com', 'https://example.com/'), true);
	assert.equal(siteUrlsAreEquivalent('https://example.com', 'https://staging.example.com/'), false);
	assert.equal(siteUrlsAreEquivalent('https://example.com', 'https://example.com/path'), false);
});

test('supports explicit ports and bracketed IPv6 origin addresses', () => {
	const normalized = validateAndNormalizeOrigin({
		originIp: '[2001:db8::10]',
		siteUrl: 'https://media.example.com:8443',
	});

	assert.equal(normalized.hostHeader, 'media.example.com:8443');
	assert.equal(normalized.originIp, '2001:db8::10');
	assert.equal(normalized.port, 8443);
});

for (const [name, input, expected] of [
	['credentials', { originIp: '192.0.2.1', siteUrl: 'https://user:pass@example.com' }, /username or password/],
	['path', { originIp: '192.0.2.1', siteUrl: 'https://example.com/uploads' }, /without a path/],
	['query', { originIp: '192.0.2.1', siteUrl: 'https://example.com/?x=1' }, /without a path/],
	['unsupported protocol', { originIp: '192.0.2.1', siteUrl: 'ftp://example.com' }, /HTTP or HTTPS/],
	['invalid hostname', { originIp: '192.0.2.1', siteUrl: 'https://bad_host.example' }, /valid hostname/],
	['invalid IP', { originIp: 'origin.example.com', siteUrl: 'https://example.com' }, /valid IPv4 or IPv6/],
]) {
	test(`rejects ${name}`, () => {
		assert.throws(() => validateAndNormalizeOrigin(input), expected);
	});
}

test('disabling never requires valid origin settings', () => {
	assert.deepEqual(
		sanitizeDisabledSettings({ originIp: 'not-an-ip', siteUrl: 'draft' }),
		{ enabled: false, originIp: 'not-an-ip', siteUrl: 'draft' },
	);
	assert.deepEqual(
		sanitizeDisabledSettings({
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'Example-Production.WPEngine.com.',
			siteUrl: 'https://example-production.example.com',
		}),
		{
			enabled: false,
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'example-production.wpengine.com',
			siteUrl: 'https://example-production.example.com',
		},
	);
	assert.deepEqual(
		sanitizeDisabledSettings({
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://media.example.com',
		}),
		{
			enabled: false,
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://media.example.com',
		},
	);
});

test('validates the renderer settings envelope and sanitizes discovery metadata', () => {
	assert.throws(
		() => validateSettingsInput({
			enabled: 'false',
			originIp: '',
			siteUrl: '',
		}),
		/enabled setting must be true or false/,
	);

	assert.deepEqual(validateSettingsInput({
		enabled: false,
		originIp: '',
		originSource: ['wpengine'],
		resolvedAt: 'x'.repeat(100),
		siteUrl: '',
	}), {
		enabled: false,
		originIp: '',
		siteUrl: '',
	});

	const resolvedAt = '2026-07-16T21:00:00.000Z';
	assert.deepEqual(validateSettingsInput({
		enabled: true,
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originSource: 'wpengine',
		originTlsHostname: 'example-production.wpengine.com',
		resolvedAt,
		siteUrl: 'https://example-production.example.com',
	}), {
		enabled: true,
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originSource: 'wpengine',
		originTlsHostname: 'example-production.wpengine.com',
		resolvedAt,
		siteUrl: 'https://example-production.example.com',
	});
	assert.throws(
		() => validateSettingsInput({
			enabled: true,
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'example-production.wpengine.com',
			siteUrl: 'https://example-production.example.com',
		}),
		/auto-population again/,
	);

	assert.throws(
		() => validateSettingsInput({
			enabled: true,
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'example-production.wpengine.com',
			siteUrl: 'https://example-production.example.com',
		}),
		/only the verified WP Engine TLS fallback hostname/,
	);
	assert.deepEqual(
		validateSettingsInput({
			enabled: true,
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://media.example.com',
		}),
		{
			enabled: true,
			originIp: '192.0.2.10',
			originSource: 'manual',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://media.example.com',
		},
	);
	assert.throws(
		() => validateSettingsInput({
			enabled: true,
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'example-production.wpengine.com/path',
			siteUrl: 'https://example-production.example.com',
		}),
		/bare valid hostname/,
	);
	assert.throws(
		() => validateSettingsInput({
			enabled: true,
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'example-production.wpengine.com/',
			siteUrl: 'https://example-production.example.com',
		}),
		/bare valid hostname/,
	);
	assert.throws(
		() => validateSettingsInput({
			enabled: true,
			originEnvironment: 'production',
			originIp: '192.0.2.10',
			originSource: 'wpengine',
			originTlsHostname: 'unrelated.example.com',
			siteUrl: 'https://example-production.example.com',
		}),
		/WP Engine environment hostname/,
	);
	assert.deepEqual(
		validateSettingsInput({
			enabled: false,
			originEnvironment: 'production',
			originIp: 'draft',
			originSource: 'wpengine',
			originTlsHostname: 'invalid.example/path',
			siteUrl: 'draft',
		}),
		{
			enabled: false,
			originEnvironment: 'production',
			originIp: 'draft',
			originSource: 'wpengine',
			originTlsHostname: 'invalid.example/path',
			siteUrl: 'draft',
		},
	);
});
