/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecFileOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as Local from '@getflywheel/local';
import {
	APACHE_UPLOAD_ASSET_ROUTE_PATTERN,
	BLOCKED_UPLOAD_ASSET_PATH_PATTERN,
	UNSAFE_RAW_PERCENT_ENCODING_PATTERN,
	UPLOAD_ASSET_ROUTE_REVISION,
	UPLOAD_ASSET_URI_PATTERN,
	uploadAssetPathIsProxyEligible,
} from './asset-policy';
import {
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
	PROXIED_CONTENT_SECURITY_POLICY,
	PROXIED_RESPONSE_HEADERS_TO_STRIP,
} from './constants';
import type { NormalizedOrigin } from './types';
import type { ExecFilePromise } from './nginx';

const APACHE_COMMAND_TIMEOUT_MS = 10_000;
const APACHE_READINESS_ATTEMPTS = 20;
const APACHE_READINESS_INTERVAL_MS = 100;
const APACHE_REQUEST_HEADERS_TO_STRIP = [
	'Accept',
	'Accept-Charset',
	'Accept-Encoding',
	'Accept-Language',
	'Authorization',
	'B3',
	'Baggage',
	'Cache-Control',
	'CF-Access-Client-Id',
	'CF-Access-Client-Secret',
	'CF-Connecting-IP',
	'Content-Encoding',
	'Content-Language',
	'Content-Length',
	'Content-Location',
	'Content-MD5',
	'Content-Type',
	'Cookie',
	'Device-Memory',
	'Digest',
	'DNT',
	'Downlink',
	'DPR',
	'Early-Data',
	'ECT',
	'Expect',
	'Fastly-Client-IP',
	'Forwarded',
	'From',
	'If-Match',
	'If-Modified-Since',
	'If-None-Match',
	'If-Unmodified-Since',
	'Max-Forwards',
	'Origin',
	'Pragma',
	'Priority',
	'Purpose',
	'Proxy-Authorization',
	'Referer',
	'Sec-CH-UA',
	'Sec-CH-UA-Arch',
	'Sec-CH-UA-Bitness',
	'Sec-CH-UA-Full-Version',
	'Sec-CH-UA-Full-Version-List',
	'Sec-CH-UA-Mobile',
	'Sec-CH-UA-Model',
	'Sec-CH-UA-Platform',
	'Sec-CH-UA-Platform-Version',
	'Sec-CH-UA-WoW64',
	'Sec-CH-Prefers-Color-Scheme',
	'Sec-CH-Prefers-Contrast',
	'Sec-CH-Prefers-Reduced-Motion',
	'Sec-CH-Prefers-Reduced-Transparency',
	'Sec-CH-Viewport-Height',
	'Sec-CH-Viewport-Width',
	'Sec-Fetch-Dest',
	'Sec-Fetch-Mode',
	'Sec-Fetch-Site',
	'Sec-Fetch-User',
	'Sec-GPC',
	'Sec-Purpose',
	'Save-Data',
	'Sentry-Trace',
	'TE',
	'Traceparent',
	'Tracestate',
	'Trailer',
	'Transfer-Encoding',
	'True-Client-IP',
	'Uber-Trace-Id',
	'Upgrade',
	'Upgrade-Insecure-Requests',
	'Via',
	'Viewport-Width',
	'Want-Digest',
	'Warning',
	'Width',
	'X-Access-Token',
	'X-Amz-Credential',
	'X-Amz-Security-Token',
	'X-API-Key',
	'X-ARR-ClientCert',
	'X-Auth-Token',
	'X-B3-Flags',
	'X-B3-ParentSpanId',
	'X-B3-Sampled',
	'X-B3-SpanId',
	'X-B3-TraceId',
	'X-Client-Cert',
	'X-Client-IP',
	'X-Cloud-Trace-Context',
	'X-Cluster-Client-IP',
	'X-Correlation-ID',
	'X-CSRF-Token',
	'X-Device-ID',
	'X-Forwarded',
	'X-Forwarded-By',
	'X-Forwarded-Client-Cert',
	'X-Forwarded-For',
	'X-Forwarded-Host',
	'X-Forwarded-Path',
	'X-Forwarded-Port',
	'X-Forwarded-Prefix',
	'X-Forwarded-Proto',
	'X-Forwarded-Scheme',
	'X-Forwarded-Server',
	'X-Forwarded-Uri',
	'X-HTTP-Method',
	'X-HTTP-Method-Override',
	'X-Id-Token',
	'X-Method-Override',
	'X-Moz',
	'X-Original-Forwarded-For',
	'X-Original-Host',
	'X-Original-Method',
	'X-Original-URI',
	'X-Original-URL',
	'X-Originating-IP',
	'X-Ot-Span-Context',
	'X-Playback-Session-Id',
	'X-Purpose',
	'X-Real-IP',
	'X-Refresh-Token',
	'X-Remote-Addr',
	'X-Remote-IP',
	'X-Request-ID',
	'X-Requested-With',
	'X-Rewrite-URL',
	'X-Session-ID',
	'X-SSL-Client-Cert',
	'X-UIDH',
	'X-User-ID',
	'X-WP-Nonce',
] as const;
const APACHE_REQUEST_HEADERS_TO_ACCEPT = [
	...APACHE_REQUEST_HEADERS_TO_STRIP,
	'Connection',
	'Host',
	'If-Range',
	'Keep-Alive',
	'Range',
	'User-Agent',
] as const;

