/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

export interface FileSnapshot {
	content: Buffer | null;
	filePath: string;
}

export function apacheSnapshotHasCompleteManagedConfig(
	site: Local.Site,
	snapshots: FileSnapshot[],
): boolean {
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

function normalizePathForNginx(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}

		throw error;
	}
}

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

	try {
		await fs.writeFile(temporaryPath, content);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

async function writeIfChanged(filePath: string, content: string | Buffer): Promise<boolean> {
	const current = await readOptionalFile(filePath);
	const next = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

	if (current?.equals(next)) {
		return false;
	}

	await atomicWrite(filePath, next);
	return true;
}

async function removeIfPresent(filePath: string): Promise<boolean> {
	try {
		await fs.unlink(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}

		throw error;
	}
}

function atomicWriteSync(filePath: string, content: string | Buffer): void {
	fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

	try {
		fsSync.writeFileSync(temporaryPath, content);
		fsSync.renameSync(temporaryPath, filePath);
	} finally {
		fsSync.rmSync(temporaryPath, { force: true });
	}
}

export async function captureManagedFiles(site: Local.Site): Promise<FileSnapshot[]> {
	const paths = getManagedPaths(site);
	return Promise.all(Object.values(paths).map(async (filePath) => ({
		content: await readOptionalFile(filePath),
		filePath,
	})));
}

export async function restoreManagedFiles(snapshots: FileSnapshot[]): Promise<void> {
	const failures: Error[] = [];
	for (const snapshot of snapshots) {
		try {
			if (snapshot.content === null) {
				await fs.rm(snapshot.filePath, { force: true });
			} else {
				await atomicWrite(snapshot.filePath, snapshot.content);
			}
		} catch (error) {
			failures.push(new Error(
				`Could not restore ${snapshot.filePath}: ${error instanceof Error ? error.message : String(error)}`,
			));
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, 'One or more managed files could not be restored.');
	}
}

export async function captureAllManagedFiles(site: Local.Site): Promise<FileSnapshot[]> {
	const nginx = getManagedPaths(site);
	const apache = getApacheManagedPaths(site);
	return Promise.all([
		...Object.values(nginx),
		...Object.values(apache),
	].map(async (filePath) => ({
		content: await readOptionalFile(filePath),
		filePath,
	})));
}

export async function applyManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	trustedCertificateAuthoritiesPem?: string,
): Promise<boolean> {
	const paths = getManagedPaths(site);
	const originalSiteTemplate = await fs.readFile(paths.siteTemplate, 'utf8');
	const nextSiteTemplate = upsertManagedInclude(originalSiteTemplate);
	const nextInclude = buildManagedNginxConfig(
		origin,
		origin.protocol === 'https:' ? normalizePathForNginx(paths.trustBundle) : undefined,
	);

	if (origin.protocol === 'https:' && !trustedCertificateAuthoritiesPem) {
		throw new Error('The HTTPS certificate authority bundle is unavailable.');
	}

	let changed = false;
	if (origin.protocol === 'https:') {
		changed = await writeIfChanged(
			paths.trustBundle,
			trustedCertificateAuthoritiesPem as string,
		) || changed;
	} else {
		changed = await removeIfPresent(paths.trustBundle) || changed;
	}

	changed = await writeIfChanged(paths.includeTemplate, nextInclude) || changed;
	changed = await writeIfChanged(paths.siteTemplate, nextSiteTemplate) || changed;
	return changed;
}

