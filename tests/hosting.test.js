/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	discoverWpEngineOrigin,
	getAuthoritativeWpEngineOrigin,
	getWpEngineConnectionSiteId,
	getOriginDiscoveryOptions,
	shouldRetainWpEngineSettingsAfterVerificationError,
	wpEngineOriginIdentityMatches,
	wpEngineStoredProvenanceMatches,
	WpEngineVerificationUnavailableError,
} = require('../lib/hosting');

const linkedSiteId = 'site-linked';
const accountId = 'account-one';

function localSite(hostId = 'wpe', remoteSiteEnv = 'staging') {
	return {
		hostConnections: [{
			accountId,
			hostId,
			remoteSiteEnv,
			remoteSiteId: linkedSiteId,
			userId: 'user-one',
		}],
		id: 'local-site',
	};
}

function siteList(installs) {
	return [
		{
			id: 'another-site',
			installs: [{ id: 'other-prod', name: 'other', environment: 'production' }],
		},
		{ id: linkedSiteId, installs, name: 'Linked site' },
	];
}

function installs() {
	return [
		{ cname: 'example-development.wpengine.com', environment: 'development', id: 'dev-id', name: 'example-development' },
		{ cname: 'example-production.wpengine.com', environment: 'production', id: 'prod-id', name: 'example-production' },
		{ cname: 'example-staging.wpengine.com', environment: 'staging', id: 'stg-id', name: 'example-staging' },
	];
}

function capi(overrides = {}) {
	return {
		getInstall: async (id) => ({
			account: { id: accountId },
			cname: id === 'prod-id'
				? 'example-production.wpengine.com'
				: id === 'stg-id'
					? 'example-staging.wpengine.com'
					: 'example-development.wpengine.com',
			environment: id === 'prod-id' ? 'production' : id === 'stg-id' ? 'staging' : 'development',
			id,
			name: id,
			site: { id: linkedSiteId },
			stableIps: ['93.184.216.34'],
		}),
		getSiteAndInstallList: async () => siteList(installs()),
		...overrides,
	};
}

test('returns only linked WP Engine environments in the expected order', async () => {
	assert.equal(getWpEngineConnectionSiteId(localSite()), linkedSiteId);
	assert.equal(getWpEngineConnectionSiteId(localSite('flywheel')), undefined);
	const options = await getOriginDiscoveryOptions(localSite(), capi());

	assert.equal(options.provider, 'wpengine');
	assert.equal(options.canAutoPopulate, true);
	assert.equal(options.selectedEnvironment, 'staging');
	assert.deepEqual(options.environments, [
		{ current: false, environment: 'production', name: 'example-production' },
		{ current: true, environment: 'staging', name: 'example-staging' },
		{ current: false, environment: 'development', name: 'example-development' },
	]);
});

test('gracefully falls back when Local does not expose environment listing', async () => {
	const options = await getOriginDiscoveryOptions(localSite(), {
		getInstall: capi().getInstall,
	});
	assert.equal(options.provider, 'wpengine');
	assert.equal(options.canAutoPopulate, false);
	assert.match(options.message, /does not expose WP Engine environment discovery/);

	const missingDetailMethod = await getOriginDiscoveryOptions(localSite(), {
		getSiteAndInstallList: capi().getSiteAndInstallList,
	});
	assert.equal(missingDetailMethod.canAutoPopulate, false);
	assert.match(missingDetailMethod.message, /does not expose WP Engine environment discovery/);
});

test('does not expose raw WP Engine client errors to the renderer', async () => {
	let loggedError;
	const options = await getOriginDiscoveryOptions(
		localSite(),
		capi({
			getSiteAndInstallList: async () => {
				throw new Error('request to https://private-provider.example/token failed');
			},
		}),
		(error) => { loggedError = error; },
	);
	assert.match(options.message, /could not load the connected WP Engine environments/);
	assert.doesNotMatch(options.message, /private-provider/);
	assert.match(loggedError.cause.message, /private-provider/);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => {
				throw new Error('provider response included a private URL');
			},
		})),
		(error) => {
			assert.match(error.message, /could not load the selected WP Engine environment/);
			assert.doesNotMatch(error.message, /private URL/);
			return true;
		},
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => null,
		})),
		/unexpected details for the selected WP Engine environment/,
	);
});

