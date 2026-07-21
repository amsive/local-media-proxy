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

${ADDON_NAME} is an Amsive add-on that keeps cloned WordPress sites lightweight without losing remote imagery. It serves upload images already available in Local and retrieves only missing images from a configured remote site.

Configuration is independent for every site. The Site URL supplies the HTTP hostname, while the remote IP selects the endpoint Local connects to. That endpoint may be a direct origin or a compatible proxy, CDN, or load balancer that serves the Site URL. The add-on can discover WP Engine environments and public-DNS candidates without applying them automatically.

## How it works

1. A browser requests an image under \`/wp-content/uploads/\`.
2. If the file exists locally, Local serves it normally.
3. If it is missing, the add-on connects to the configured remote IP using the Site URL as HTTP Host and a verified TLS identity. WP Engine discovery retains the provider's direct CNAME for TLS while using the primary domain as Host.
4. The response is streamed to the browser and is not permanently cached locally.

## Install and configure

1. Download \`local-media-proxy-v<version>.tgz\` from the matching [GitHub release](https://github.com/amsive/local-media-proxy/releases). Select the TGZ directly in Local; do not extract it first.
2. When replacing an existing installation, disable and remove its Installed Add-ons entry first; Local does not overwrite the same add-on slug.
3. In Local, open **Add-ons → Installed** and choose **Install from disk**.
4. Enable **Local Media Proxy** and relaunch Local if prompted.
5. Start a site that uses Nginx, then open **Tools → Media Proxy**.
6. For a connected WP Engine site, select Production, Staging, or Development and choose **Auto-populate from WP Engine**. Otherwise enter a Site URL and optionally choose **Find IP addresses**.
7. Review the suggested remote IPv4 or IPv6 address. A provider-supplied direct origin is preferred, but a compatible proxy or CDN address can also work. Public-DNS addresses may be shared or change.
8. Select **Test connection**. This checks endpoint reachability and, for HTTPS, certificate identity and trust—not a media file.
9. Turn on **Enable for this site**, then select **Save & apply**.
10. Load an actual upload that is missing locally and confirm it succeeds through the Local site.

Auto-populated values remain unsaved suggestions and are never enabled or applied automatically. Test them before explicitly applying them. Flywheel-connected sites retain the manual and DNS-assisted workflow because Local does not publish a supported Flywheel environment API for add-ons.

## Verify and disable

Open a page containing an upload that is missing locally. Remote fallbacks include the response header \`X-Local-Media-Proxy: origin\`; locally served files do not.

To disable the fallback, turn off **Enable for this site** and select **Save & apply**. The URL and IP remain saved for future use while the managed Nginx configuration is removed. Disable configured sites before uninstalling the add-on.

## Scope and safety

- Supports Local sites using Nginx.
- Proxies only missing image files beneath \`/wp-content/uploads/\`.
- Existing local media always takes priority.
- Allows only \`GET\` and \`HEAD\` requests.
- Does not forward cookies, credentials, request bodies, or visitor-identifying proxy headers; a fixed add-on User-Agent replaces the browser's identity.
- Does not proxy PDFs, video, audio, themes, plugins, API requests, or arbitrary URLs.
- HTTPS endpoints require a valid certificate for the Site URL hostname, a narrowly verified provider identity for a manual WP Engine origin, or the validated direct environment CNAME from WP Engine auto-population.

## Troubleshooting

- **Nginx-only warning:** Change the site's web server to Nginx before enabling.
- **Connection test fails:** Verify the URL scheme, optional port, and remote IP. For a DNS-discovered address, resolve again and try another candidate.
- **Certificate error:** Confirm the endpoint serves the Site URL hostname and uses a public CA or Cloudflare Origin CA certificate.
- **An image still fails:** Confirm the exact upload exists on the selected remote site and that its origin, proxy, or CDN permits the add-on's stripped, read-only request.

${ADDON_NAME} is maintained by Amsive LLC and developed by Mark Davoli and Boris Hegedis. It is community-supported software distributed under the [Apache License 2.0](https://github.com/amsive/local-media-proxy/blob/main/LICENSE) without a support SLA. See the [support policy](https://github.com/amsive/local-media-proxy/blob/main/SUPPORT.md) and [trademark policy](https://github.com/amsive/local-media-proxy/blob/main/TRADEMARKS.md).`;
}

function createCurrentReleaseNotes(): string {
	return `Version 0.1.1 maintenance release.

- Kept build-job output as validated data across the draft-release permission boundary.
- Bound the publisher's version, installer filename, checksum filename, and visible release title to the exact SemVer tag.
- Restricted credential placeholders to explicit whole-value forms in both source and installer checks.
- Preserved the Local-installable TGZ format, npm's standard \`package/\` root, and exact minimal runtime manifest.

[View the full changelog](https://github.com/amsive/local-media-proxy/blob/main/CHANGELOG.md).`;
}

function createPackagedReleaseHistory(): PackagedRelease[] {
	return [
		{
			changelog: createCurrentReleaseNotes(),
			date: '2026-07-21T00:00:00.000Z',
			id: `${ADDON_ID}-${ADDON_VERSION}`,
			version: ADDON_VERSION,
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
					original: assetUrl(packageRoot, 'icon.svg'),
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
					homepage: 'https://www.amsive.com/',
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
				excerpt: 'Load missing WordPress upload images from a remote site while keeping existing media local.',
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