export async function removeManagedFiles(site: Local.Site): Promise<boolean> {
	const paths = getManagedPaths(site);
	let changed = false;

	try {
		const currentSiteTemplate = await fs.readFile(paths.siteTemplate, 'utf8');
		const nextSiteTemplate = removeManagedInclude(currentSiteTemplate);
		if (nextSiteTemplate !== currentSiteTemplate) {
			changed = await writeIfChanged(paths.siteTemplate, nextSiteTemplate) || changed;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	changed = await removeIfPresent(paths.includeTemplate) || changed;
	changed = await removeIfPresent(paths.trustBundle) || changed;
	return changed;
}

async function applyApacheManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	httpdBinary: string,
	trustedCertificateAuthoritiesPem?: string,
): Promise<boolean> {
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
	if (origin.protocol === 'https:' && !trustedCertificateAuthoritiesPem) {
		throw new Error('The HTTPS certificate authority bundle is unavailable.');
	}

	let changed = false;
	if (origin.protocol === 'https:') {
		changed = await writeIfChanged(
			paths.trustBundle,
			trustedCertificateAuthoritiesPem as string,
		) || changed;
	} else {
		changed = await removeIfPresent(paths.trustBundle) || changed;
	}
	changed = await writeIfChanged(paths.includeTemplate, nextInclude) || changed;
	changed = await writeIfChanged(paths.modulesTemplate, nextModulesTemplate) || changed;
	changed = await writeIfChanged(paths.siteTemplate, nextSiteTemplate) || changed;
	return changed;
}

async function removeApacheManagedFiles(site: Local.Site): Promise<boolean> {
	const paths = getApacheManagedPaths(site);
	let changed = false;
	for (const templatePath of [paths.siteTemplate, paths.modulesTemplate]) {
		try {
			const current = await fs.readFile(templatePath, 'utf8');
			const next = removeApacheManagedBlock(current);
			if (next !== current) {
				changed = await writeIfChanged(templatePath, next) || changed;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
	changed = await removeIfPresent(paths.includeTemplate) || changed;
	changed = await removeIfPresent(paths.trustBundle) || changed;
	return changed;
}

export async function removeAllManagedFiles(site: Local.Site): Promise<boolean> {
	const [nginxChanged, apacheChanged] = await Promise.all([
		removeManagedFiles(site),
		removeApacheManagedFiles(site),
	]);
	return nginxChanged || apacheChanged;
}

export async function applyServerManagedFiles(
	site: Local.Site,
	origin: NormalizedOrigin,
	options: ServerManagedFileOptions,
	trustedCertificateAuthoritiesPem?: string,
): Promise<boolean> {
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
		let changed = await removeApacheManagedFiles(site);
		changed = await applyManagedFiles(
			site,
			origin,
			trustedCertificateAuthoritiesPem,
		) || changed;
		return changed;
	}
	const changed = await removeManagedFiles(site);
	return await applyApacheManagedFiles(
		site,
		origin,
		apacheHttpdBinary as string,
		trustedCertificateAuthoritiesPem,
	) || changed;
}

export function removeManagedFilesSync(site: Local.Site): boolean {
	const paths = getManagedPaths(site);
	let changed = false;

	try {
		const currentSiteTemplate = fsSync.readFileSync(paths.siteTemplate, 'utf8');
		const nextSiteTemplate = removeManagedInclude(currentSiteTemplate);
		if (nextSiteTemplate !== currentSiteTemplate) {
			atomicWriteSync(paths.siteTemplate, nextSiteTemplate);
			changed = true;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	for (const filePath of [paths.includeTemplate, paths.trustBundle]) {
		if (fsSync.existsSync(filePath)) {
			fsSync.rmSync(filePath, { force: true });
			changed = true;
		}
	}

	return changed;
}

export function removeAllManagedFilesSync(site: Local.Site): boolean {
	let changed = removeManagedFilesSync(site);
	const paths = getApacheManagedPaths(site);
	for (const templatePath of [paths.siteTemplate, paths.modulesTemplate]) {
		try {
			const current = fsSync.readFileSync(templatePath, 'utf8');
			const next = removeApacheManagedBlock(current);
			if (next !== current) {
				atomicWriteSync(templatePath, next);
				changed = true;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
	for (const filePath of [paths.includeTemplate, paths.trustBundle]) {
		if (fsSync.existsSync(filePath)) {
			fsSync.rmSync(filePath, { force: true });
			changed = true;
		}
	}
	return changed;
}

export async function managedArtifactsExist(site: Local.Site): Promise<boolean> {
	const paths = getManagedPaths(site);
	const [siteTemplate, includeTemplate, trustBundle] = await Promise.all([
		readOptionalFile(paths.siteTemplate),
		readOptionalFile(paths.includeTemplate),
		readOptionalFile(paths.trustBundle),
	]);

	return (
		(siteTemplate !== null && hasManagedInclude(siteTemplate.toString('utf8'))) ||
		includeTemplate !== null ||
		trustBundle !== null
	);
}

export async function allManagedArtifactsExist(site: Local.Site): Promise<boolean> {
	if (await managedArtifactsExist(site)) {
		return true;
	}
	const paths = getApacheManagedPaths(site);
	const [siteTemplate, modulesTemplate, includeTemplate, trustBundle] = await Promise.all([
		readOptionalFile(paths.siteTemplate),
		readOptionalFile(paths.modulesTemplate),
		readOptionalFile(paths.includeTemplate),
		readOptionalFile(paths.trustBundle),
	]);
	return (
		(siteTemplate !== null && hasApacheManagedBlock(siteTemplate.toString('utf8'))) ||
		(modulesTemplate !== null && hasApacheManagedBlock(modulesTemplate.toString('utf8'))) ||
		includeTemplate !== null ||
		trustBundle !== null
	);
}

export async function managedFilesMatch(
	site: Local.Site,
	origin: NormalizedOrigin,
	trustedCertificateAuthoritiesPem?: string,
): Promise<boolean> {
	const paths = getManagedPaths(site);
	try {
		const [siteTemplate, includeTemplate, trustBundle] = await Promise.all([
			fs.readFile(paths.siteTemplate, 'utf8'),
			fs.readFile(paths.includeTemplate, 'utf8'),
			readOptionalFile(paths.trustBundle),
		]);
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
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
): Promise<boolean> {
	const paths = getApacheManagedPaths(site);
	try {
		const [siteTemplate, modulesTemplate, includeTemplate, trustBundle] = await Promise.all([
			fs.readFile(paths.siteTemplate, 'utf8'),
			fs.readFile(paths.modulesTemplate, 'utf8'),
			fs.readFile(paths.includeTemplate, 'utf8'),
			readOptionalFile(paths.trustBundle),
		]);
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
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
): Promise<boolean> {
	if (options.serverKind === 'nginx') {
		return await managedFilesMatch(site, origin, trustedCertificateAuthoritiesPem) &&
			!await apacheArtifactsExist(site);
	}
	if (!options.apacheHttpdBinary) {
		return false;
	}
	return await apacheManagedFilesMatch(
		site,
		origin,
		options.apacheHttpdBinary,
		trustedCertificateAuthoritiesPem,
	) && !await managedArtifactsExist(site);
}

async function apacheArtifactsExist(site: Local.Site): Promise<boolean> {
	const paths = getApacheManagedPaths(site);
	const [siteTemplate, modulesTemplate, includeTemplate, trustBundle] = await Promise.all([
		readOptionalFile(paths.siteTemplate),
		readOptionalFile(paths.modulesTemplate),
		readOptionalFile(paths.includeTemplate),
		readOptionalFile(paths.trustBundle),
	]);
	return (
		(siteTemplate !== null && hasApacheManagedBlock(siteTemplate.toString('utf8'))) ||
		(modulesTemplate !== null && hasApacheManagedBlock(modulesTemplate.toString('utf8'))) ||
		includeTemplate !== null ||
		trustBundle !== null
	);
}
