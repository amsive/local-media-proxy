/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_SETTINGS } from './constants';
import type {
	CertificateSummary,
	ServerKind,
	StoredConnectionProfile,
	StoredSettings,
	StoredSettingsEnvelope,
	SupportedServerKind,
} from './types';
import {
	sanitizeHostingEnvironment,
	sanitizeOriginSource,
	sanitizeResolvedAt,
	siteUrlComparisonKey,
	validateAndNormalizeSiteUrl,
} from './validation';

type RawStoredSettings = {
	certificate?: unknown;
	enabled?: unknown;
	lastOriginStatus?: unknown;
	lastVerifiedAt?: unknown;
	originIp?: unknown;
	originEnvironment?: unknown;
	originSource?: unknown;
	originTlsHostname?: unknown;
	originWpEngineInstallId?: unknown;
	originWpEngineSiteId?: unknown;
	productionUrl?: unknown;
	resolvedAt?: unknown;
	siteUrl?: unknown;
};

type RawStoredSettingsEnvelope = {
	enabled?: unknown;
	lastServerKind?: unknown;
	profiles?: unknown;
	schemaVersion?: unknown;
};

type SerializedConnectionProfile = StoredConnectionProfile & {
	productionUrl: string;
};

type SerializedFlatCompatibilitySettings = Omit<StoredSettings, 'enabled'> & {
	productionUrl: string;
};

export type SerializedSettingsEnvelope = Omit<StoredSettingsEnvelope, 'profiles'> &
	SerializedFlatCompatibilitySettings & {
	profiles: Record<SupportedServerKind, SerializedConnectionProfile>;
};

const LEGACY_SETTINGS_KEYS = [
	'certificate',
	'enabled',
	'lastOriginStatus',
	'lastVerifiedAt',
	'originEnvironment',
	'originIp',
	'originSource',
	'originTlsHostname',
	'originWpEngineInstallId',
	'originWpEngineSiteId',
	'productionUrl',
	'resolvedAt',
	'siteUrl',
] as const;

function readProviderIdentifier(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const identifier = value.trim();
	return identifier && identifier.length <= 256 ? identifier : undefined;
}

function readCertificateSummary(value: unknown): CertificateSummary | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Partial<CertificateSummary>;
	if (
		typeof candidate.fingerprint256 !== 'string' ||
		typeof candidate.issuer !== 'string' ||
		typeof candidate.subject !== 'string' ||
		typeof candidate.validTo !== 'string'
	) {
		return undefined;
	}

	return {
		fingerprint256: candidate.fingerprint256,
		issuer: candidate.issuer,
		subject: candidate.subject,
		validTo: candidate.validTo,
	};
}

export function normalizeStoredSettings(value: unknown): StoredSettings {
	const raw = value && typeof value === 'object' ? value as RawStoredSettings : {};
	const siteUrl = typeof raw.siteUrl === 'string'
		? raw.siteUrl
		: typeof raw.productionUrl === 'string'
			? raw.productionUrl
			: DEFAULT_SETTINGS.siteUrl;

	return {
		certificate: readCertificateSummary(raw.certificate),
		enabled: raw.enabled === true,
		lastOriginStatus: typeof raw.lastOriginStatus === 'number' &&
			Number.isInteger(raw.lastOriginStatus) &&
			raw.lastOriginStatus >= 100 &&
			raw.lastOriginStatus <= 599
			? raw.lastOriginStatus
			: undefined,
		lastVerifiedAt: sanitizeResolvedAt(raw.lastVerifiedAt),
		originEnvironment: sanitizeHostingEnvironment(raw.originEnvironment),
		originIp: typeof raw.originIp === 'string' ? raw.originIp : DEFAULT_SETTINGS.originIp,
		originSource: sanitizeOriginSource(raw.originSource),
		originTlsHostname: typeof raw.originTlsHostname === 'string' && raw.originTlsHostname.trim()
			? raw.originTlsHostname.trim()
			: undefined,
		originWpEngineInstallId: readProviderIdentifier(raw.originWpEngineInstallId),
		originWpEngineSiteId: readProviderIdentifier(raw.originWpEngineSiteId),
		resolvedAt: sanitizeResolvedAt(raw.resolvedAt),
		siteUrl,
	};
}

export function serializeStoredSettings(settings: StoredSettings): StoredSettings & {
	productionUrl: string;
} {
	return {
		...settings,
		productionUrl: settings.siteUrl,
	};
}

function sanitizeSupportedServerKind(value: unknown): SupportedServerKind | undefined {
	return value === 'apache' || value === 'nginx' ? value : undefined;
}

function connectionProfileFromSettings(settings: StoredSettings): StoredConnectionProfile {
	const { enabled: _enabled, ...profile } = settings;
	return profile;
}

function normalizeConnectionProfile(value: unknown): StoredConnectionProfile {
	return connectionProfileFromSettings(normalizeStoredSettings(value));
}

function defaultConnectionProfile(): StoredConnectionProfile {
	return normalizeConnectionProfile(undefined);
}

