/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	carrySiteUrlToPristineServerProfile,
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

test('carries only a canonical Site URL from Nginx into a pristine Apache profile', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		lastServerKind: 'nginx',
		profiles: {
			apache: {},
			nginx: {
				certificate: {
					fingerprint256: 'AA:BB',
					issuer: 'Example issuer',
					subject: 'Example subject',
					validTo: '2027-01-01T00:00:00.000Z',
				},
				lastOriginStatus: 200,
				lastVerifiedAt: '2026-08-01T12:00:00.000Z',
				originEnvironment: 'production',
				originIp: '192.0.2.20',
				originSource: 'wpengine',
				originTlsHostname: 'origin.wpengine.com',
				originWpEngineInstallId: 'install-id',
				originWpEngineSiteId: 'site-id',
				resolvedAt: '2026-08-01T11:00:00.000Z',
				siteUrl: 'HTTPS://MEDIA.EXAMPLE.COM:443/',
			},
		},
		schemaVersion: 2,
	});
	const carried = carrySiteUrlToPristineServerProfile(envelope, 'apache');

	assert.notStrictEqual(carried, envelope);
	assert.equal(carried.enabled, true);
	assert.equal(carried.lastServerKind, 'nginx');
	assert.deepEqual(carried.profiles.nginx, envelope.profiles.nginx);
	assert.deepEqual(carried.profiles.apache, {
		...envelope.profiles.apache,
		siteUrl: 'https://media.example.com',
	});
	assert.equal(
		validateAndNormalizeOrigin(
			storedSettingsForServer(carried, 'apache'),
			{ requiresOriginIp: false },
		).siteUrl,
		'https://media.example.com',
	);
});

test('carries only Site URL from Apache into pristine Nginx and still requires its own IP', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		lastServerKind: 'apache',
		profiles: {
			apache: {
				certificate: {
					fingerprint256: 'CC:DD',
					issuer: 'Example issuer',
					subject: 'Example subject',
					validTo: '2027-01-01T00:00:00.000Z',
				},
				lastOriginStatus: 206,
				lastVerifiedAt: '2026-08-02T12:00:00.000Z',
				originIp: '',
				siteUrl: 'https://files.example.com/',
			},
			nginx: {},
		},
		schemaVersion: 2,
	});
	const carried = carrySiteUrlToPristineServerProfile(envelope, 'nginx');

	assert.deepEqual(carried.profiles.apache, envelope.profiles.apache);
	assert.deepEqual(carried.profiles.nginx, {
		...envelope.profiles.nginx,
		siteUrl: 'https://files.example.com',
	});
	assert.throws(
		() => validateAndNormalizeOrigin(storedSettingsForServer(carried, 'nginx')),
		/Remote IP address must be a valid IPv4 or IPv6 address/,
	);
});

test('does not overwrite a v0.3.1-stamped blank current profile', () => {
	const envelope = normalizeStoredSettingsEnvelope({
		enabled: true,
		lastServerKind: 'apache',
		profiles: {
			apache: {},
			nginx: {
				originIp: '192.0.2.21',
				siteUrl: 'https://source.example.com',
			},
		},
		schemaVersion: 2,
	});

	assert.strictEqual(carrySiteUrlToPristineServerProfile(envelope, 'apache'), envelope);
	assert.equal(envelope.profiles.apache.siteUrl, '');
});

test('does not overwrite an intentionally cleared or otherwise non-pristine profile', () => {
	const nonPristineFields = {
		certificate: {
			fingerprint256: 'EE:FF',
			issuer: 'Example issuer',
			subject: 'Example subject',
			validTo: '2027-01-01T00:00:00.000Z',
		},
		lastOriginStatus: 404,
		lastVerifiedAt: '2026-08-01T12:00:00.000Z',
		originEnvironment: 'production',
		originIp: '198.51.100.10',
		originSource: 'manual',
		originTlsHostname: 'origin.wpengine.com',
		originWpEngineInstallId: 'install-id',
		originWpEngineSiteId: 'site-id',
		resolvedAt: '2026-08-01T11:00:00.000Z',
		siteUrl: 'https://configured.example.com',
	};

	for (const destination of ['apache', 'nginx']) {
		const source = destination === 'apache' ? 'nginx' : 'apache';
		for (const [field, value] of Object.entries(nonPristineFields)) {
			const envelope = normalizeStoredSettingsEnvelope({
				enabled: false,
				lastServerKind: source,
				profiles: {
					[destination]: { [field]: value },
					[source]: { siteUrl: 'https://source.example.com' },
				},
				schemaVersion: 2,
			});

			assert.strictEqual(
				carrySiteUrlToPristineServerProfile(envelope, destination),
				envelope,
				`${destination}.${field} must mark the profile as previously touched`,
			);
		}
	}
});

test('preserves an explicitly cleared destination across switch-away and switch-back', () => {
	const configured = normalizeStoredSettingsEnvelope({
		enabled: false,
		lastServerKind: 'apache',
		profiles: {
			apache: { siteUrl: 'https://configured.example.com' },
			nginx: {
				originIp: '192.0.2.40',
				originSource: 'manual',
				siteUrl: 'https://configured.example.com',
			},
		},
		schemaVersion: 2,
	});
	const cleared = replaceStoredSettingsForServer(configured, 'apache', {
		enabled: false,
		originIp: '',
		originSource: 'manual',
		siteUrl: '',
	});
	const switchedAway = setStoredSettingsLastServer(cleared, 'nginx');

	assert.equal(switchedAway.profiles.apache.siteUrl, '');
	assert.equal(switchedAway.profiles.apache.originSource, 'manual');
	assert.strictEqual(
		carrySiteUrlToPristineServerProfile(switchedAway, 'apache'),
		switchedAway,
	);
});

test('invalid source URLs and unrelated envelopes remain no-op identities', () => {
	for (const siteUrl of ['', 'not a URL', 'https://example.com/path', 'ftp://example.com']) {
		const envelope = normalizeStoredSettingsEnvelope({
			enabled: true,
			lastServerKind: 'nginx',
			profiles: {
				apache: {},
				nginx: { siteUrl },
			},
			schemaVersion: 2,
		});
		assert.strictEqual(carrySiteUrlToPristineServerProfile(envelope, 'apache'), envelope);
	}

	const siteA = normalizeStoredSettingsEnvelope({
		enabled: false,
		lastServerKind: 'nginx',
		profiles: {
			apache: {},
			nginx: { siteUrl: 'https://site-a.example.com' },
		},
		schemaVersion: 2,
	});
	const siteB = normalizeStoredSettingsEnvelope({
		enabled: false,
		lastServerKind: 'nginx',
		profiles: {
			apache: {},
			nginx: { siteUrl: 'https://site-b.example.com' },
		},
		schemaVersion: 2,
	});
	const siteABefore = structuredClone(siteA);
	const siteBBefore = structuredClone(siteB);

	assert.equal(
		carrySiteUrlToPristineServerProfile(siteA, 'apache').profiles.apache.siteUrl,
		'https://site-a.example.com',
	);
	assert.deepEqual(siteA, siteABefore);
	assert.deepEqual(siteB, siteBBefore);
	assert.equal(
		carrySiteUrlToPristineServerProfile(siteB, 'apache').profiles.apache.siteUrl,
		'https://site-b.example.com',
	);
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
