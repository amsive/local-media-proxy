/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	normalizeStoredSettings,
	originPairMatches,
	serializeStoredSettings,
} = require('../lib/settings');
const { validateAndNormalizeOrigin } = require('../lib/validation');

test('loads legacy productionUrl settings as Site URL settings', () => {
	assert.deepEqual(
		normalizeStoredSettings({
			enabled: true,
			originIp: '192.0.2.10',
			productionUrl: 'https://legacy.example.com',
		}),
		{
			certificate: undefined,
			enabled: true,
			lastOriginStatus: undefined,
			lastVerifiedAt: undefined,
			originEnvironment: undefined,
			originIp: '192.0.2.10',
			originSource: undefined,
			originTlsHostname: undefined,
			originWpEngineInstallId: undefined,
			originWpEngineSiteId: undefined,
			resolvedAt: undefined,
			siteUrl: 'https://legacy.example.com',
		},
	);
});

test('prefers the current siteUrl while continuing to serialize the legacy key', () => {
	const settings = normalizeStoredSettings({
		enabled: false,
		originIp: '198.51.100.5',
		productionUrl: 'https://old.example.com',
		siteUrl: 'https://new.example.com',
	});

	assert.equal(settings.siteUrl, 'https://new.example.com');
	assert.deepEqual(serializeStoredSettings(settings), {
		...settings,
		productionUrl: 'https://new.example.com',
	});
});

test('preserves a stored TLS hostname so enabled validation can fail closed', () => {
	const settings = normalizeStoredSettings({
		enabled: true,
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originSource: 'wpengine',
		originTlsHostname: 'invalid.example/path',
		siteUrl: 'https://primary.example',
	});

	assert.equal(settings.originTlsHostname, 'invalid.example/path');
	assert.throws(() => validateAndNormalizeOrigin(settings), /bare valid hostname/);
});

test('loads only bounded main-owned WP Engine provenance identifiers', () => {
	const settings = normalizeStoredSettings({
		originWpEngineInstallId: ' install-id ',
		originWpEngineSiteId: 'site-id',
	});
	assert.equal(settings.originWpEngineInstallId, 'install-id');
	assert.equal(settings.originWpEngineSiteId, 'site-id');
	assert.equal(normalizeStoredSettings({
		originWpEngineInstallId: 'x'.repeat(257),
	}).originWpEngineInstallId, undefined);
});

test('preserves verification only when the URL and IP pair is unchanged', () => {
	const saved = {
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originTlsHostname: 'origin.example.com',
		siteUrl: 'https://example.com',
	};
	assert.equal(originPairMatches(saved, { ...saved }), true);
	assert.equal(originPairMatches(saved, { ...saved, siteUrl: 'https://example.com/' }), true);
	assert.equal(originPairMatches(saved, { ...saved, originIp: '192.0.2.11' }), false);
	assert.equal(originPairMatches(saved, { ...saved, siteUrl: 'https://staging.example.com' }), false);
	assert.equal(originPairMatches(saved, { ...saved, originTlsHostname: 'other.example.com' }), false);
	assert.equal(originPairMatches(saved, { ...saved, originEnvironment: 'staging' }), false);
});