function serializeConnectionProfile(profile: StoredConnectionProfile): SerializedConnectionProfile {
	const { enabled: _enabled, ...serialized } = serializeStoredSettings({
		...profile,
		enabled: false,
	});
	return serialized;
}

function rawObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function storedSettingsEnvelopeNeedsMigration(value: unknown): boolean {
	const raw = rawObject(value);
	if (!raw || raw.schemaVersion === 2) {
		return false;
	}

	return hasLegacySettingsData(raw) ||
		Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') ||
		Object.prototype.hasOwnProperty.call(raw, 'profiles');
}

function hasLegacySettingsData(value: unknown): boolean {
	const raw = rawObject(value);
	return Boolean(raw && LEGACY_SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key)));
}

function legacyProfileKind(
	value: unknown,
	settings: StoredSettings,
): SupportedServerKind | undefined {
	const raw = rawObject(value);
	if (!raw || !hasLegacySettingsData(raw)) {
		return undefined;
	}

	if (
		settings.originIp.trim() ||
		settings.originEnvironment ||
		settings.originSource === 'dns' ||
		settings.originSource === 'wpengine' ||
		settings.originTlsHostname ||
		settings.originWpEngineInstallId ||
		settings.originWpEngineSiteId ||
		settings.resolvedAt ||
		(Object.prototype.hasOwnProperty.call(raw, 'productionUrl') &&
			!Object.prototype.hasOwnProperty.call(raw, 'siteUrl'))
	) {
		return 'nginx';
	}

	if (settings.enabled) {
		return 'apache';
	}

	return undefined;
}

function migrateLegacySettings(
	value: unknown,
	currentServerKind: ServerKind,
): StoredSettingsEnvelope {
	const settings = normalizeStoredSettings(value);
	const profile = connectionProfileFromSettings(settings);
	const profileKind = legacyProfileKind(value, settings);
	const hasLegacyData = hasLegacySettingsData(value);
	const hasAmbiguousDisabledProfile = hasLegacyData && !settings.enabled && !profileKind;
	const lastServerKind = profileKind ?? (
		hasAmbiguousDisabledProfile
			? sanitizeSupportedServerKind(currentServerKind)
			: !hasLegacyData
				? sanitizeSupportedServerKind(currentServerKind)
				: undefined
	);
	const profiles: Record<SupportedServerKind, StoredConnectionProfile> = {
		apache: defaultConnectionProfile(),
		nginx: defaultConnectionProfile(),
	};

	if (profileKind) {
		profiles[profileKind] = profile;
	} else if (hasAmbiguousDisabledProfile) {
		profiles.apache = { ...profile };
		profiles.nginx = { ...profile };
	}

	return {
		enabled: settings.enabled,
		...(lastServerKind ? { lastServerKind } : {}),
		profiles,
		schemaVersion: 2,
	};
}

export function normalizeStoredSettingsEnvelope(
	value: unknown,
	currentServerKind: ServerKind = 'unsupported',
): StoredSettingsEnvelope {
	const raw = rawObject(value) as RawStoredSettingsEnvelope | undefined;
	if (!raw || (raw.schemaVersion === undefined && raw.profiles === undefined)) {
		return migrateLegacySettings(value, currentServerKind);
	}
	if (raw.schemaVersion !== 2) {
		throw new Error('Saved media proxy settings use an unsupported schema version.');
	}
	if (!raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
		throw new Error('Saved media proxy connection profiles are invalid.');
	}

	const profiles = raw.profiles as Partial<Record<SupportedServerKind, unknown>>;
	return {
		enabled: raw.enabled === true,
		...(sanitizeSupportedServerKind(raw.lastServerKind)
			? { lastServerKind: sanitizeSupportedServerKind(raw.lastServerKind) }
			: {}),
		profiles: {
			apache: normalizeConnectionProfile(profiles.apache),
			nginx: normalizeConnectionProfile(profiles.nginx),
		},
		schemaVersion: 2,
	};
}

export function serializeStoredSettingsEnvelope(
	envelope: StoredSettingsEnvelope,
): SerializedSettingsEnvelope {
	const { enabled: _profileEnabled, ...flatCompatibilitySettings } = serializeStoredSettings(
		fallbackStoredSettings(envelope),
	);
	return {
		...flatCompatibilitySettings,
		enabled: envelope.enabled,
		...(envelope.lastServerKind ? { lastServerKind: envelope.lastServerKind } : {}),
		profiles: {
			apache: serializeConnectionProfile(envelope.profiles.apache),
			nginx: serializeConnectionProfile(envelope.profiles.nginx),
		},
		schemaVersion: 2,
	};
}

export function storedSettingsForServer(
	envelope: StoredSettingsEnvelope,
	serverKind: SupportedServerKind,
): StoredSettings {
	return {
		...envelope.profiles[serverKind],
		enabled: envelope.enabled,
	};
}

