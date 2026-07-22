/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServerKind } from './types';

const SERVER_TRANSACTION_CHANGED_ERROR_NAME = 'LocalMediaProxyServerTransactionChangedError';

export interface ServerTransactionFingerprint {
	configPath: string | null;
	executablePath: string | null;
	runPath: string | null;
	serverKind: ServerKind;
	serviceName: string | null;
	siteConfigTemplatePath: string | null;
	sitePath: string;
	siteStatus: string;
	templatesPath: string | null;
}

export class ServerTransactionChangedError extends Error {
	constructor() {
		super(
			'Local changed this site\'s web-server identity or lifecycle status before the Media Proxy operation completed. Any settings and managed files changed by this transaction were restored; wait for Local to finish the change, then retry.',
		);
		this.name = SERVER_TRANSACTION_CHANGED_ERROR_NAME;
	}
}

export function serverTransactionFingerprintsMatch(
	expected: ServerTransactionFingerprint,
	current: ServerTransactionFingerprint,
): boolean {
	return expected.configPath === current.configPath &&
		expected.executablePath === current.executablePath &&
		expected.runPath === current.runPath &&
		expected.serverKind === current.serverKind &&
		expected.serviceName === current.serviceName &&
		expected.siteConfigTemplatePath === current.siteConfigTemplatePath &&
		expected.sitePath === current.sitePath &&
		expected.siteStatus === current.siteStatus &&
		expected.templatesPath === current.templatesPath;
}

export function isServerTransactionChangedError(
	error: unknown,
): error is ServerTransactionChangedError {
	return error instanceof ServerTransactionChangedError || (
		error instanceof Error &&
		error.name === SERVER_TRANSACTION_CHANGED_ERROR_NAME
	);
}

export async function runServerTransactionMutation<T>(
	assertCurrent: () => void,
	mutation: () => Promise<T>,
): Promise<T> {
	assertCurrent();
	const result = await mutation();
	assertCurrent();
	return result;
}

export interface UnresolvedServiceCleanupOperations {
	compileAllConfigs: () => Promise<void>;
	hasManagedArtifacts: () => Promise<boolean>;
	isSiteRunning: () => boolean;
	removeAllManagedFiles: () => Promise<boolean>;
}

export interface UnresolvedServiceCleanupResult {
	changed: boolean;
}

export function cleanupRequiresRefresh(changed: boolean, enabledIntent: boolean): boolean {
	return changed || enabledIntent;
}

const EXPLICITLY_INACTIVE_SITE_STATUSES = new Set([
	'deleting',
	'deleting_backup',
	'halted',
	'stopping',
]);

export function shouldRefreshRuntime(siteStatus: string, targetServiceRunning: boolean): boolean {
	return siteStatus === 'running' || (
		targetServiceRunning && !EXPLICITLY_INACTIVE_SITE_STATUSES.has(siteStatus)
	);
}

export function shouldReconcileManagedFiles(
	siteStatus: string,
	forcedAfterSiteStarted: boolean,
): boolean {
	return siteStatus === 'running' || siteStatus === 'halted' || (
		forcedAfterSiteStarted && !EXPLICITLY_INACTIVE_SITE_STATUSES.has(siteStatus)
	);
}

export function synchronousCleanupRequiresRefresh(
	removeManagedFiles: () => boolean,
	onError: (error: unknown) => void,
): boolean {
	try {
		return removeManagedFiles();
	} catch (error) {
		onError(error);
		return true;
	}
}

export async function completeUnresolvedServiceCleanup(
	operations: UnresolvedServiceCleanupOperations,
	forceRefresh: boolean,
): Promise<UnresolvedServiceCleanupResult> {
	const wasRunning = operations.isSiteRunning();
	const assertSiteStopped = (): void => {
		if (wasRunning || operations.isSiteRunning()) {
			throw new Error(
				'Persistent proxy files were cleaned, but this running site could not be refreshed safely because its web-server service was not resolved. Stop the site in Local, then retry the add-on cleanup before starting it again; a previously compiled proxy may remain active until the site stops.',
			);
		}
	};
	const changed = await operations.removeAllManagedFiles();
	if (await operations.hasManagedArtifacts()) {
		throw new Error('Managed proxy files remained after whole-site cleanup.');
	}
	if (!changed && !forceRefresh) {
		assertSiteStopped();
		return { changed: false };
	}

	await operations.compileAllConfigs();
	if (await operations.hasManagedArtifacts()) {
		throw new Error('Managed proxy files reappeared while compiling the cleaned site.');
	}
	assertSiteStopped();
	return { changed };
}
