/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import type * as Local from '@getflywheel/local';
import {
	MANAGED_INCLUDE_FILENAME,
	TRUST_BUNDLE_FILENAME,
} from './constants';
import {
	buildManagedApacheConfig,
	hasApacheManagedBlock,
	removeApacheManagedBlock,
	upsertApacheInclude,
	upsertApacheModules,
	validateApacheModuleFiles,
} from './apache';
import {
	buildManagedNginxConfig,
	hasManagedInclude,
	removeManagedInclude,
	upsertManagedInclude,
} from './nginx';
import type { NormalizedOrigin } from './types';
import type { ServerKind } from './types';

interface ManagedPaths {
	includeTemplate: string;
	siteTemplate: string;
	trustBundle: string;
}

export interface ApacheManagedPaths {
	includeTemplate: string;
	modulesTemplate: string;
	siteTemplate: string;
	trustBundle: string;
}

export interface ServerManagedFileOptions {
	apacheHttpdBinary?: string;
	serverKind: Exclude<ServerKind, 'unsupported'>;
}

export type ManagedFileMutationGuard = () => void | Promise<void>;
export type ManagedFileMutationGuardSync = () => void;

export interface FileSnapshot {
	content: Buffer | null;
	/** Strip only this add-on's block if Local creates the core template after the snapshot. */
	createdTemplateKind?: 'apache' | 'nginx';
	filePath: string;
}