test('detects Flywheel and unconnected sites without using private APIs', async () => {
	const flywheel = await getOriginDiscoveryOptions(localSite('flywheel', 'production'), capi());
	assert.equal(flywheel.provider, 'flywheel');
	assert.equal(flywheel.canAutoPopulate, false);
	assert.match(flywheel.message, /manual/i);

	const unconnected = await getOriginDiscoveryOptions({ id: 'none' }, capi());
	assert.equal(unconnected.provider, 'none');
	assert.match(unconnected.message, /not connected/);
});

test('uses provider stable IPs and falls back to the direct WP Engine CNAME for Site URL', async () => {
	const result = await discoverWpEngineOrigin(localSite(), 'production', capi());
	assert.equal(result.siteUrl, 'https://example-production.wpengine.com');
	assert.equal(result.originTlsHostname, undefined);
	assert.equal(result.environment, 'production');
	assert.equal(result.wpEngineInstallId, 'prod-id');
	assert.equal(result.wpEngineSiteId, linkedSiteId);
	assert.deepEqual(result.addresses, [{
		address: '93.184.216.34',
		family: 4,
		source: 'wpengine-stable-ip',
		warning: undefined,
	}]);
});

test('uses the primary domain for Site URL while resolving the direct CNAME for origin IP', async () => {
	const fakeCapi = capi({
		getSiteAndInstallList: async () => siteList([
			{ cname: 'example-development.wpengine.com', environment: 'development', id: 'dev-id', name: 'example-development' },
			{ cname: 'example-production.wpengine.com', environment: 'production', id: 'prod-id', name: 'example-production' },
			{ cname: 'example-staging.wpengine.com', environment: 'staging', id: 'stg-id', name: 'example-staging' },
		]),
		getInstall: async () => ({
			account: { id: accountId },
			cname: 'example-production.wpengine.com',
			environment: 'production',
			id: 'prod-id',
			name: 'example-production',
			primaryDomain: 'Example-Production.example.com.',
			site: { id: linkedSiteId },
			stableIps: [],
		}),
	});
	const resolver = {
		resolve4: async (hostname) => {
			assert.equal(hostname, 'example-production.wpengine.com');
			return [{ address: '93.184.216.34', ttl: 120 }];
		},
		resolve6: async (hostname) => {
			assert.equal(hostname, 'example-production.wpengine.com');
			return [];
		},
	};

	const result = await discoverWpEngineOrigin(localSite(), 'production', fakeCapi, resolver);
	assert.equal(result.siteUrl, 'https://example-production.example.com');
	assert.equal(result.originTlsHostname, 'example-production.wpengine.com');
	assert.equal(result.wpEngineInstallId, 'prod-id');
	assert.equal(result.wpEngineSiteId, linkedSiteId);
	assert.equal(result.addresses[0].address, '93.184.216.34');
	assert.equal(result.addresses[0].source, 'wpengine-cname');
	assert.equal(result.addresses[0].ttl, 120);
	assert.match(result.warning, /primary Site URL/);
});

test('loads authoritative WP Engine identity without requiring origin DNS', async () => {
	const fakeCapi = capi({
		getSiteAndInstallList: async () => siteList([
			{ cname: 'example-production.wpengine.com', environment: 'production', id: 'prod-id', name: 'example-production' },
		]),
		getInstall: async () => ({
			account: { id: accountId },
			cname: 'example-production.wpengine.com',
			environment: 'production',
			id: 'prod-id',
			name: 'example-production',
			primaryDomain: 'example-production.example.com',
			site: { id: linkedSiteId },
			stableIps: [],
		}),
	});

	const metadata = await getAuthoritativeWpEngineOrigin(localSite(), 'production', fakeCapi);
	assert.equal(metadata.siteUrl, 'https://example-production.example.com');
	assert.equal(metadata.originTlsHostname, 'example-production.wpengine.com');
	assert.equal(metadata.cname, 'example-production.wpengine.com');
	assert.deepEqual(metadata.stableAddresses, []);
});

