/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADDON_ID, ADDON_NAME, ADDON_VERSION } from './constants';

const DEFAULT_GRAPHQL_ENDPOINT = 'https://api.localbyflywheel.com/graphql';
const SHIM_MARKER = '__localMediaProxyMarketplaceMetadataShimV1';

type MarketplaceQueryKind = 'detail' | 'releases';

interface MarketplaceGraphqlRequest {
	operationName: string | null;
	query: string;
}

interface GraphqlToken {
	end: number;
	start: number;
	type: 'name' | 'punctuator' | 'string';
	value: string;
}

interface GraphqlOperation {
	name: string | null;
	source: string;
}

interface PackagedRelease {
	changelog: string;
	date: string;
	id: string;
	version: string;
}

export interface MarketplaceFetchHost {
	fetch: typeof fetch;
	Response: typeof Response;
}

export interface MarketplaceShimOptions {
	endpoint?: string;
	packageRoot?: string;
}

interface MarkedMarketplaceFetchHost extends MarketplaceFetchHost {
	[SHIM_MARKER]?: boolean;
}

function assetUrl(packageRoot: string, ...segments: string[]): string {
	return pathToFileURL(path.join(packageRoot, ...segments)).href;
}

function createOverview(heroUrl: string): string {
	return `![Local Media Proxy settings and local-first request flow](${heroUrl})

${ADDON_NAME} is an Amsive add-on that keeps cloned WordPress sites lightweight without losing remote upload assets. It serves files already available in Local and retrieves only safe missing assets from a configured remote site.

Configuration is independent for every site, with separate saved profiles for Nginx and Apache. Nginx mode uses a Site URL plus a remote IP and can discover WP Engine or public-DNS candidates without applying them automatically. Apache mode requires only the Site URL and uses its hostname for DNS, HTTP Host, TLS SNI, and certificate verification.

For any provider on Nginx, the Site URL supplies HTTP Host and TLS identity while the remote IP selects the endpoint, which may be the origin itself or a compatible proxy, CDN, or load balancer. Apache intentionally uses one hostname for all of those roles.

## How it works

1. A browser requests an asset under \`/wp-content/uploads/\`.
2. If the file exists locally, Local serves it normally.
3. If it is missing, the add-on connects to the configured endpoint with a verified TLS identity. Nginx can use a separate remote IP and verified WP Engine identity; Apache deliberately uses the Site URL hostname for the complete connection identity.
4. The response is streamed to the browser and is not permanently cached locally.

## Install and configure

1. Download \`local-media-proxy-v<version>.tgz\` from the matching [GitHub release](https://github.com/amsive/local-media-proxy/releases). Select the TGZ directly in Local; do not extract it first.
2. When replacing an existing installation, disable and remove its Installed Add-ons entry first; Local does not overwrite the same add-on slug. A release before v0.4.1 may clear a site's enabled state during that one-time replacement, so enable the site once after installing v0.4.1. Later v0.4.1 disable and reinstall cycles preserve enabled intent.
3. In Local, open **Add-ons → Installed** and choose **Install from disk**.
4. Enable **Local Media Proxy** and relaunch Local if prompted.
5. Start a site that uses Nginx or Apache, then open **Tools → Media Proxy**.
6. Enter the Site URL or choose **Auto-populate from WP Engine** for a connected environment. On Nginx, also enter a remote IP or choose **Find via public DNS**. Apache intentionally omits the IP and DNS-candidate controls.
7. On Nginx, review any suggested IPv4 or IPv6 address. On Apache, review the Site URL hostname that will be used for DNS, Host, SNI, and certificate verification.
8. Select **Test connection**. This checks endpoint reachability and, for HTTPS, certificate identity and trust—not a media file.
9. Select **Save & apply** after changing connection setup, then turn on **Enable for this site**. The enable switch saves and applies its on/off state immediately.
10. Load an actual upload that is missing locally and confirm it succeeds through the Local site.

Auto-populated values remain unsaved suggestions and are never enabled or applied automatically. Test them before explicitly applying them. Flywheel-connected sites retain the manual setup because Local does not publish a supported Flywheel environment API for add-ons; Nginx also offers DNS-assisted IP discovery, while Apache uses the Site URL hostname directly.

The on/off intent is shared across web servers while Nginx and Apache retain their own connection values. On the first change to a truly untouched server profile, only the validated Site URL is carried across; no IP, hosting, TLS, certificate, timestamp, or verification metadata is copied, and an existing or intentionally cleared profile is not overwritten. An enabled proxy automatically applies a complete destination profile. Nginx still requires its own remote IP; otherwise, the activation controls remain unavailable and explain what still needs setup.

## Verify and disable

Open a page containing an upload that is missing locally. Remote fallbacks include the response header \`X-Local-Media-Proxy: origin\`; locally served files do not.

To disable the fallback, turn off either **Enable for this site** or the compact **Media Proxy** switch on the site's Overview tab. The change saves and applies immediately. Saved connection fields remain available while managed configuration is removed and the selected service is refreshed. If Local cannot resolve or load that service, cleanup is deferred without changing settings or files; the Overview information tooltip and Tools help explain the problem. Stop the site, restore the service, and retry before uninstalling.

## Scope and safety

- Supports Local sites using Nginx or Apache.
- Proxies safe missing files beneath \`/wp-content/uploads/\` without enumerating allowed extensions.
- Existing non-dangerous local files always take priority; hidden and server-executable paths stay blocked.
- Allows only \`GET\` and \`HEAD\` requests.
- Does not forward cookies, credentials, nonces, forwarding headers, or request bodies; a fixed add-on User-Agent replaces the browser's identity. Nginx reconstructs only range negotiation. Apache explicitly removes known browser, credential, forwarding, and tracing headers before preserving range requests; future benign header names do not block proxying.
- Requires a visible filename with an extension and rejects executable, browser-active, hidden, configuration, secret, database, and backup paths. SVG remains supported as a media format.
- Rejects browser execution destinations for missing assets and removes upstream redirect targets while retaining document and embed support for PDFs, SVG, and other media.
- Apache HTTPS requires Local's platform bundle to include \`mod_ssl\`. The current official Intel macOS +11 bundle is Apache HTTP-only; the site UI detects and explains this before testing or writing configuration.
- Supports images, video, audio, captions, PDFs, documents, fonts, archives, generated CSS, data, streaming manifests, and unknown future asset formats. Themes, plugins, API requests, non-upload paths, and arbitrary URLs remain local-only.
- Supported HTTPS endpoints require a trusted certificate. Apache always verifies the Site URL hostname; Nginx retains its existing guarded support for separately verified WP Engine identities.

## Troubleshooting

- **Unsupported-server warning:** Use an unambiguous Local Nginx or Apache HTTP service.
- **Connection test fails:** Verify the URL scheme and optional port. On Nginx, also verify the remote IP and retry a suitable DNS candidate when applicable.
- **Certificate error:** Confirm the endpoint serves the Site URL hostname and uses a public CA or Cloudflare Origin CA certificate.
- **An asset still fails:** Confirm the exact upload exists on the selected remote site, includes a visible filename and extension, is not in a blocked safety category, and that its origin, proxy, or CDN permits the add-on's stripped, read-only request.

${ADDON_NAME} is maintained by Amsive LLC and developed by Mark Davoli and Boris Hegedis. It is community-supported software distributed under the [Apache License 2.0](https://github.com/amsive/local-media-proxy/blob/main/LICENSE) without a support SLA. See the [support policy](https://github.com/amsive/local-media-proxy/blob/main/SUPPORT.md) and [trademark policy](https://github.com/amsive/local-media-proxy/blob/main/TRADEMARKS.md).`;
}

