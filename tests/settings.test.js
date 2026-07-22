/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	fallbackStoredSettings,
	normalizeStoredSettings,
	normalizeStoredSettingsEnvelope,
	originPairMatches,
	replaceStoredSettingsForServer,
	serializeStoredSettings,
	serializeStoredSettingsEnvelope,
	setStoredSettingsEnabled,
	setStoredSettingsLastServer,
	storedSettingsEnvelopeNeedsMigration,
	storedSettingsForServer,
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

test('migrates a legacy Nginx record into only the Nginx connection profile', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		originIp: '192.0.2.10',
		productionUrl: 'https://legacy.example.com',
	}, 'apache');

	assert.equal(envelope.schemaVersion, 2);
	assert.equal(envelope.enabled, true);
	assert.equal(envelope.lastServerKind, 'nginx');
	assert.equal(envelope.profiles.nginx.originIp, '192.0.2.10');
	assert.equal(envelope.profiles.nginx.siteUrl, 'https://legacy.example.com');
	assert.equal(envelope.profiles.apache.originIp, '');
	assert.equal(envelope.profiles.apache.siteUrl, '');
	assert.equal('enabled' in envelope.profiles.nginx, false);
});

test('migrates an enabled URL-only legacy record into only the Apache connection profile', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		originIp: '',
		siteUrl: 'https://apache.example.com',
	}, 'nginx');

	assert.equal(envelope.enabled, true);
	assert.equal(envelope.lastServerKind, 'apache');
	assert.equal(envelope.profiles.apache.siteUrl, 'https://apache.example.com');
	assert.equal(envelope.profiles.nginx.siteUrl, '');
});

test('preserves an ambiguous disabled legacy draft in both profiles', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: false,
		originIp: '',
		siteUrl: 'https://draft.example.com',
	}, 'apache');

	assert.equal(envelope.enabled, false);
	assert.equal(envelope.lastServerKind, 'apache');
	assert.equal(envelope.profiles.apache.siteUrl, 'https://draft.example.com');
	assert.equal(envelope.profiles.nginx.siteUrl, 'https://draft.example.com');
});

test('duplicates an ambiguous disabled draft even when no server can be selected safely', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: false,
		originIp: '',
		siteUrl: 'https://draft.example.com',
	}, 'unsupported');

	assert.equal(envelope.lastServerKind, undefined);
	assert.equal(envelope.profiles.apache.siteUrl, 'https://draft.example.com');
	assert.equal(envelope.profiles.nginx.siteUrl, 'https://draft.example.com');
});

test('keeps empty settings in memory without turning reconciliation into a persistence write', () => {
	for (const raw of [undefined, null, false, 0, '', [], {}]) {
		const envelope = normalizeStoredSettingsEnvelope(raw, 'apache');
		const reconciled = setStoredSettingsLastServer(envelope, 'apache');

		assert.equal(envelope.enabled, false);
		assert.equal(envelope.lastServerKind, 'apache');
		assert.equal(envelope.profiles.apache.siteUrl, '');
		assert.equal(envelope.profiles.nginx.siteUrl, '');
		assert.equal(storedSettingsEnvelopeNeedsMigration(raw), false);
		assert.strictEqual(reconciled, envelope);
		assert.equal(
			reconciled !== envelope || storedSettingsEnvelopeNeedsMigration(raw),
			false,
			'empty input must not satisfy the reconciliation persistence gate',
		);
	}
});

test('continues to identify and reconcile real legacy settings', () => {
	const raw = {
		enabled: false,
		originIp: '',
		siteUrl: 'https://legacy.example.com',
	};
	const envelope = normalizeStoredSettingsEnvelope(raw, 'apache');
	const reconciled = setStoredSettingsLastServer(envelope, 'apache');

	assert.equal(storedSettingsEnvelopeNeedsMigration(raw), true);
	assert.equal(reconciled.profiles.apache.siteUrl, 'https://legacy.example.com');
	assert.equal(reconciled.profiles.nginx.siteUrl, 'https://legacy.example.com');
	assert.equal(
		reconciled !== envelope || storedSettingsEnvelopeNeedsMigration(raw),
		true,
		'legacy input must still satisfy the reconciliation persistence gate',
	);
});