export interface ApacheRuntimeService {
	bin: { [binaryName: string]: string } | undefined;
	configPath: string;
	configVariables: Local.GenericObject;
	env?: NodeJS.ProcessEnv;
	runPath: string;
	siteConfigTemplatePath: string;
}

export interface ApacheConfigTemplates {
	compileConfigTemplates: (
		site: Local.Site,
		templatesDir: string,
		destDir: string,
		context: Local.GenericObject,
	) => Promise<void>;
}

export interface ApacheCompiledPaths {
	include: string;
	main: string;
	modules: string;
	site: string;
}

export interface ApacheRuntimeCapabilities {
	http: boolean;
	https: boolean;
	reason?: string;
}

export interface ApacheServiceRefreshOptions {
	assertCurrent?: () => void;
	attempts?: number;
	expectedManagedInclude?: string;
	expectedManagedModules?: string;
	intervalMs?: number;
	masterProcessExists?: (pid: number) => boolean;
	wait?: (milliseconds: number) => Promise<void>;
}

async function assertRealDirectoryPath(
	directoryPath: string,
	description: string,
	assertCurrent: () => void = (): void => undefined,
): Promise<string> {
	if (!directoryPath || !path.isAbsolute(directoryPath)) {
		throw new Error(`Local returned a relative ${description}.`);
	}
	const resolvedPath = path.resolve(directoryPath);
	let currentPath = path.parse(resolvedPath).root;
	const segments = path.relative(currentPath, resolvedPath).split(path.sep).filter(Boolean);
	for (const segment of segments) {
		assertCurrent();
		const metadata = await fs.lstat(currentPath);
		assertCurrent();
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(`Local returned an unsafe ${description}.`);
		}
		currentPath = path.join(currentPath, segment);
	}
	assertCurrent();
	const metadata = await fs.lstat(currentPath);
	assertCurrent();
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Local returned an unsafe ${description}.`);
	}
	return resolvedPath;
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerLineCount(config: string, marker: string): number {
	const escaped = escapeRegularExpression(marker);
	return (config.match(new RegExp(`^[\\t ]*${escaped}[\\t ]*$`, 'gm')) ?? []).length;
}

function hasExactManagedMarker(config: string): boolean {
	return markerLineCount(config, MANAGED_MARKER_START) > 0 ||
		markerLineCount(config, MANAGED_MARKER_END) > 0;
}

function isExpectedCompiledFileAbsence(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE';
}

async function readOptionalCompiledFile(
	rootPath: string,
	filePath: string,
	assertCurrent: () => void = (): void => undefined,
): Promise<string | null> {
	try {
		const root = await assertRealDirectoryPath(
			rootPath,
			'compiled Apache root',
			assertCurrent,
		);
		const relative = path.relative(root, filePath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Local returned an unsafe compiled Apache path.');
		}
		assertCurrent();
		let current = root;
		const segments = relative.split(path.sep);
		for (let index = 0; index < segments.length; index += 1) {
			current = path.join(current, segments[index]);
			assertCurrent();
			const metadata = await fs.lstat(current);
			const isFile = index === segments.length - 1;
			if (
				metadata.isSymbolicLink() ||
				(isFile ? !metadata.isFile() : !metadata.isDirectory())
			) {
				throw new Error('Local returned an unsafe compiled Apache path.');
			}
		}
		assertCurrent();
		const content = await fs.readFile(filePath, 'utf8');
		assertCurrent();
		return content;
	} catch (error) {
		if (isExpectedCompiledFileAbsence(error)) {
			return null;
		}
		throw error;
	}
}

function assertSafeApacheValue(value: string, description: string): string {
	if (!value || /[\r\n\0]/.test(value)) {
		throw new Error(`${description} contains an unsupported control character.`);
	}

	return value;
}

function quoteApache(value: string, description: string): string {
	return `"${assertSafeApacheValue(value, description)
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')}"`;
}

function quoteApachePattern(value: string, description: string): string {
	const safeValue = assertSafeApacheValue(value, description);
	if (safeValue.includes('"')) {
		throw new Error(`${description} contains an unsupported quote character.`);
	}

	return `"${safeValue}"`;
}

function quoteApachePath(value: string, description: string): string {
	const safeValue = assertSafeApacheValue(value, description);
	if (safeValue.includes('"')) {
		throw new Error(`${description} contains an unsupported quote character.`);
	}

	return `"${safeValue.replace(/\\/g, '/')}"`;
}

function defaultPort(protocol: NormalizedOrigin['protocol']): number {
	return protocol === 'https:' ? 443 : 80;
}