function createCurrentReleaseNotes(): string {
	return `Version 0.4.2 refines missing-upload filtering so ordinary media filename prefixes do not look like server-interpreter paths.

- Proxy safe final extensions after ordinary filename prefixes containing interpreter-like words, while continuing to block interpreter extensions and path-info forms such as \`shell.php.jpg\`. ([#45](https://github.com/amsive/local-media-proxy/issues/45))

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createV041ReleaseNotes(): string {
	return `Version 0.4.1 proxies more types of safe missing uploads and improves reliability across add-on and web-server changes.

- Proxy missing video, audio, documents, fonts, and other safe uploads while keeping existing local files first. ([#32](https://github.com/amsive/local-media-proxy/issues/32))
- Support media seeking and partial downloads on Nginx and Apache. ([#32](https://github.com/amsive/local-media-proxy/issues/32))
- Preserve enabled status across disable or reinstall, and carry only the Site URL into a new server profile. ([#31](https://github.com/amsive/local-media-proxy/issues/31), [#33](https://github.com/amsive/local-media-proxy/issues/33))
- Repair confirmed configuration drift without unnecessary reloads or repeated connection tests. ([#34](https://github.com/amsive/local-media-proxy/issues/34), [#38](https://github.com/amsive/local-media-proxy/issues/38))
- Recover verified stale Local web-server processes without affecting unrelated services, and accept safe Apache headers. ([#32](https://github.com/amsive/local-media-proxy/issues/32), [#39](https://github.com/amsive/local-media-proxy/issues/39))

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createV031ReleaseNotes(): string {
	return `Version 0.3.1 restores Media Proxy setup on running Apache sites while preserving Local site-lifecycle protections.

- Running Apache sites no longer remain on the web-server preparation screen when Local's core Apache templates are ready but the add-on's own managed-file directory has not been created yet. ([#29](https://github.com/amsive/local-media-proxy/issues/29))
- Apache setup creates only its add-on-owned managed-file directory and continues to stay out of Local's site creation, replacement, and deletion work.
- Nginx readiness and managed-file behavior are unchanged.

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createV030ReleaseNotes(): string {
	return `Version 0.3.0 keeps Local Media Proxy out of Local's site creation, first-pull, and deletion work.

- Defers managed-file inspection and reconciliation until Local reports the site as running or halted, so early lifecycle notifications do not block provisioning or a first WP Engine pull.
- Cancels deferred work when deletion starts and treats missing or transitional site roots as unavailable instead of reading, restoring, or creating files.
- Revalidates the site before every managed write, rename, and removal, and commits settings only after the server configuration succeeds.
- Adds a required lifecycle smoke test for every future release, including numbered non-client fixtures, log review, and complete fixture cleanup.

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createV024ReleaseNotes(): string {
	return `Version 0.2.4 restores the README screenshot and adds link attribution without changing Local Media Proxy behavior.

- Restored the reviewed origin-discovery screenshot in both the public and packaged README without linking to removed repository history.
- Added consistent campaign attribution to Amsive links in the public README and installed add-on metadata.

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createV023ReleaseNotes(): string {
	return `Version 0.2.3 prepares the project for public open-source collaboration without changing proxy or TLS behavior.

- Added machine-readable third-party provenance and an offline release gate that pins both bundled Cloudflare Origin CA roots, their fingerprints, and the exact trust-file hash.
- Added project-specific issue forms, security scope, contributor conduct and DCO guidance, and monthly npm dependency updates.
- Simplified the installation and usage landing page while moving advanced proxy, TLS, and managed-file details into dedicated technical documentation.
- Preserved standard public CA trust, both Cloudflare Origin CA roots, strict hostname and chain verification, and the exact minimal installer boundary.

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createPackagedReleaseHistory(): PackagedRelease[] {
	return [
		{
			changelog: createCurrentReleaseNotes(),
			date: '2026-08-18T00:00:00.000Z',
			id: `${ADDON_ID}-${ADDON_VERSION}`,
			version: ADDON_VERSION,
		},
		{
			changelog: createV041ReleaseNotes(),
			date: '2026-08-05T00:00:00.000Z',
			id: `${ADDON_ID}-0.4.1`,
			version: '0.4.1',
		},
		{
			changelog: createV031ReleaseNotes(),
			date: '2026-07-30T00:00:00.000Z',
			id: `${ADDON_ID}-0.3.1`,
			version: '0.3.1',
		},
		{
			changelog: createV030ReleaseNotes(),
			date: '2026-07-27T00:00:00.000Z',
			id: `${ADDON_ID}-0.3.0`,
			version: '0.3.0',
		},
		{
			changelog: createV024ReleaseNotes(),
			date: '2026-07-24T00:00:00.000Z',
			id: `${ADDON_ID}-0.2.4`,
			version: '0.2.4',
		},
	];
}

export function createMarketplaceDetailPayload(
	packageRoot = path.resolve(__dirname, '..'),
): Record<string, unknown> {
	return {
		data: {
			addon: {
				avatar: {
					original: assetUrl(packageRoot, 'resources', 'detail-icon.svg'),
				},
				categories: [
					{ name: 'Developer Tools' },
					{ name: 'WordPress' },
				],
				collaborators: [
					{
						avatar: {
							original: assetUrl(packageRoot, 'resources', 'mark-davoli-avatar.svg'),
						},
						name: 'Mark Davoli',
					},
					{
						avatar: {
							original: assetUrl(packageRoot, 'resources', 'boris-hegedis-avatar.svg'),
						},
						name: 'Boris Hegedis',
					},
				],
				color: '#6E187A',
				details: {
					homepage: 'https://www.amsive.com/?utm_source=localwp&utm_medium=referral&utm_campaign=local_media_proxy&utm_content=addon_details',
					license: 'Apache-2.0',
					overview: createOverview(assetUrl(packageRoot, 'resources', 'detail-hero.svg')),
					repository: 'https://github.com/amsive/local-media-proxy',
					support: 'https://github.com/amsive/local-media-proxy/issues',
				},
				developer: {
					addonsCount: 1,
					avatar: {
						original: assetUrl(packageRoot, 'resources', 'amsive-avatar.svg'),
					},
					name: 'Amsive',
				},
				excerpt: 'Load safe missing WordPress upload assets from a remote site while keeping existing files local.',
				name: ADDON_NAME,
				npmPackageName: ADDON_ID,
				releases: [
					{
						downloadUrl: `https://github.com/amsive/local-media-proxy/releases/download/v${ADDON_VERSION}/local-media-proxy-v${ADDON_VERSION}.tgz`,
						localRequirement: '>=10.1.1',
						testedUpTo: '10.1.1',
						version: ADDON_VERSION,
					},
				],
				type: { name: 'Extension' },
				verified: false,
			},
		},
	};
}

export function createMarketplaceReleasesPayload(): Record<string, unknown> {
	return {
		data: {
			addon: {
				releases: createPackagedReleaseHistory(),
			},
		},
	};
}

function queryKind(query: string): MarketplaceQueryKind | null {
	const tokens = tokenizeGraphql(query);
	if (!tokens) {
		return null;
	}

	const targetAddon = tokens.some((token, index) => token.type === 'name'
		&& token.value === 'addon'
		&& tokens[index + 1]?.type === 'punctuator'
		&& tokens[index + 1]?.value === '('
		&& tokens[index + 2]?.type === 'name'
		&& tokens[index + 2]?.value === 'slug'
		&& tokens[index + 3]?.type === 'punctuator'
		&& tokens[index + 3]?.value === ':'
		&& tokens[index + 4]?.type === 'string'
		&& tokens[index + 4]?.value === ADDON_ID);
	if (!targetAddon) {
		return null;
	}

	const fieldNames = new Set(
		tokens
			.filter(({ type }) => type === 'name')
			.map(({ value }) => value),
	);

	if (fieldNames.has('changelog') && fieldNames.has('releases')) {
		return 'releases';
	}

	if (fieldNames.has('details') && fieldNames.has('overview')) {
		return 'detail';
	}

	return null;
}

function tokenizeGraphql(source: string): GraphqlToken[] | null {
	const tokens: GraphqlToken[] = [];
	let index = 0;

	while (index < source.length) {
		const character = source[index];

		if (/[,\s]/.test(character)) {
			index += 1;
			continue;
		}

		if (character === '#') {
			while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
				index += 1;
			}
			continue;
		}

		if (source.startsWith('"""', index)) {
			const start = index;
			index += 3;
			let closed = false;
			while (index < source.length) {
				if (source.startsWith('\\"""', index)) {
					index += 4;
					continue;
				}
				if (source.startsWith('"""', index)) {
					index += 3;
					closed = true;
					break;
				}
				index += 1;
			}
			if (!closed) {
				return null;
			}
			tokens.push({
				end: index,
				start,
				type: 'string',
				value: source.slice(start + 3, index - 3),
			});
			continue;
		}

		if (character === '"') {
			const start = index;
			index += 1;
			let closed = false;
			while (index < source.length) {
				if (source[index] === '\\') {
					index += 2;
					continue;
				}
				if (source[index] === '"') {
					index += 1;
					closed = true;
					break;
				}
				index += 1;
			}
			if (!closed) {
				return null;
			}
			tokens.push({
				end: index,
				start,
				type: 'string',
				value: source.slice(start + 1, index - 1),
			});
			continue;
		}

		if (/[A-Za-z_]/.test(character)) {
			const start = index;
			index += 1;
			while (index < source.length && /[0-9A-Za-z_]/.test(source[index])) {
				index += 1;
			}
			tokens.push({
				end: index,
				start,
				type: 'name',
				value: source.slice(start, index),
			});
			continue;
		}

		tokens.push({
			end: index + 1,
			start: index,
			type: 'punctuator',
			value: character,
		});
		index += 1;
	}

	return tokens;
}

function selectionStart(tokens: GraphqlToken[], start: number): number | null {
	let parentheses = 0;
	let brackets = 0;

	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.type !== 'punctuator') {
			continue;
		}
		const value = token.value;
		if (value === '(') {
			parentheses += 1;
		} else if (value === ')') {
			if (parentheses === 0) {
				return null;
			}
			parentheses -= 1;
		} else if (value === '[') {
			brackets += 1;
		} else if (value === ']') {
			if (brackets === 0) {
				return null;
			}
			brackets -= 1;
		} else if (value === '{' && parentheses === 0 && brackets === 0) {
			return index;
		}
	}

	return null;
}

function selectionEnd(tokens: GraphqlToken[], start: number): number | null {
	let braces = 0;

	for (let index = start; index < tokens.length; index += 1) {
		if (tokens[index].type === 'punctuator' && tokens[index].value === '{') {
			braces += 1;
		} else if (tokens[index].type === 'punctuator' && tokens[index].value === '}') {
			braces -= 1;
			if (braces === 0) {
				return index;
			}
		}
	}

	return null;
}

function graphqlOperations(source: string): GraphqlOperation[] | null {
	const tokens = tokenizeGraphql(source);
	if (!tokens) {
		return null;
	}

	const operations: GraphqlOperation[] = [];
	let index = 0;

	while (index < tokens.length) {
		const token = tokens[index];
		const explicitOperation = token.type === 'name'
			&& ['query', 'mutation', 'subscription'].includes(token.value);
		const anonymousOperation = token.type === 'punctuator' && token.value === '{';
		const fragment = token.type === 'name' && token.value === 'fragment';

		if (!explicitOperation && !anonymousOperation && !fragment) {
			index += 1;
			continue;
		}

		const start = anonymousOperation ? index : selectionStart(tokens, index + 1);
		if (start === null) {
			return null;
		}

		const end = selectionEnd(tokens, start);
		if (end === null) {
			return null;
		}

		if (!fragment) {
			const possibleName = explicitOperation ? tokens[index + 1] : undefined;
			operations.push({
				name: possibleName?.type === 'name' ? possibleName.value : null,
				source: source.slice(token.start, tokens[end].end),
			});
		}

		index = end + 1;
	}

	return operations;
}

function selectedOperationQuery(
	query: string,
	operationName: string | null,
): string | null {
	const operations = graphqlOperations(query);
	if (!operations || operations.length === 0) {
		return null;
	}

	if (operationName !== null) {
		const matches = operations.filter(({ name }) => name === operationName);
		return matches.length === 1 ? matches[0].source : null;
	}

	return operations.length === 1 ? operations[0].source : null;
}

function requestMatchesEndpoint(input: RequestInfo | URL, endpoint: string): boolean {
	const requestUrl = typeof input === 'string'
		? input
		: input instanceof URL
			? input.href
			: input.url;

	try {
		const request = new URL(requestUrl);
		const expected = new URL(endpoint);
		return request.protocol === expected.protocol
			&& request.host === expected.host
			&& request.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '');
	} catch {
		return requestUrl === endpoint;
	}
}

async function requestDocument(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<MarketplaceGraphqlRequest | null> {
	let body = typeof init?.body === 'string' ? init.body : '';

	if (!body && typeof Request !== 'undefined' && input instanceof Request) {
		body = await input.clone().text();
	}

	if (!body) {
		return null;
	}

	try {
		const payload = JSON.parse(body) as {
			operationName?: unknown;
			query?: unknown;
		};
		if (typeof payload.query !== 'string') {
			return null;
		}
		if (payload.operationName !== undefined
			&& payload.operationName !== null
			&& typeof payload.operationName !== 'string') {
			return null;
		}

		return {
			operationName: typeof payload.operationName === 'string'
				? payload.operationName
				: null,
			query: payload.query,
		};
	} catch {
		return null;
	}
}

async function responseHasAddon(response: Response): Promise<boolean> {
	if (!response.ok) {
		return false;
	}

	try {
		const payload = await response.clone().json() as {
			data?: { addon?: unknown };
		};
		return Boolean(payload.data?.addon);
	} catch {
		return false;
	}
}

function fallbackResponse(
	host: MarketplaceFetchHost,
	payload: Record<string, unknown>,
): Response {
	return new host.Response(JSON.stringify(payload), {
		headers: {
			'content-type': 'application/json',
			'x-local-media-proxy-metadata': 'packaged-fallback',
		},
		status: 200,
		statusText: 'OK',
	});
}

export function installMarketplaceMetadataShim(
	host: MarketplaceFetchHost,
	options: MarketplaceShimOptions = {},
): boolean {
	const markedHost = host as MarkedMarketplaceFetchHost;
	if (markedHost[SHIM_MARKER]) {
		return false;
	}

	if (typeof host.fetch !== 'function' || typeof host.Response !== 'function') {
		return false;
	}

	const endpoint = options.endpoint || DEFAULT_GRAPHQL_ENDPOINT;
	const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
	const originalFetch = host.fetch.bind(host);

	host.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (!requestMatchesEndpoint(input, endpoint)) {
			return originalFetch(input, init);
		}

		const document = await requestDocument(input, init);
		const query = document
			? selectedOperationQuery(document.query, document.operationName)
			: null;
		const kind = query ? queryKind(query) : null;
		if (!kind) {
			return originalFetch(input, init);
		}

		try {
			const upstream = await originalFetch(input, init);
			if (await responseHasAddon(upstream)) {
				return upstream;
			}
		} catch {
			// The packaged page also provides useful help when the marketplace is offline.
		}

		return fallbackResponse(
			host,
			kind === 'detail'
				? createMarketplaceDetailPayload(packageRoot)
				: createMarketplaceReleasesPayload(),
		);
	}) as typeof fetch;

	Object.defineProperty(markedHost, SHIM_MARKER, {
		configurable: false,
		enumerable: false,
		value: true,
		writable: false,
	});

	return true;
}
