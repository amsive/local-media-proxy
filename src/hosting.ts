/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIP } from 'node:net';
import type * as Local from '@getflywheel/local';
import {
	ipAddressWarning,
	resolveIpCandidates,
	type DnsResolver,
} from './dns';
import type {
	HostingEnvironment,
	HostingEnvironmentOption,
	OriginAddressCandidate,
	OriginDiscoveryOptions,
	OriginSuggestion,
} from './types';
import {
	validateAndNormalizeSiteUrl,
	validateBareHostname,
	validateWpEngineOriginTlsHostname,
} from './validation';

interface WpEngineInstallSummary {
	cname?: unknown;
	environment?: unknown;
	id?: unknown;
	name?: unknown;
}

interface WpEngineSiteSummary {
	id?: unknown;
	installs?: unknown;
	name?: unknown;
}

interface WpEngineInstallDetail {
	account?: { id?: string };
	cname?: unknown;
	environment?: HostingEnvironment;
	id: string;
	name: string;
	primaryDomain?: unknown;
	site?: { id?: string } | null;
	stableIps?: unknown;
}

export interface WpEngineCapi {
	getInstall?: (installId: string) => Promise<unknown>;
	getSiteAndInstallList?: () => Promise<unknown>;
}

export interface WpEngineOriginSuggestion extends OriginSuggestion {
	wpEngineInstallId: string;
	wpEngineSiteId: string;
}

export interface WpEngineOriginMetadata {
	cname: string;
	environment: HostingEnvironment;
	originTlsHostname?: string;
	siteUrl: string;
	stableAddresses: OriginAddressCandidate[];
	warning: string;
	wpEngineInstallId: string;
	wpEngineSiteId: string;
}

export class WpEngineVerificationUnavailableError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WpEngineVerificationUnavailableError';
	}
}

export function shouldRetainWpEngineSettingsAfterVerificationError(error: unknown): boolean {
	return error instanceof WpEngineVerificationUnavailableError;
}

interface WpEngineConnection {
	accountId?: unknown;
	remoteSiteEnv?: unknown;
	remoteSiteId: string;
	userId?: unknown;
}

interface ConnectedEnvironment extends HostingEnvironmentOption {
	cname?: string;
	id: string;
}

const ENVIRONMENT_ORDER: Record<HostingEnvironment, number> = {
	production: 0,
	staging: 1,
	development: 2,
};

function isEnvironment(value: unknown): value is HostingEnvironment {
	return value === 'production' || value === 'staging' || value === 'development';
}

export interface WpEngineOriginIdentity {
	environment?: unknown;
	siteUrl?: unknown;
	tlsHostname?: unknown;
}

export function wpEngineOriginIdentityMatches(
	left: WpEngineOriginIdentity,
	right: WpEngineOriginIdentity,
): boolean {
	try {
		if (
			!isEnvironment(left.environment) ||
			left.environment !== right.environment ||
			typeof left.siteUrl !== 'string' ||
			typeof right.siteUrl !== 'string'
		) {
			return false;
		}
		const leftSite = validateAndNormalizeSiteUrl(left.siteUrl);
		const rightSite = validateAndNormalizeSiteUrl(right.siteUrl);
		const leftTlsHostname = validateWpEngineOriginTlsHostname(
			typeof left.tlsHostname === 'string' ? left.tlsHostname : leftSite.hostname,
		);
		const rightTlsHostname = validateWpEngineOriginTlsHostname(
			typeof right.tlsHostname === 'string' ? right.tlsHostname : rightSite.hostname,
		);

		return leftSite.siteUrl === rightSite.siteUrl && leftTlsHostname === rightTlsHostname;
	} catch {
		return false;
	}
}

