/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecFileOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as Local from '@getflywheel/local';
import {
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
} from './constants';
import type { NormalizedOrigin } from './types';
import type { ExecFilePromise } from './nginx';

const APACHE_COMMAND_TIMEOUT_MS = 10_000;
const APACHE_READINESS_ATTEMPTS = 20;
const APACHE_READINESS_INTERVAL_MS = 100;
const MEDIA_EXTENSIONS = 'avif|bmp|gif|heic|heif|ico|jpe?g|png|svgz?|tiff?|webp';
const SAFE_MEDIA_SEGMENT = `(?!\\.{1,2}(?:/|$))[A-Za-z0-9%._~!$&'()*+,;=:@-]+`;
const SAFE_MEDIA_PATH = `(?:${SAFE_MEDIA_SEGMENT}/)*${SAFE_MEDIA_SEGMENT}\\.(?:${MEDIA_EXTENSIONS})`;
const MEDIA_EXTENSION = new RegExp(`\\.(?:${MEDIA_EXTENSIONS})$`, 'i');

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
	attempts?: number;
	intervalMs?: number;
	masterProcessExists?: (pid: number) => boolean;
	wait?: (milliseconds: number) => Promise<void>;
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
	if (
		/[?#\\\\\0\r\n]/.test(requestPath) ||
		!requestPath.startsWith('/wp-content/uploads/') ||
		!MEDIA_EXTENSION.test(requestPath)
	) {
		return false;
	}

	const segments = requestPath.slice('/wp-content/uploads/'.length).split('/');
	return segments.length > 0 && segments.every((segment) => {
		if (!segment || !/^[A-Za-z0-9%._~!$&'()*+,;=:@-]+$/.test(segment)) {
			return false;
		}
		try {
			const decoded = decodeURIComponent(segment);
			return decoded !== '.' &&
				decoded !== '..' &&
				/^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/.test(decoded);
		} catch {
			return false;
		}
	});
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
	for (const filename of ['mod_proxy_http.so', 'mod_headers.so', 'mod_ssl.so']) {
		const modulePath = apacheModulePath(httpdBinary, filename);
		try {
			await fs.access(modulePath);
			availability.set(filename, true);
		} catch {
			availability.set(filename, false);
		}
	}
	const missingRequired = ['mod_proxy_http.so', 'mod_headers.so']
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
	return template.includes(MANAGED_MARKER_START) && template.includes(MANAGED_MARKER_END);
}

export function apacheConfigReferencesInclude(siteConfig: string, expectedInclude: string): boolean {
	const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');
	const expected = normalizeSeparators(expectedInclude);
	return [...siteConfig.matchAll(/^[\t ]*IncludeOptional[\t ]+"([^"\r\n]+)"[\t ]*$/gm)]
		.some((match) => normalizeSeparators(match[1]) === expected);
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
	const route = `^/(wp-content/uploads/${SAFE_MEDIA_PATH})$`;
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
		'ProxyRequests Off',
		'ProxyAddHeaders Off',
		'ProxyPreserveHost Off',
		...tls,
		'',
		`<LocationMatch "(?i)^/wp-content/uploads/.*\\.(?:${MEDIA_EXTENSIONS})$">`,
		'\tRequestHeader unset Authorization env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Proxy-Authorization env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Cookie env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Referer env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Origin env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Forwarded env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-For env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-By env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-Host env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-Proto env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-Port env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-Server env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Forwarded-Scheme env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Real-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Remote-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Remote-Addr env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Client-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Cluster-Client-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Originating-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Original-Forwarded-For env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset True-Client-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset CF-Connecting-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Fastly-Client-IP env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-WP-Nonce env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-API-Key env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-Auth-Token env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset X-CSRF-Token env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Content-Length env=LOCAL_MEDIA_PROXY_ORIGIN',
		'\tRequestHeader unset Transfer-Encoding env=LOCAL_MEDIA_PROXY_ORIGIN',
		`\tRequestHeader set User-Agent ${quoteApache(ORIGIN_REQUEST_USER_AGENT, 'Apache User-Agent')} env=LOCAL_MEDIA_PROXY_ORIGIN`,
		'</LocationMatch>',
		'',
		'RewriteEngine On',
		'RewriteCond %{REQUEST_METHOD} !^(?:GET|HEAD)$ [NC]',
		`RewriteRule ${quoteApachePattern(route, 'Apache media route')} - [R=405,L,NC]`,
		'RewriteCond %{HTTP:Transfer-Encoding} !^$ [OR]',
		'RewriteCond %{HTTP:Content-Length} !^(?:|0)$',
		`RewriteRule ${quoteApachePattern(route, 'Apache media route')} - [R=400,L,NC]`,
		'RewriteCond $1 "%" [OR]',
		'RewriteCond $1 "(?:^|/)(?:\\.{1,2}|%(?:25)*2e(?:%(?:25)*2e)?)(?:/|$)" [NC,OR]',
		'RewriteCond $1 "%(?:25)*(?:2f|5c|3f|23|00)" [NC,OR]',
		'RewriteCond $1 "%(?![0-9a-f]{2})" [NC]',
		`RewriteRule ${quoteApachePattern(route, 'Apache media route')} - [R=400,L,NC]`,
		'RewriteCond "%{DOCUMENT_ROOT}/$1" !-f',
		`RewriteRule ${quoteApachePattern(route, 'Apache media route')} ${quoteApache(`${backend}/$1`, 'Apache proxy target')} [P,L,NE,QSA,NC,E=LOCAL_MEDIA_PROXY_ORIGIN:1]`,
		'',
		'Header unset Set-Cookie env=LOCAL_MEDIA_PROXY_ORIGIN',
		'Header always unset Set-Cookie env=LOCAL_MEDIA_PROXY_ORIGIN',
		'Header always set X-Local-Media-Proxy "origin" env=LOCAL_MEDIA_PROXY_ORIGIN',
		'Header always set X-Content-Type-Options "nosniff" env=LOCAL_MEDIA_PROXY_ORIGIN',
		MANAGED_MARKER_END,
		'',
	].join('\n');
}