function backendAuthority(origin: NormalizedOrigin): string {
	return origin.port === defaultPort(origin.protocol)
		? origin.hostname
		: `${origin.hostname}:${origin.port}`;
}

export function apacheMediaPathIsProxyEligible(requestPath: string): boolean {
	return uploadAssetPathIsProxyEligible(requestPath);
}

export function removeApacheManagedBlock(template: string): string {
	const start = escapeRegularExpression(MANAGED_MARKER_START);
	const end = escapeRegularExpression(MANAGED_MARKER_END);
	const managedBlock = new RegExp(
		`^[\\t ]*${start}\\r?\\n[\\s\\S]*?^[\\t ]*${end}(?:\\r?\\n)?`,
		'gm',
	);

	return template.replace(managedBlock, '');
}

function appendManagedBlock(template: string, lines: string[]): string {
	const eol = template.includes('\r\n') ? '\r\n' : '\n';
	const cleanTemplate = removeApacheManagedBlock(template);
	if (hasExactManagedMarker(cleanTemplate)) {
		throw new Error('The Local Apache template contains an incomplete managed block.');
	}
	const prefix = cleanTemplate && !cleanTemplate.endsWith('\n') ? eol : '';
	return `${cleanTemplate}${prefix}${[
		MANAGED_MARKER_START,
		...lines,
		MANAGED_MARKER_END,
		'',
	].join(eol)}`;
}

export function upsertApacheInclude(template: string): string {
	const eol = template.includes('\r\n') ? '\r\n' : '\n';
	const cleanTemplate = removeApacheManagedBlock(template);
	if (hasExactManagedMarker(cleanTemplate)) {
		throw new Error('The Local Apache template contains an incomplete managed include block.');
	}
	const virtualHostEnd = /^[\t ]*<\/VirtualHost>[\t ]*$/gm;
	const matches = [...cleanTemplate.matchAll(virtualHostEnd)];
	if (matches.length === 0) {
		throw new Error('Could not find a VirtualHost block in the Local Apache template.');
	}

	let result = cleanTemplate;
	for (const match of matches.reverse()) {
		const index = match.index;
		const indent = match[0].match(/^[\t ]*/)?.[0] ?? '';
		const block = [
			`${indent}${MANAGED_MARKER_START}`,
			`${indent}Protocols http/1.1`,
			`${indent}IncludeOptional "{{ configPath }}/includes/local-media-proxy.conf"`,
			`${indent}${MANAGED_MARKER_END}`,
		].join(eol);
		result = `${result.slice(0, index)}${block}${eol}${result.slice(index)}`;
	}

	return result;
}

export function apacheModulePath(httpdBinary: string, filename: string): string {
	const providedBinary = assertSafeApacheValue(httpdBinary, 'Apache binary path');
	const pathApi = /^[A-Za-z]:[\\/]/.test(providedBinary) || providedBinary.startsWith('\\\\')
		? path.win32
		: path.posix;
	if (!pathApi.isAbsolute(providedBinary)) {
		throw new Error('Local returned a relative Apache service binary path.');
	}
	const binary = pathApi.normalize(providedBinary);
	const binaryName = pathApi.basename(binary).toLowerCase();
	if (
		(binaryName !== 'httpd' && binaryName !== 'httpd.exe') ||
		pathApi.basename(pathApi.dirname(binary)).toLowerCase() !== 'bin'
	) {
		throw new Error('Local returned an unexpected Apache service binary layout.');
	}

	return pathApi.join(pathApi.dirname(pathApi.dirname(binary)), 'modules', filename);
}

function apacheBundlePlatform(httpdBinary: string): string {
	const modulePath = apacheModulePath(httpdBinary, 'mod_headers.so');
	const pathApi = /^[A-Za-z]:[\\/]/.test(modulePath) || modulePath.startsWith('\\\\')
		? path.win32
		: path.posix;
	return pathApi.basename(pathApi.dirname(pathApi.dirname(modulePath)));
}

export function upsertApacheModules(
	template: string,
	httpdBinary: string,
	secure: boolean,
): string {
	const module = (identifier: string, filename: string): string[] => [
		`<IfModule !${identifier}>`,
		`\tLoadModule ${identifier} ${quoteApachePath(apacheModulePath(httpdBinary, filename), 'Apache module path')}`,
		'</IfModule>',
	];
	const modules = [
		...module('proxy_http_module', 'mod_proxy_http.so'),
		...module('headers_module', 'mod_headers.so'),
		...module('setenvif_module', 'mod_setenvif.so'),
		...(secure ? module('ssl_module', 'mod_ssl.so') : []),
	];

	return appendManagedBlock(template, modules);
}

export async function validateApacheModuleFiles(
	httpdBinary: string,
	secure: boolean,
): Promise<void> {
	const capabilities = await inspectApacheRuntimeCapabilities(httpdBinary);
	if (!capabilities.http || (secure && !capabilities.https)) {
		throw new Error(capabilities.reason || 'Local\'s Apache service is missing a required proxy module.');
	}
}

