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
	runtimeInputsFingerprint: string | null;
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
			'Local changed this site\'s web-server identity or lifecycle status before the Media Proxy operation completed. Media Proxy stopped further work; wait for Local to finish the change, then review the current state before retrying.',
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
		expected.runtimeInputsFingerprint === current.runtimeInputsFingerprint &&
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

const READY_SITE_STATUSES = new Set([
	'halted',
	'running',
]);

const DESTROYING_SITE_STATUSES = new Set([
	'deleting',
	'deleting_backup',
]);

const FAILED_SITE_STATUSES = new Set([
	'container_missing',
	'provisioning_error',
	'stalled',
	'wordpress_install_error',
]);

export type SiteLifecycleAccess = 'destroying' | 'failed' | 'ready' | 'transitioning';

export function siteLifecycleAccess(siteStatus: string): SiteLifecycleAccess {
	if (READY_SITE_STATUSES.has(siteStatus)) {
		return 'ready';
	}
	if (DESTROYING_SITE_STATUSES.has(siteStatus)) {
		return 'destroying';
	}
	if (FAILED_SITE_STATUSES.has(siteStatus)) {
		return 'failed';
	}
	return 'transitioning';
}

export function lifecycleUnavailableReason(siteStatus: string): string {
	const access = siteLifecycleAccess(siteStatus);
	if (access === 'destroying') {
		return 'Local is deleting this site. Media Proxy is inactive and will not access its files.';
	}
	if (access === 'failed') {
		return 'Local could not finish preparing this site. Resolve the site error in Local before using Media Proxy.';
	}
	if (siteStatus.startsWith('pulling') || siteStatus === 'downloading_backup') {
		return 'Local is still pulling this site. Media Proxy will remain inactive until the pull is complete.';
	}
	if (
		siteStatus === 'adding' ||
		siteStatus === 'creating' ||
		siteStatus === 'provisioning' ||
		siteStatus === 'wordpress_installing'
	) {
		return 'Local is still creating this site. Media Proxy will remain inactive until the site is ready.';
	}
	return 'Local is changing this site. Media Proxy will remain inactive until the site is running or stopped.';
}

export function shouldCancelDeferredReconciliation(siteStatus: string): boolean {
	const access = siteLifecycleAccess(siteStatus);
	return access === 'destroying' || access === 'failed';
}

export function shouldRefreshRuntime(
	siteStatus: string,
	targetServiceRunning: boolean,
): boolean {
	return siteStatus === 'running' && targetServiceRunning;
}

export function shouldReconcileManagedFiles(siteStatus: string): boolean {
	return siteLifecycleAccess(siteStatus) === 'ready';
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