function getHostConnection(site: Local.Site, hostId: 'flywheel' | 'wpe'): WpEngineConnection | null {
	const connection = site.hostConnections?.find((candidate) => (
		candidate?.hostId === hostId && typeof candidate.remoteSiteId === 'string'
	));

	return connection && typeof connection.remoteSiteId === 'string'
		? {
			accountId: (connection as { accountId?: unknown }).accountId,
			remoteSiteEnv: connection.remoteSiteEnv,
			remoteSiteId: connection.remoteSiteId,
			userId: (connection as { userId?: unknown }).userId,
		}
		: null;
}

export function getWpEngineConnectionSiteId(site: Local.Site): string | undefined {
	return getHostConnection(site, 'wpe')?.remoteSiteId;
}

export function wpEngineStoredProvenanceMatches(
	site: Local.Site,
	installId: unknown,
	siteId: unknown,
	authoritative?: Pick<WpEngineOriginMetadata, 'wpEngineInstallId' | 'wpEngineSiteId'>,
): boolean {
	if (
		typeof installId !== 'string' ||
		!installId ||
		typeof siteId !== 'string' ||
		!siteId ||
		getWpEngineConnectionSiteId(site) !== siteId
	) {
		return false;
	}

	return !authoritative || (
		authoritative.wpEngineInstallId === installId &&
		authoritative.wpEngineSiteId === siteId
	);
}

function parseSites(value: unknown): WpEngineSiteSummary[] {
	if (!Array.isArray(value)) {
		throw new Error('Local returned an unexpected WP Engine site list.');
	}

	return value.filter((site): site is WpEngineSiteSummary => Boolean(site && typeof site === 'object'));
}

function findConnectedWpEngineSite(
	sites: WpEngineSiteSummary[],
	connection: WpEngineConnection,
): WpEngineSiteSummary | undefined {
	return sites.find((site) => site.id === connection.remoteSiteId);
}

function parseEnvironmentOptions(
	site: WpEngineSiteSummary,
	currentEnvironment: unknown,
): ConnectedEnvironment[] {
	if (!Array.isArray(site.installs)) {
		throw new Error('Local returned WP Engine site data without an environment list.');
	}

	return site.installs
		.filter((install): install is WpEngineInstallSummary => Boolean(install && typeof install === 'object'))
		.flatMap((install) => {
			if (
				typeof install.id !== 'string' ||
				typeof install.name !== 'string' ||
				!isEnvironment(install.environment)
			) {
				return [];
			}

			return [{
				cname: typeof install.cname === 'string' ? install.cname : undefined,
				current: install.environment === currentEnvironment,
				environment: install.environment,
				id: install.id,
				name: install.name,
			}];
		})
		.sort((left, right) => ENVIRONMENT_ORDER[left.environment] - ENVIRONMENT_ORDER[right.environment]);
}

async function getConnectedWpEngineData(
	site: Local.Site,
	capi: WpEngineCapi,
): Promise<{
	connection: WpEngineConnection;
	options: ConnectedEnvironment[];
}> {
	const connection = getHostConnection(site, 'wpe');
	if (!connection) {
		throw new Error('This Local site is not connected to WP Engine.');
	}

	if (
		typeof capi.getSiteAndInstallList !== 'function' ||
		typeof capi.getInstall !== 'function'
	) {
		throw new WpEngineVerificationUnavailableError('This version of Local does not expose WP Engine environment discovery to add-ons.');
	}

	let rawSites: unknown;
	try {
		rawSites = await capi.getSiteAndInstallList.call(capi);
	} catch (error) {
		throw new WpEngineVerificationUnavailableError(
			'Local could not load the connected WP Engine environments. Confirm that Local is signed in and try again.',
			{ cause: error },
		);
	}
	const sites = parseSites(rawSites);
	const connectedSite = findConnectedWpEngineSite(sites, connection);
	if (!connectedSite) {
		throw new Error('Local could not match this site to its connected WP Engine site.');
	}

	const options = parseEnvironmentOptions(connectedSite, connection.remoteSiteEnv);
	if (options.length === 0) {
		throw new Error('No usable WP Engine environments were found for this connected site.');
	}
	for (const environment of Object.keys(ENVIRONMENT_ORDER) as HostingEnvironment[]) {
		if (options.filter((option) => option.environment === environment).length > 1) {
			throw new Error(`Local returned more than one WP Engine install for the ${environment} environment.`);
		}
	}

	return { connection, options };
}