test('retains primary-domain identity when WP Engine supplies stable IPs', async () => {
	const fakeCapi = capi({
		getSiteAndInstallList: async () => siteList([
			{ cname: 'example-development.wpengine.com', environment: 'development', id: 'dev-id', name: 'example-development' },
			{ cname: 'example-production.wpengine.com', environment: 'production', id: 'prod-id', name: 'example-production' },
			{ cname: 'example-staging.wpengine.com', environment: 'staging', id: 'stg-id', name: 'example-staging' },
		]),
		getInstall: async () => ({
			account: { id: accountId },
			cname: 'example-production.wpengine.com',
			environment: 'production',
			id: 'prod-id',
			name: 'example-production',
			primaryDomain: 'example-production.example.com',
			site: { id: linkedSiteId },
			stableIps: ['93.184.216.34'],
		}),
	});
	const resolver = {
		resolve4: async () => { throw new Error('DNS should not be used'); },
		resolve6: async () => { throw new Error('DNS should not be used'); },
	};

	const result = await discoverWpEngineOrigin(localSite(), 'production', fakeCapi, resolver);
	assert.equal(result.siteUrl, 'https://example-production.example.com');
	assert.equal(result.originTlsHostname, 'example-production.wpengine.com');
	assert.equal(result.wpEngineInstallId, 'prod-id');
	assert.equal(result.wpEngineSiteId, linkedSiteId);
	assert.deepEqual(result.addresses, [{
		address: '93.184.216.34',
		family: 4,
		source: 'wpengine-stable-ip',
		warning: undefined,
	}]);
});

test('matches only normalized authoritative WP Engine environment identities', () => {
	const authoritative = {
		environment: 'production',
		siteUrl: 'https://example-production.example.com',
		tlsHostname: 'example-production.wpengine.com',
	};
	assert.equal(wpEngineOriginIdentityMatches({
		...authoritative,
		siteUrl: 'HTTPS://EXAMPLE-PRODUCTION.EXAMPLE.COM/',
		tlsHostname: 'EXAMPLE-PRODUCTION.WPENGINE.COM.',
	}, authoritative), true);
	assert.equal(wpEngineOriginIdentityMatches({
		...authoritative,
		environment: 'staging',
	}, authoritative), false);
	assert.equal(wpEngineOriginIdentityMatches({
		...authoritative,
		siteUrl: 'https://unrelated.example.com',
	}, authoritative), false);
	assert.equal(wpEngineOriginIdentityMatches({
		...authoritative,
		tlsHostname: 'example-staging.wpengine.com',
	}, authoritative), false);
	assert.equal(wpEngineOriginIdentityMatches({
		environment: 'production',
		siteUrl: 'https://example-production.wpengine.com/',
	}, {
		environment: 'production',
		siteUrl: 'https://example-production.wpengine.com',
	}), true);
	assert.equal(wpEngineOriginIdentityMatches({
		environment: 'production',
		siteUrl: 'https://unrelated.example.com',
	}, {
		environment: 'production',
		siteUrl: 'https://example-production.wpengine.com',
	}), false);
});

test('matches stored WP Engine provenance and rejects missing, relinked, or replaced installs', () => {
	const site = localSite();
	const authoritative = {
		wpEngineInstallId: 'prod-id',
		wpEngineSiteId: linkedSiteId,
	};
	assert.equal(wpEngineStoredProvenanceMatches(site, 'prod-id', linkedSiteId), true);
	assert.equal(wpEngineStoredProvenanceMatches(site, undefined, linkedSiteId), false);
	assert.equal(wpEngineStoredProvenanceMatches(site, 'prod-id', undefined), false);
	assert.equal(wpEngineStoredProvenanceMatches(site, 'prod-id', 'relinked-site'), false);
	assert.equal(wpEngineStoredProvenanceMatches(site, 'prod-id', linkedSiteId, authoritative), true);
	assert.equal(wpEngineStoredProvenanceMatches(site, 'replaced-id', linkedSiteId, authoritative), false);
});

