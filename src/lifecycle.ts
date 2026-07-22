/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