export async function getOriginDiscoveryOptions(
	site: Local.Site,
	capi: WpEngineCapi,
	onError?: (error: unknown) => void,
): Promise<OriginDiscoveryOptions> {
	if (getHostConnection(site, 'wpe')) {
		try {
			const { options } = await getConnectedWpEngineData(site, capi);
			const selected = options.find((option) => option.current) ?? options[0];
			return {
				canAutoPopulate: true,
				environments: options.map(({ cname: _cname, id: _id, ...option }) => option),
				message: 'Connected to WP Engine. Select an environment to discover its provider-recommended Site URL and remote IP.',
				provider: 'wpengine',
				selectedEnvironment: selected.environment,
			};
		} catch (error) {
			onError?.(error);
			const reason = error instanceof Error ? error.message : String(error);
			return {
				canAutoPopulate: false,
				environments: [],
				message: `${reason} Manual entry and DNS lookup remain available.`,
				provider: 'wpengine',
			};
		}
	}

	if (getHostConnection(site, 'flywheel')) {
		return {
			canAutoPopulate: false,
			environments: [],
			message: 'Connected to Flywheel. Local does not expose a supported Flywheel environment API to add-ons, so enter a Site URL manually and use DNS lookup if appropriate.',
			provider: 'flywheel',
		};
	}

	return {
		canAutoPopulate: false,
		environments: [],
		message: 'This site is not connected to WP Engine or Flywheel. Enter a Site URL to find public DNS address candidates.',
		provider: 'none',
	};
}

function normalizeWpEngineCname(value: unknown): string {
	if (typeof value !== 'string') {
		throw new Error('WP Engine did not return a direct environment CNAME.');
	}

	let hostname: string;
	try {
		hostname = validateBareHostname(value);
	} catch (error) {
		throw new Error('WP Engine returned an invalid direct environment CNAME.', { cause: error });
	}
	if (hostname === 'wpengine.com' || !hostname.endsWith('.wpengine.com')) {
		throw new Error('WP Engine returned a CNAME outside the expected wpengine.com domain.');
	}

	return hostname;
}

function normalizeWpEnginePrimaryDomain(value: unknown, fallback: string): string {
	if (value == null) {
		return fallback;
	}
	if (typeof value !== 'string') {
		throw new Error('WP Engine returned an invalid primary domain.');
	}

	const candidate = value.trim();
	if (!candidate) {
		return fallback;
	}

	try {
		return validateBareHostname(candidate);
	} catch (error) {
		throw new Error('WP Engine returned an invalid primary domain.', { cause: error });
	}
}

function stableIpCandidates(stableIps: unknown): OriginAddressCandidate[] {
	if (!Array.isArray(stableIps)) {
		return [];
	}

	const seen = new Set<string>();
	return stableIps.flatMap((address) => {
		if (typeof address !== 'string' || seen.has(address)) {
			return [];
		}

		const family = isIP(address);
		if (family !== 4 && family !== 6) {
			return [];
		}

		seen.add(address);
		return [{
			address,
			family,
			source: 'wpengine-stable-ip' as const,
			warning: ipAddressWarning(address),
		}];
	});
}