export async function inspectApacheRuntimeCapabilities(
	httpdBinary: string,
): Promise<ApacheRuntimeCapabilities> {
	const availability = new Map<string, boolean>();
	for (const filename of [
		'mod_proxy_http.so',
		'mod_headers.so',
		'mod_setenvif.so',
		'mod_ssl.so',
	]) {
		const modulePath = apacheModulePath(httpdBinary, filename);
		try {
			await fs.access(modulePath);
			availability.set(filename, true);
		} catch {
			availability.set(filename, false);
		}
	}
	const missingRequired = ['mod_proxy_http.so', 'mod_headers.so', 'mod_setenvif.so']
		.filter((filename) => !availability.get(filename));
	const platform = apacheBundlePlatform(httpdBinary);
	if (missingRequired.length > 0) {
		return {
			http: false,
			https: false,
			reason: `Local's Apache service bundle for ${platform} does not provide the required ${missingRequired.join(' and ')} module${missingRequired.length === 1 ? '' : 's'}, so Apache media proxying is unavailable on this platform.`,
		};
	}
	if (!availability.get('mod_ssl.so')) {
		return {
			http: true,
			https: false,
			reason: `Local's Apache service bundle for ${platform} does not provide the required mod_ssl.so module. Apache HTTP origins remain supported, but Apache HTTPS origins are unavailable with this Local bundle.`,
		};
	}
	return { http: true, https: true };
}

export function hasApacheManagedBlock(template: string): boolean {
	return hasExactManagedMarker(template);
}

export function hasCompleteApacheManagedBlock(template: string): boolean {
	const cleaned = removeApacheManagedBlock(template);
	return cleaned !== template && !hasExactManagedMarker(cleaned);
}

export function apacheConfigReferencesInclude(siteConfig: string, expectedInclude: string): boolean {
	return apacheIncludeReferenceCount(siteConfig, expectedInclude) > 0;
}