export function fallbackStoredSettings(envelope: StoredSettingsEnvelope): StoredSettings {
	const serverKind = envelope.lastServerKind ?? 'nginx';
	return storedSettingsForServer(envelope, serverKind);
}

export function replaceStoredSettingsForServer(
	envelope: StoredSettingsEnvelope,
	serverKind: SupportedServerKind,
	settings: StoredSettings,
): StoredSettingsEnvelope {
	return {
		...envelope,
		enabled: settings.enabled,
		lastServerKind: serverKind,
		profiles: {
			...envelope.profiles,
			[serverKind]: connectionProfileFromSettings(settings),
		},
	};
}

export function setStoredSettingsEnabled(
	envelope: StoredSettingsEnvelope,
	enabled: boolean,
): StoredSettingsEnvelope {
	return {
		...envelope,
		enabled,
	};
}

export function setStoredSettingsLastServer(
	envelope: StoredSettingsEnvelope,
	serverKind: SupportedServerKind,
): StoredSettingsEnvelope {
	return envelope.lastServerKind === serverKind
		? envelope
		: { ...envelope, lastServerKind: serverKind };
}

function connectionProfileIsPristine(profile: StoredConnectionProfile): boolean {
	const defaults = defaultConnectionProfile();
	return (Object.keys(defaults) as Array<keyof StoredConnectionProfile>).every(
		(key) => profile[key] === defaults[key],
	);
}

export function storedSettingsRequireBackgroundReconciliation(value: unknown): boolean {
	if (value === undefined) {
		return false;
	}

	const raw = rawObject(value);
	if (!raw) {
		return true;
	}

	try {
		const envelope = normalizeStoredSettingsEnvelope(value);
		const rawProfiles = rawObject(raw.profiles);
		const hasBlankCurrentApacheProfile = raw.schemaVersion === 2 &&
			envelope.lastServerKind === 'apache' &&
			Boolean(rawProfiles && Object.prototype.hasOwnProperty.call(rawProfiles, 'apache')) &&
			connectionProfileIsPristine(envelope.profiles.apache);
		return envelope.enabled ||
			hasBlankCurrentApacheProfile ||
			!connectionProfileIsPristine(envelope.profiles.apache) ||
			!connectionProfileIsPristine(envelope.profiles.nginx);
	} catch {
		// Unknown schemas and malformed envelopes still need fail-closed cleanup.
		return true;
	}
}

export function preserveStoredBlankCurrentProfile(
	envelope: StoredSettingsEnvelope,
	storedValue: unknown,
	currentServerKind: SupportedServerKind,
): StoredSettingsEnvelope {
	// v0.3.x Apache saves could persist an intentionally cleared current profile
	// without a touched marker. Nginx saves retained their manual-origin marker,
	// so stamping pristine Nginx profiles would turn untouched profiles into
	// false server-switch destinations and cause passive startup writes.
	const raw = rawObject(storedValue);
	const rawProfiles = rawObject(raw?.profiles);
	if (
		currentServerKind !== 'apache' ||
		raw?.schemaVersion !== 2 ||
		envelope.lastServerKind !== currentServerKind ||
		!rawProfiles ||
		!Object.prototype.hasOwnProperty.call(rawProfiles, currentServerKind) ||
		!connectionProfileIsPristine(envelope.profiles[currentServerKind])
	) {
		return envelope;
	}

	return {
		...envelope,
		profiles: {
			...envelope.profiles,
			[currentServerKind]: {
				...envelope.profiles[currentServerKind],
				originSource: 'manual',
			},
		},
	};
}

export function carrySiteUrlToPristineServerProfile(
	envelope: StoredSettingsEnvelope,
	destinationServerKind: SupportedServerKind,
): StoredSettingsEnvelope {
	const sourceServerKind = envelope.lastServerKind;
	if (!sourceServerKind || sourceServerKind === destinationServerKind) {
		return envelope;
	}

	const destinationProfile = envelope.profiles[destinationServerKind];
	if (!connectionProfileIsPristine(destinationProfile)) {
		return envelope;
	}

	let siteUrl: string;
	try {
		siteUrl = validateAndNormalizeSiteUrl(
			envelope.profiles[sourceServerKind].siteUrl,
		).siteUrl;
	} catch {
		return envelope;
	}

	return {
		...envelope,
		profiles: {
			...envelope.profiles,
			[destinationServerKind]: {
				...destinationProfile,
				siteUrl,
			},
		},
	};
}

export function originPairMatches(
	left: Pick<StoredSettings, 'originEnvironment' | 'originIp' | 'originTlsHostname' | 'siteUrl'>,
	right: Pick<StoredSettings, 'originEnvironment' | 'originIp' | 'originTlsHostname' | 'siteUrl'>,
): boolean {
	return left.originIp.trim() === right.originIp.trim()
		&& siteUrlComparisonKey(left.siteUrl) === siteUrlComparisonKey(right.siteUrl)
		&& left.originEnvironment === right.originEnvironment
		&& (left.originTlsHostname?.trim() ?? '') === (right.originTlsHostname?.trim() ?? '');
}
