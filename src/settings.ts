/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_SETTINGS } from './constants';
import type {
	CertificateSummary,
	StoredSettings,
} from './types';
import {
	sanitizeHostingEnvironment,
	sanitizeOriginSource,
	sanitizeResolvedAt,
	siteUrlComparisonKey,
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

export function originPairMatches(
	left: Pick<StoredSettings, 'originEnvironment' | 'originIp' | 'originTlsHostname' | 'siteUrl'>,
	right: Pick<StoredSettings, 'originEnvironment' | 'originIp' | 'originTlsHostname' | 'siteUrl'>,
): boolean {
	return left.originIp.trim() === right.originIp.trim()
		&& siteUrlComparisonKey(left.siteUrl) === siteUrlComparisonKey(right.siteUrl)
		&& left.originEnvironment === right.originEnvironment
		&& (left.originTlsHostname?.trim() ?? '') === (right.originTlsHostname?.trim() ?? '');
}