test('normalizes partial v2 profiles and fails closed on unknown schema versions', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		lastServerKind: 'apache',
		profiles: {
			apache: { siteUrl: 'https://apache.example.com' },
		},
		schemaVersion: 2,
	});

	assert.equal(envelope.enabled, true);
	assert.equal(envelope.profiles.apache.siteUrl, 'https://apache.example.com');
	assert.equal(envelope.profiles.nginx.siteUrl, '');
	assert.throws(
		() => normalizeStoredSettingsEnvelope({ profiles: {}, schemaVersion: 3 }),
		/unsupported schema version/,
	);
	assert.throws(
		() => normalizeStoredSettingsEnvelope({ profiles: null, schemaVersion: 2 }),
		/connection profiles are invalid/,
	);
	assert.equal(storedSettingsEnvelopeNeedsMigration(envelope), false);
	assert.equal(storedSettingsEnvelopeNeedsMigration({ enabled: false }), true);
	assert.equal(storedSettingsEnvelopeNeedsMigration({ profiles: {}, schemaVersion: 3 }), true);
	assert.equal(storedSettingsEnvelopeNeedsMigration({}), false);
	assert.equal(storedSettingsEnvelopeNeedsMigration({ unrelated: true }), false);
});

test('selects and replaces one profile without allowing enabled intent to diverge', () => {
	const original = normalizeStoredSettingsEnvelope({
		enabled: false,
		lastServerKind: 'apache',
		profiles: {
			apache: { originIp: '', siteUrl: 'https://apache.example.com' },
			nginx: { originIp: '192.0.2.20', siteUrl: 'https://nginx.example.com' },
		},
		schemaVersion: 2,
	});
	const replaced = replaceStoredSettingsForServer(original, 'apache', {
		enabled: true,
		originIp: '',
		siteUrl: 'https://new-apache.example.com',
	});

	assert.equal(replaced.enabled, true);
	assert.equal(replaced.profiles.apache.siteUrl, 'https://new-apache.example.com');
	assert.deepEqual(replaced.profiles.nginx, original.profiles.nginx);
	assert.equal('enabled' in replaced.profiles.apache, false);
	assert.equal(storedSettingsForServer(replaced, 'apache').enabled, true);
	assert.equal(storedSettingsForServer(replaced, 'nginx').enabled, true);
	assert.equal(fallbackStoredSettings(replaced).siteUrl, 'https://new-apache.example.com');

	const disabled = setStoredSettingsEnabled(replaced, false);
	assert.equal(storedSettingsForServer(disabled, 'apache').enabled, false);
	assert.equal(storedSettingsForServer(disabled, 'nginx').enabled, false);
	assert.deepEqual(disabled.profiles, replaced.profiles);
});

test('serializes the v2 envelope with nested profiles and a legacy-readable active Nginx profile', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		lastServerKind: 'nginx',
		profiles: {
			apache: { originIp: '', siteUrl: 'https://apache.example.com' },
			nginx: { originIp: '192.0.2.30', siteUrl: 'https://nginx.example.com' },
		},
		schemaVersion: 2,
	});
	const serialized = serializeStoredSettingsEnvelope(envelope);

	assert.equal(serialized.schemaVersion, 2);
	assert.equal(serialized.enabled, true);
	assert.equal(serialized.siteUrl, 'https://nginx.example.com');
	assert.equal(serialized.productionUrl, 'https://nginx.example.com');
	assert.equal(serialized.originIp, '192.0.2.30');
	assert.equal(serialized.profiles.apache.productionUrl, 'https://apache.example.com');
	assert.equal(serialized.profiles.nginx.productionUrl, 'https://nginx.example.com');
	assert.equal('enabled' in serialized.profiles.apache, false);
	assert.equal('enabled' in serialized.profiles.nginx, false);
	assert.deepEqual(normalizeStoredSettings(serialized), {
		certificate: undefined,
		enabled: true,
		lastOriginStatus: undefined,
		lastVerifiedAt: undefined,
		originEnvironment: undefined,
		originIp: '192.0.2.30',
		originSource: undefined,
		originTlsHostname: undefined,
		originWpEngineInstallId: undefined,
		originWpEngineSiteId: undefined,
		resolvedAt: undefined,
		siteUrl: 'https://nginx.example.com',
	});
	assert.deepEqual(
		normalizeStoredSettingsEnvelope(serialized),
		envelope,
	);
});

test('mirrors the last Apache profile for legacy readers without changing nested profiles or intent', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: false,
		lastServerKind: 'apache',
		profiles: {
			apache: { originIp: '', siteUrl: 'https://apache.example.com' },
			nginx: { originIp: '192.0.2.31', siteUrl: 'https://nginx.example.com' },
		},
		schemaVersion: 2,
	});
	const serialized = serializeStoredSettingsEnvelope(envelope);
	const legacySettings = normalizeStoredSettings(serialized);

	assert.equal(legacySettings.enabled, false);
	assert.equal(legacySettings.siteUrl, 'https://apache.example.com');
	assert.equal(legacySettings.originIp, '');
	assert.equal(serialized.profiles.apache.siteUrl, 'https://apache.example.com');
	assert.equal(serialized.profiles.nginx.siteUrl, 'https://nginx.example.com');
	assert.equal(serialized.profiles.nginx.originIp, '192.0.2.31');
	assert.deepEqual(
		normalizeStoredSettingsEnvelope(serialized),
		envelope,
	);
});
