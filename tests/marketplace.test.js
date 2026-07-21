/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	createMarketplaceDetailPayload,
	createMarketplaceReleasesPayload,
	installMarketplaceMetadataShim,
} = require('../lib/marketplace');

const ENDPOINT = 'https://api.localbyflywheel.com/graphql';
const DETAIL_QUERY = `{
	addon(slug: "local-media-proxy") {
		details { overview }
		npmPackageName
	}
}`;
const RELEASES_QUERY = `{
	addon(slug: "local-media-proxy") {
		releases { changelog date id version }
	}
}`;

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		headers: { 'content-type': 'application/json' },
		status,
	});
}

function requestInit(query, operationName) {
	return {
		body: JSON.stringify({
			query,
			...(operationName === undefined ? {} : { operationName }),
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	};
}

test('builds complete Amsive detail and release metadata', () => {
	const detail = createMarketplaceDetailPayload('/tmp/Local Media Proxy');
	const addon = detail.data.addon;
	const release = addon.releases[0];

	assert.equal(addon.name, 'Local Media Proxy');
	assert.equal(addon.npmPackageName, 'local-media-proxy');
	assert.equal(addon.color, '#6E187A');
	assert.equal(addon.developer.name, 'Amsive');
	assert.deepEqual(
		addon.collaborators.map(({ name }) => name),
		['Mark Davoli', 'Boris Hegedis'],
	);
	assert.equal(addon.details.license, 'Apache-2.0');
	assert.equal(release.version, '0.1.0');
	assert.equal(release.testedUpTo, '10.1.1');
	assert.equal(release.localRequirement, '>=10.1.1');
	assert.match(release.downloadUrl, /releases\/download\/v0\.1\.0\//);
	assert.match(addon.avatar.original, /^file:\/\/\/tmp\/Local%20Media%20Proxy\/icon\.svg$/);
	assert.match(addon.details.overview, /detail-hero\.svg/);
	assert.match(addon.details.overview, /## Install and configure/);
	assert.match(addon.details.overview, /## Scope and safety/);
	assert.match(addon.details.overview, /Tools → Media Proxy/);
	assert.match(addon.details.overview, /Auto-populate from WP Engine/);
	assert.match(addon.details.overview, /Find IP addresses/);
	assert.match(addon.details.overview, /remote IP selects the endpoint/);
	assert.match(addon.details.overview, /compatible proxy, CDN, or load balancer/);
	assert.match(addon.details.overview, /Test connection/);
	assert.match(addon.details.overview, /checks endpoint reachability and, for HTTPS, certificate identity and trust—not a media file/);
	assert.match(addon.details.overview, /actual upload that is missing locally/);
	assert.doesNotMatch(addon.details.overview, /Test direct connection/);
	assert.match(addon.details.overview, /Flywheel-connected sites retain the manual/);
	assert.match(addon.details.overview, /fixed add-on User-Agent/);
	assert.match(addon.details.overview, /does not overwrite the same add-on slug/);
	assert.match(addon.details.overview, /Apache License 2\.0/);
	assert.match(addon.details.overview, /without a support SLA/);
	assert.match(addon.details.overview, /trademark policy/);

	const releases = createMarketplaceReleasesPayload().data.addon.releases;
	assert.equal(releases.length, 1);
	assert.deepEqual(
		releases.map(({ version }) => version),
		['0.1.0'],
	);
	assert.match(releases[0].changelog, /Initial public release/);
	assert.match(releases[0].changelog, /Apache License 2\.0/);
	assert.match(releases[0].changelog, /DCO sign-off/);
	assert.match(releases[0].changelog, /WP Engine/);
	assert.match(releases[0].changelog, /stale-master-PID recovery/);
	assert.match(releases[0].changelog, /reviewed-asset validation/);
});

test('uses packaged detail metadata only when the marketplace has no listing', async () => {
	const calls = [];
	const host = {
		Response,
		fetch: async (...args) => {
			calls.push(args);
			return jsonResponse({ data: { addon: null } });
		},
	};

	assert.equal(installMarketplaceMetadataShim(host, {
		endpoint: ENDPOINT,
		packageRoot: '/tmp/local-media-proxy',
	}), true);

	const response = await host.fetch(ENDPOINT, requestInit(DETAIL_QUERY));
	const payload = await response.json();

	assert.equal(calls.length, 1);
	assert.equal(payload.data.addon.name, 'Local Media Proxy');
	assert.equal(response.headers.get('x-local-media-proxy-metadata'), 'packaged-fallback');
});

test('supplies packaged release notes for the native Release notes tab', async () => {
	const host = {
		Response,
		fetch: async () => jsonResponse({ data: { addon: null } }),
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const response = await host.fetch(ENDPOINT, requestInit(RELEASES_QUERY));
	const payload = await response.json();
	const [currentRelease] = payload.data.addon.releases;

	assert.equal(payload.data.addon.releases.length, 1);
	assert.equal(currentRelease.version, '0.1.0');
	assert.equal(currentRelease.date, '2026-07-20T00:00:00.000Z');
	assert.match(currentRelease.changelog, /Initial public release/);
});

test('supports a single named target operation without operationName', async () => {
	const host = {
		Response,
		fetch: async () => jsonResponse({ data: { addon: null } }),
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const response = await host.fetch(
		ENDPOINT,
		requestInit(`query LocalMediaProxyDetails {
			addon(slug: "local-media-proxy") { details { overview } }
		}`),
	);

	assert.equal((await response.json()).data.addon.name, 'Local Media Proxy');
	assert.equal(response.headers.get('x-local-media-proxy-metadata'), 'packaged-fallback');
});

test('preserves an official marketplace listing when one becomes available', async () => {
	const officialResponse = jsonResponse({
		data: { addon: { name: 'Official Local Media Proxy' } },
	});
	const host = {
		Response,
		fetch: async () => officialResponse,
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const response = await host.fetch(ENDPOINT, requestInit(DETAIL_QUERY));

	assert.strictEqual(response, officialResponse);
	assert.equal((await response.json()).data.addon.name, 'Official Local Media Proxy');
});

test('falls back to packaged help when the marketplace is offline', async () => {
	const host = {
		Response,
		fetch: async () => {
			throw new Error('offline');
		},
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const response = await host.fetch(ENDPOINT, requestInit(DETAIL_QUERY));

	assert.equal(response.status, 200);
	assert.equal((await response.json()).data.addon.developer.name, 'Amsive');
});

test('does not intercept other endpoints, add-ons, or GraphQL operations', async () => {
	const calls = [];
	const host = {
		Response,
		fetch: async (...args) => {
			calls.push(args);
			return jsonResponse({ data: { delegated: true } });
		},
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const otherEndpoint = await host.fetch(
		'https://example.com/graphql',
		requestInit(DETAIL_QUERY),
	);
	const localAppGraphql = await host.fetch(
		'http://127.0.0.1:4000/graphql',
		requestInit(DETAIL_QUERY),
	);
	const otherAddon = await host.fetch(
		ENDPOINT,
		requestInit('{ addon(slug: "local-tableplus") { details { overview } } }'),
	);
	const unrelatedOperation = await host.fetch(
		ENDPOINT,
		requestInit('{ addons { name } }'),
	);

	assert.equal(calls.length, 4);
	assert.equal((await otherEndpoint.json()).data.delegated, true);
	assert.equal((await localAppGraphql.json()).data.delegated, true);
	assert.equal((await otherAddon.json()).data.delegated, true);
	assert.equal((await unrelatedOperation.json()).data.delegated, true);
});

test('ignores target-looking GraphQL comments and string literals', async () => {
	const calls = [];
	const host = {
		Response,
		fetch: async (...args) => {
			calls.push(args);
			return jsonResponse({ data: { delegated: true } });
		},
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const commentResponse = await host.fetch(ENDPOINT, requestInit(`query AddonLibrary {
		addons { name }
		# addon(slug: "local-media-proxy") { details { overview } }
	}`));
	const stringResponse = await host.fetch(ENDPOINT, requestInit(`query Search {
		search(query: """addon(slug: "local-media-proxy") { details { overview } }""") { id }
	}`));

	assert.equal(calls.length, 2);
	assert.equal((await commentResponse.json()).data.delegated, true);
	assert.equal((await stringResponse.json()).data.delegated, true);
	assert.equal(commentResponse.headers.get('x-local-media-proxy-metadata'), null);
	assert.equal(stringResponse.headers.get('x-local-media-proxy-metadata'), null);
});

test('delegates when a different operation is selected from a multi-operation document', async () => {
	const calls = [];
	const host = {
		Response,
		fetch: async (...args) => {
			calls.push(args);
			return jsonResponse({ data: { delegated: true } });
		},
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const document = `
		query LocalMediaProxyDetails {
			addon(slug: "local-media-proxy") { details { overview } }
		}
		query AddonLibrary { addons { name } }
	`;
	const response = await host.fetch(
		ENDPOINT,
		requestInit(document, 'AddonLibrary'),
	);

	assert.equal(calls.length, 1);
	assert.equal((await response.json()).data.delegated, true);
	assert.equal(response.headers.get('x-local-media-proxy-metadata'), null);
});

test('uses packaged metadata when the target operation is selected explicitly', async () => {
	const calls = [];
	const host = {
		Response,
		fetch: async (...args) => {
			calls.push(args);
			return jsonResponse({ data: { addon: null } });
		},
	};
	installMarketplaceMetadataShim(host, { endpoint: ENDPOINT });

	const document = `
		query AddonLibrary { addons { name } }
		query LocalMediaProxyDetails {
			addon(slug: "local-media-proxy") { details { overview } }
		}
	`;
	const response = await host.fetch(
		ENDPOINT,
		requestInit(document, 'LocalMediaProxyDetails'),
	);
	const payload = await response.json();

	assert.equal(calls.length, 1);
	assert.equal(payload.data.addon.name, 'Local Media Proxy');
	assert.equal(response.headers.get('x-local-media-proxy-metadata'), 'packaged-fallback');
});

test('installs the marketplace shim only once per renderer host', async () => {
	let calls = 0;
	const host = {
		Response,
		fetch: async () => {
			calls += 1;
			return jsonResponse({ data: { addon: null } });
		},
	};

	assert.equal(installMarketplaceMetadataShim(host, { endpoint: ENDPOINT }), true);
	assert.equal(installMarketplaceMetadataShim(host, { endpoint: ENDPOINT }), false);
	await host.fetch(ENDPOINT, requestInit(DETAIL_QUERY));
	assert.equal(calls, 1);
});
