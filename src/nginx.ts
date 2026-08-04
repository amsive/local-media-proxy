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
const NGINX_DUMP_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const NGINX_READINESS_ATTEMPTS = 20;
const NGINX_READINESS_INTERVAL_MS = 100;
const NGINX_READINESS_STABLE_SAMPLES = 11;

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
	attempts?: number;
	intervalMs?: number;
	masterProcessExists?: (pid: number) => boolean;
	masterProcessMatches?: (pid: number) => boolean | Promise<boolean>;
	stableSamples?: number;
	wait?: (milliseconds: number) => Promise<void>;
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

function nginxCompilationCommandContext(service: NginxRuntimeService): NginxCommandContext {
	const context = nginxCommandContext(service);
	return {
		...context,
		options: {
			env: {
				...process.env,
				...service.env,
			},
			maxBuffer: NGINX_DUMP_MAX_BUFFER_BYTES,
			timeout: NGINX_COMMAND_TIMEOUT_MS,
			windowsHide: true,
		},
	};
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

function decodeNginxPath(value: string): string {
	return value.replace(/\\(.)/g, '$1');
}

function configuredNginxPidPath(mainConfig: string): string {
	const directives = [...mainConfig.matchAll(
		/^[\t ]*pid[\t ]+(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^;\s#]+))[\t ]*;[\t ]*(?:#[^\r\n]*)?$/gm,
	)];
	if (directives.length > 1) {
		throw new Error('Local returned an unsafe Nginx PID path.');
	}
	const pidDirectiveLines = mainConfig.match(/^[\t ]*pid\b[^\r\n]*$/gm) ?? [];
	if (pidDirectiveLines.length !== directives.length) {
		throw new Error('Local returned an unsupported Nginx PID directive.');
	}
	if (directives.length === 0) {
		return path.join('logs', 'nginx.pid');
	}
	const configured = decodeNginxPath(
		directives[0][1] ?? directives[0][2] ?? directives[0][3],
	);
	if (!configured || /[\r\n\0$]/.test(configured)) {
		throw new Error('Local returned an unsafe Nginx PID path.');
	}
	const segments = configured.split(/[\\/]/);
	if (segments.some((segment) => segment === '.' || segment === '..')) {
		throw new Error('Local returned an unsafe Nginx PID path.');
	}
	return configured;
}

async function readNginxMasterPid(
	service: NginxRuntimeService,
	assertCurrent: () => void = (): void => undefined,
): Promise<number> {
	if (!service.runPath || !path.isAbsolute(service.runPath)) {
		throw new Error('Local returned a relative Nginx runtime root.');
	}
	const runRoot = await assertRealDirectoryPath(
		service.runPath,
		'Nginx runtime root',
		assertCurrent,
	);
	const compiled = nginxCompiledPaths(service);
	const mainConfig = await readOptionalCompiledFile(
		service.configPath,
		compiled.main,
		assertCurrent,
	);
	if (mainConfig === null) {
		throw new Error('Local did not compile the Nginx main configuration.');
	}
	const configuredPath = configuredNginxPidPath(mainConfig);
	const pidFile = path.isAbsolute(configuredPath)
		? path.resolve(configuredPath)
		: path.resolve(runRoot, configuredPath);
	const relative = path.relative(runRoot, pidFile);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Local returned an unsafe Nginx PID path.');
	}
	let current = runRoot;
	const segments = relative.split(path.sep);
	for (let index = 0; index < segments.length - 1; index += 1) {
		assertCurrent();
		current = path.join(current, segments[index]);
		const metadata = await fs.lstat(current);
		assertCurrent();
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error('Local returned an unsafe Nginx PID path.');
		}
	}
	assertCurrent();
	const pidMetadata = await fs.lstat(pidFile);
	assertCurrent();
	if (!pidMetadata.isFile() || pidMetadata.isSymbolicLink()) {
		throw new Error('Local returned an unsafe Nginx PID file.');
	}
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

export function nginxMasterProcessExists(
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

function nginxCommandLineMatchesService(
	commandLine: string,
	service: NginxRuntimeService,
): boolean {
	const nginxBinary = service.bin?.nginx;
	if (!nginxBinary) {
		throw new Error('Local did not provide an Nginx binary for this site.');
	}
	const configFile = path.join(service.configPath, 'nginx.conf');
	const normalized = commandLine.replace(/\s+/g, ' ').trim();
	const unquote = (value: string): string => {
		const trimmed = value.trim();
		return (
			(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'"))
		) ? trimmed.slice(1, -1) : trimmed;
	};
	const executableForms = [nginxBinary, `"${nginxBinary}"`, `'${nginxBinary}'`];
	const executableMatches = executableForms.some((executable) => (
		normalized === executable ||
		normalized.startsWith(`${executable} `) ||
		normalized.includes(`master process ${executable} `)
	));
	const optionValue = (flag: string): string | null => {
		const escapedFlag = escapeRegularExpression(flag);
		const match = new RegExp(
			`(?:^|\\s)${escapedFlag}\\s+(.+?)(?=\\s+-[A-Za-z](?:\\s|$)|$)`,
		).exec(normalized);
		return match ? unquote(match[1]) : null;
	};
	const configArgument = optionValue('-c');
	const prefixArgument = optionValue('-p');
	return executableMatches &&
		configArgument !== null && path.resolve(configArgument) === path.resolve(configFile) &&
		prefixArgument !== null && path.resolve(prefixArgument) === path.resolve(service.runPath);
}

export async function nginxMasterProcessMatches(
	service: NginxRuntimeService,
	pid: number,
	execFilePromise: ExecFilePromise,
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	if (!Number.isSafeInteger(pid) || pid <= 1) {
		return false;
	}
	if (platform === 'darwin') {
		const commandLine = await execFilePromise(
			'/bin/ps',
			['-ww', '-p', String(pid), '-o', 'command='],
			{ timeout: NGINX_COMMAND_TIMEOUT_MS, windowsHide: true },
		);
		return nginxCommandLineMatchesService(commandLine, service);
	}
	if (platform === 'linux') {
		const commandLine = (await fs.readFile(`/proc/${pid}/cmdline`))
			.toString('utf8')
			.split('\0')
			.filter(Boolean)
			.join(' ');
		return nginxCommandLineMatchesService(commandLine, service);
	}
	if (platform === 'win32') {
		// Nginx for Windows sends control signals through its PID-scoped
		// Global\\ngx_<signal>_<pid> named event. An unrelated PID reuse has no
		// matching event, so `nginx -s reload` fails without signaling that process.
		return true;
	}
	throw new Error('Nginx master-process identity verification is unavailable on this platform.');
}

function isNginxRuntimePathError(error: unknown): boolean {
	return error instanceof Error &&
		/^Local returned (?:(?:an unsafe|a relative) Nginx (?:PID|runtime)|an unsupported Nginx PID)/.test(error.message);
}

export async function refreshNginxService(
	site: Local.Site,
	service: NginxRuntimeService,
	configTemplates: NginxConfigTemplates,
	execFilePromise: ExecFilePromise,
	expectedManagedInclude: string | null,
	isSiteRunning: () => boolean,
	isServiceRunning: () => boolean,
	refreshOptions: NginxServiceRefreshOptions = {},
): Promise<boolean> {
	const assertCurrent = refreshOptions.assertCurrent ?? ((): void => undefined);
	const attempts = refreshOptions.attempts ?? NGINX_READINESS_ATTEMPTS;
	const intervalMs = refreshOptions.intervalMs ?? NGINX_READINESS_INTERVAL_MS;
	const requiredStableSamples = refreshOptions.stableSamples ?? NGINX_READINESS_STABLE_SAMPLES;
	const wait = refreshOptions.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	}));
	if (
		!Number.isSafeInteger(attempts) || attempts < 1 ||
		!Number.isSafeInteger(intervalMs) || intervalMs < 0 ||
		!Number.isSafeInteger(requiredStableSamples) ||
		requiredStableSamples < 1 || requiredStableSamples > attempts
	) {
		throw new Error('Nginx readiness options are invalid.');
	}
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
		const unexpectedService = isServiceRunning();
		assertCurrent();
		if (unexpectedService) {
			throw new Error(
				"Local reports this site as stopped while its Nginx service is still running. Stop the orphaned service in Local, then retry.",
			);
		}
		return false;
	}
	const serviceRunning = isServiceRunning();
	assertCurrent();
	if (!serviceRunning) {
		throw new Error(
			"Local no longer reports this site's Nginx service as running. Stop and start the site in Local, then retry.",
		);
	}

	let masterPid: number;
	try {
		masterPid = await readNginxMasterPid(service, assertCurrent);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		if (isNginxRuntimePathError(cause)) {
			throw cause;
		}
		throw new Error(
			"Local's Nginx master PID is unavailable for this site. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}

	const masterProcessExists = refreshOptions.masterProcessExists ?? nginxMasterProcessExists;
	const masterProcessMatches = refreshOptions.masterProcessMatches ?? (
		(pid: number) => nginxMasterProcessMatches(service, pid, execFilePromise)
	);
	assertCurrent();
	const masterIsRunning = masterProcessExists(masterPid);
	assertCurrent();
	if (!masterIsRunning) {
		throw new Error(
			"Local's Nginx master PID is stale for this site. Stop and start the site in Local, then retry.",
		);
	}
	let masterMatchesService: boolean;
	try {
		masterMatchesService = await masterProcessMatches(masterPid);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		throw new Error(
			"Local could not verify this site's Nginx master process. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	if (!masterMatchesService) {
		throw new Error(
			"Local's Nginx master PID does not belong to this site's expected Nginx service. Stop and start the site in Local, then retry.",
		);
	}

	const context = nginxCommandContext(service);
	try {
		assertCurrent();
		await signalNginxReload(context, execFilePromise);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		throw new Error(
			"Nginx could not gracefully reload this site's validated configuration. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}

	let reloadedMasterPid: number;
	try {
		reloadedMasterPid = await readNginxMasterPid(service, assertCurrent);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		if (isNginxRuntimePathError(cause)) {
			throw cause;
		}
		throw new Error(
			"Local's Nginx master PID disappeared after the graceful reload. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	if (reloadedMasterPid !== masterPid) {
		throw new Error(
			"Local's Nginx master process changed unexpectedly during the graceful reload. Stop and start the site in Local, then retry.",
		);
	}
	try {
		masterMatchesService = await masterProcessMatches(masterPid);
		assertCurrent();
	} catch (cause) {
		assertCurrent();
		throw new Error(
			"Local could not verify this site's Nginx master process after the graceful reload. Stop and start the site in Local, then retry.",
			{ cause },
		);
	}
	if (!masterMatchesService) {
		throw new Error(
			"Local's Nginx master PID no longer belongs to this site's expected Nginx service. Stop and start the site in Local, then retry.",
		);
	}

	let stableSamples = 0;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		assertCurrent();
		const stillRunning = isSiteRunning();
		assertCurrent();
		const serviceStillRunning = isServiceRunning();
		assertCurrent();
		const masterStillRunning = masterProcessExists(masterPid);
		assertCurrent();
		let masterStillMatches = false;
		if (masterStillRunning) {
			try {
				masterStillMatches = await masterProcessMatches(masterPid);
				assertCurrent();
			} catch {
				assertCurrent();
				masterStillMatches = false;
			}
		}
		if (stillRunning && serviceStillRunning && masterStillRunning && masterStillMatches) {
			let currentMasterPid: number;
			try {
				currentMasterPid = await readNginxMasterPid(service, assertCurrent);
				assertCurrent();
			} catch (cause) {
				assertCurrent();
				if (isNginxRuntimePathError(cause)) {
					throw cause;
				}
				currentMasterPid = 0;
			}
			if (currentMasterPid !== masterPid) {
				throw new Error(
					"Local's Nginx master process changed unexpectedly after the graceful reload. Stop and start the site in Local, then retry.",
				);
			}
			stableSamples += 1;
			if (stableSamples >= requiredStableSamples) {
				return true;
			}
		} else {
			stableSamples = 0;
		}
		if (attempt < attempts - 1) {
			await wait(intervalMs);
			assertCurrent();
		}
	}
	throw new Error(
		"Local did not keep this site's Nginx master running after the graceful reload. Stop and start the site in Local, then retry.",
	);
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

function normalizedConfigText(config: string): string {
	return config.replace(/\r\n/g, '\n').trimEnd();
}

function nginxDumpSections(configDump: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = configDump.replace(/\r\n/g, '\n').split('\n');
	let currentPath: string | null = null;
	let currentLines: string[] = [];
	const finish = (): void => {
		if (currentPath !== null) {
			const key = path.normalize(currentPath);
			sections.set(
				key,
				sections.has(key)
					? '\0duplicate configuration section'
					: normalizedConfigText(currentLines.join('\n')),
			);
		}
	};
	for (const line of lines) {
		const header = /^# configuration file (.+):$/.exec(line);
		if (header) {
			finish();
			currentPath = header[1];
			currentLines = [];
			continue;
		}
		if (currentPath !== null) {
			currentLines.push(line);
		}
	}
	finish();
	return sections;
}

function nginxDumpExactlyMatchesCompiledState(
	configDump: string,
	compiled: NginxCompiledPaths,
	state: CompiledNginxState,
): boolean {
	const sections = nginxDumpSections(configDump);
	const exactSection = (filePath: string, expected: string | null): boolean => {
		const actual = sections.get(path.normalize(filePath));
		return expected === null
			? actual === undefined
			: actual === normalizedConfigText(expected);
	};
	return exactSection(compiled.main, state.main) &&
		exactSection(compiled.site, state.site) &&
		exactSection(compiled.include, state.include);
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
	const compiledState = await assertCompiledNginxState(
		service,
		expectedManagedInclude,
		assertCurrent,
		true,
	);

	const context = nginxCompilationCommandContext(service);
	assertCurrent();
	await execFilePromise(
		context.nginxBinary,
		['-t', ...context.commonArgs],
		context.options,
	);
	assertCurrent();
	const compiledDump = await execFilePromise(
		context.nginxBinary,
		['-T', ...context.commonArgs],
		context.options,
	);
	assertCurrent();
	if (!nginxDumpExactlyMatchesCompiledState(compiledDump, compiled, compiledState)) {
		throw new Error('Nginx did not load the exact compiled configuration.');
	}
	if (
		expectedManagedInclude !== null
			? !compiledNginxSiteHasCanonicalManagedInclude(
				compiledState.site ?? '',
				compiled.site,
				compiled.include,
			)
			: compiledNginxSiteHasManagedArtifacts(
				compiledState.site ?? '',
				compiled.site,
				compiled.include,
			)
	) {
		if (expectedManagedInclude !== null) {
			throw new Error('Nginx did not load the expected managed configuration.');
		}
		throw new Error('Nginx still loads a managed configuration after cleanup.');
	}
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