export async function getAuthoritativeWpEngineOrigin(
	site: Local.Site,
	environment: HostingEnvironment,
	capi: WpEngineCapi,
): Promise<WpEngineOriginMetadata> {
	if (!isEnvironment(environment)) {
		throw new Error('Select a valid WP Engine environment.');
	}

	const { connection, options } = await getConnectedWpEngineData(site, capi);
	const matches = options.filter((option) => option.environment === environment);
	if (matches.length > 1) {
		throw new Error('Local returned more than one WP Engine install for the selected environment.');
	}
	const selected = matches[0];
	if (!selected) {
		throw new Error('The selected WP Engine environment does not belong to this connected site.');
	}

	if (typeof capi.getInstall !== 'function') {
		throw new WpEngineVerificationUnavailableError('This version of Local does not expose WP Engine environment discovery to add-ons.');
	}
	let rawInstall: unknown;
	try {
		rawInstall = await capi.getInstall.call(capi, selected.id);
	} catch (error) {
		throw new WpEngineVerificationUnavailableError(
			'Local could not load the selected WP Engine environment. Confirm that Local is signed in and try again.',
			{ cause: error },
		);
	}
	if (!rawInstall || typeof rawInstall !== 'object') {
		throw new Error('Local returned unexpected details for the selected WP Engine environment.');
	}
	const install = rawInstall as WpEngineInstallDetail;
	if (
		install.id !== selected.id ||
		(
			install.site?.id !== connection.remoteSiteId &&
			!(install.site == null && install.id === connection.remoteSiteId)
		) ||
		install.environment !== selected.environment
	) {
		throw new Error('WP Engine returned environment details that do not match this connected site.');
	}
	const hasAuthoritativeAccountId = typeof connection.accountId === 'string' &&
		typeof connection.userId === 'string' &&
		connection.accountId !== connection.userId;
	if (hasAuthoritativeAccountId && connection.accountId !== install.account?.id) {
		throw new Error('WP Engine returned environment details from a different account.');
	}

	const detailCname = install.cname == null ? undefined : normalizeWpEngineCname(install.cname);
	const summaryCname = selected.cname == null ? undefined : normalizeWpEngineCname(selected.cname);
	if (detailCname && summaryCname && detailCname !== summaryCname) {
		throw new Error('WP Engine returned inconsistent CNAME details for the selected environment.');
	}
	const cname = detailCname ?? summaryCname ?? normalizeWpEngineCname(undefined);
	const siteHostname = normalizeWpEnginePrimaryDomain(install.primaryDomain, cname);
	const stableAddresses = stableIpCandidates(install.stableIps);
	const warning = siteHostname === cname
		? `WP Engine did not expose a separate primary domain, so ${cname} is used for Site URL, TLS identity, and remote-IP discovery. Provider addresses can change; test the connection, then verify an actual missing upload after applying.`
		: `WP Engine supplied ${siteHostname} as the primary Site URL. TLS identity and remote-IP discovery use the direct environment CNAME ${cname}. Provider addresses can change; test the connection, then verify an actual missing upload after applying.`;

	return {
		cname,
		environment: selected.environment,
		...(siteHostname === cname ? {} : { originTlsHostname: cname }),
		siteUrl: `https://${siteHostname}`,
		stableAddresses,
		warning,
		wpEngineInstallId: selected.id,
		wpEngineSiteId: connection.remoteSiteId,
	};
}

export async function discoverWpEngineOrigin(
	site: Local.Site,
	environment: HostingEnvironment,
	capi: WpEngineCapi,
	resolver?: DnsResolver,
): Promise<WpEngineOriginSuggestion> {
	const metadata = await getAuthoritativeWpEngineOrigin(site, environment, capi);
	const addresses = metadata.stableAddresses.length > 0
		? metadata.stableAddresses
		: await resolveIpCandidates(metadata.cname, 'wpengine-cname', resolver);

	return {
		addresses,
		environment: metadata.environment,
		...(metadata.originTlsHostname ? { originTlsHostname: metadata.originTlsHostname } : {}),
		provider: 'wpengine',
		resolvedAt: new Date().toISOString(),
		siteUrl: metadata.siteUrl,
		warning: metadata.warning,
		wpEngineInstallId: metadata.wpEngineInstallId,
		wpEngineSiteId: metadata.wpEngineSiteId,
	};
}