export function buildManagedApacheConfig(
	origin: NormalizedOrigin,
	trustBundlePath?: string,
): string {
	if (origin.originIp !== origin.hostname || origin.tlsHostname !== origin.hostname) {
		throw new Error('Apache requires hostname-based origin routing from the Site URL.');
	}
	if (origin.protocol === 'https:' && !trustBundlePath) {
		throw new Error('HTTPS origins require a trusted certificate authority bundle.');
	}

	const authority = backendAuthority(origin);
	const backend = `${origin.protocol}//${authority}`;
	const route = APACHE_UPLOAD_ASSET_ROUTE_PATTERN;
	const uploadsGuardRoute = '^/wp-content/uploads/';
	const unknownHeaderPattern =
		`^(?!(?:${APACHE_REQUEST_HEADERS_TO_ACCEPT.map(escapeRegularExpression).join('|')})$).+`;
	const tls = origin.protocol === 'https:'
		? [
			'SSLProxyEngine On',
			'SSLProxyVerify require',
			'SSLProxyVerifyDepth 5',
			'SSLProxyCheckPeerName on',
			'SSLProxyCheckPeerExpire on',
			`SSLProxyCACertificateFile ${quoteApachePath(trustBundlePath as string, 'Apache trust bundle path')}`,
		]
		: [];

	return [
		MANAGED_MARKER_START,
		'# Generated by Local Media Proxy. Changes will be overwritten.',
		`# Managed route revision: ${UPLOAD_ASSET_ROUTE_REVISION}`,
		'ProxyRequests Off',
		...tls,
		'',
		`SetEnvIfNoCase ${quoteApachePattern(unknownHeaderPattern, 'Apache accepted request headers')} ".+" LOCAL_MEDIA_PROXY_UNKNOWN_HEADER=1`,
		'',
		`<LocationMatch "(?i)${UPLOAD_ASSET_URI_PATTERN}">`,
		'\tProxyAddHeaders Off',
		'\tProxyErrorOverride Off',
		'\tProxyPreserveHost Off',
		...APACHE_REQUEST_HEADERS_TO_STRIP.map((header) => (
			`\tRequestHeader unset ${header} env=LOCAL_MEDIA_PROXY_ORIGIN`
		)),
		`\tRequestHeader set User-Agent ${quoteApache(ORIGIN_REQUEST_USER_AGENT, 'Apache User-Agent')} env=LOCAL_MEDIA_PROXY_ORIGIN`,
		'</LocationMatch>',
		'',
		'RewriteEngine On',
		'RewriteCond %{REQUEST_METHOD} !^(?:GET|HEAD)$',
		`RewriteRule ${quoteApachePattern(route, 'Apache media route')} - [R=405,L,NC]`,
		'RewriteCond %{HTTP:Transfer-Encoding} !^$ [OR]',
		'RewriteCond %{HTTP:Content-Length} !^(?:|0)$',
		`RewriteRule ${quoteApachePattern(route, 'Apache asset route')} - [R=400,L,NC]`,
		`RewriteCond %{THE_REQUEST} ${quoteApachePattern('!\\s/wp-content/uploads/', 'Apache raw uploads prefix')} [NC]`,
		`RewriteRule ${quoteApachePattern(uploadsGuardRoute, 'Apache uploads guard route')} - [R=400,L,NC]`,
		`RewriteCond %{THE_REQUEST} ${quoteApachePattern(`\\s/+wp-content/uploads/[^?\\s]*${UNSAFE_RAW_PERCENT_ENCODING_PATTERN}`, 'Apache raw unsafe encoding')} [NC,OR]`,
		`RewriteCond %{THE_REQUEST} ${quoteApachePattern('\\s/+wp-content/uploads/[^?\\s]*\\x5c', 'Apache raw backslash')} [NC,OR]`,
		`RewriteCond %{THE_REQUEST} ${quoteApachePattern('\\s/+wp-content/uploads/(?:[^?\\s]*/)?(?:\\.|%2e){1,2}(?:/|\\?|\\s)', 'Apache raw dot segment')} [NC,OR]`,
		`RewriteCond %{THE_REQUEST} ${quoteApachePattern('\\s/+wp-content/uploads/(?:/|[^?\\s]*//)', 'Apache raw empty segment')} [NC]`,
		`RewriteRule ${quoteApachePattern(uploadsGuardRoute, 'Apache uploads guard route')} - [R=400,L,NC]`,
		'RewriteCond $1 "%" [OR]',
		'RewriteCond $1 "(?:^|/)(?:\\.{1,2}|%(?:25)*2e(?:%(?:25)*2e)?)(?:/|$)" [NC,OR]',
		'RewriteCond $1 "%(?:25)*(?:2f|5c|3f|23|00)" [NC,OR]',
		'RewriteCond $1 "%(?![0-9a-f]{2})" [NC]',
		`RewriteRule ${quoteApachePattern(route, 'Apache asset route')} - [R=400,L,NC]`,
		'RewriteCond "%{DOCUMENT_ROOT}/$1" !-f',
		'RewriteCond %{ENV:LOCAL_MEDIA_PROXY_UNKNOWN_HEADER} =1',
		`RewriteRule ${quoteApachePattern(route, 'Apache asset route')} - [R=400,L,NC]`,
		'RewriteCond "%{DOCUMENT_ROOT}/$1" !-f',
		`RewriteCond $1 ${quoteApachePattern(BLOCKED_UPLOAD_ASSET_PATH_PATTERN, 'Apache blocked asset path')} [NC]`,
		`RewriteRule ${quoteApachePattern(route, 'Apache asset route')} - [R=404,L,NC]`,
		'RewriteCond "%{DOCUMENT_ROOT}/$1" !-f',
		`RewriteRule ${quoteApachePattern(route, 'Apache asset route')} ${quoteApache(`${backend}/$1`, 'Apache proxy target')} [P,L,NE,QSA,NC,E=LOCAL_MEDIA_PROXY_ORIGIN:1]`,
		'',
		...PROXIED_RESPONSE_HEADERS_TO_STRIP.flatMap((header) => [
			`Header unset ${header} env=LOCAL_MEDIA_PROXY_ORIGIN`,
			`Header always unset ${header} env=LOCAL_MEDIA_PROXY_ORIGIN`,
		]),
		'Header always set X-Local-Media-Proxy "origin" env=LOCAL_MEDIA_PROXY_ORIGIN',
		'Header always set X-Content-Type-Options "nosniff" env=LOCAL_MEDIA_PROXY_ORIGIN',
		`Header always set Content-Security-Policy ${quoteApache(PROXIED_CONTENT_SECURITY_POLICY, 'Apache content security policy')} env=LOCAL_MEDIA_PROXY_ORIGIN`,
		MANAGED_MARKER_END,
		'',
	].join('\n');
}

export function apacheCompiledPaths(service: ApacheRuntimeService): ApacheCompiledPaths {
	if (!service.configPath || !path.isAbsolute(service.configPath)) {
		throw new Error('Local returned a relative Apache compiled configuration root.');
	}
	const root = path.resolve(service.configPath);
	const child = (relativePath: string): string => {
		const candidate = path.resolve(root, relativePath);
		const relative = path.relative(root, candidate);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Local returned an unsafe compiled Apache path.');
		}
		return candidate;
	};
	return {
		include: child(path.join('includes', 'local-media-proxy.conf')),
		main: child('apache2.conf'),
		modules: child('modules.conf'),
		site: child('site.conf'),
	};
}