export function apacheCompiledPaths(service: ApacheRuntimeService): ApacheCompiledPaths {
	return {
		include: path.join(service.configPath, 'includes', 'local-media-proxy.conf'),
		main: path.join(service.configPath, 'apache2.conf'),
		modules: path.join(service.configPath, 'modules.conf'),
		site: path.join(service.configPath, 'site.conf'),
	};
}

async function readApacheMasterPid(service: ApacheRuntimeService): Promise<number> {
	const pidText = await fs.readFile(path.join(service.runPath, 'logs', 'httpd.pid'), 'utf8');
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
): Promise<void> {
	const httpdBinary = service.bin?.httpd;
	if (!httpdBinary) {
		throw new Error('Local did not provide an Apache httpd binary for this site.');
	}

	await configTemplates.compileConfigTemplates(
		site,
		service.siteConfigTemplatePath,
		service.configPath,
		service.configVariables,
	);

	const compiled = apacheCompiledPaths(service);
	const [mainConfig, modulesConfig, siteConfig] = await Promise.all([
		fs.readFile(compiled.main, 'utf8'),
		fs.readFile(compiled.modules, 'utf8'),
		fs.readFile(compiled.site, 'utf8'),
	]);
	if (expectManaged) {
		const includeConfig = await fs.readFile(compiled.include, 'utf8');
		if (
			!hasApacheManagedBlock(siteConfig) ||
			!hasApacheManagedBlock(modulesConfig) ||
			!hasApacheManagedBlock(includeConfig) ||
			!apacheConfigReferencesInclude(siteConfig, compiled.include)
		) {
			throw new Error('Local did not compile the complete managed Apache configuration.');
		}
	} else if (hasApacheManagedBlock(siteConfig) || hasApacheManagedBlock(modulesConfig)) {
		throw new Error('Local retained a managed Apache include after cleanup.');
	}

	await execFilePromise(
		httpdBinary,
		['-t', '-f', compiled.main],
		apacheCommandOptions(service.env),
	);
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
	await compileAndValidateApacheConfig(
		site,
		service,
		configTemplates,
		execFilePromise,
		expectManaged,
	);
	if (!isSiteRunning()) {
		return false;
	}

	if (!isServiceRunning()) {
		throw new Error(
			"Local no longer reports this site's Apache service as running. Stop and start the site in Local, then retry.",
		);
	}

	let masterPid: number;
	try {
		masterPid = await readApacheMasterPid(service);
	} catch (cause) {
		throw new Error(
			"Local's Apache master PID is unavailable for this site. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}

	const masterProcessExists = refreshOptions.masterProcessExists ?? apacheMasterProcessExists;
	if (!masterProcessExists(masterPid)) {
		throw new Error(
			"Local's Apache master PID is stale for this site. Stop and start the site in Local, then retry.",
		);
	}

	const compiled = apacheCompiledPaths(service);
	try {
		await execFilePromise(
			httpdBinary,
			['-k', 'graceful', '-f', compiled.main],
			apacheCommandOptions(service.env),
		);
	} catch (cause) {
		throw new Error(
			"Apache could not gracefully reload this site's validated configuration. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}

	let reloadedMasterPid: number;
	try {
		reloadedMasterPid = await readApacheMasterPid(service);
	} catch (cause) {
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
		if (isSiteRunning() && isServiceRunning() && masterProcessExists(masterPid)) {
			running = true;
			break;
		}
		if (attempt < attempts - 1) {
			await wait(intervalMs);
		}
	}
	if (!running) {
		throw new Error(
			"Local did not keep this site's Apache master running after the graceful reload. Stop and start the site in Local, then retry.",
		);
	}
	return true;
}
