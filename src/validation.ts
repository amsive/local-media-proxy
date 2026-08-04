/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { MANUAL_WPENGINE_TLS_HOSTNAME } from './constants';
import type {
	HostingEnvironment,
	NormalizedOrigin,
	OriginSource,
	SettingsInput,
} from './types';

const MAX_URL_LENGTH = 2048;
const MAX_IP_LENGTH = 64;
const MAX_TIMESTAMP_LENGTH = 32;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface NormalizedSiteUrl {
	hostHeader: string;
	hostname: string;
	port: number;
	protocol: 'http:' | 'https:';
	siteUrl: string;
}

export interface OriginValidationOptions {
	requiresOriginIp?: boolean;
}

export function sanitizeOriginSource(value: unknown): OriginSource | undefined {
	return value === 'dns' || value === 'manual' || value === 'wpengine'
		? value
		: undefined;
}

export function sanitizeHostingEnvironment(value: unknown): HostingEnvironment | undefined {
	return value === 'production' || value === 'staging' || value === 'development'
		? value
		: undefined;
}

export function sanitizeResolvedAt(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_LENGTH) {
		return undefined;
	}

	const timestamp = value.trim();
	const parsed = new Date(timestamp);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === timestamp
		? timestamp
		: undefined;
}

export function validateSettingsInput(
	value: unknown,
	options: OriginValidationOptions = {},
): SettingsInput {
	const requiresOriginIp = options.requiresOriginIp ?? true;
	if (!value || typeof value !== 'object') {
		throw new Error('Media proxy settings are required.');
	}

	const input = value as Partial<SettingsInput>;
	if (typeof input.enabled !== 'boolean') {
		throw new Error('The media proxy enabled setting must be true or false.');
	}
	if (typeof input.siteUrl !== 'string') {
		throw new Error('Site URL must be a string.');
	}
	if (!requiresOriginIp) {
		return {
			enabled: input.enabled,
			originIp: '',
			...(input.originSource === 'manual' ? { originSource: 'manual' as const } : {}),
			siteUrl: input.siteUrl,
		};
	}
	if (requiresOriginIp && typeof input.originIp !== 'string') {
		throw new Error('Remote IP address must be a string.');
	}
	const originSource = sanitizeOriginSource(input.originSource);
	const originEnvironment = sanitizeHostingEnvironment(input.originEnvironment);
	if (input.enabled && input.originEnvironment !== undefined && !originEnvironment) {
		throw new Error('Select a valid WP Engine environment.');
	}
	if (input.originTlsHostname !== undefined && typeof input.originTlsHostname !== 'string') {
		throw new Error('Origin TLS hostname must be a string.');
	}
	const originTlsHostname = requiresOriginIp && typeof input.originTlsHostname === 'string' && input.originTlsHostname.trim()
		? input.enabled
			? validateWpEngineOriginTlsHostname(input.originTlsHostname)
			: input.originTlsHostname.trim()
		: undefined;
	if (
		input.enabled &&
		originTlsHostname &&
		originSource !== 'wpengine' &&
		originTlsHostname !== MANUAL_WPENGINE_TLS_HOSTNAME
	) {
		throw new Error('A manual origin may use only the verified WP Engine TLS fallback hostname.');
	}
	if (input.enabled && originTlsHostname && originSource === 'wpengine' && !originEnvironment) {
		throw new Error('Run WP Engine auto-population again to verify the selected environment.');
	}
	if (input.enabled && originEnvironment && originSource !== 'wpengine') {
		throw new Error('A WP Engine environment is supported only for WP Engine discovery.');
	}
	const resolvedAt = sanitizeResolvedAt(input.resolvedAt);

	return {
		enabled: input.enabled,
		...(originEnvironment ? { originEnvironment } : {}),
		originIp: requiresOriginIp && typeof input.originIp === 'string' ? input.originIp : '',
		...(originSource ? { originSource } : {}),
		...(originTlsHostname ? { originTlsHostname } : {}),
		...(resolvedAt ? { resolvedAt } : {}),
		siteUrl: input.siteUrl,
	};
}

export function validateHostname(hostname: string): string {
	const asciiHostname = domainToASCII(hostname).toLowerCase();

	if (
		!asciiHostname ||
		asciiHostname.length > 253 ||
		asciiHostname.includes('..') ||
		!asciiHostname.split('.').every((label) => HOST_LABEL.test(label))
	) {
		throw new Error('Site URL must contain a valid hostname.');
	}

	return asciiHostname;
}

export function validateBareHostname(rawValue: string): string {
	const candidate = rawValue.trim();
	if (!candidate) {
		throw new Error('Hostname must be a bare valid hostname.');
	}

	try {
		const domain = candidate.replace(/\.$/, '');
		const parsed = new URL(`https://${domain}`);
		if (
			parsed.username ||
			parsed.password ||
			parsed.port ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash ||
			domain.includes(':') ||
			domain.includes('%') ||
			/[/\\?#@]/.test(domain)
		) {
			throw new Error('Hostname must not contain URL components.');
		}

		return validateHostname(parsed.hostname);
	} catch (error) {
		throw new Error('Hostname must be a bare valid hostname.', { cause: error });
	}
}

export function validateWpEngineOriginTlsHostname(rawValue: string): string {
	const hostname = validateBareHostname(rawValue);
	if (hostname === 'wpengine.com' || !hostname.endsWith('.wpengine.com')) {
		throw new Error('Origin TLS hostname must be a WP Engine environment hostname.');
	}

	return hostname;
}

export function sanitizeOriginTlsHostname(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}

	try {
		return validateWpEngineOriginTlsHostname(value);
	} catch {
		return undefined;
	}
}