function compiledApacheSiteHasCanonicalManagedIncludes(
	siteConfig: string,
	expectedInclude: string,
	compiledSitePath?: string,
): boolean {
	const normalizedConfig = siteConfig.replace(/\\/g, '/');
	const normalizedInclude = expectedInclude.replace(/\\/g, '/');
	const start = escapeRegularExpression(MANAGED_MARKER_START);
	const end = escapeRegularExpression(MANAGED_MARKER_END);
	const include = escapeRegularExpression(normalizedInclude);
	const canonicalBlocks = normalizedConfig.match(new RegExp(
		`^[\\t ]*${start}[\\t ]*\\r?\\n` +
		`[\\t ]*Protocols[\\t ]+http/1\\.1[\\t ]*\\r?\\n` +
		`[\\t ]*IncludeOptional[\\t ]+"${include}"[\\t ]*\\r?\\n` +
		`[\\t ]*${end}[\\t ]*\\r?\\n` +
		`[\\t ]*<\\/VirtualHost>[\\t ]*$`,
		'gm',
	)) ?? [];
	const virtualHostCount = (normalizedConfig.match(/^[\t ]*<\/VirtualHost>[\t ]*$/gm) ?? []).length;
	return virtualHostCount > 0 &&
		canonicalBlocks.length === virtualHostCount &&
		markerLineCount(normalizedConfig, MANAGED_MARKER_START) === canonicalBlocks.length &&
		markerLineCount(normalizedConfig, MANAGED_MARKER_END) === canonicalBlocks.length &&
		apacheIncludeReferenceCount(
			normalizedConfig,
			normalizedInclude,
			compiledSitePath,
		) === canonicalBlocks.length;
}

function apacheIncludeReferences(config: string): string[] {
	return [...config.matchAll(
		/^[\t ]*Include(?:Optional)?[\t ]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s\r\n]+))[\t ]*$/gmi,
	)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function apacheReferenceTargets(
	reference: string,
	expectedInclude: string,
	sourceConfigPath?: string,
): boolean {
	const normalizedReference = reference.replace(/\\/g, '/');
	const normalizedExpected = expectedInclude.replace(/\\/g, '/');
	if (
		normalizedReference === normalizedExpected ||
		normalizedReference.endsWith(`/${normalizedExpected}`)
	) {
		return true;
	}
	if (!sourceConfigPath || !path.isAbsolute(expectedInclude)) {
		return false;
	}
	const resolvedReference = path.isAbsolute(reference)
		? path.normalize(reference)
		: path.resolve(path.dirname(sourceConfigPath), reference);
	return path.normalize(resolvedReference) === path.normalize(expectedInclude);
}

function apacheIncludeReferenceCount(
	config: string,
	expectedInclude: string,
	sourceConfigPath?: string,
): number {
	return apacheIncludeReferences(config).filter((reference) => apacheReferenceTargets(
		reference,
		expectedInclude,
		sourceConfigPath,
	)).length;
}

function extractSingleManagedBlock(config: string): string | null {
	const start = escapeRegularExpression(MANAGED_MARKER_START);
	const end = escapeRegularExpression(MANAGED_MARKER_END);
	const blocks = config.replace(/\r\n/g, '\n').match(new RegExp(
		`^[\\t ]*${start}[\\t ]*\\r?\\n` +
		`(?:(?!^[\\t ]*(?:${start}|${end})[\\t ]*$)[\\s\\S])+?` +
		`^[\\t ]*${end}[\\t ]*$`,
		'gm',
	)) ?? [];
	return blocks.length === 1 &&
		markerLineCount(config, MANAGED_MARKER_START) === 1 &&
		markerLineCount(config, MANAGED_MARKER_END) === 1
		? blocks[0].trimEnd()
		: null;
}

function compiledApacheModulesHaveExpectedManagedBlock(
	modulesConfig: string,
	expectedModulesTemplate: string,
): boolean {
	const actual = extractSingleManagedBlock(modulesConfig);
	const expected = extractSingleManagedBlock(expectedModulesTemplate);
	return actual !== null && expected !== null && actual === expected;
}

function apacheMainLoadsCompiledFiles(
	mainConfig: string,
	compiled: ApacheCompiledPaths,
): boolean {
	const references = apacheIncludeReferences(mainConfig);
	const exactCount = (filePath: string): number => {
		return references.filter((reference) => apacheReferenceTargets(
			reference,
			filePath,
			compiled.main,
		)).length;
	};
	return exactCount(compiled.modules) === 1 &&
		exactCount(compiled.site) === 1 &&
		exactCount(compiled.include) === 0;
}

