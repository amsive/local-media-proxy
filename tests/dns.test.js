/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	discoverDnsOrigin,
	ipAddressWarning,
	resolveIpCandidates,
} = require('../lib/dns');

function resolver({ ipv4 = [], ipv6 = [] } = {}) {
	return {
		resolve4: async () => ipv4,
		resolve6: async () => ipv6,
	};
}

test('discovers and normalizes all public DNS address candidates', async () => {
	const result = await discoverDnsOrigin('HTTPS://Example.com/', resolver({
		ipv4: [
			{ address: '93.184.216.34', ttl: 120 },
			{ address: '93.184.216.35', ttl: 60 },
		],
		ipv6: [{ address: '2606:2800:220:1:248:1893:25c8:1946', ttl: 180 }],
	}));

	assert.equal(result.siteUrl, 'https://example.com');
	assert.equal(result.provider, 'dns');
	assert.deepEqual(result.addresses.map(({ address, family, source, ttl }) => ({
		address,
		family,
		source,
		ttl,
	})), [
		{ address: '93.184.216.34', family: 4, source: 'public-dns', ttl: 120 },
		{ address: '93.184.216.35', family: 4, source: 'public-dns', ttl: 60 },
		{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6, source: 'public-dns', ttl: 180 },
	]);
	assert.match(result.warning, /CDN, reverse proxy, or load balancer/);
	assert.match(result.warning, /These addresses can work when they serve the Site URL/);
	assert.match(result.warning, /shared or change/);
	assert.match(result.warning, /actual missing upload after applying/);
});

test('ignores a missing address family and deduplicates records', async () => {
	const missing = Object.assign(new Error('no IPv6'), { code: 'ENODATA' });
	const fake = {
		resolve4: async () => [
			{ address: '93.184.216.34', ttl: 120 },
			{ address: '93.184.216.34', ttl: 30 },
		],
		resolve6: async () => { throw missing; },
	};

	const result = await resolveIpCandidates('example.com', 'public-dns', fake);
	assert.equal(result.length, 1);
	assert.equal(result[0].ttl, 120);
});

test('uses a successful address family when the other family lookup fails', async () => {
	const transientError = Object.assign(new Error('temporary IPv6 failure'), { code: 'EAI_AGAIN' });
	const fake = {
		resolve4: async () => [{ address: '93.184.216.34', ttl: 120 }],
		resolve6: async () => { throw transientError; },
	};

	const result = await resolveIpCandidates('example.com', 'public-dns', fake);
	assert.deepEqual(result.map(({ address }) => address), ['93.184.216.34']);
});

test('bounds a stalled lookup while preserving results from the other family', async () => {
	const fake = {
		resolve4: async () => [{ address: '93.184.216.34', ttl: 120 }],
		resolve6: async () => new Promise(() => undefined),
	};

	const result = await resolveIpCandidates('example.com', 'public-dns', fake, 10);
	assert.deepEqual(result.map(({ address }) => address), ['93.184.216.34']);
});

test('fails when DNS returns no usable addresses', async () => {
	await assert.rejects(
		resolveIpCandidates('missing.example', 'public-dns', resolver()),
		/No IPv4 or IPv6 addresses/,
	);
});

test('warns about reserved addresses and known WP Engine edge hostnames', async () => {
	const broadcastAddress = [255, 255, 255, 255].join('.');
	const mappedPrefix = ['', '', 'ffff'].join(':');
	const mappedLoopback = [mappedPrefix, [127, 0, 0, 1].join('.')].join(':');
	const siteLocalAddress = ['fec0', '', '1'].join(':');
	assert.match(ipAddressWarning('127.0.0.1'), /private, reserved, or non-routable/);
	assert.match(ipAddressWarning(broadcastAddress), /private, reserved, or non-routable/);
	assert.match(ipAddressWarning('2001:db8::1'), /private, reserved, or non-routable/);
	assert.match(ipAddressWarning(mappedLoopback), /private, reserved, or non-routable/);
	assert.match(ipAddressWarning(siteLocalAddress), /private, reserved, or non-routable/);
	assert.equal(ipAddressWarning('93.184.216.34'), undefined);

	const result = await discoverDnsOrigin(
		'https://example.wpenginepowered.com',
		resolver({ ipv4: [{ address: '198.51.100.10', ttl: 300 }] }),
	);
	assert.match(result.warning, /edge network/);
	assert.match(result.warning, /If you intentionally use an edge address/);
	assert.match(result.warning, /may be shared or change/);
});
