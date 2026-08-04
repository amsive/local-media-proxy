/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecFileOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as Local from '@getflywheel/local';
import {
	COMPILED_INCLUDE_FILENAME,
	MANAGED_MARKER_END,
	MANAGED_MARKER_START,
	ORIGIN_REQUEST_USER_AGENT,
	PROXIED_CONTENT_SECURITY_POLICY,
	PROXIED_RESPONSE_HEADERS_TO_STRIP,
} from './constants';
import {
	assertSafeCompiledFilePath,
	COMPILED_INCLUDE_TOMBSTONE,
	compileCompiledIncludeTombstone,
} from './compiled-config';
import {
	BLOCKED_BROWSER_FETCH_DESTINATION_PATTERN,
	BLOCKED_UPLOAD_ASSET_PATH_PATTERN,
	NGINX_HARD_BLOCKED_UPLOAD_ASSET_URI_PATTERN,
	NGINX_UPLOAD_ASSET_URI_PATTERN,
	NGINX_UPLOADS_CATCH_ALL_URI_PATTERN,
	UNSAFE_RAW_PERCENT_ENCODING_PATTERN,
	UPLOAD_ASSET_ROUTE_REVISION,
} from './asset-policy';
import type { NormalizedOrigin } from './types';

const NGINX_COMMAND_TIMEOUT_MS = 10_000;
const NGINX_RESTART_CONFIRMATION_ATTEMPTS = 5;
const NGINX_RESTART_CONFIRMATION_INTERVAL_MS = 200;

export interface NginxRuntimeService {
	bin: { [binaryName: string]: string } | undefined;
	configPath: string;
	configVariables: Local.GenericObject;
	env?: NodeJS.ProcessEnv;
	runPath: string;
	siteConfigTemplatePath: string;
}

export interface NginxConfigTemplates {
	compileConfigTemplates: (
		site: Local.Site,
		templatesDir: string,
		destDir: string,
		context: Local.GenericObject,
	) => Promise<void>;
}

export interface NginxServiceRefreshOptions {
	assertCurrent?: () => void;
	restartService?: () => Promise<void>;
}

export interface NginxCompiledPaths {
	include: string;
	main: string;
	site: string;
}

export type ExecFilePromise = (
	command: string,
	args: string[],
	options?: ExecFileOptions,
) => Promise<string>;

interface NginxCommandContext {
	commonArgs: string[];
	nginxBinary: string;
	options: ExecFileOptions;
}

interface CompiledNginxState {
	include: string | null;
	main: string | null;
	site: string | null;
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
			'compiled Nginx root',
			assertCurrent,
		);
		const relative = path.relative(root, filePath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Local returned an unsafe compiled Nginx path.');
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
				throw new Error('Local returned an unsafe compiled Nginx path.');
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

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteNginx(value: string): string {
	if (/[\r\n\0]/.test(value)) {
		throw new Error('Nginx value contains an unsupported control character.');
	}

	return `"${value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')}"`;
}

function quoteNginxRegularExpression(value: string): string {
	let inCharacterClass = false;
	let escaped = false;
	let normalized = '';
	for (const character of value) {
		if (escaped) {
			normalized += character;
			escaped = false;
			continue;
		}
		if (character === '\\') {
			normalized += character;
			escaped = true;
			continue;
		}
		if (character === '[') {
			inCharacterClass = true;
		} else if (character === ']') {
			inCharacterClass = false;
		}
		normalized += character === '$' && !inCharacterClass ? '\\z' : character;
	}
	return quoteNginx(normalized);
}

function formatProxyIp(ipAddress: string): string {
	return ipAddress.includes(':') ? `[${ipAddress}]` : ipAddress;
}

function nginxCommandContext(service: NginxRuntimeService): NginxCommandContext {
	const nginxBinary = service.bin?.nginx;
	if (!nginxBinary) {
		throw new Error('Local did not provide an Nginx binary for this site.');
	}
	if (!path.isAbsolute(service.configPath) || !path.isAbsolute(service.runPath)) {
		throw new Error('Local returned a relative Nginx runtime path.');
	}

	const configFile = path.join(service.configPath, 'nginx.conf');
	const commonArgs = ['-c', configFile, '-p', service.runPath];
	const options: ExecFileOptions = {
		env: {
			...process.env,
			...service.env,
		},
		timeout: NGINX_COMMAND_TIMEOUT_MS,
		windowsHide: true,
	};

	return { commonArgs, nginxBinary, options };
}

async function assertRealRuntimeRoot(
	rootPath: string,
	description: string,
	assertCurrent: () => void,
): Promise<void> {
	await assertRealDirectoryPath(rootPath, description, assertCurrent);
}

export function nginxCompiledPaths(service: NginxRuntimeService): NginxCompiledPaths {
	if (!service.configPath || !path.isAbsolute(service.configPath)) {
		throw new Error('Local returned a relative Nginx compiled configuration root.');
	}
	const root = path.resolve(service.configPath);
	const child = (relativePath: string): string => {
		const candidate = path.resolve(root, relativePath);
		const relative = path.relative(root, candidate);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Local returned an unsafe compiled Nginx path.');
		}
		return candidate;
	};
	return {
		include: child(path.join('includes', COMPILED_INCLUDE_FILENAME)),
		main: child('nginx.conf'),
		site: child('site.conf'),
	};
}