async function assertCompiledApacheState(
	service: ApacheRuntimeService,
	expectedManagedInclude: string | null,
	expectedManagedModules: string | null,
	assertCurrent: () => void = (): void => undefined,
	requireRunnableConfig = false,
): Promise<void> {
	assertCurrent();
	const compiled = apacheCompiledPaths(service);
	const [mainConfig, modulesConfig, siteConfig, includeConfig] = await Promise.all([
		readOptionalCompiledFile(service.configPath, compiled.main, assertCurrent),
		readOptionalCompiledFile(service.configPath, compiled.modules, assertCurrent),
		readOptionalCompiledFile(service.configPath, compiled.site, assertCurrent),
		readOptionalCompiledFile(service.configPath, compiled.include, assertCurrent),
	]);
	assertCurrent();
	if (expectedManagedInclude !== null) {
		if (
			mainConfig === null ||
			modulesConfig === null ||
			siteConfig === null ||
			expectedManagedModules === null ||
			!apacheMainLoadsCompiledFiles(mainConfig, compiled) ||
			!compiledApacheSiteHasCanonicalManagedIncludes(
				siteConfig,
				compiled.include,
				compiled.site,
			) ||
			!compiledApacheModulesHaveExpectedManagedBlock(modulesConfig, expectedManagedModules) ||
			apacheIncludeReferenceCount(modulesConfig, compiled.include, compiled.modules) > 0 ||
			includeConfig !== expectedManagedInclude
		) {
			throw new Error('Local did not compile the expected managed Apache configuration.');
		}
		return;
	}
	if (
		(requireRunnableConfig && (
			mainConfig === null ||
			modulesConfig === null ||
			siteConfig === null ||
			!apacheMainLoadsCompiledFiles(mainConfig, compiled)
		)) ||
		(siteConfig !== null && hasExactManagedMarker(siteConfig)) ||
		(siteConfig !== null && apacheIncludeReferenceCount(
			siteConfig,
			compiled.include,
			compiled.site,
		) > 0) ||
		(modulesConfig !== null && hasExactManagedMarker(modulesConfig)) ||
		(modulesConfig !== null && apacheIncludeReferenceCount(
			modulesConfig,
			compiled.include,
			compiled.modules,
		) > 0) ||
		includeConfig !== null
	) {
		throw new Error('Local retained a managed Apache configuration after cleanup.');
	}
}

export async function apacheCompiledConfigMatches(
	service: ApacheRuntimeService,
	expectedManagedInclude: string | null,
	expectedManagedModules: string | null,
	assertCurrent: () => void = (): void => undefined,
): Promise<boolean> {
	try {
		await assertCompiledApacheState(
			service,
			expectedManagedInclude,
			expectedManagedModules,
			assertCurrent,
		);
		return true;
	} catch (error) {
		if (isExpectedCompiledFileAbsence(error)) {
			return expectedManagedInclude === null;
		}
		if (
			error instanceof Error && (
				error.message.startsWith('Local did not compile') ||
				error.message === 'Local retained a managed Apache configuration after cleanup.'
			)
		) {
			return false;
		}
		throw error;
	}
}

async function readApacheMasterPid(
	service: ApacheRuntimeService,
	assertCurrent: () => void = (): void => undefined,
): Promise<number> {
	if (!service.runPath || !path.isAbsolute(service.runPath)) {
		throw new Error('Local returned a relative Apache runtime root.');
	}
	const runRoot = await assertRealDirectoryPath(
		service.runPath,
		'Apache runtime root',
		assertCurrent,
	);
	const pidFile = path.join(runRoot, 'logs', 'httpd.pid');
	const relative = path.relative(runRoot, pidFile);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Local returned an unsafe Apache PID path.');
	}
	let current = runRoot;
	const segments = relative.split(path.sep);
	for (let index = 0; index < segments.length; index += 1) {
		assertCurrent();
		const metadata = await fs.lstat(current);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error('Local returned an unsafe Apache runtime path.');
		}
		current = path.join(current, segments[index]);
	}
	assertCurrent();
	const pidMetadata = await fs.lstat(pidFile);
	if (!pidMetadata.isFile() || pidMetadata.isSymbolicLink()) {
		throw new Error('Local returned an unsafe Apache PID file.');
	}
	assertCurrent();
	const pidText = await fs.readFile(pidFile, 'utf8');
	assertCurrent();
	if (!/^[1-9][0-9]*\s*$/.test(pidText)) {
		throw new Error('invalid PID file contents');
	}
	const pid = Number(pidText.trim());
	if (!Number.isSafeInteger(pid) || pid <= 1) {
		throw new Error('invalid PID value');
	}
	return pid;
}