export function sanitizeDisabledSettings(input: Partial<SettingsInput>): SettingsInput {
	const originSource = sanitizeOriginSource(input.originSource);
	const originEnvironment = originSource === 'wpengine'
		? sanitizeHostingEnvironment(input.originEnvironment)
		: undefined;
	const sanitizedTlsHostname = sanitizeOriginTlsHostname(input.originTlsHostname);
	const originTlsHostname = originSource === 'wpengine' && originEnvironment
		? sanitizedTlsHostname
		: sanitizedTlsHostname === MANUAL_WPENGINE_TLS_HOSTNAME
			? sanitizedTlsHostname
			: undefined;
	const resolvedAt = sanitizeResolvedAt(input.resolvedAt);

	return {
		enabled: false,
		...(originEnvironment ? { originEnvironment } : {}),
		originIp: typeof input.originIp === 'string'
			? input.originIp.trim().slice(0, MAX_IP_LENGTH)
			: '',
		...(originSource ? { originSource } : {}),
		...(originTlsHostname ? { originTlsHostname } : {}),
		...(resolvedAt ? { resolvedAt } : {}),
		siteUrl: typeof input.siteUrl === 'string'
			? input.siteUrl.trim().slice(0, MAX_URL_LENGTH)
			: '',
	};
}

export function validateAndNormalizeSiteUrl(rawValue: unknown): NormalizedSiteUrl {
	if (typeof rawValue !== 'string') {
		throw new Error('Site URL is required.');
	}

	const rawUrl = rawValue.trim();
	if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
		throw new Error('Site URL is required and must be 2,048 characters or fewer.');
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new Error('Site URL must be a complete HTTP or HTTPS URL.');
	}

	if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
		throw new Error('Site URL must use HTTP or HTTPS.');
	}

	if (parsedUrl.username || parsedUrl.password) {
		throw new Error('Site URL cannot contain a username or password.');
	}

	if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
		throw new Error('Site URL must be an origin URL without a path, query, or fragment.');
	}

	const hostname = validateHostname(parsedUrl.hostname);
	const port = parsedUrl.port
		? Number.parseInt(parsedUrl.port, 10)
		: parsedUrl.protocol === 'https:'
			? 443
			: 80;

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('Site URL contains an invalid port.');
	}

	const defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
	const hostHeader = port === defaultPort ? hostname : `${hostname}:${port}`;

	return {
		hostHeader,
		hostname,
		port,
		protocol: parsedUrl.protocol,
		siteUrl: `${parsedUrl.protocol}//${hostHeader}`,
	};
}

export function siteUrlComparisonKey(rawValue: string): string {
	try {
		return validateAndNormalizeSiteUrl(rawValue).siteUrl;
	} catch {
		return rawValue.trim();
	}
}

export function siteUrlsAreEquivalent(left: string, right: string): boolean {
	try {
		return validateAndNormalizeSiteUrl(left).siteUrl === validateAndNormalizeSiteUrl(right).siteUrl;
	} catch {
		return false;
	}
}

export function validateAndNormalizeOrigin(
	input: Pick<SettingsInput, 'originEnvironment' | 'originIp' | 'originSource' | 'originTlsHostname' | 'siteUrl'>,
	options: OriginValidationOptions = {},
): NormalizedOrigin {
	const requiresOriginIp = options.requiresOriginIp ?? true;
	const site = validateAndNormalizeSiteUrl(input.siteUrl);
	if (!requiresOriginIp) {
		return {
			hostHeader: site.hostHeader,
			hostname: site.hostname,
			originIp: site.hostname,
			port: site.port,
			protocol: site.protocol,
			siteUrl: site.siteUrl,
			tlsHostname: site.hostname,
		};
	}
	const originEnvironment = sanitizeHostingEnvironment(input.originEnvironment);
	const originTlsHostname = input.originTlsHostname
		? validateWpEngineOriginTlsHostname(input.originTlsHostname)
		: undefined;
	if (
		originTlsHostname &&
		input.originSource !== 'wpengine' &&
		originTlsHostname !== MANUAL_WPENGINE_TLS_HOSTNAME
	) {
		throw new Error('A manual origin may use only the verified WP Engine TLS fallback hostname.');
	}
	if (originTlsHostname && input.originSource === 'wpengine' && !originEnvironment) {
		throw new Error('Run WP Engine auto-population again to verify the selected environment.');
	}
	if (originTlsHostname && site.protocol !== 'https:') {
		throw new Error('A separate origin TLS hostname requires an HTTPS Site URL.');
	}
	if (
		input.originSource === 'wpengine' &&
		!originTlsHostname &&
		(site.hostname === 'wpengine.com' || !site.hostname.endsWith('.wpengine.com'))
	) {
		throw new Error('This WP Engine Site URL requires fresh auto-population to restore its direct TLS hostname.');
	}

	if (typeof input.originIp !== 'string') {
		throw new Error('Remote IP address is required.');
	}

	const originIp = input.originIp.trim().replace(/^\[|\]$/g, '');
	if (!originIp || originIp.length > MAX_IP_LENGTH || isIP(originIp) === 0) {
		throw new Error('Remote IP address must be a valid IPv4 or IPv6 address.');
	}

	return {
		hostHeader: site.hostHeader,
		hostname: site.hostname,
		originIp,
		port: site.port,
		protocol: site.protocol,
		siteUrl: site.siteUrl,
		tlsHostname: originTlsHostname ?? site.hostname,
	};
}