async function signalNginxReload(
	context: NginxCommandContext,
	execFilePromise: ExecFilePromise,
): Promise<void> {
	await execFilePromise(
		context.nginxBinary,
		['-s', 'reload', ...context.commonArgs],
		context.options,
	);
}

function errorOutput(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const commandError = error as Error & { stderr?: unknown };
	return [
		error.message,
		typeof commandError.stderr === 'string' ? commandError.stderr : '',
	].join('\n');
}

export function isMissingNginxMasterProcess(error: unknown): boolean {
	return /kill\(\d+,\s*1\) failed \(3:\s*No such process\)/i.test(errorOutput(error));
}

function isTransientNginxRestartSignalError(error: unknown): boolean {
	const output = errorOutput(error);
	return isMissingNginxMasterProcess(error) ||
		/open\(\) "[^"]*nginx\.pid" failed \(2:\s*No such file or directory\)/i.test(output) ||
		/invalid PID number .*nginx\.pid/i.test(output);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export async function refreshNginxService(
	site: Local.Site,
	service: NginxRuntimeService,
	configTemplates: NginxConfigTemplates,
	execFilePromise: ExecFilePromise,
	expectedManagedInclude: string | null,
	isSiteRunning: () => boolean,
	refreshOptions: NginxServiceRefreshOptions = {},
): Promise<boolean> {
	const assertCurrent = refreshOptions.assertCurrent ?? ((): void => undefined);
	await compileAndValidateNginxConfig(
		site,
		service,
		configTemplates,
		execFilePromise,
		expectedManagedInclude,
		assertCurrent,
	);
	assertCurrent();
	const siteRunning = isSiteRunning();
	assertCurrent();
	if (!siteRunning) {
		return false;
	}

	const context = nginxCommandContext(service);
	try {
		assertCurrent();
		await signalNginxReload(context, execFilePromise);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		if (isMissingNginxMasterProcess(cause) && refreshOptions.restartService) {
			const stillRunning = isSiteRunning();
			assertCurrent();
			if (!stillRunning) {
				throw new Error(
					'Nginx reported a stale master PID, but the Local site stopped before recovery. Start the site, then retry.',
					{ cause },
				);
			}
			try {
				await refreshOptions.restartService();
				assertCurrent();
			} catch (restartCause) {
				assertCurrent();
				throw new Error(
					"Nginx reported a stale master PID and Local could not restart this site's Nginx service. Stop and start the site in Local, then retry. If it still fails, share Local's main log and the site's Nginx error log from this attempt.",
					{ cause: restartCause },
				);
			}
			const restartedSiteRunning = isSiteRunning();
			assertCurrent();
			if (!restartedSiteRunning) {
				throw new Error(
					'After Local attempted to restart Nginx, the site stopped before the selected service could be verified. Start the site, then retry.',
				);
			}
			let verificationCause: unknown;
			for (let attempt = 0; attempt < NGINX_RESTART_CONFIRMATION_ATTEMPTS; attempt += 1) {
				try {
					await signalNginxReload(context, execFilePromise);
					assertCurrent();
					return true;
				} catch (confirmationError) {
					assertCurrent();
					verificationCause = confirmationError;
					const siteStillRunning = isSiteRunning();
					assertCurrent();
					if (!siteStillRunning) {
						throw new Error(
							'Nginx restart verification stopped because the Local site stopped. Start the site, then retry.',
						);
					}
					if (
						!isTransientNginxRestartSignalError(confirmationError) ||
						attempt === NGINX_RESTART_CONFIRMATION_ATTEMPTS - 1
					) {
						break;
					}
				}
				await wait(NGINX_RESTART_CONFIRMATION_INTERVAL_MS);
				assertCurrent();
			}
			throw new Error(
				"After Local attempted to restart Nginx, the selected service did not accept a reload. Another process may still be using this site's port. Fully quit and reopen Local, start the site, then retry. If it still fails, share Local's main log and the site's Nginx error log from that attempt.",
				{ cause: verificationCause },
			);
		}
		throw new Error(
			"Nginx could not gracefully reload this site's validated configuration. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	return true;
}

function markerLineCount(config: string, marker: string): number {
	const escaped = escapeRegularExpression(marker);
	return (config.match(new RegExp(`^[\\t ]*${escaped}[\\t ]*$`, 'gm')) ?? []).length;
}

function nginxIncludeReferences(config: string): string[] {
	return [...config.matchAll(
		/^[\t ]*include[\t ]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^;\s\r\n]+));[\t ]*$/gm,
	)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function nginxReferenceTargets(
	reference: string,
	sourceConfigPath: string | undefined,
	targetPath: string | undefined,
	relativeTarget: string,
): boolean {
	const normalizedReference = reference.replace(/\\/g, '/');
	if (sourceConfigPath !== undefined || targetPath !== undefined) {
		if (!sourceConfigPath || !targetPath) {
			return false;
		}
		const resolvedReference = path.isAbsolute(reference)
			? path.normalize(reference)
			: path.resolve(path.dirname(sourceConfigPath), reference);
		return path.normalize(resolvedReference) === path.normalize(targetPath);
	}
	return normalizedReference === relativeTarget ||
		normalizedReference.endsWith(`/${relativeTarget}`);
}

function managedIncludeReferenceCount(
	config: string,
	sourceConfigPath?: string,
	expectedIncludePath?: string,
): number {
	return nginxIncludeReferences(config).filter((reference) => nginxReferenceTargets(
		reference,
		sourceConfigPath,
		expectedIncludePath,
		`includes/${COMPILED_INCLUDE_FILENAME}`,
	)).length;
}

function nginxMainLoadsCompiledSite(
	mainConfig: string,
	compiledSitePath: string,
	compiledIncludePath: string,
): boolean {
	const references = nginxIncludeReferences(mainConfig);
	const siteReferences = references.filter((reference) => nginxReferenceTargets(
		reference,
		path.join(path.dirname(compiledSitePath), 'nginx.conf'),
		compiledSitePath,
		'site.conf',
	));
	const managedIncludeReferences = references.filter((reference) => nginxReferenceTargets(
		reference,
		path.join(path.dirname(compiledSitePath), 'nginx.conf'),
		compiledIncludePath,
		`includes/${COMPILED_INCLUDE_FILENAME}`,
	));
	return siteReferences.length === 1 && managedIncludeReferences.length === 0;
}

export function compiledNginxSiteHasManagedArtifacts(
	siteConfig: string,
	compiledSitePath?: string,
	compiledIncludePath?: string,
): boolean {
	return markerLineCount(siteConfig, MANAGED_MARKER_START) > 0 ||
		markerLineCount(siteConfig, MANAGED_MARKER_END) > 0 ||
		managedIncludeReferenceCount(siteConfig, compiledSitePath, compiledIncludePath) > 0;
}

export function compiledNginxSiteHasCanonicalManagedInclude(
	siteConfig: string,
	compiledSitePath?: string,
	compiledIncludePath?: string,
): boolean {
	const start = escapeRegularExpression(MANAGED_MARKER_START);
	const end = escapeRegularExpression(MANAGED_MARKER_END);
	const include = escapeRegularExpression(`includes/${COMPILED_INCLUDE_FILENAME}`);
	const canonicalBlocks = siteConfig.match(new RegExp(
		`^[\\t ]*${start}[\\t ]*\\r?\\n` +
		`[\\t ]*include[\\t ]+${include};[\\t ]*\\r?\\n` +
		`[\\t ]*${end}[\\t ]*$`,
		'gm',
	)) ?? [];
	return canonicalBlocks.length === 1 &&
		markerLineCount(siteConfig, MANAGED_MARKER_START) === 1 &&
		markerLineCount(siteConfig, MANAGED_MARKER_END) === 1 &&
		managedIncludeReferenceCount(siteConfig, compiledSitePath, compiledIncludePath) === 1;
}

async function readCompiledNginxState(
	service: NginxRuntimeService,
	assertCurrent: () => void = (): void => undefined,
): Promise<CompiledNginxState> {
	assertCurrent();
	const compiled = nginxCompiledPaths(service);
	const [mainConfig, siteConfig, includeConfig] = await Promise.all([
		readOptionalCompiledFile(service.configPath, compiled.main, assertCurrent),
		readOptionalCompiledFile(service.configPath, compiled.site, assertCurrent),
		readOptionalCompiledFile(service.configPath, compiled.include, assertCurrent),
	]);
	assertCurrent();
	return { include: includeConfig, main: mainConfig, site: siteConfig };
}

async function assertCompiledNginxState(
	service: NginxRuntimeService,
	expectedManagedInclude: string | null,
	assertCurrent: () => void = (): void => undefined,
	requireRunnableConfig = false,
): Promise<CompiledNginxState> {
	const compiled = nginxCompiledPaths(service);
	const state = await readCompiledNginxState(service, assertCurrent);
	const { include: includeConfig, main: mainConfig, site: siteConfig } = state;
	if (expectedManagedInclude !== null) {
		if (
			mainConfig === null ||
			siteConfig === null ||
			!nginxMainLoadsCompiledSite(mainConfig, compiled.site, compiled.include) ||
			!compiledNginxSiteHasCanonicalManagedInclude(siteConfig, compiled.site, compiled.include) ||
			includeConfig !== expectedManagedInclude
		) {
			throw new Error('Local did not compile the expected managed Nginx configuration.');
		}
		return state;
	}
	if (
		(requireRunnableConfig && (
			mainConfig === null ||
			siteConfig === null ||
			!nginxMainLoadsCompiledSite(mainConfig, compiled.site, compiled.include)
		)) ||
		(siteConfig !== null && compiledNginxSiteHasManagedArtifacts(
			siteConfig,
			compiled.site,
			compiled.include,
		)) ||
		(includeConfig !== null && includeConfig !== COMPILED_INCLUDE_TOMBSTONE)
	) {
		throw new Error('Local retained a managed Nginx configuration after cleanup.');
	}
	return { ...state, include: null };
}

export async function nginxCompiledConfigMatches(
	service: NginxRuntimeService,
	expectedManagedInclude: string | null,
	assertCurrent: () => void = (): void => undefined,
): Promise<boolean> {
	try {
		await assertCompiledNginxState(service, expectedManagedInclude, assertCurrent);
		return true;
	} catch (error) {
		if (isExpectedCompiledFileAbsence(error)) {
			return expectedManagedInclude === null;
		}
		if (
			error instanceof Error && (
				error.message === 'Local did not compile the expected managed Nginx configuration.' ||
				error.message === 'Local retained a managed Nginx configuration after cleanup.'
			)
		) {
			return false;
		}
		throw error;
	}
}

async function compileOrphanedNginxIncludeTombstone(
	site: Local.Site,
	service: NginxRuntimeService,
	configTemplates: NginxConfigTemplates,
	assertCurrent: () => void,
): Promise<void> {
	const compiled = nginxCompiledPaths(service);
	const state = await readCompiledNginxState(service, assertCurrent);
	if (state.include === null || state.include === COMPILED_INCLUDE_TOMBSTONE) {
		return;
	}
	if (
		state.main === null ||
		state.site === null ||
		!nginxMainLoadsCompiledSite(state.main, compiled.site, compiled.include) ||
		compiledNginxSiteHasManagedArtifacts(state.site, compiled.site, compiled.include)
	) {
		throw new Error('Local retained a managed Nginx configuration after cleanup.');
	}

	await compileCompiledIncludeTombstone(
		service.configPath,
		compiled.include,
		'compiled Nginx managed include',
		(templatesDirectory) => configTemplates.compileConfigTemplates(
			site,
			templatesDirectory,
			service.configPath,
			service.configVariables,
		),
		assertCurrent,
	);
}

export async function compileAndValidateNginxConfig(
	site: Local.Site,
	service: NginxRuntimeService,
	configTemplates: NginxConfigTemplates,
	execFilePromise: ExecFilePromise,
	expectedManagedInclude: string | null,
	assertCurrent: () => void = (): void => undefined,
): Promise<void> {
	if (!path.isAbsolute(service.siteConfigTemplatePath)) {
		throw new Error('Local returned a relative Nginx template root.');
	}
	assertCurrent();
	await assertRealDirectoryPath(
		service.configPath,
		'Nginx compiled configuration root',
		assertCurrent,
	);
	const compiled = nginxCompiledPaths(service);
	for (const [filePath, description] of [
		[compiled.main, 'compiled Nginx main configuration'],
		[compiled.site, 'compiled Nginx site configuration'],
		[compiled.include, 'compiled Nginx managed include'],
	] as const) {
		await assertSafeCompiledFilePath(
			service.configPath,
			filePath,
			description,
			assertCurrent,
		);
	}
	assertCurrent();
	await configTemplates.compileConfigTemplates(
		site,
		service.siteConfigTemplatePath,
		service.configPath,
		service.configVariables,
	);
	assertCurrent();
	await assertRealRuntimeRoot(service.runPath, 'Nginx runtime root', assertCurrent);
	if (expectedManagedInclude === null) {
		await compileOrphanedNginxIncludeTombstone(
			site,
			service,
			configTemplates,
			assertCurrent,
		);
	}
	await assertCompiledNginxState(
		service,
		expectedManagedInclude,
		assertCurrent,
		true,
	);

	const context = nginxCommandContext(service);
	assertCurrent();
	await execFilePromise(
		context.nginxBinary,
		['-t', ...context.commonArgs],
		context.options,
	);
	assertCurrent();
}

export function buildManagedNginxConfig(
	origin: NormalizedOrigin,
	trustBundlePath?: string,
): string {
	if (origin.protocol === 'https:' && !trustBundlePath) {
		throw new Error('HTTPS origins require a trusted certificate authority bundle.');
	}

	const tlsDirectives = origin.protocol === 'https:'
		? [
			'\tproxy_ssl_server_name on;',
			`\tproxy_ssl_name ${quoteNginx(origin.tlsHostname)};`,
			`\tproxy_ssl_trusted_certificate ${quoteNginx(trustBundlePath as string)};`,
			'\tproxy_ssl_verify on;',
			'\tproxy_ssl_verify_depth 5;',
		]
		: [];

	return [
		'# Generated by Local Media Proxy. Changes will be overwritten.',
		`# Managed route revision: ${UPLOAD_ASSET_ROUTE_REVISION}`,
		`location ~* ${quoteNginxRegularExpression(NGINX_HARD_BLOCKED_UPLOAD_ASSET_URI_PATTERN)} { return 404; }`,
		'',
		`location ~* ${quoteNginxRegularExpression(NGINX_UPLOAD_ASSET_URI_PATTERN)} {`,
		'\tif ($request_method !~ ^(GET|HEAD)$) { return 405; }',
		'\tif ($http_transfer_encoding != "") { return 400; }',
		'\tif ($http_content_length !~ ^(?:|0)$) { return 400; }',
		`\tif ($request_uri !~* ${quoteNginxRegularExpression('^/wp-content/uploads/')}) { return 400; }`,
		`\tif ($request_uri ~* ${quoteNginxRegularExpression(`^/wp-content/uploads/[^?]*${UNSAFE_RAW_PERCENT_ENCODING_PATTERN}`)}) { return 400; }`,
		`\tif ($request_uri ~* ${quoteNginxRegularExpression('^/wp-content/uploads/[^?]*\\x5c')}) { return 400; }`,
		`\tif ($request_uri ~* ${quoteNginxRegularExpression('^/wp-content/uploads/(?:[^?]*/)?(?:\\.|%2e){1,2}(?:/|\\?|$)')}) { return 400; }`,
		`\tif ($request_uri ~* ${quoteNginxRegularExpression('^/wp-content/uploads/(?:/|[^?]*//)')}) { return 400; }`,
		'\ttry_files $uri @local_media_proxy;',
		'\taccess_log off;',
		'\tlog_not_found off;',
		'\texpires 5m;',
		'\tadd_header Cache-Control "public";',
		'}',
		'',
		`location ~* ${quoteNginxRegularExpression(NGINX_UPLOADS_CATCH_ALL_URI_PATTERN)} { try_files $uri =404; }`,
		'',
		'location @local_media_proxy {',
		`\tif ($uri ~* ${quoteNginxRegularExpression(BLOCKED_UPLOAD_ASSET_PATH_PATTERN)}) { return 404; }`,
		`\tif ($http_sec_fetch_dest ~* ${quoteNginxRegularExpression(BLOCKED_BROWSER_FETCH_DESTINATION_PATTERN)}) { return 404; }`,
		`\tproxy_pass ${origin.protocol}//${formatProxyIp(origin.originIp)}:${origin.port};`,
		`\tproxy_set_header Host ${quoteNginx(origin.hostHeader)};`,
		`\tproxy_set_header User-Agent ${quoteNginx(ORIGIN_REQUEST_USER_AGENT)};`,
		'\tproxy_set_header Range $http_range;',
		'\tproxy_set_header If-Range $http_if_range;',
		'\tproxy_set_header Sec-Fetch-Dest "";',
		...tlsDirectives,
		'\tproxy_http_version 1.1;',
		'\tproxy_pass_request_headers off;',
		'\tproxy_pass_request_body off;',
		'\tproxy_set_header Connection "";',
		'\tproxy_set_header Content-Length "";',
		'\tproxy_set_header Authorization "";',
		'\tproxy_set_header Proxy-Authorization "";',
		'\tproxy_set_header Cookie "";',
		'\tproxy_set_header Referer "";',
		'\tproxy_set_header Origin "";',
		'\tproxy_set_header X-Forwarded-For "";',
		'\tproxy_set_header X-Forwarded "";',
		'\tproxy_set_header X-Forwarded-By "";',
		'\tproxy_set_header X-Forwarded-Host "";',
		'\tproxy_set_header X-Forwarded-Proto "";',
		'\tproxy_set_header X-Forwarded-Port "";',
		'\tproxy_set_header X-Forwarded-Server "";',
		'\tproxy_set_header X-Forwarded-Scheme "";',
		'\tproxy_set_header Forwarded "";',
		'\tproxy_set_header X-Real-IP "";',
		'\tproxy_set_header X-Remote-IP "";',
		'\tproxy_set_header X-Remote-Addr "";',
		'\tproxy_set_header X-Client-IP "";',
		'\tproxy_set_header X-Cluster-Client-IP "";',
		'\tproxy_set_header X-Originating-IP "";',
		'\tproxy_set_header X-Original-Forwarded-For "";',
		'\tproxy_set_header True-Client-IP "";',
		'\tproxy_set_header CF-Connecting-IP "";',
		'\tproxy_set_header Fastly-Client-IP "";',
		'\tproxy_set_header X-WP-Nonce "";',
		'\tproxy_set_header X-API-Key "";',
		'\tproxy_set_header X-Auth-Token "";',
		'\tproxy_set_header X-CSRF-Token "";',
		'\tproxy_set_header Transfer-Encoding "";',
		'\tproxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Buffering X-Accel-Charset;',
		...PROXIED_RESPONSE_HEADERS_TO_STRIP.map((header) => `\tproxy_hide_header ${header};`),
		'\tproxy_buffering off;',
		'\tproxy_request_buffering off;',
		'\tproxy_redirect off;',
		'\tproxy_intercept_errors off;',
		'\tproxy_connect_timeout 10s;',
		'\tproxy_read_timeout 60s;',
		'\tproxy_send_timeout 60s;',
		'\tadd_header X-Local-Media-Proxy "origin" always;',
		'\tadd_header X-Content-Type-Options "nosniff" always;',
		`\tadd_header Content-Security-Policy ${quoteNginx(PROXIED_CONTENT_SECURITY_POLICY)} always;`,
		'}',
		'',
	].join('\n');
}

export function removeManagedInclude(siteConfig: string): string {
	const start = escapeRegularExpression(MANAGED_MARKER_START);
	const end = escapeRegularExpression(MANAGED_MARKER_END);
	const managedBlock = new RegExp(
		`^[\\t ]*${start}\\r?\\n[\\s\\S]*?^[\\t ]*${end}(?:\\r?\\n)?`,
		'gm',
	);

	return siteConfig.replace(managedBlock, '');
}

export function upsertManagedInclude(siteConfig: string): string {
	const eol = siteConfig.includes('\r\n') ? '\r\n' : '\n';
	const cleanConfig = removeManagedInclude(siteConfig);
	if (compiledNginxSiteHasManagedArtifacts(cleanConfig)) {
		throw new Error('The Local Nginx template contains an incomplete managed include block.');
	}
	const block = [
		`    ${MANAGED_MARKER_START}`,
		`    include includes/${COMPILED_INCLUDE_FILENAME};`,
		`    ${MANAGED_MARKER_END}`,
		'',
	].join(eol);

	const wordpressComment = /^[\t ]*#[\t ]*\r?\n[\t ]*#[\t ]*WordPress Rules[\t ]*\r?\n/m;
	const firstLocation = /^[\t ]*location\b/m;
	const wordpressMatch = wordpressComment.exec(cleanConfig);
	const locationMatch = firstLocation.exec(cleanConfig);
	const anchorMatch = wordpressMatch && locationMatch
		? wordpressMatch.index <= locationMatch.index
			? wordpressMatch
			: locationMatch
		: wordpressMatch ?? locationMatch;

	if (anchorMatch?.index !== undefined) {
		return `${cleanConfig.slice(0, anchorMatch.index)}${block}${cleanConfig.slice(anchorMatch.index)}`;
	}

	const serverEnd = cleanConfig.lastIndexOf('}');
	if (serverEnd === -1) {
		throw new Error('Could not find a server block in the Local Nginx template.');
	}

	return `${cleanConfig.slice(0, serverEnd)}${eol}${block}${cleanConfig.slice(serverEnd)}`;
}

export function hasManagedInclude(siteConfig: string): boolean {
	return compiledNginxSiteHasManagedArtifacts(siteConfig);
}