export function apacheMasterProcessExists(
	pid: number,
	signalProcess: (targetPid: number, signal: 0) => boolean = (targetPid, signal) => process.kill(targetPid, signal),
): boolean {
	try {
		signalProcess(pid, 0);
		return true;
	} catch (error) {
		const code = error instanceof Error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === 'EPERM') {
			return true;
		}
		if (code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

function apacheCommandOptions(serviceEnvironment: NodeJS.ProcessEnv | undefined): ExecFileOptions {
	return {
		env: {
			...process.env,
			...serviceEnvironment,
		},
		timeout: APACHE_COMMAND_TIMEOUT_MS,
		windowsHide: true,
	};
}

export async function compileAndValidateApacheConfig(
	site: Local.Site,
	service: ApacheRuntimeService,
	configTemplates: ApacheConfigTemplates,
	execFilePromise: ExecFilePromise,
	expectManaged: boolean,
	expectedManagedInclude?: string,
	expectedManagedModules?: string,
	assertCurrent: () => void = (): void => undefined,
): Promise<void> {
	const httpdBinary = service.bin?.httpd;
	if (!httpdBinary) {
		throw new Error('Local did not provide an Apache httpd binary for this site.');
	}
	if (!path.isAbsolute(service.siteConfigTemplatePath)) {
		throw new Error('Local returned a relative Apache template root.');
	}

	assertCurrent();
	await assertRealDirectoryPath(
		service.configPath,
		'Apache compiled configuration root',
		assertCurrent,
	);
	assertCurrent();
	await configTemplates.compileConfigTemplates(
		site,
		service.siteConfigTemplatePath,
		service.configPath,
		service.configVariables,
	);
	assertCurrent();

	const compiled = apacheCompiledPaths(service);
	const expectedInclude = expectManaged ? expectedManagedInclude ?? null : null;
	const expectedModules = expectManaged ? expectedManagedModules ?? null : null;
	if (expectManaged && (expectedInclude === null || expectedModules === null)) {
		throw new Error('Local did not compile the expected managed Apache configuration.');
	}
	await assertCompiledApacheState(
		service,
		expectedInclude,
		expectedModules,
		assertCurrent,
		true,
	);

	assertCurrent();
	await execFilePromise(
		httpdBinary,
		['-t', '-f', compiled.main],
		apacheCommandOptions(service.env),
	);
	assertCurrent();
}

export async function refreshApacheService(
	site: Local.Site,
	service: ApacheRuntimeService,
	configTemplates: ApacheConfigTemplates,
	execFilePromise: ExecFilePromise,
	expectManaged: boolean,
	isSiteRunning: () => boolean,
	isServiceRunning: () => boolean,
	refreshOptions: ApacheServiceRefreshOptions = {},
): Promise<boolean> {
	const httpdBinary = service.bin?.httpd;
	if (!httpdBinary) {
		throw new Error('Local did not provide an Apache httpd binary for this site.');
	}
	const assertCurrent = refreshOptions.assertCurrent ?? ((): void => undefined);
	await compileAndValidateApacheConfig(
		site,
		service,
		configTemplates,
		execFilePromise,
		expectManaged,
		refreshOptions.expectedManagedInclude,
		refreshOptions.expectedManagedModules,
		assertCurrent,
	);
	assertCurrent();
	const siteRunning = isSiteRunning();
	assertCurrent();
	if (!siteRunning) {
		return false;
	}

	const serviceRunning = isServiceRunning();
	assertCurrent();
	if (!serviceRunning) {
		throw new Error(
			"Local no longer reports this site's Apache service as running. Stop and start the site in Local, then retry.",
		);
	}

	let masterPid: number;
	try {
		assertCurrent();
		masterPid = await readApacheMasterPid(service, assertCurrent);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		if (
			cause instanceof Error &&
			/^Local returned (?:an unsafe|a relative) Apache runtime/.test(cause.message)
		) {
			throw cause;
		}
		throw new Error(
			"Local's Apache master PID is unavailable for this site. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}

	const masterProcessExists = refreshOptions.masterProcessExists ?? apacheMasterProcessExists;
	assertCurrent();
	const masterIsRunning = masterProcessExists(masterPid);
	assertCurrent();
	if (!masterIsRunning) {
		throw new Error(
			"Local's Apache master PID is stale for this site. Stop and start the site in Local, then retry.",
		);
	}

	const compiled = apacheCompiledPaths(service);
	try {
		assertCurrent();
		await execFilePromise(
			httpdBinary,
			['-k', 'graceful', '-f', compiled.main],
			apacheCommandOptions(service.env),
		);
	} catch (cause) {
		assertCurrent();
		if (
			cause instanceof Error &&
			/^Local returned (?:an unsafe|a relative) Apache runtime/.test(cause.message)
		) {
			throw cause;
		}
		throw new Error(
			"Apache could not gracefully reload this site's validated configuration. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	assertCurrent();

	let reloadedMasterPid: number;
	try {
		assertCurrent();
		reloadedMasterPid = await readApacheMasterPid(service, assertCurrent);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		throw new Error(
			"Local's Apache master PID disappeared after the graceful reload. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	if (reloadedMasterPid !== masterPid) {
		throw new Error(
			"Local's Apache master process changed unexpectedly during the graceful reload. Stop and start the site in Local, then retry.",
		);
	}

	const attempts = refreshOptions.attempts ?? APACHE_READINESS_ATTEMPTS;
	const intervalMs = refreshOptions.intervalMs ?? APACHE_READINESS_INTERVAL_MS;
	const wait = refreshOptions.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	}));
	let running = false;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		assertCurrent();
		const stillRunning = isSiteRunning();
		assertCurrent();
		const serviceStillRunning = isServiceRunning();
		assertCurrent();
		const masterStillRunning = masterProcessExists(masterPid);
		assertCurrent();
		if (stillRunning && serviceStillRunning && masterStillRunning) {
			running = true;
			break;
		}
		if (attempt < attempts - 1) {
			await wait(intervalMs);
			assertCurrent();
		}
	}
	if (!running) {
		throw new Error(
			"Local did not keep this site's Apache master running after the graceful reload. Stop and start the site in Local, then retry.",
		);
	}
	return true;
}