test('retains enabled intent only for actual WP Engine availability failures', async () => {
	const unavailable = new WpEngineVerificationUnavailableError('provider unavailable');
	assert.equal(shouldRetainWpEngineSettingsAfterVerificationError(unavailable), true);
	assert.equal(shouldRetainWpEngineSettingsAfterVerificationError(new Error('confirmed mismatch')), false);

	await assert.rejects(
		getAuthoritativeWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => {
				throw new Error('temporary CAPI outage');
			},
		})),
		(error) => shouldRetainWpEngineSettingsAfterVerificationError(error),
	);
	await assert.rejects(
		getAuthoritativeWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'example-production.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				site: { id: 'different-site' },
			}),
		})),
		(error) => !shouldRetainWpEngineSettingsAfterVerificationError(error),
	);
});

test('rejects arbitrary, duplicate, or mismatched WP Engine environments', async () => {
	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'example-production.wpengine.com/path',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				primaryDomain: 'example.com',
				site: { id: linkedSiteId },
			}),
		})),
		/invalid direct environment CNAME/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'example-production.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				primaryDomain: 'example.com/',
				site: { id: linkedSiteId },
			}),
		})),
		/invalid primary domain/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'example-production.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				primaryDomain: 'example.com/path',
				site: { id: linkedSiteId },
			}),
		})),
		/invalid primary domain/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'development', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'wpengine.com.evil.example',
				environment: 'development',
				id: 'dev-id',
				name: 'dev',
				site: { id: linkedSiteId },
			}),
		})),
		/outside the expected wpengine.com domain/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: accountId },
				cname: 'example-staging.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				primaryDomain: 'example.com',
				site: { id: linkedSiteId },
			}),
		})),
		/inconsistent CNAME details/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				cname: 'example-production.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				site: { id: 'different-site' },
			}),
		})),
		/do not match this connected site/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getSiteAndInstallList: async () => siteList([
				...installs(),
				{ cname: 'example-production.wpengine.com', environment: 'production', id: 'duplicate', name: 'duplicate' },
			]),
		})),
		/more than one WP Engine install/,
	);

	await assert.rejects(
		discoverWpEngineOrigin(localSite(), 'production', capi({
			getInstall: async () => ({
				account: { id: 'different-account' },
				cname: 'example-production.wpengine.com',
				environment: 'production',
				id: 'prod-id',
				name: 'prod',
				site: { id: linkedSiteId },
			}),
		})),
		/different account/,
	);
});

test('permits Local legacy install wrapping only when the install ID is the linked site ID', async () => {
	const legacy = localSite();
	legacy.hostConnections[0].remoteSiteId = 'legacy-id';
	const fakeCapi = {
		getSiteAndInstallList: async () => [{
			id: 'legacy-id',
			installs: [{ cname: 'example-site.wpengine.com', environment: 'production', id: 'legacy-id', name: 'legacy' }],
		}],
		getInstall: async () => ({
			account: { id: accountId },
			cname: 'example-site.wpengine.com',
			environment: 'production',
			id: 'legacy-id',
			name: 'legacy',
			site: null,
			stableIps: ['93.184.216.34'],
		}),
	};

	const result = await discoverWpEngineOrigin(legacy, 'production', fakeCapi);
	assert.equal(result.siteUrl, 'https://example-site.wpengine.com');
});

test('does not treat the legacy Local user UUID as a WP Engine account ID', async () => {
	const legacy = localSite();
	delete legacy.hostConnections[0].userId;
	legacy.hostConnections[0].accountId = 'legacy-user-uuid';

	const result = await discoverWpEngineOrigin(legacy, 'production', capi());
	assert.equal(result.siteUrl, 'https://example-production.wpengine.com');
});
