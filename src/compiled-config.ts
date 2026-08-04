/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANAGED_INCLUDE_FILENAME } from './constants';

export type CompiledConfigMutationGuard = () => void;

export const COMPILED_INCLUDE_TOMBSTONE =
	'# Local Media Proxy inactive compiled include.\n';

function isExpectedFilesystemAbsence(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE';
}

async function assertRealDirectoryPath(
	directoryPath: string,
	description: string,
	assertCurrent: CompiledConfigMutationGuard,
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

export async function assertSafeCompiledFilePath(
	rootPath: string,
	filePath: string,
	description: string,
	assertCurrent: CompiledConfigMutationGuard = (): void => undefined,
): Promise<void> {
	const root = await assertRealDirectoryPath(rootPath, description, assertCurrent);
	const relative = path.relative(root, filePath);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`Local returned an unsafe ${description}.`);
	}

	let current = root;
	const segments = relative.split(path.sep);
	for (let index = 0; index < segments.length; index += 1) {
		assertCurrent();
		current = path.join(current, segments[index]);
		try {
			const metadata = await fs.lstat(current);
			const isFile = index === segments.length - 1;
			if (
				metadata.isSymbolicLink() ||
				(isFile ? !metadata.isFile() : !metadata.isDirectory())
			) {
				throw new Error(`Local returned an unsafe ${description}.`);
			}
		} catch (error) {
			if (isExpectedFilesystemAbsence(error)) {
				return;
			}
			throw error;
		}
	}
	assertCurrent();
}

export async function compileCompiledIncludeTombstone(
	rootPath: string,
	filePath: string,
	description: string,
	compileConfigTemplates: (templatesDirectory: string) => Promise<void>,
	assertCurrent: CompiledConfigMutationGuard = (): void => undefined,
): Promise<void> {
	await assertSafeCompiledFilePath(rootPath, filePath, description, assertCurrent);
	assertCurrent();
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'local-media-proxy-compiled-tombstone-'),
	);
	try {
		await fs.chmod(temporaryRoot, 0o700);
		const includesDirectory = path.join(temporaryRoot, 'includes');
		await fs.mkdir(includesDirectory, { mode: 0o700 });
		await fs.writeFile(
			path.join(includesDirectory, MANAGED_INCLUDE_FILENAME),
			COMPILED_INCLUDE_TOMBSTONE,
			{ encoding: 'utf8', mode: 0o600 },
		);
		assertCurrent();
		await compileConfigTemplates(temporaryRoot);
		assertCurrent();
	} finally {
		await fs.rm(temporaryRoot, { force: true, recursive: true });
	}
}