export function apacheSnapshotHasCompleteManagedConfig(
	site: Local.Site,
	snapshots: FileSnapshot[],
): boolean {
	try {
		const paths = getApacheManagedPaths(site);
		const content = (filePath: string): string | null => (
			snapshots.find((snapshot) => snapshot.filePath === filePath)?.content?.toString('utf8') ?? null
		);
		const main = content(paths.siteTemplate);
		const modules = content(paths.modulesTemplate);
		const include = content(paths.includeTemplate);
		return Boolean(
			main && hasApacheManagedBlock(main) &&
			modules && hasApacheManagedBlock(modules) &&
			include && hasApacheManagedBlock(include),
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function nearestExistingAncestor(candidatePath: string): string {
	let currentPath = candidatePath;
	while (true) {
		try {
			fsSync.lstatSync(currentPath);
			return currentPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			throw new Error('Could not resolve a safe web-server configuration parent path.');
		}
		currentPath = parentPath;
	}
}

function ensureInsideSite(siteRoot: string, candidatePath: string): string {
	const relative = path.relative(siteRoot, candidatePath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Local returned an unsafe web-server configuration path.');
	}

	const siteRootMetadata = fsSync.lstatSync(siteRoot);
	if (!siteRootMetadata.isDirectory() || siteRootMetadata.isSymbolicLink()) {
		throw new Error(
			'Local returned an unsafe site root. The site root must be a real directory, not a symbolic link.',
		);
	}
	const realSiteRoot = fsSync.realpathSync.native(siteRoot);
	const existingAncestor = nearestExistingAncestor(candidatePath);
	const realExistingAncestor = fsSync.realpathSync.native(existingAncestor);
	const realRelative = path.relative(realSiteRoot, realExistingAncestor);
	if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
		throw new Error('Local returned an unsafe web-server configuration path through a symbolic link.');
	}

	return candidatePath;
}

export function getManagedPaths(site: Local.Site): ManagedPaths {
	const siteRoot = path.resolve(site.longPath);
	const configuredTemplatesPath = (site as Local.Site & {
		paths?: { confTemplates?: string };
	}).paths?.confTemplates;
	const templatesRoot = path.resolve(configuredTemplatesPath || path.join(siteRoot, 'conf'));
	const nginxRoot = ensureInsideSite(siteRoot, path.join(templatesRoot, 'nginx'));

	return {
		includeTemplate: ensureInsideSite(
			siteRoot,
			path.join(nginxRoot, 'includes', MANAGED_INCLUDE_FILENAME),
		),
		siteTemplate: ensureInsideSite(siteRoot, path.join(nginxRoot, 'site.conf.hbs')),
		trustBundle: ensureInsideSite(siteRoot, path.join(nginxRoot, TRUST_BUNDLE_FILENAME)),
	};
}

export function getApacheManagedPaths(site: Local.Site): ApacheManagedPaths {
	const siteRoot = path.resolve(site.longPath);
	const configuredTemplatesPath = (site as Local.Site & {
		paths?: { confTemplates?: string };
	}).paths?.confTemplates;
	const templatesRoot = path.resolve(configuredTemplatesPath || path.join(siteRoot, 'conf'));
	const apacheRoot = ensureInsideSite(siteRoot, path.join(templatesRoot, 'apache'));

	return {
		includeTemplate: ensureInsideSite(
			siteRoot,
			path.join(apacheRoot, 'includes', MANAGED_INCLUDE_FILENAME),
		),
		modulesTemplate: ensureInsideSite(siteRoot, path.join(apacheRoot, 'modules.conf.hbs')),
		siteTemplate: ensureInsideSite(siteRoot, path.join(apacheRoot, 'site.conf.hbs')),
		trustBundle: ensureInsideSite(siteRoot, path.join(apacheRoot, TRUST_BUNDLE_FILENAME)),
	};
}

function isExpectedLifecycleFilesystemAbsence(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE';
}

function isRegularFile(filePath: string): boolean {
	try {
		return fsSync.statSync(filePath).isFile();
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function isRealDirectory(filePath: string): boolean {
	try {
		const metadata = fsSync.lstatSync(filePath);
		return metadata.isDirectory() && !metadata.isSymbolicLink();
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function isAbsentOrRealDirectory(filePath: string): boolean {
	try {
		const metadata = fsSync.lstatSync(filePath);
		return metadata.isDirectory() && !metadata.isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return true;
		}
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function allManagedParentsReady(paths: ManagedPaths | ApacheManagedPaths): boolean {
	return [...new Set(
		Object.values(paths).map((filePath) => path.dirname(filePath)),
	)].every(isRealDirectory);
}

/**
 * Confirm Local has finished creating the site-owned templates this add-on may
 * inspect or modify. Expected creation/deletion races are an ordinary "not
 * ready" result, while unsafe configured paths and symlink escapes still throw.
 */
export function serverManagedFilesystemReady(
	site: Local.Site,
	serverKind: ServerKind,
): boolean {
	if (serverKind === 'unsupported' || !site.longPath) {
		return false;
	}

	try {
		const siteRoot = path.resolve(site.longPath);
		if (serverKind === 'nginx') {
			const paths = getManagedPaths(site);
			return (
				isRealDirectory(siteRoot) &&
				isRegularFile(paths.siteTemplate) &&
				allManagedParentsReady(paths)
			);
		}

		const paths = getApacheManagedPaths(site);
		const apacheRoot = path.dirname(paths.siteTemplate);
		const managedIncludesRoot = path.dirname(paths.includeTemplate);
		return (
			isRealDirectory(siteRoot) &&
			isRealDirectory(apacheRoot) &&
			isRegularFile(paths.siteTemplate) &&
			isRegularFile(paths.modulesTemplate) &&
			isAbsentOrRealDirectory(managedIncludesRoot)
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function assertServerManagedFilesystemReady(
	site: Local.Site,
	serverKind: Exclude<ServerKind, 'unsupported'>,
): void {
	if (!serverManagedFilesystemReady(site, serverKind)) {
		throw new Error('Local has not finished creating this site web-server configuration.');
	}
}

function normalizePathForNginx(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

function assertHttpsTrustBundleAvailable(
	origin: NormalizedOrigin,
	trustedCertificateAuthoritiesPem?: string,
): void {
	if (origin.protocol === 'https:' && !trustedCertificateAuthoritiesPem) {
		throw new Error('The HTTPS certificate authority bundle is unavailable.');
	}
}

async function runGuardedRead<T>(
	assertCurrent: ManagedFileMutationGuard | undefined,
	read: () => T | Promise<T>,
): Promise<T> {
	await runMutationGuard(assertCurrent);
	let result: T;
	try {
		result = await read();
	} catch (error) {
		if (assertCurrent) {
			try {
				await runMutationGuard(assertCurrent);
			} catch (guardError) {
				throw guardError;
			}
		}
		throw error;
	}
	await runMutationGuard(assertCurrent);
	return result;
}

async function readOptionalFile(
	filePath: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<Buffer | null> {
	return runGuardedRead(assertCurrent, async () => {
		try {
			return await fs.readFile(filePath);
		} catch (error) {
			if (isExpectedLifecycleFilesystemAbsence(error)) {
				return null;
			}

			throw error;
		}
	});
}

async function assertExistingParentDirectory(filePath: string): Promise<void> {
	const directoryPath = path.dirname(filePath);
	try {
		const metadata = await fs.lstat(directoryPath);
		if (!metadata.isDirectory()) {
			throw new Error('The managed-file parent path is not a directory.');
		}
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			throw new Error(
				'The managed-file parent directory is unavailable during the Local site lifecycle.',
				{ cause: error },
			);
		}
		throw error;
	}
}

function assertExistingParentDirectorySync(filePath: string): void {
	const directoryPath = path.dirname(filePath);
	try {
		const metadata = fsSync.lstatSync(directoryPath);
		if (!metadata.isDirectory()) {
			throw new Error('The managed-file parent path is not a directory.');
		}
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			throw new Error(
				'The managed-file parent directory is unavailable during the Local site lifecycle.',
				{ cause: error },
			);
		}
		throw error;
	}
}

async function runMutationGuard(
	assertCurrent?: ManagedFileMutationGuard,
): Promise<void> {
	await assertCurrent?.();
}

async function ensureApacheManagedIncludesDirectory(
	site: Local.Site,
	paths: ApacheManagedPaths,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<void> {
	const directoryPath = path.dirname(paths.includeTemplate);

	await runMutationGuard(assertCurrent);
	assertServerManagedFilesystemReady(site, 'apache');
	try {
		const metadata = await fs.lstat(directoryPath);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error('The Apache managed-file parent path must be a real directory.');
		}
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	await runMutationGuard(assertCurrent);
	assertServerManagedFilesystemReady(site, 'apache');
	try {
		await fs.mkdir(directoryPath, { mode: 0o755 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
		const metadata = await fs.lstat(directoryPath);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error('The Apache managed-file parent path must be a real directory.');
		}
	}

	// Leave an empty managed directory behind if the next guard closes. Local may
	// have replaced this root, so path-based cleanup could escape the site.
	await runMutationGuard(assertCurrent);
	assertServerManagedFilesystemReady(site, 'apache');
}

function removeTemporaryFile(filePath: string): Promise<void> {
	return fs.rm(filePath, { force: true }).catch((error: unknown) => {
		if (!isExpectedLifecycleFilesystemAbsence(error)) {
			throw error;
		}
	});
}

function removeTemporaryFileSync(filePath: string): void {
	try {
		fsSync.rmSync(filePath, { force: true });
	} catch (error) {
		if (!isExpectedLifecycleFilesystemAbsence(error)) {
			throw error;
		}
	}
}

async function writeExclusiveTemporaryFile(
	filePath: string,
	content: string | Buffer,
): Promise<void> {
	const handle = await fs.open(filePath, 'wx', 0o600);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) {
			throw new Error('The managed-file temporary path is not a regular file.');
		}
		await handle.writeFile(content);
	} finally {
		await handle.close();
	}
}

function writeExclusiveTemporaryFileSync(
	filePath: string,
	content: string | Buffer,
): void {
	const descriptor = fsSync.openSync(filePath, 'wx', 0o600);
	try {
		if (!fsSync.fstatSync(descriptor).isFile()) {
			throw new Error('The managed-file temporary path is not a regular file.');
		}
		fsSync.writeFileSync(descriptor, content);
	} finally {
		fsSync.closeSync(descriptor);
	}
}

async function atomicWrite(
	filePath: string,
	content: string | Buffer,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<void> {
	await assertExistingParentDirectory(filePath);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

	try {
		await runMutationGuard(assertCurrent);
		await writeExclusiveTemporaryFile(temporaryPath, content);
		await assertExistingParentDirectory(filePath);
		await runMutationGuard(assertCurrent);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await removeTemporaryFile(temporaryPath);
	}
}

async function writeIfChanged(
	filePath: string,
	content: string | Buffer,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	const current = await readOptionalFile(filePath, assertCurrent);
	const next = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

	if (current?.equals(next)) {
		return false;
	}

	await atomicWrite(filePath, next, assertCurrent);
	return true;
}

async function removeIfPresent(
	filePath: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	try {
		await fs.lstat(filePath);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}

	await runMutationGuard(assertCurrent);
	try {
		await fs.unlink(filePath);
		return true;
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

function atomicWriteSync(
	filePath: string,
	content: string | Buffer,
	assertCurrent?: ManagedFileMutationGuardSync,
): void {
	assertExistingParentDirectorySync(filePath);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

	try {
		assertCurrent?.();
		writeExclusiveTemporaryFileSync(temporaryPath, content);
		assertExistingParentDirectorySync(filePath);
		assertCurrent?.();
		fsSync.renameSync(temporaryPath, filePath);
	} finally {
		removeTemporaryFileSync(temporaryPath);
	}
}

export async function captureManagedFiles(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<FileSnapshot[]> {
	const paths = await runGuardedRead(assertCurrent, () => getManagedPaths(site));
	const snapshots = [
		{ filePath: paths.includeTemplate },
		{ createdTemplateKind: 'nginx' as const, filePath: paths.siteTemplate },
		{ filePath: paths.trustBundle },
	];
	const captured: FileSnapshot[] = [];
	for (const snapshot of snapshots) {
		captured.push({
			...snapshot,
			content: await readOptionalFile(snapshot.filePath, assertCurrent),
		});
	}
	return captured;
}

export async function restoreManagedFiles(
	snapshots: FileSnapshot[],
	assertCurrent?: ManagedFileMutationGuard,
): Promise<void> {
	const failures: Error[] = [];
	for (const snapshot of snapshots) {
		await runMutationGuard(assertCurrent);
		try {
			if (snapshot.content === null) {
				if (!snapshot.createdTemplateKind) {
					await removeIfPresent(snapshot.filePath, assertCurrent);
				} else {
					const createdContent = await readOptionalFile(snapshot.filePath, assertCurrent);
					if (createdContent) {
						const current = createdContent.toString('utf8');
						const restored = snapshot.createdTemplateKind === 'nginx'
							? removeManagedInclude(current)
							: removeApacheManagedBlock(current);
						if (restored !== current) {
							await atomicWrite(snapshot.filePath, restored, assertCurrent);
						}
					}
				}
			} else {
				await atomicWrite(snapshot.filePath, snapshot.content, assertCurrent);
			}
		} catch (error) {
			if (assertCurrent) {
				try {
					await runMutationGuard(assertCurrent);
				} catch (guardError) {
					throw guardError;
				}
			}
			failures.push(new Error(
				`Could not restore ${snapshot.filePath}: ${error instanceof Error ? error.message : String(error)}`,
			));
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, 'One or more managed files could not be restored.');
	}
}

export async function captureAllManagedFiles(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<FileSnapshot[]> {
	const nginx = await runGuardedRead(assertCurrent, () => getManagedPaths(site));
	const apache = await runGuardedRead(assertCurrent, () => getApacheManagedPaths(site));
	const snapshots = [
		{ filePath: nginx.includeTemplate },
		{ createdTemplateKind: 'nginx' as const, filePath: nginx.siteTemplate },
		{ filePath: nginx.trustBundle },
		{ filePath: apache.includeTemplate },
		{ createdTemplateKind: 'apache' as const, filePath: apache.modulesTemplate },
		{ createdTemplateKind: 'apache' as const, filePath: apache.siteTemplate },
		{ filePath: apache.trustBundle },
	];
	const captured: FileSnapshot[] = [];
	for (const snapshot of snapshots) {
		captured.push({
			...snapshot,
			content: await readOptionalFile(snapshot.filePath, assertCurrent),
		});
	}
	return captured;
}

export async function applyManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	assertServerManagedFilesystemReady(site, 'nginx');
	const paths = getManagedPaths(site);
	const originalSiteTemplate = await fs.readFile(paths.siteTemplate, 'utf8');
	const nextSiteTemplate = upsertManagedInclude(originalSiteTemplate);
	const nextInclude = buildManagedNginxConfig(
		origin,
		origin.protocol === 'https:' ? normalizePathForNginx(paths.trustBundle) : undefined,
	);

	assertHttpsTrustBundleAvailable(origin, trustedCertificateAuthoritiesPem);

	let changed = false;
	if (origin.protocol === 'https:') {
		changed = await writeIfChanged(
			paths.trustBundle,
			trustedCertificateAuthoritiesPem as string,
			assertCurrent,
		) || changed;
	} else {
		changed = await removeIfPresent(paths.trustBundle, assertCurrent) || changed;
	}

	changed = await writeIfChanged(paths.includeTemplate, nextInclude, assertCurrent) || changed;
	changed = await writeIfChanged(paths.siteTemplate, nextSiteTemplate, assertCurrent) || changed;
	return changed;
}

export async function removeManagedFiles(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	let paths: ManagedPaths;
	try {
		paths = getManagedPaths(site);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
	let changed = false;

	try {
		const currentSiteTemplate = await fs.readFile(paths.siteTemplate, 'utf8');
		const nextSiteTemplate = removeManagedInclude(currentSiteTemplate);
		if (nextSiteTemplate !== currentSiteTemplate) {
			changed = await writeIfChanged(
				paths.siteTemplate,
				nextSiteTemplate,
				assertCurrent,
			) || changed;
		}
	} catch (error) {
		if (!isExpectedLifecycleFilesystemAbsence(error)) {
			throw error;
		}
	}

	changed = await removeIfPresent(paths.includeTemplate, assertCurrent) || changed;
	changed = await removeIfPresent(paths.trustBundle, assertCurrent) || changed;
	return changed;
}

async function applyApacheManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	httpdBinary: string,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	assertServerManagedFilesystemReady(site, 'apache');
	const paths = getApacheManagedPaths(site);
	const [originalSiteTemplate, originalModulesTemplate] = await Promise.all([
		fs.readFile(paths.siteTemplate, 'utf8'),
		fs.readFile(paths.modulesTemplate, 'utf8'),
	]);
	const nextSiteTemplate = upsertApacheInclude(originalSiteTemplate);
	const nextModulesTemplate = upsertApacheModules(
		originalModulesTemplate,
		httpdBinary,
		origin.protocol === 'https:',
	);
	const nextInclude = buildManagedApacheConfig(
		origin,
		origin.protocol === 'https:' ? normalizePathForNginx(paths.trustBundle) : undefined,
	);
	assertHttpsTrustBundleAvailable(origin, trustedCertificateAuthoritiesPem);
	await ensureApacheManagedIncludesDirectory(site, paths, assertCurrent);

	let changed = false;
	if (origin.protocol === 'https:') {
		changed = await writeIfChanged(
			paths.trustBundle,
			trustedCertificateAuthoritiesPem as string,
			assertCurrent,
		) || changed;
	} else {
		changed = await removeIfPresent(paths.trustBundle, assertCurrent) || changed;
	}
	changed = await writeIfChanged(paths.includeTemplate, nextInclude, assertCurrent) || changed;
	changed = await writeIfChanged(
		paths.modulesTemplate,
		nextModulesTemplate,
		assertCurrent,
	) || changed;
	changed = await writeIfChanged(paths.siteTemplate, nextSiteTemplate, assertCurrent) || changed;
	return changed;
}

async function removeApacheManagedFiles(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	let paths: ApacheManagedPaths;
	try {
		paths = getApacheManagedPaths(site);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
	let changed = false;
	for (const templatePath of [paths.siteTemplate, paths.modulesTemplate]) {
		try {
			const current = await fs.readFile(templatePath, 'utf8');
			const next = removeApacheManagedBlock(current);
			if (next !== current) {
				changed = await writeIfChanged(templatePath, next, assertCurrent) || changed;
			}
		} catch (error) {
			if (!isExpectedLifecycleFilesystemAbsence(error)) {
				throw error;
			}
		}
	}
	changed = await removeIfPresent(paths.includeTemplate, assertCurrent) || changed;
	changed = await removeIfPresent(paths.trustBundle, assertCurrent) || changed;
	return changed;
}

export async function removeAllManagedFiles(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	const nginxChanged = await removeManagedFiles(site, assertCurrent);
	const apacheChanged = await removeApacheManagedFiles(site, assertCurrent);
	return nginxChanged || apacheChanged;
}

export async function applyServerManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	options: ServerManagedFileOptions,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	assertServerManagedFilesystemReady(site, options.serverKind);
	assertHttpsTrustBundleAvailable(origin, trustedCertificateAuthoritiesPem);
	let apacheHttpdBinary: string | undefined;
	if (options.serverKind === 'apache') {
		if (!options.apacheHttpdBinary) {
			throw new Error('Local did not provide an Apache httpd binary for this site.');
		}
		apacheHttpdBinary = options.apacheHttpdBinary;
		await validateApacheModuleFiles(
			apacheHttpdBinary,
			origin.protocol === 'https:',
		);
	}
	if (options.serverKind === 'nginx') {
		let changed = await removeApacheManagedFiles(site, assertCurrent);
		changed = await applyManagedFiles(
			site,
			origin,
			trustedCertificateAuthoritiesPem,
			assertCurrent,
		) || changed;
		return changed;
	}
	const changed = await removeManagedFiles(site, assertCurrent);
	return await applyApacheManagedFiles(
		site,
		origin,
		apacheHttpdBinary as string,
		trustedCertificateAuthoritiesPem,
		assertCurrent,
	) || changed;
}

export function removeManagedFilesSync(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuardSync,
): boolean {
	let paths: ManagedPaths;
	try {
		paths = getManagedPaths(site);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
	let changed = false;

	try {
		const currentSiteTemplate = fsSync.readFileSync(paths.siteTemplate, 'utf8');
		const nextSiteTemplate = removeManagedInclude(currentSiteTemplate);
		if (nextSiteTemplate !== currentSiteTemplate) {
			atomicWriteSync(paths.siteTemplate, nextSiteTemplate, assertCurrent);
			changed = true;
		}
	} catch (error) {
		if (!isExpectedLifecycleFilesystemAbsence(error)) {
			throw error;
		}
	}

	for (const filePath of [paths.includeTemplate, paths.trustBundle]) {
		try {
			fsSync.lstatSync(filePath);
		} catch (error) {
			if (isExpectedLifecycleFilesystemAbsence(error)) {
				continue;
			}
			throw error;
		}
		assertCurrent?.();
		try {
			fsSync.unlinkSync(filePath);
			changed = true;
		} catch (error) {
			if (!isExpectedLifecycleFilesystemAbsence(error)) {
				throw error;
			}
		}
	}

	return changed;
}

export function removeAllManagedFilesSync(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuardSync,
): boolean {
	let changed = removeManagedFilesSync(site, assertCurrent);
	let paths: ApacheManagedPaths;
	try {
		paths = getApacheManagedPaths(site);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return changed;
		}
		throw error;
	}
	for (const templatePath of [paths.siteTemplate, paths.modulesTemplate]) {
		try {
			const current = fsSync.readFileSync(templatePath, 'utf8');
			const next = removeApacheManagedBlock(current);
			if (next !== current) {
				atomicWriteSync(templatePath, next, assertCurrent);
				changed = true;
			}
		} catch (error) {
			if (!isExpectedLifecycleFilesystemAbsence(error)) {
				throw error;
			}
		}
	}
	for (const filePath of [paths.includeTemplate, paths.trustBundle]) {
		try {
			fsSync.lstatSync(filePath);
		} catch (error) {
			if (isExpectedLifecycleFilesystemAbsence(error)) {
				continue;
			}
			throw error;
		}
		assertCurrent?.();
		try {
			fsSync.unlinkSync(filePath);
			changed = true;
		} catch (error) {
			if (!isExpectedLifecycleFilesystemAbsence(error)) {
				throw error;
			}
		}
	}
	return changed;
}

export async function managedArtifactsExist(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	try {
		const paths = await runGuardedRead(assertCurrent, () => getManagedPaths(site));
		const siteTemplate = await readOptionalFile(paths.siteTemplate, assertCurrent);
		const includeTemplate = await readOptionalFile(paths.includeTemplate, assertCurrent);
		const trustBundle = await readOptionalFile(paths.trustBundle, assertCurrent);

		return (
			(siteTemplate !== null && hasManagedInclude(siteTemplate.toString('utf8'))) ||
			includeTemplate !== null ||
			trustBundle !== null
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

export async function allManagedArtifactsExist(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	if (await managedArtifactsExist(site, assertCurrent)) {
		return true;
	}
	return apacheArtifactsExist(site, assertCurrent);
}

export async function managedFilesMatch(
	site: Local.Site,
	origin: NormalizedOrigin,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	try {
		const paths = await runGuardedRead(assertCurrent, () => getManagedPaths(site));
		const siteTemplate = await runGuardedRead(
			assertCurrent,
			() => fs.readFile(paths.siteTemplate, 'utf8'),
		);
		const includeTemplate = await runGuardedRead(
			assertCurrent,
			() => fs.readFile(paths.includeTemplate, 'utf8'),
		);
		const trustBundle = await readOptionalFile(paths.trustBundle, assertCurrent);
		const expectedSiteTemplate = upsertManagedInclude(siteTemplate);
		const expectedInclude = buildManagedNginxConfig(
			origin,
			origin.protocol === 'https:' ? normalizePathForNginx(paths.trustBundle) : undefined,
		);
		const trustMatches = origin.protocol === 'https:'
			? Boolean(
				trustedCertificateAuthoritiesPem &&
				trustBundle?.equals(Buffer.from(trustedCertificateAuthoritiesPem, 'utf8')),
			)
			: trustBundle === null;

		return (
			hasManagedInclude(siteTemplate) &&
			siteTemplate === expectedSiteTemplate &&
			includeTemplate === expectedInclude &&
			trustMatches
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}

		throw error;
	}
}

async function apacheManagedFilesMatch(
	site: Local.Site,
	origin: NormalizedOrigin,
	httpdBinary: string,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	try {
		const paths = await runGuardedRead(assertCurrent, () => getApacheManagedPaths(site));
		const siteTemplate = await runGuardedRead(
			assertCurrent,
			() => fs.readFile(paths.siteTemplate, 'utf8'),
		);
		const modulesTemplate = await runGuardedRead(
			assertCurrent,
			() => fs.readFile(paths.modulesTemplate, 'utf8'),
		);
		const includeTemplate = await runGuardedRead(
			assertCurrent,
			() => fs.readFile(paths.includeTemplate, 'utf8'),
		);
		const trustBundle = await readOptionalFile(paths.trustBundle, assertCurrent);
		const expectedSite = upsertApacheInclude(siteTemplate);
		const expectedModules = upsertApacheModules(
			modulesTemplate,
			httpdBinary,
			origin.protocol === 'https:',
		);
		const expectedInclude = buildManagedApacheConfig(
			origin,
			origin.protocol === 'https:' ? normalizePathForNginx(paths.trustBundle) : undefined,
		);
		const trustMatches = origin.protocol === 'https:'
			? Boolean(
				trustedCertificateAuthoritiesPem &&
				trustBundle?.equals(Buffer.from(trustedCertificateAuthoritiesPem, 'utf8')),
			)
			: trustBundle === null;
		return (
			siteTemplate === expectedSite &&
			modulesTemplate === expectedModules &&
			includeTemplate === expectedInclude &&
			trustMatches
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}

export async function serverManagedFilesMatch(
	site: Local.Site,
	origin: NormalizedOrigin,
	options: ServerManagedFileOptions,
	trustedCertificateAuthoritiesPem?: string,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	if (options.serverKind === 'nginx') {
		return await managedFilesMatch(
			site,
			origin,
			trustedCertificateAuthoritiesPem,
			assertCurrent,
		) && !await apacheArtifactsExist(site, assertCurrent);
	}
	if (!options.apacheHttpdBinary) {
		return false;
	}
	return await apacheManagedFilesMatch(
		site,
		origin,
		options.apacheHttpdBinary,
		trustedCertificateAuthoritiesPem,
		assertCurrent,
	) && !await managedArtifactsExist(site, assertCurrent);
}

async function apacheArtifactsExist(
	site: Local.Site,
	assertCurrent?: ManagedFileMutationGuard,
): Promise<boolean> {
	try {
		const paths = await runGuardedRead(assertCurrent, () => getApacheManagedPaths(site));
		const siteTemplate = await readOptionalFile(paths.siteTemplate, assertCurrent);
		const modulesTemplate = await readOptionalFile(paths.modulesTemplate, assertCurrent);
		const includeTemplate = await readOptionalFile(paths.includeTemplate, assertCurrent);
		const trustBundle = await readOptionalFile(paths.trustBundle, assertCurrent);
		return (
			(siteTemplate !== null && hasApacheManagedBlock(siteTemplate.toString('utf8'))) ||
			(modulesTemplate !== null && hasApacheManagedBlock(modulesTemplate.toString('utf8'))) ||
			includeTemplate !== null ||
			trustBundle !== null
		);
	} catch (error) {
		if (isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}
		throw error;
	}
}
