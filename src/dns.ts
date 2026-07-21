/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dnsPromises from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
	OriginAddressCandidate,
	OriginAddressSource,
	OriginSuggestion,
} from './types';
import { validateAndNormalizeSiteUrl } from './validation';

export interface DnsRecordWithTtl {
	address: string;
	ttl: number;
}

export interface DnsResolver {
	resolve4: (hostname: string, options: { ttl: true }) => Promise<DnsRecordWithTtl[]>;
	resolve6: (hostname: string, options: { ttl: true }) => Promise<DnsRecordWithTtl[]>;
}

const defaultResolver: DnsResolver = {
	resolve4: (hostname, options) => dnsPromises.resolve4(hostname, options),
	resolve6: (hostname, options) => dnsPromises.resolve6(hostname, options),
};
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

function ignoredDnsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENOENT';
}

function ipv4Number(address: string): number {
	return address.split('.').reduce((value, octet) => (
		(value * 256) + Number.parseInt(octet, 10)
	), 0) >>> 0;
}

function ipv4InRange(address: string, start: string, prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (ipv4Number(address) & mask) === (ipv4Number(start) & mask);
}

export function ipAddressWarning(address: string): string | undefined {
	const family = isIP(address);
	if (family === 4) {
		const nonPublicRanges: Array<[string, number]> = [
			['0.0.0.0', 8],
			['10.0.0.0', 8],
			['100.64.0.0', 10],
			['127.0.0.0', 8],
			['169.254.0.0', 16],
			['172.16.0.0', 12],
			['192.0.0.0', 24],
			['192.0.2.0', 24],
			['192.168.0.0', 16],
			['198.18.0.0', 15],
			['198.51.100.0', 24],
			['203.0.113.0', 24],
			['224.0.0.0', 4],
			['240.0.0.0', 4],
		];
		if (nonPublicRanges.some(([start, prefix]) => ipv4InRange(address, start, prefix))) {
			return 'This is a private, reserved, or non-routable IPv4 address. Confirm that it is intentional.';
		}
	}

	if (family === 6) {
		const normalized = address.toLowerCase();
		if (
			normalized === '::' ||
			normalized === '::1' ||
			normalized.startsWith('::ffff:') ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('fe8') ||
			normalized.startsWith('fe9') ||
			normalized.startsWith('fea') ||
			normalized.startsWith('feb') ||
			normalized.startsWith('fec') ||
			normalized.startsWith('fed') ||
			normalized.startsWith('fee') ||
			normalized.startsWith('fef') ||
			normalized.startsWith('ff') ||
			normalized.startsWith('2001:db8')
		) {
			return 'This is a private, reserved, or non-routable IPv6 address. Confirm that it is intentional.';
		}
	}

	return undefined;
}

async function resolveFamily(
	hostname: string,
	family: 4 | 6,
	resolver: DnsResolver,
	timeoutMs: number,
): Promise<DnsRecordWithTtl[]> {
	try {
		const lookup = family === 4
			? resolver.resolve4(hostname, { ttl: true })
			: resolver.resolve6(hostname, { ttl: true });
		return await new Promise<DnsRecordWithTtl[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`DNS IPv${family} lookup timed out for ${hostname}.`));
			}, timeoutMs);
			lookup.then(
				(records) => {
					clearTimeout(timer);
					resolve(records);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	} catch (error) {
		if (ignoredDnsError(error)) {
			return [];
		}

		throw error;
	}
}

export async function resolveIpCandidates(
	hostname: string,
	source: OriginAddressSource,
	resolver: DnsResolver = defaultResolver,
	timeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): Promise<OriginAddressCandidate[]> {
	const [ipv4Result, ipv6Result] = await Promise.allSettled([
		resolveFamily(hostname, 4, resolver, timeoutMs),
		resolveFamily(hostname, 6, resolver, timeoutMs),
	]);
	const ipv4 = ipv4Result.status === 'fulfilled' ? ipv4Result.value : [];
	const ipv6 = ipv6Result.status === 'fulfilled' ? ipv6Result.value : [];
	const seen = new Set<string>();
	const candidates: OriginAddressCandidate[] = [];

	for (const [family, records] of [[4, ipv4], [6, ipv6]] as const) {
		for (const record of records) {
			if (isIP(record.address) !== family || seen.has(record.address)) {
				continue;
			}

			seen.add(record.address);
			candidates.push({
				address: record.address,
				family,
				source,
				ttl: Number.isFinite(record.ttl) && record.ttl >= 0 ? record.ttl : undefined,
				warning: ipAddressWarning(record.address),
			});
		}
	}

	if (candidates.length === 0) {
		const failedLookup = [ipv4Result, ipv6Result].find((result) => result.status === 'rejected');
		if (failedLookup?.status === 'rejected') {
			throw failedLookup.reason instanceof Error
				? failedLookup.reason
				: new Error('DNS lookup failed.');
		}
		throw new Error(`No IPv4 or IPv6 addresses were found for ${hostname}.`);
	}

	return candidates;
}

export async function discoverDnsOrigin(
	siteUrl: string,
	resolver: DnsResolver = defaultResolver,
): Promise<OriginSuggestion> {
	const normalized = validateAndNormalizeSiteUrl(siteUrl);
	const addresses = await resolveIpCandidates(normalized.hostname, 'public-dns', resolver);
	const knownProxy = normalized.hostname.endsWith('.wpenginepowered.com')
		|| normalized.hostname.endsWith('.wpeproxy.com');
	const warning = knownProxy
		? 'This WP Engine hostname is served by an edge network, so its addresses may be shared or change. Prefer WP Engine auto-population when available. If you intentionally use an edge address, test it and verify an actual missing upload after applying.'
		: 'Public DNS may return a CDN, reverse proxy, or load balancer instead of a direct origin. These addresses can work when they serve the Site URL, but they may be shared or change. Prefer a provider-supplied origin IP when available; otherwise test the selected address and verify an actual missing upload after applying.';

	return {
		addresses,
		provider: 'dns',
		resolvedAt: new Date().toISOString(),
		siteUrl: normalized.siteUrl,
		warning,
	};
}
