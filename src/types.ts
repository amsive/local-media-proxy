/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type OriginProtocol = 'http:' | 'https:';

export type HostingEnvironment = 'production' | 'staging' | 'development';

export type OriginProvider = 'dns' | 'flywheel' | 'none' | 'wpengine';

export type OriginSource = 'dns' | 'manual' | 'wpengine';

export interface SettingsInput {
	enabled: boolean;
	originEnvironment?: HostingEnvironment;
	originIp: string;
	originSource?: OriginSource;
	originTlsHostname?: string;
	resolvedAt?: string;
	siteUrl: string;
}

export interface CertificateSummary {
	fingerprint256: string;
	issuer: string;
	subject: string;
	validTo: string;
}

export interface StoredSettings extends SettingsInput {
	certificate?: CertificateSummary;
	lastOriginStatus?: number;
	lastVerifiedAt?: string;
	originWpEngineInstallId?: string;
	originWpEngineSiteId?: string;
}

export interface NormalizedOrigin {
	hostHeader: string;
	hostname: string;
	originIp: string;
	port: number;
	protocol: OriginProtocol;
	siteUrl: string;
	tlsHostname: string;
}

export interface OriginProbeResult {
	certificate?: CertificateSummary;
	statusCode: number;
	trustedCertificateAuthoritiesPem?: string;
	verifiedTlsHostname?: string;
}

export interface PublicOriginProbeResult {
	certificate?: CertificateSummary;
	message: string;
	originTlsHostname?: string;
	outcome: 'success' | 'warning';
	statusCode: number;
}

export interface SiteState {
	applied: boolean;
	reason?: string;
	settings: StoredSettings;
	siteStatus: string;
	supported: boolean;
}

export interface HostingEnvironmentOption {
	current: boolean;
	environment: HostingEnvironment;
	name: string;
}

export interface OriginDiscoveryOptions {
	canAutoPopulate: boolean;
	environments: HostingEnvironmentOption[];
	message: string;
	provider: OriginProvider;
	selectedEnvironment?: HostingEnvironment;
}

export type OriginAddressSource = 'public-dns' | 'wpengine-cname' | 'wpengine-stable-ip';

export interface OriginAddressCandidate {
	address: string;
	family: 4 | 6;
	source: OriginAddressSource;
	ttl?: number;
	warning?: string;
}

export type OriginDiscoveryRequest =
	| {
		environment: HostingEnvironment;
		mode: 'wpengine';
	}
	| {
		mode: 'dns';
		siteUrl: string;
	};

export interface OriginSuggestion {
	addresses: OriginAddressCandidate[];
	environment?: HostingEnvironment;
	originTlsHostname?: string;
	provider: Exclude<OriginProvider, 'none'>;
	resolvedAt: string;
	siteUrl: string;
	warning: string;
}
