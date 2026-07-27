/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import {
	inspectApacheRuntimeCapabilities,
	refreshApacheService,
	type ApacheRuntimeService,
} from './apache';
import {
	ADDON_ID,
	IPC_CHANNELS,
	SITE_SETTINGS_KEY,
} from './constants';
import { discoverDnsOrigin } from './dns';
import {
	discoverWpEngineOrigin,
	getAuthoritativeWpEngineOrigin,
	getWpEngineConnectionSiteId,
	getOriginDiscoveryOptions,
	shouldRetainWpEngineSettingsAfterVerificationError,
	wpEngineOriginIdentityMatches,
	wpEngineStoredProvenanceMatches,
	type WpEngineCapi,
	type WpEngineOriginMetadata,
	WpEngineVerificationUnavailableError,
} from './hosting';
import { reloadNginxWithFallback } from './nginx';
import {
	cleanupRequiresRefresh,
	completeUnresolvedServiceCleanup,
	isServerTransactionChangedError,
	lifecycleUnavailableReason,
	runServerTransactionMutation,
	ServerTransactionChangedError,
	serverTransactionFingerprintsMatch,
	shouldCancelDeferredReconciliation,
	shouldReconcileManagedFiles,
	shouldRefreshRuntime,
	siteLifecycleAccess,
	type ServerTransactionFingerprint,
} from './lifecycle';
import {
	originResponseOutcome,
	probeOrigin,
	trustedCertificateAuthoritiesPem,
} from './origin';
import {
	allManagedArtifactsExist,
	apacheSnapshotHasCompleteManagedConfig,
	applyServerManagedFiles,
	captureAllManagedFiles,
	removeAllManagedFiles,
	removeAllManagedFilesSync,
	restoreManagedFiles,
	serverManagedFilesystemReady,
	serverManagedFilesMatch,
} from './site-config';
import { detectSiteServer, type SiteServerAdapter } from './server';
import {
	fallbackStoredSettings,
	normalizeStoredSettingsEnvelope,
	originPairMatches,
	replaceStoredSettingsForServer,
	serializeStoredSettingsEnvelope,
	setStoredSettingsEnabled,
	setStoredSettingsLastServer,
	storedSettingsEnvelopeNeedsMigration,
	storedSettingsForServer,
} from './settings';
import type {
	OriginDiscoveryRequest,
	OriginSuggestion,
	PublicOriginProbeResult,
	SettingsInput,
	SiteState,
	StoredSettings,
	StoredSettingsEnvelope,
	SupportedServerKind,
} from './types';
import {
	sanitizeDisabledSettings,
	validateAndNormalizeOrigin,
	validateSettingsInput,
} from './validation';

type SiteWithSettings = Local.Site & {
	[SITE_SETTINGS_KEY]?: unknown;
};

interface ReconcileOptions {
	configuredOnly?: boolean;
	refreshMatchingEnabledRuntime?: boolean;
}

interface DeferredReconciliation {
	attempts: number;
	options: ReconcileOptions;
	stableSamples: number;
	timer?: ReturnType<typeof setTimeout>;
}

interface DeferredGlobalCleanup {
	attempts: number;
	forceRefresh: boolean;
	generation: number;
	lastError?: string;
	mode: 'disabled' | 'uninstalling';
	stableSamples: number;
	timer?: ReturnType<typeof setTimeout>;
}

const siteOperationQueues = new Map<string, Promise<void>>();
const LIFECYCLE_LISTENERS_KEY = Symbol.for('amsive.local-media-proxy.lifecycle-listeners');
const DEFERRED_RECONCILIATION_INTERVAL_MS = 1_000;
const DEFERRED_RECONCILIATION_MAX_ATTEMPTS = 900;
const DEFERRED_RECONCILIATION_STABLE_SAMPLES = 2;
const DEFERRED_GLOBAL_CLEANUP_INTERVAL_MS = 1_000;
const DEFERRED_GLOBAL_CLEANUP_MAX_ATTEMPTS = 900;
const DEFERRED_GLOBAL_CLEANUP_STABLE_SAMPLES = 2;

class ApacheCapabilityUnavailableError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorLogMessage(error: unknown): string {
	if (error instanceof Error && error.cause !== undefined) {
		return `${error.message} Cause: ${errorMessage(error.cause)}`;
	}

	return errorMessage(error);
}

function isExpectedLifecycleFilesystemAbsence(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE';
}

function readStoredSettingsEnvelope(
	site: Local.Site,
	serverKind: 'apache' | 'nginx' | 'unsupported',
): StoredSettingsEnvelope {
	return normalizeStoredSettingsEnvelope((site as SiteWithSettings)[SITE_SETTINGS_KEY], serverKind);
}

async function withSiteLock<T>(siteId: string, operation: () => Promise<T>): Promise<T> {
	const previous = siteOperationQueues.get(siteId) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	siteOperationQueues.set(siteId, queued);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (siteOperationQueues.get(siteId) === queued) {
			siteOperationQueues.delete(siteId);
		}
	}
}

export default function main(context: LocalMain.AddonMainContext): void {
	const { ipcMain } = context.electron;
	const {
		appState,
		capi,
		configTemplates,
		lightningServices,
		localLogger,
		siteData,
		siteProcessManager,
	} = LocalMain.getServiceContainer().cradle;
	const wpEngineCapi = capi as WpEngineCapi;
	const logger = localLogger.child({ addon: ADDON_ID, thread: 'main' });
	const originProbeControllers = new Map<string, AbortController>();
	const deferredReconciliations = new Map<string, DeferredReconciliation>();
	const deferredGlobalCleanups = new Map<string, DeferredGlobalCleanup>();
	let globalLifecycleState: 'disabled' | 'uninstalling' | null = null;
	let globalLifecycleGeneration = 0;

	type RuntimeServer = SiteServerAdapter & {
		service: ApacheRuntimeService | null;
	};

	const resolveServer = (site: Local.Site): RuntimeServer => {
		const adapter = detectSiteServer(site);
		const service = adapter.serviceName
			? lightningServices.getSiteService(site, adapter.serviceName) as ApacheRuntimeService | null
			: null;
		return { ...adapter, service };
	};

	const serverTransactionFingerprint = (
		site: Local.Site,
		server: RuntimeServer,
	): ServerTransactionFingerprint => {
		const executableName = server.kind === 'apache' ? 'httpd' : 'nginx';
		const templatesPath = (site as Local.Site & {
			paths?: { confTemplates?: unknown };
		}).paths?.confTemplates;
		return {
			configPath: server.service?.configPath ?? null,
			executablePath: server.kind === 'unsupported'
				? null
				: server.service?.bin?.[executableName] ?? null,
			runPath: server.service?.runPath ?? null,
			serverKind: server.kind,
			serviceName: server.serviceName,
			siteConfigTemplatePath: server.service?.siteConfigTemplatePath ?? null,
			sitePath: site.longPath,
			siteStatus: siteProcessManager.getSiteStatus(site),
			templatesPath: typeof templatesPath === 'string' ? templatesPath : null,
		};
	};

	const currentServerTransactionFingerprint = (
		siteId: string,
	): ServerTransactionFingerprint | null => {
		const currentSite = siteData.getSite(siteId);
		if (!currentSite) {
			return null;
		}
		try {
			return serverTransactionFingerprint(currentSite, resolveServer(currentSite));
		} catch {
			return null;
		}
	};

	const serverTransactionIsCurrent = (
		siteId: string,
		expected: ServerTransactionFingerprint,
	): boolean => {
		try {
			const currentSite = siteData.getSite(siteId);
			if (!currentSite) {
				return false;
			}
			const current = currentServerTransactionFingerprint(siteId);
			if (
				current === null ||
				!serverTransactionFingerprintsMatch(expected, current)
			) {
				return false;
			}
			return expected.serverKind === 'unsupported' ||
				serverManagedFilesystemReady(currentSite, expected.serverKind);
		} catch {
			return false;
		}
	};

	const assertServerTransactionCurrent = (
		siteId: string,
		expected: ServerTransactionFingerprint,
	): void => {
		assertGloballyActive();
		if (!serverTransactionIsCurrent(siteId, expected)) {
			throw new ServerTransactionChangedError();
		}
	};

	const isExpectedLifecycleInterruption = (
		siteId: string,
		error: unknown,
	): boolean => {
		if (isServerTransactionChangedError(error)) {
			return true;
		}
		if (!isExpectedLifecycleFilesystemAbsence(error)) {
			return false;
		}

		const currentSite = siteData.getSite(siteId);
		if (!currentSite) {
			return true;
		}
		try {
			const siteStatus = siteProcessManager.getSiteStatus(currentSite);
			if (!shouldReconcileManagedFiles(siteStatus)) {
				return true;
			}
			const server = detectSiteServer(currentSite);
			return server.kind !== 'unsupported' &&
				!serverManagedFilesystemReady(currentSite, server.kind);
		} catch {
			return true;
		}
	};

	const beginInteractiveServerTransaction = (
		site: Local.Site,
		server: RuntimeServer,
	): ServerTransactionFingerprint => {
		const transaction = serverTransactionFingerprint(site, server);
		if (!shouldReconcileManagedFiles(transaction.siteStatus)) {
			throw new Error(
				`Local is currently ${transaction.siteStatus || 'changing this site'}. Wait until the site is running or stopped before changing Media Proxy settings.`,
			);
		}
		if (
			server.kind !== 'unsupported' &&
			!serverManagedFilesystemReady(site, server.kind)
		) {
			throw new Error(
				'Local has not finished preparing this site\'s web-server files. Wait for Local to finish, then retry.',
			);
		}
		return transaction;
	};

	const managedFileOptions = (server: RuntimeServer): {
		apacheHttpdBinary?: string;
		serverKind: 'apache' | 'nginx';
	} => {
		if (server.kind === 'unsupported') {
			throw new Error(server.reason || 'This site uses an unsupported web server.');
		}
		return {
			apacheHttpdBinary: server.kind === 'apache' ? server.service?.bin?.httpd : undefined,
			serverKind: server.kind,
		};
	};

	const assertGloballyActive = (): void => {
		if (globalLifecycleState) {
			throw new Error(`Local Media Proxy is ${globalLifecycleState}; the site operation was cancelled.`);
		}
	};

	const requireSiteId = (siteId: unknown): string => {
		if (typeof siteId !== 'string' || !siteId) {
			throw new Error('A valid Local site ID is required.');
		}

		return siteId;
	};

	const requireSupportedServerKind = (value: unknown): SupportedServerKind => {
		if (value !== 'apache' && value !== 'nginx') {
			throw new Error('A valid expected web-server profile is required.');
		}
		return value;
	};

	const requireSite = (siteId: string): Local.Site => {
		requireSiteId(siteId);

		const site = siteData.getSite(siteId);
		if (!site) {
			throw new Error('The selected Local site no longer exists.');
		}

		return site;
	};

	const requireLifecycleReadySite = (siteId: string): Local.Site => {
		const site = requireSite(siteId);
		const siteStatus = siteProcessManager.getSiteStatus(site);
		if (!shouldReconcileManagedFiles(siteStatus)) {
			throw new Error(lifecycleUnavailableReason(siteStatus));
		}
		const server = detectSiteServer(site);
		if (
			server.kind !== 'unsupported' &&
			!serverManagedFilesystemReady(site, server.kind)
		) {
			throw new Error(
				'Local has not finished preparing this site\'s web-server files. Wait for Local to finish, then retry.',
			);
		}
		return site;
	};

	const assertExpectedServer = (
		server: RuntimeServer,
		expectedServerKind: SupportedServerKind,
	): void => {
		if (server.kind !== expectedServerKind) {
			throw new Error(
				`This site now uses ${server.kind === 'unsupported' ? 'an unsupported web server' : server.kind}. Reload Media Proxy before changing its ${expectedServerKind} profile.`,
			);
		}
	};

	const requireOriginProbeToken = (value: unknown): string => {
		if (
			typeof value !== 'string' ||
			value.length < 1 ||
			value.length > 128 ||
			!/^[0-9A-Za-z:._-]+$/.test(value)
		) {
			throw new Error('A valid connection test token is required.');
		}

		return value;
	};

	const originProbeKey = (senderId: number, siteId: string, token: string): string => JSON.stringify([
		senderId,
		siteId,
		token,
	]);

	const wpEngineIdentity = (settings: SettingsInput): {
		environment?: unknown;
		siteUrl?: unknown;
		tlsHostname?: unknown;
	} => ({
		environment: settings.originEnvironment,
		siteUrl: settings.siteUrl,
		tlsHostname: settings.originTlsHostname,
	});

	const assertAuthoritativeWpEngineIdentity = async (
		site: Local.Site,
		settings: SettingsInput,
	): Promise<WpEngineOriginMetadata | undefined> => {
		if (settings.originSource !== 'wpengine') {
			return undefined;
		}
		if (!settings.originEnvironment) {
			throw new Error('Run WP Engine auto-population again to verify the selected environment.');
		}

		let authoritative: WpEngineOriginMetadata;
		try {
			authoritative = await getAuthoritativeWpEngineOrigin(
				site,
				settings.originEnvironment,
				wpEngineCapi,
			);
		} catch (error) {
			const message = 'Could not verify this WP Engine Site URL and TLS identity. Run auto-population again while Local is connected and signed in.';
			if (shouldRetainWpEngineSettingsAfterVerificationError(error)) {
				throw new WpEngineVerificationUnavailableError(message, { cause: error });
			}
			throw new Error(
				message,
				{ cause: error },
			);
		}

		if (
			!wpEngineOriginIdentityMatches(
				wpEngineIdentity(settings),
				{
					environment: authoritative.environment,
					siteUrl: authoritative.siteUrl,
					tlsHostname: authoritative.originTlsHostname,
				},
			)
		) {
			throw new Error('WP Engine origin identity changed. Run auto-population again before testing or applying these settings.');
		}

		return authoritative;
	};

	const assertStoredWpEngineConnection = async (
		site: Local.Site,
		settings: StoredSettings,
	): Promise<void> => {
		if (settings.originSource !== 'wpengine') {
			return;
		}
		if (!wpEngineStoredProvenanceMatches(
			site,
			settings.originWpEngineInstallId,
			settings.originWpEngineSiteId,
		)) {
			throw new Error('The saved WP Engine origin no longer matches this Local site connection. Run auto-population again.');
		}

		const authoritative = await assertAuthoritativeWpEngineIdentity(site, settings);
		if (
			!authoritative ||
			!wpEngineStoredProvenanceMatches(
				site,
				settings.originWpEngineInstallId,
				settings.originWpEngineSiteId,
				authoritative,
			)
		) {
			throw new Error('The saved WP Engine install identity changed. Run auto-population again.');
		}
	};

	const persistSettings = (siteId: string, envelope: StoredSettingsEnvelope): void => {
		siteData.updateSite(siteId, {
			id: siteId,
			[SITE_SETTINGS_KEY]: serializeStoredSettingsEnvelope(envelope),
		} as unknown as Partial<Local.SiteJSON>);
	};

	const commitInteractiveSettings = (
		siteId: string,
		transaction: ServerTransactionFingerprint,
		envelope: StoredSettingsEnvelope,
	): void => {
		assertServerTransactionCurrent(siteId, transaction);
		persistSettings(siteId, envelope);
	};

	const compileAndReload = async (
		site: Local.Site,
		server: RuntimeServer,
		expectManaged: boolean,
		assertCurrent: () => void = (): void => undefined,
	): Promise<boolean> => {
		assertCurrent();
		if (!server.serviceName || server.kind === 'unsupported' || !server.service) {
			throw new Error(server.reason || 'Local could not load the web-server service for this site.');
		}
		const serviceName = server.serviceName;
		if (server.kind === 'apache') {
			const processName = 'httpd';
			const targetServiceRunning = (): boolean => {
				assertCurrent();
				return siteProcessManager.hasRunningProcess(site, processName);
			};
			const refreshed = await refreshApacheService(
				site,
				server.service,
				configTemplates,
				LocalMain.execFilePromise,
				expectManaged,
				() => shouldRefreshRuntime(
					siteProcessManager.getSiteStatus(site),
					targetServiceRunning(),
				),
				targetServiceRunning,
			);
			assertCurrent();
			return refreshed;
		}

		await configTemplates.compileServiceConfigs(site);
		assertCurrent();
		const targetServiceRunning = (): boolean => {
			assertCurrent();
			return siteProcessManager.hasRunningProcess(site, serviceName);
		};
		if (shouldRefreshRuntime(
			siteProcessManager.getSiteStatus(site),
			targetServiceRunning(),
		)) {
			const reloadResult = await reloadNginxWithFallback(
				server.service,
				LocalMain.execFilePromise,
				async () => {
					assertCurrent();
					await siteProcessManager.restartSiteService(site, serviceName);
					assertCurrent();
					return siteProcessManager.hasRunningProcess(site, serviceName);
				},
				() => {
					assertCurrent();
					return siteProcessManager.getSiteStatus(site) === 'running' &&
						siteProcessManager.hasRunningProcess(site);
				},
			);
			assertCurrent();
			if (reloadResult === 'restarted') {
				logger.log('warn', `Restarted the ${serviceName} service for site ${site.id} after its Nginx master PID became stale.`);
			}
			return true;
		}

		return false;
	};

	const runtimeCleanupUnavailableReason = (server: RuntimeServer): string => (
		`${server.reason || `Local could not load this site's ${server.kind} service.`} ` +
		'Runtime cleanup cannot be verified, so saved settings and managed files were left unchanged. ' +
		'Stop the site to immediately prevent a previously compiled proxy from serving requests, then restore an unambiguous web-server service and retry.'
	);

	const requireApacheCapabilities = async (
		server: RuntimeServer,
	): Promise<Awaited<ReturnType<typeof inspectApacheRuntimeCapabilities>>> => {
		const httpdBinary = server.service?.bin?.httpd;
		if (server.kind !== 'apache' || !httpdBinary) {
			throw new Error('Local did not provide an Apache httpd binary for this site.');
		}
		return inspectApacheRuntimeCapabilities(httpdBinary);
	};

	const assertApacheOriginCapability = async (
		server: RuntimeServer,
		protocol: 'http:' | 'https:',
	): Promise<void> => {
		if (server.kind !== 'apache') {
			return;
		}
		const capabilities = await requireApacheCapabilities(server);
		if (!capabilities.http || (protocol === 'https:' && !capabilities.https)) {
			throw new ApacheCapabilityUnavailableError(
				capabilities.reason || 'This Local Apache bundle cannot proxy the selected origin protocol.',
			);
		}
	};

	const rollbackTransaction = async (
		site: Local.Site,
		server: RuntimeServer,
		expectedTransaction: ServerTransactionFingerprint,
		previousEnvelope: StoredSettingsEnvelope,
		snapshots: Awaited<ReturnType<typeof captureAllManagedFiles>>,
		originalError: unknown,
	): Promise<never> => {
		const rollbackErrors: string[] = [];
		const throwOriginalError = (): never => {
			throw originalError instanceof Error
				? originalError
				: new Error(errorMessage(originalError));
		};
		const deferRecovery = (): void => {
			if (globalLifecycleState) {
				scheduleDeferredGlobalCleanup(
					site.id,
					globalLifecycleState,
					globalLifecycleGeneration,
				);
				return;
			}
			scheduleDeferredReconciliation(site.id, {
				configuredOnly: false,
				refreshMatchingEnabledRuntime: true,
			});
		};
		const currentRollbackTarget = (): {
			server: RuntimeServer;
			site: Local.Site;
			transaction: ServerTransactionFingerprint;
		} | null => {
			try {
				if (globalLifecycleState) {
					return null;
				}
				const currentSite = siteData.getSite(site.id);
				if (!currentSite) {
					return null;
				}
				const siteStatus = siteProcessManager.getSiteStatus(currentSite);
				if (!shouldReconcileManagedFiles(siteStatus)) {
					return null;
				}
				const currentServer = resolveServer(currentSite);
				if (
					currentServer.kind === 'unsupported' ||
					currentServer.kind !== server.kind ||
					currentServer.serviceName !== server.serviceName ||
					currentSite.longPath !== site.longPath ||
					!serverManagedFilesystemReady(currentSite, currentServer.kind)
				) {
					return null;
				}
				const currentTransaction = serverTransactionFingerprint(
					currentSite,
					currentServer,
				);
				if (
					!serverTransactionFingerprintsMatch(
						expectedTransaction,
						currentTransaction,
					)
				) {
					return null;
				}
				return {
					server: currentServer,
					site: currentSite,
					transaction: currentTransaction,
				};
			} catch {
				return null;
			}
		};

		let rollbackTarget = currentRollbackTarget();
		if (!rollbackTarget) {
			deferRecovery();
			logger.log(
				'info',
				`Skipped Media Proxy rollback writes for site ${site.id} because Local is changing or removing the site.`,
			);
			return throwOriginalError();
		}
		const assertRollbackTransactionCurrent = (): void => {
			const current = currentRollbackTarget();
			if (
				!current ||
				!serverTransactionFingerprintsMatch(
					expectedTransaction,
					current.transaction,
				)
			) {
				throw new ServerTransactionChangedError();
			}
		};

		try {
			await restoreManagedFiles(snapshots, assertRollbackTransactionCurrent);
			assertRollbackTransactionCurrent();
			rollbackTarget = currentRollbackTarget();
			if (
				rollbackTarget?.server.serviceName &&
				rollbackTarget.server.kind !== 'unsupported'
			) {
				await compileAndReload(
					rollbackTarget.site,
					rollbackTarget.server,
					rollbackTarget.server.kind === 'apache'
						? apacheSnapshotHasCompleteManagedConfig(rollbackTarget.site, snapshots)
						: previousEnvelope.enabled,
					assertRollbackTransactionCurrent,
				);
			}
			assertRollbackTransactionCurrent();
			persistSettings(site.id, previousEnvelope);
		} catch (error) {
			if (isServerTransactionChangedError(error)) {
				deferRecovery();
				logger.log(
					'info',
					`Stopped Media Proxy rollback for site ${site.id} because Local changed the site's web-server identity or lifecycle status; deferred reconciliation will verify the stable state.`,
				);
				return throwOriginalError();
			}
			rollbackErrors.push(`restore: ${errorMessage(error)}`);
		}

		if (rollbackErrors.length > 0) {
			const rollbackSummary = rollbackErrors.join('; ');
			logger.log('error', `Rollback failed for site ${site.id}: ${rollbackSummary}`);
			throw new Error(`${errorMessage(originalError)} Rollback also failed (${rollbackSummary}).`);
		}

		return throwOriginalError();
	};

	const abortForGlobalLifecycle = async (
		siteId: string,
		originalError: unknown,
	): Promise<never> => {
		if (globalLifecycleState) {
			scheduleDeferredGlobalCleanup(
				siteId,
				globalLifecycleState,
				globalLifecycleGeneration,
			);
		}
		throw originalError instanceof Error
			? originalError
			: new Error(errorMessage(originalError));
	};

	const lifecycleUnavailableSiteState = (
		site: Local.Site | null,
		siteStatus: string,
		reason = lifecycleUnavailableReason(siteStatus),
	): SiteState => {
		const server = site ? detectSiteServer(site) : {
			kind: 'unsupported' as const,
			requiresOriginIp: false,
		};
		const envelope = site
			? readStoredSettingsEnvelope(site, server.kind)
			: normalizeStoredSettingsEnvelope(undefined, 'unsupported');
		const settings = server.kind === 'apache' || server.kind === 'nginx'
			? storedSettingsForServer(envelope, server.kind)
			: fallbackStoredSettings(envelope);
		return {
			applied: false,
			canEnable: false,
			cleanupSupported: false,
			enableUnavailableReason: reason,
			lifecycleReady: false,
			needsAttention: false,
			reason,
			requiresOriginIp: server.requiresOriginIp,
			serverKind: server.kind,
			settings,
			siteStatus,
			supported: false,
			supportsHttpsOrigin: false,
		};
	};

	const getSiteState = async (siteId: string): Promise<SiteState> => {
		requireSiteId(siteId);
		const site = siteData.getSite(siteId);
		if (!site) {
			return lifecycleUnavailableSiteState(null, 'deleting');
		}
		const siteStatus = siteProcessManager.getSiteStatus(site);
		if (!shouldReconcileManagedFiles(siteStatus)) {
			return lifecycleUnavailableSiteState(site, siteStatus);
		}
		const detectedServer = detectSiteServer(site);
		if (
			detectedServer.kind !== 'unsupported' &&
			!serverManagedFilesystemReady(site, detectedServer.kind)
		) {
			return lifecycleUnavailableSiteState(
				site,
				siteStatus,
				'Local has not finished preparing this site\'s web-server files. Media Proxy will remain inactive until they are ready.',
			);
		}
		const server = resolveServer(site);
		const transaction = serverTransactionFingerprint(site, server);
		const assertSiteStateTransactionCurrent = (): void => {
			if (!serverTransactionIsCurrent(siteId, transaction)) {
				throw new ServerTransactionChangedError();
			}
		};
		assertSiteStateTransactionCurrent();
		const envelope = readStoredSettingsEnvelope(site, server.kind);
		const settings = server.kind === 'apache' || server.kind === 'nginx'
			? storedSettingsForServer(envelope, server.kind)
			: fallbackStoredSettings(envelope);
		const managedArtifactsPresent = await allManagedArtifactsExist(
			site,
			assertSiteStateTransactionCurrent,
		);
		const runtimeUnavailable = server.kind === 'unsupported' || !server.service;
		let apacheCapabilities: Awaited<ReturnType<typeof inspectApacheRuntimeCapabilities>> | undefined;
		let capabilityInspectionReason: string | undefined;
		if (server.kind === 'apache' && server.service) {
			try {
				apacheCapabilities = await requireApacheCapabilities(server);
			} catch (error) {
				capabilityInspectionReason = `Local could not inspect this site's Apache module capabilities: ${errorMessage(error)}`;
			}
		}
		let normalizedOrigin: ReturnType<typeof validateAndNormalizeOrigin> | undefined;
		let enableUnavailableReason: string | undefined;
		if (runtimeUnavailable) {
			if (server.kind !== 'unsupported') {
				enableUnavailableReason = runtimeCleanupUnavailableReason(server);
			}
		} else {
			try {
				if (
					server.kind === 'nginx' &&
					settings.originSource === 'wpengine' &&
					!wpEngineStoredProvenanceMatches(
						site,
						settings.originWpEngineInstallId,
						settings.originWpEngineSiteId,
					)
				) {
					throw new Error('The saved WP Engine origin no longer matches this Local site connection.');
				}
				normalizedOrigin = validateAndNormalizeOrigin(settings, {
					requiresOriginIp: server.requiresOriginIp,
				});
			} catch (error) {
				enableUnavailableReason = errorMessage(error);
			}
		}
		const configuredForHttps = normalizedOrigin?.protocol === 'https:';
		const apacheCapabilityUnavailable = server.kind === 'apache' && (
			!apacheCapabilities?.http || (configuredForHttps && !apacheCapabilities.https)
		);
		if (!enableUnavailableReason && server.kind === 'apache') {
			if (capabilityInspectionReason) {
				enableUnavailableReason = capabilityInspectionReason;
			} else if (apacheCapabilityUnavailable) {
				enableUnavailableReason = apacheCapabilities?.reason ||
					'This Local Apache bundle cannot proxy the configured origin protocol.';
			}
		}
		const canEnable = server.kind !== 'unsupported' && !enableUnavailableReason;
		let applied = false;

		if (server.kind !== 'unsupported' && server.service) {
			if (settings.enabled) {
				try {
					if (!normalizedOrigin || !canEnable) {
						throw new Error(enableUnavailableReason || 'The current connection profile is incomplete.');
					}
					const trustBundle = normalizedOrigin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					applied = await serverManagedFilesMatch(
						site,
						normalizedOrigin,
						managedFileOptions(server),
						trustBundle,
						assertSiteStateTransactionCurrent,
					);
				} catch (error) {
					if (isExpectedLifecycleInterruption(siteId, error)) {
						throw error;
					}
					applied = false;
				}
			} else {
				applied = managedArtifactsPresent;
			}
		}
		const needsAttention = (
			runtimeUnavailable && (settings.enabled || managedArtifactsPresent)
		) || Boolean(settings.enabled && (!canEnable || !applied)) ||
			Boolean(!settings.enabled && applied);
		const attentionReason = runtimeUnavailable
			? runtimeCleanupUnavailableReason(server)
			: !settings.enabled && applied
				? `The ${server.kind} profile is disabled, but managed proxy configuration remains and cleanup is required.`
				: enableUnavailableReason || (
					settings.enabled && !applied
						? `The ${server.kind} profile is enabled, but its managed proxy configuration is not applied.`
						: undefined
				);

		return {
			applied,
			canEnable,
			cleanupSupported: server.kind !== 'unsupported' && Boolean(server.service),
			enableUnavailableReason,
			httpsUnavailableReason: apacheCapabilities?.http && !apacheCapabilities.https
				? apacheCapabilities.reason
				: undefined,
			lifecycleReady: true,
			needsAttention,
			reason: needsAttention
				? attentionReason
				: server.kind === 'unsupported'
					? server.reason
					: !server.service
						? `Local could not load this site's ${server.kind} service.`
						: apacheCapabilities && !apacheCapabilities.http
							? apacheCapabilities.reason
							: capabilityInspectionReason,
			requiresOriginIp: server.requiresOriginIp,
			serverKind: server.kind,
			settings,
			siteStatus,
			supported: server.kind !== 'unsupported' && Boolean(server.service) && (
				server.kind !== 'apache' || apacheCapabilities?.http === true
			),
			supportsHttpsOrigin: server.kind !== 'apache' || apacheCapabilities?.https === true,
		};
	};

	const applySettingsLocked = async (
		siteId: string,
		input: unknown,
		rawExpectedServerKind: unknown,
	): Promise<SiteState> => {
		assertGloballyActive();
		const expectedServerKind = requireSupportedServerKind(rawExpectedServerKind);
		const site = requireSite(siteId);
		const server = resolveServer(site);
		assertExpectedServer(server, expectedServerKind);
		const transaction = beginInteractiveServerTransaction(site, server);
		const normalizedInput = validateSettingsInput(input, {
			requiresOriginIp: server.requiresOriginIp,
		});

		const previousEnvelope = readStoredSettingsEnvelope(site, expectedServerKind);
		const previousSettings = storedSettingsForServer(previousEnvelope, expectedServerKind);
		let nextSettings: StoredSettings;
		let nextEnvelope: StoredSettingsEnvelope;

		if (normalizedInput.enabled) {
			if (server.kind === 'unsupported' || !server.service) {
				throw new Error(server.reason || 'Local could not load the web-server service for this site.');
			}

			const origin = validateAndNormalizeOrigin(normalizedInput, {
				requiresOriginIp: server.requiresOriginIp,
			});
			await assertApacheOriginCapability(server, origin.protocol);
			const authoritativeWpEngine = server.kind === 'nginx'
				? await assertAuthoritativeWpEngineIdentity(site, normalizedInput)
				: undefined;
			const probe = await probeOrigin(origin, {
				allowWpEngineTlsFallback: server.kind === 'nginx',
			});
			const verifiedOrigin = {
				...origin,
				tlsHostname: server.kind === 'nginx'
					? probe.verifiedTlsHostname ?? origin.tlsHostname
					: origin.hostname,
			};
			assertServerTransactionCurrent(siteId, transaction);
			nextSettings = {
				certificate: probe.certificate,
				enabled: true,
				lastOriginStatus: probe.statusCode,
				lastVerifiedAt: new Date().toISOString(),
				originEnvironment: normalizedInput.originEnvironment,
				originIp: server.requiresOriginIp ? verifiedOrigin.originIp : '',
				originSource: normalizedInput.originSource ?? 'manual',
				originTlsHostname: server.kind === 'apache' || verifiedOrigin.tlsHostname === verifiedOrigin.hostname
					? undefined
					: verifiedOrigin.tlsHostname,
				originWpEngineInstallId: authoritativeWpEngine?.wpEngineInstallId,
				originWpEngineSiteId: authoritativeWpEngine?.wpEngineSiteId,
				resolvedAt: normalizedInput.resolvedAt,
				siteUrl: verifiedOrigin.siteUrl,
			};
			nextEnvelope = replaceStoredSettingsForServer(
				previousEnvelope,
				expectedServerKind,
				nextSettings,
			);

			let snapshots: Awaited<ReturnType<typeof captureAllManagedFiles>> | undefined;
			try {
				snapshots = await captureAllManagedFiles(
					site,
					() => assertServerTransactionCurrent(siteId, transaction),
				);
				await runServerTransactionMutation(
					() => assertServerTransactionCurrent(siteId, transaction),
					() => applyServerManagedFiles(
						site,
						verifiedOrigin,
						managedFileOptions(server),
						probe.trustedCertificateAuthoritiesPem,
						() => assertServerTransactionCurrent(siteId, transaction),
					),
				);
				const restarted = await compileAndReload(
					site,
					server,
					true,
					() => assertServerTransactionCurrent(siteId, transaction),
				);
				commitInteractiveSettings(siteId, transaction, nextEnvelope);
				logger.log('info', `Enabled media proxy for site ${siteId}${restarted ? ` and refreshed ${server.kind}` : ''}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site.id, error);
				}
				if (!snapshots) {
					throw error;
				}
				return rollbackTransaction(
					site,
					server,
					transaction,
					previousEnvelope,
					snapshots,
					error,
				);
			}
		} else {
			if (
				(server.kind === 'unsupported' || !server.service) &&
				(previousSettings.enabled || await allManagedArtifactsExist(
					site,
					() => assertServerTransactionCurrent(siteId, transaction),
				))
			) {
				throw new Error(runtimeCleanupUnavailableReason(server));
			}
			let disabled = sanitizeDisabledSettings(normalizedInput);
			const matchesPreviouslyValidatedIdentity = previousSettings.originSource === 'wpengine' &&
				wpEngineOriginIdentityMatches(
					wpEngineIdentity(disabled),
					wpEngineIdentity(previousSettings),
				);
			const canReusePreviousProvenance = matchesPreviouslyValidatedIdentity &&
				Boolean(previousSettings.originWpEngineInstallId) &&
				Boolean(previousSettings.originWpEngineSiteId) &&
				getWpEngineConnectionSiteId(site) === previousSettings.originWpEngineSiteId;
			let originWpEngineInstallId = canReusePreviousProvenance
				? previousSettings.originWpEngineInstallId
				: undefined;
			let originWpEngineSiteId = canReusePreviousProvenance
				? previousSettings.originWpEngineSiteId
				: undefined;
			if (
				server.kind === 'nginx' &&
				disabled.originSource === 'wpengine' &&
				disabled.originEnvironment &&
				!canReusePreviousProvenance
			) {
				try {
					const authoritativeWpEngine = await assertAuthoritativeWpEngineIdentity(site, disabled);
					originWpEngineInstallId = authoritativeWpEngine?.wpEngineInstallId;
					originWpEngineSiteId = authoritativeWpEngine?.wpEngineSiteId;
				} catch (error) {
					if (!previousSettings.enabled) {
						throw error;
					}
					logger.log('warn', `Discarded stale WP Engine origin metadata while disabling site ${site.id}: ${errorLogMessage(error)}`);
					disabled = {
						enabled: false,
						originIp: disabled.originIp,
						originSource: 'manual',
						siteUrl: disabled.siteUrl,
					};
				}
			}
			const preserveVerification = originPairMatches(disabled, previousSettings);
			assertServerTransactionCurrent(siteId, transaction);
			nextSettings = {
				...disabled,
				certificate: preserveVerification ? previousSettings.certificate : undefined,
				lastOriginStatus: preserveVerification ? previousSettings.lastOriginStatus : undefined,
				lastVerifiedAt: preserveVerification ? previousSettings.lastVerifiedAt : undefined,
				originWpEngineInstallId,
				originWpEngineSiteId,
			};
			nextEnvelope = replaceStoredSettingsForServer(
				previousEnvelope,
				expectedServerKind,
				nextSettings,
			);

			let snapshots: Awaited<ReturnType<typeof captureAllManagedFiles>> | undefined;
			try {
				snapshots = await captureAllManagedFiles(
					site,
					() => assertServerTransactionCurrent(siteId, transaction),
				);
				const changed = await runServerTransactionMutation(
					() => assertServerTransactionCurrent(siteId, transaction),
					() => removeAllManagedFiles(
						site,
						() => assertServerTransactionCurrent(siteId, transaction),
					),
				);
				if ((changed || previousSettings.enabled) && server.kind !== 'unsupported' && server.service) {
					await compileAndReload(
						site,
						server,
						false,
						() => assertServerTransactionCurrent(siteId, transaction),
					);
				}
				commitInteractiveSettings(siteId, transaction, nextEnvelope);
				logger.log('info', `Disabled media proxy for site ${siteId}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site.id, error);
				}
				if (!snapshots) {
					throw error;
				}
				return rollbackTransaction(
					site,
					server,
					transaction,
					previousEnvelope,
					snapshots,
					error,
				);
			}
		}

		return getSiteState(siteId);
	};

	const applySettings = async (
		siteId: string,
		input: unknown,
		expectedServerKind: unknown,
	): Promise<SiteState> => withSiteLock(
		siteId,
		() => applySettingsLocked(siteId, input, expectedServerKind),
	);

	const setEnabled = async (
		siteId: string,
		rawExpectedServerKind: unknown,
		rawEnabled: unknown,
	): Promise<SiteState> => withSiteLock(siteId, async () => {
		if (typeof rawEnabled !== 'boolean') {
			throw new Error('The media proxy enabled setting must be true or false.');
		}
		const expectedServerKind = requireSupportedServerKind(rawExpectedServerKind);
		const site = requireSite(siteId);
		const server = resolveServer(site);
		assertExpectedServer(server, expectedServerKind);
		const transaction = beginInteractiveServerTransaction(site, server);
		const envelope = readStoredSettingsEnvelope(site, expectedServerKind);
		if (envelope.enabled === rawEnabled) {
			return getSiteState(siteId);
		}
		const settings = storedSettingsForServer(envelope, expectedServerKind);
		if (rawEnabled) {
			return applySettingsLocked(
				siteId,
				{ ...settings, enabled: true },
				expectedServerKind,
			);
		}

		if (!server.service) {
			throw new Error(runtimeCleanupUnavailableReason(server));
		}
		const disabledEnvelope = setStoredSettingsEnabled(envelope, false);
		let snapshots: Awaited<ReturnType<typeof captureAllManagedFiles>> | undefined;
		try {
			snapshots = await captureAllManagedFiles(
				site,
				() => assertServerTransactionCurrent(siteId, transaction),
			);
			const changed = await runServerTransactionMutation(
				() => assertServerTransactionCurrent(siteId, transaction),
				() => removeAllManagedFiles(
					site,
					() => assertServerTransactionCurrent(siteId, transaction),
				),
			);
			if (changed || envelope.enabled) {
				await compileAndReload(
					site,
					server,
					false,
					() => assertServerTransactionCurrent(siteId, transaction),
				);
			}
			commitInteractiveSettings(siteId, transaction, disabledEnvelope);
			logger.log('info', `Disabled media proxy for site ${siteId} without changing its connection profiles.`);
		} catch (error) {
			if (globalLifecycleState) {
				return abortForGlobalLifecycle(site.id, error);
			}
			if (!snapshots) {
				throw error;
			}
			return rollbackTransaction(
				site,
				server,
				transaction,
				envelope,
				snapshots,
				error,
			);
		}
		return getSiteState(siteId);
	});

	const discoverOrigin = async (
		siteId: string,
		request: OriginDiscoveryRequest,
	): Promise<OriginSuggestion> => {
		const site = requireLifecycleReadySite(siteId);
		if (!request || typeof request !== 'object') {
			throw new Error('A valid origin discovery request is required.');
		}

		if (request.mode === 'wpengine') {
			if (detectSiteServer(site).kind === 'apache') {
				const metadata = await getAuthoritativeWpEngineOrigin(
					site,
					request.environment,
					wpEngineCapi,
				);
				return {
					addresses: [],
					environment: metadata.environment,
					provider: 'wpengine',
					resolvedAt: new Date().toISOString(),
					siteUrl: metadata.siteUrl,
					warning: 'Apache uses the Site URL hostname directly; no remote IP or separate TLS identity is selected.',
				};
			}
			return discoverWpEngineOrigin(
				site,
				request.environment,
				wpEngineCapi,
			);
		}

		if (request.mode === 'dns') {
			if (detectSiteServer(site).kind === 'apache') {
				throw new Error('Apache resolves the Site URL hostname directly; a remote-IP lookup is not used.');
			}
			return discoverDnsOrigin(request.siteUrl);
		}

		throw new Error('The requested origin discovery mode is not supported.');
	};

	const testOrigin = async (
		siteId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<PublicOriginProbeResult> => {
		const site = requireLifecycleReadySite(siteId);
		const server = resolveServer(site);
		if (server.kind === 'unsupported' || !server.service) {
			throw new Error(server.reason || 'Local could not load the web-server service for this site.');
		}
		const normalizedInput = validateSettingsInput(input, {
			requiresOriginIp: server.requiresOriginIp,
		});
		if (server.kind === 'nginx') {
			await assertAuthoritativeWpEngineIdentity(site, normalizedInput);
		}
		const origin = validateAndNormalizeOrigin(normalizedInput, {
			requiresOriginIp: server.requiresOriginIp,
		});
		await assertApacheOriginCapability(server, origin.protocol);
		const probe = await probeOrigin(origin, {
			allowWpEngineTlsFallback: server.kind === 'nginx',
			signal,
		});
		const verifiedTlsHostname = probe.verifiedTlsHostname ?? origin.tlsHostname;
		const security = origin.protocol === 'https:'
			? server.kind === 'apache'
				? ` Certificate ${probe.certificate?.subject ?? 'identity'} matched the Site URL hostname ${origin.hostname}; Apache uses that same hostname for DNS, HTTP Host, TLS SNI, and certificate verification.`
				: verifiedTlsHostname === origin.hostname
				? ` Certificate ${probe.certificate?.subject ?? 'identity'} matched ${origin.hostname}.`
				: normalizedInput.originSource === 'wpengine'
					? ` Certificate ${probe.certificate?.subject ?? 'identity'} matched the WP Engine origin ${verifiedTlsHostname}; requests retain Host ${origin.hostHeader}.`
					: ` Certificate ${probe.certificate?.subject ?? 'identity'} matched verified WP Engine infrastructure as ${verifiedTlsHostname}; requests retain Host ${origin.hostHeader}.`
			: ' The connection is unencrypted because the URL uses HTTP.';

		return {
			certificate: probe.certificate,
			message: originResponseOutcome(probe.statusCode) === 'success'
				? `The configured remote endpoint responded with HTTP ${probe.statusCode}.${security} This test checks reachability and, for HTTPS, certificate identity and trust—not a media file. After applying, verify an actual missing upload through the Local site.`
				: `The configured remote endpoint responded with HTTP ${probe.statusCode}, so network reachability was confirmed but media access was not verified.${security} Check the exact remote upload${server.requiresOriginIp ? ' or try another remote IP' : ''}.`,
			originTlsHostname: server.kind === 'apache' || verifiedTlsHostname === origin.hostname
				? undefined
				: verifiedTlsHostname,
			outcome: originResponseOutcome(probe.statusCode),
			statusCode: probe.statusCode,
		};
	};

	const reconcileSite = async (
		siteId: string,
		options: ReconcileOptions = {},
	): Promise<void> => {
		try {
			await withSiteLock(siteId, async () => {
				if (globalLifecycleState) {
					return;
				}

				const site = siteData.getSite(siteId);
				if (!site) {
					return;
				}
				const rawStoredSettings = (site as SiteWithSettings)[SITE_SETTINGS_KEY];
				if (options.configuredOnly && rawStoredSettings === undefined) {
					return;
				}
				const siteStatusAllowsReconciliation = (candidate: Local.Site): boolean => (
					shouldReconcileManagedFiles(siteProcessManager.getSiteStatus(candidate))
				);
				if (!siteStatusAllowsReconciliation(site)) {
					return;
				}

				const detectedServer = detectSiteServer(site);
				if (
					detectedServer.kind === 'unsupported' ||
					!serverManagedFilesystemReady(site, detectedServer.kind)
				) {
					return;
				}
				const server = resolveServer(site);
				const transaction = serverTransactionFingerprint(site, server);
				const reconciliationCanMutate = (): boolean => {
					const latestSite = siteData.getSite(siteId);
					if (!latestSite || !siteStatusAllowsReconciliation(latestSite)) {
						return false;
					}
					const latestServer = detectSiteServer(latestSite);
					if (
						latestServer.kind === 'unsupported' ||
						!serverManagedFilesystemReady(latestSite, latestServer.kind)
					) {
						return false;
					}
					return serverTransactionIsCurrent(siteId, transaction);
				};
				const assertReconciliationTransactionCurrent = (): void => {
					assertGloballyActive();
					if (!reconciliationCanMutate()) {
						throw new ServerTransactionChangedError();
					}
				};
				const previousEnvelope = readStoredSettingsEnvelope(site, server.kind);
				const settings = server.kind === 'apache' || server.kind === 'nginx'
					? storedSettingsForServer(previousEnvelope, server.kind)
					: fallbackStoredSettings(previousEnvelope);
				let normalizedOrigin: ReturnType<typeof validateAndNormalizeOrigin> | undefined;
				if (server.kind === 'unsupported' || !server.service) {
					if (!settings.enabled && !await allManagedArtifactsExist(
						site,
						assertReconciliationTransactionCurrent,
					)) {
						return;
					}
					throw new Error(runtimeCleanupUnavailableReason(server));
				}
				const nextEnvelope = setStoredSettingsLastServer(previousEnvelope, server.kind);
				const shouldPersistReconciledEnvelope = nextEnvelope !== previousEnvelope ||
					storedSettingsEnvelopeNeedsMigration(rawStoredSettings);
				const persistReconciledEnvelope = (): boolean => {
					if (!reconciliationCanMutate()) {
						return false;
					}
					if (shouldPersistReconciledEnvelope) {
						persistSettings(site.id, nextEnvelope);
					}
					return true;
				};
				if (!settings.enabled) {
					if (!await allManagedArtifactsExist(
						site,
						assertReconciliationTransactionCurrent,
					)) {
						if (rawStoredSettings !== undefined) {
							persistReconciledEnvelope();
						}
						return;
					}
				} else {
					try {
						if (server.kind === 'nginx') {
							await assertStoredWpEngineConnection(site, settings);
						}
						normalizedOrigin = validateAndNormalizeOrigin(settings, {
							requiresOriginIp: server.requiresOriginIp,
						});
						await assertApacheOriginCapability(server, normalizedOrigin.protocol);
					} catch (validationError) {
						if (!reconciliationCanMutate()) {
							return;
						}
						const snapshots = await captureAllManagedFiles(
							site,
							assertReconciliationTransactionCurrent,
						);
						if (!reconciliationCanMutate()) {
							return;
						}
						const cleanupErrors: string[] = [];

						let changed = false;
						try {
							changed = await runServerTransactionMutation(
								assertReconciliationTransactionCurrent,
								() => removeAllManagedFiles(
									site,
									assertReconciliationTransactionCurrent,
								),
							);
						} catch (error) {
							if (isServerTransactionChangedError(error)) {
								return rollbackTransaction(
									site,
									server,
									transaction,
									previousEnvelope,
									snapshots,
									error,
								);
							}
							cleanupErrors.push(`files: ${errorMessage(error)}`);
						}
						if (!reconciliationCanMutate()) {
							return rollbackTransaction(
								site,
								server,
								transaction,
								previousEnvelope,
								snapshots,
								new ServerTransactionChangedError(),
							);
						}

						if (cleanupRequiresRefresh(changed, settings.enabled)) {
							try {
								await compileAndReload(
									site,
									server,
									false,
									assertReconciliationTransactionCurrent,
								);
							} catch (error) {
								if (isServerTransactionChangedError(error)) {
									return rollbackTransaction(
										site,
										server,
										transaction,
										previousEnvelope,
										snapshots,
										error,
									);
								}
								cleanupErrors.push(`${server.kind} cleanup: ${errorMessage(error)}`);
							}
						}
						try {
							if (!persistReconciledEnvelope()) {
								return rollbackTransaction(
									site,
									server,
									transaction,
									previousEnvelope,
									snapshots,
									new ServerTransactionChangedError(),
								);
							}
						} catch (error) {
							if (isServerTransactionChangedError(error)) {
								throw error;
							}
							cleanupErrors.push(`settings: ${errorMessage(error)}`);
						}

						const reason = errorMessage(validationError);
						if (cleanupErrors.length > 0) {
							throw new Error(`${reason} Fail-closed cleanup also failed (${cleanupErrors.join('; ')}).`);
						}
						logger.log(
							'warn',
							`Removed unverified media proxy configuration for site ${site.id} while retaining global enabled intent for the current ${server.kind} profile: ${reason}`,
						);
						return;
					}

					const trustBundle = normalizedOrigin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;

					if (await serverManagedFilesMatch(
						site,
						normalizedOrigin,
						managedFileOptions(server),
						trustBundle,
						assertReconciliationTransactionCurrent,
					)) {
						if (options.refreshMatchingEnabledRuntime) {
							if (!reconciliationCanMutate()) {
								return;
							}
							await compileAndReload(
								site,
								server,
								true,
								assertReconciliationTransactionCurrent,
							);
							assertReconciliationTransactionCurrent();
						}
						persistReconciledEnvelope();
						return;
					}
				}

				const snapshots = await captureAllManagedFiles(
					site,
					assertReconciliationTransactionCurrent,
				);
				try {
					assertGloballyActive();
					if (!reconciliationCanMutate()) {
						return;
					}
					assertReconciliationTransactionCurrent();
					let changed: boolean;
					if (settings.enabled) {
						const origin = normalizedOrigin ?? validateAndNormalizeOrigin(settings, {
							requiresOriginIp: server.requiresOriginIp,
						});
						const trustBundle = origin.protocol === 'https:'
							? trustedCertificateAuthoritiesPem()
							: undefined;
						changed = await runServerTransactionMutation(
							assertReconciliationTransactionCurrent,
							() => applyServerManagedFiles(
								site,
								origin,
								managedFileOptions(server),
								trustBundle,
								assertReconciliationTransactionCurrent,
							),
						);
					} else {
						changed = await runServerTransactionMutation(
							assertReconciliationTransactionCurrent,
							() => removeAllManagedFiles(
								site,
								assertReconciliationTransactionCurrent,
							),
						);
					}

					if (changed) {
						await compileAndReload(
							site,
							server,
							settings.enabled,
							assertReconciliationTransactionCurrent,
						);
						assertReconciliationTransactionCurrent();
					}
					if (!persistReconciledEnvelope()) {
						return rollbackTransaction(
							site,
							server,
							transaction,
							previousEnvelope,
							snapshots,
							new ServerTransactionChangedError(),
						);
					}
				} catch (error) {
					if (globalLifecycleState) {
						return abortForGlobalLifecycle(site.id, error);
					}
					return rollbackTransaction(
						site,
						server,
						transaction,
						previousEnvelope,
						snapshots,
						error,
					);
				}
			});
		} catch (error) {
			if (isExpectedLifecycleInterruption(siteId, error)) {
				logger.log(
					'info',
					`Paused Media Proxy reconciliation for site ${siteId} because Local changed or removed the site during a guarded read.`,
				);
				return;
			}
			throw error;
		}
	};

	const cancelDeferredReconciliation = (siteId: string): void => {
		const pending = deferredReconciliations.get(siteId);
		if (pending?.timer) {
			clearTimeout(pending.timer);
		}
		deferredReconciliations.delete(siteId);
	};

	const cancelOriginProbesForSite = (siteId: string): void => {
		for (const [key, controller] of originProbeControllers) {
			try {
				const parsed = JSON.parse(key) as unknown[];
				if (parsed[1] !== siteId) {
					continue;
				}
			} catch {
				continue;
			}
			controller.abort();
			originProbeControllers.delete(key);
		}
	};

	const scheduleDeferredReconciliation = (
		siteId: string,
		options: ReconcileOptions,
	): void => {
		const existing = deferredReconciliations.get(siteId);
		if (existing) {
			existing.options = {
				configuredOnly: existing.options.configuredOnly && options.configuredOnly,
				refreshMatchingEnabledRuntime: Boolean(
					existing.options.refreshMatchingEnabledRuntime ||
					options.refreshMatchingEnabledRuntime,
				),
			};
			return;
		}

		const pending: DeferredReconciliation = {
			attempts: 0,
			options: { ...options },
			stableSamples: 0,
		};
		const poll = (): void => {
			if (deferredReconciliations.get(siteId) !== pending) {
				return;
			}
			pending.timer = undefined;
			pending.attempts += 1;
			if (globalLifecycleState) {
				cancelDeferredReconciliation(siteId);
				return;
			}

			const site = siteData.getSite(siteId);
			if (!site) {
				cancelDeferredReconciliation(siteId);
				return;
			}
			let siteStatus: string;
			try {
				siteStatus = siteProcessManager.getSiteStatus(site);
			} catch (error) {
				cancelDeferredReconciliation(siteId);
				logger.log('warn', `Unable to read lifecycle status for site ${siteId}: ${errorMessage(error)}`);
				return;
			}
			if (shouldCancelDeferredReconciliation(siteStatus)) {
				cancelDeferredReconciliation(siteId);
				return;
			}

			if (shouldReconcileManagedFiles(siteStatus)) {
				let server: SiteServerAdapter;
				try {
					server = detectSiteServer(site);
				} catch (error) {
					cancelDeferredReconciliation(siteId);
					logger.log('warn', `Unable to identify the web server for site ${siteId}: ${errorMessage(error)}`);
					return;
				}
				if (server.kind === 'unsupported') {
					cancelDeferredReconciliation(siteId);
					return;
				}
				try {
					pending.stableSamples = serverManagedFilesystemReady(site, server.kind)
						? pending.stableSamples + 1
						: 0;
				} catch (error) {
					cancelDeferredReconciliation(siteId);
					logger.log('warn', `Unsafe or unreadable Media Proxy paths for site ${siteId}: ${errorMessage(error)}`);
					return;
				}
				if (pending.stableSamples >= DEFERRED_RECONCILIATION_STABLE_SAMPLES) {
					const reconcileOptions = pending.options;
					cancelDeferredReconciliation(siteId);
					void reconcileSite(siteId, reconcileOptions).catch((error) => {
						if (isExpectedLifecycleInterruption(siteId, error)) {
							logger.log(
								'info',
								`Paused Media Proxy reconciliation for site ${siteId} because Local changed or removed the site during a guarded read.`,
							);
						} else {
							logger.log('warn', `Unable to reconcile site ${siteId}: ${errorMessage(error)}`);
						}
					});
					return;
				}
			} else {
				pending.stableSamples = 0;
			}

			if (pending.attempts >= DEFERRED_RECONCILIATION_MAX_ATTEMPTS) {
				cancelDeferredReconciliation(siteId);
				logger.log(
					'info',
					`Deferred Media Proxy reconciliation expired for site ${siteId} without accessing its files.`,
				);
				return;
			}
			pending.timer = setTimeout(poll, DEFERRED_RECONCILIATION_INTERVAL_MS);
		};

		deferredReconciliations.set(siteId, pending);
		pending.timer = setTimeout(poll, 0);
	};

	const cancelDeferredGlobalCleanup = (siteId: string): void => {
		const pending = deferredGlobalCleanups.get(siteId);
		if (pending?.timer) {
			clearTimeout(pending.timer);
		}
		deferredGlobalCleanups.delete(siteId);
	};

	const globalCleanupFilesystemReady = (
		site: Local.Site,
		server: SiteServerAdapter,
	): boolean => {
		if (server.kind === 'apache' || server.kind === 'nginx') {
			return serverManagedFilesystemReady(site, server.kind);
		}
		return serverManagedFilesystemReady(site, 'nginx') ||
			serverManagedFilesystemReady(site, 'apache');
	};

	const synchronouslyPrepareSiteForGlobalChange = (
		site: Local.Site,
		mode: 'disabled' | 'uninstalling',
		generation: number,
	): boolean => {
		const globalCleanupIsCurrent = (): boolean => (
			globalLifecycleState === mode &&
			globalLifecycleGeneration === generation
		);
		let siteStatus: string;
		try {
			siteStatus = siteProcessManager.getSiteStatus(site);
		} catch (error) {
			logger.log(
				'info',
				`Deferred synchronous Media Proxy ${mode === 'uninstalling' ? 'uninstall' : 'disable'} cleanup for site ${site.id} because Local's lifecycle status was unavailable: ${errorMessage(error)}`,
			);
			return false;
		}
		if (!shouldReconcileManagedFiles(siteStatus)) {
			return false;
		}

		let detectedServer: SiteServerAdapter;
		try {
			detectedServer = detectSiteServer(site);
			if (!globalCleanupFilesystemReady(site, detectedServer)) {
				return false;
			}
		} catch (error) {
			logger.log(
				isExpectedLifecycleInterruption(site.id, error) ? 'info' : 'warn',
				`Deferred synchronous Media Proxy ${mode === 'uninstalling' ? 'uninstall' : 'disable'} cleanup for ready site ${site.id} because its managed paths were unavailable: ${errorMessage(error)}`,
			);
			return false;
		}

		let server: RuntimeServer;
		try {
			server = resolveServer(site);
		} catch {
			server = { ...detectedServer, service: null };
		}
		const transaction = serverTransactionFingerprint(site, server);
		const currentGlobalCleanupTarget = (): Local.Site | null => {
			try {
				if (!globalCleanupIsCurrent()) {
					return null;
				}
				const currentSite = siteData.getSite(site.id);
				if (!currentSite) {
					return null;
				}
				const currentStatus = siteProcessManager.getSiteStatus(currentSite);
				if (!shouldReconcileManagedFiles(currentStatus)) {
					return null;
				}
				const currentDetectedServer = detectSiteServer(currentSite);
				if (!globalCleanupFilesystemReady(currentSite, currentDetectedServer)) {
					return null;
				}
				let currentServer: RuntimeServer;
				try {
					currentServer = resolveServer(currentSite);
				} catch {
					currentServer = { ...currentDetectedServer, service: null };
				}
				const currentTransaction = serverTransactionFingerprint(
					currentSite,
					currentServer,
				);
				return serverTransactionFingerprintsMatch(transaction, currentTransaction)
					? currentSite
					: null;
			} catch {
				return null;
			}
		};
		const assertSynchronousGlobalCleanupCurrent = (): void => {
			if (!currentGlobalCleanupTarget()) {
				throw new ServerTransactionChangedError();
			}
		};

		let envelopeBeforeCleanup: StoredSettingsEnvelope | undefined;
		let forceRefresh = true;
		try {
			assertSynchronousGlobalCleanupCurrent();
			envelopeBeforeCleanup = readStoredSettingsEnvelope(site, server.kind);
			const settingsBeforeCleanup = server.kind === 'apache' || server.kind === 'nginx'
				? storedSettingsForServer(envelopeBeforeCleanup, server.kind)
				: fallbackStoredSettings(envelopeBeforeCleanup);
			forceRefresh = settingsBeforeCleanup.enabled;
		} catch (error) {
			if (isExpectedLifecycleInterruption(site.id, error)) {
				logger.log(
					'info',
					`Paused synchronous Media Proxy global cleanup for site ${site.id} because Local changed the site before saved settings could be read.`,
				);
				return true;
			}
			logger.log(
				'warn',
				`Could not read saved settings during synchronous global cleanup for site ${site.id}; forcing the deferred runtime refresh. ${errorMessage(error)}`,
			);
		}

		try {
			assertSynchronousGlobalCleanupCurrent();
			forceRefresh = removeAllManagedFilesSync(
				site,
				assertSynchronousGlobalCleanupCurrent,
			) || forceRefresh;
			assertSynchronousGlobalCleanupCurrent();
		} catch (error) {
			forceRefresh = true;
			logger.log(
				isExpectedLifecycleInterruption(site.id, error) ? 'info' : 'warn',
				`Synchronous Media Proxy global cleanup for site ${site.id} was incomplete; deferred cleanup will retry. ${errorMessage(error)}`,
			);
		}

		if (mode === 'uninstalling') {
			try {
				assertSynchronousGlobalCleanupCurrent();
				const latestSite = currentGlobalCleanupTarget();
				if (!latestSite) {
					throw new ServerTransactionChangedError();
				}
				const latestEnvelope = envelopeBeforeCleanup ??
					readStoredSettingsEnvelope(latestSite, server.kind);
				assertSynchronousGlobalCleanupCurrent();
				persistSettings(
					site.id,
					setStoredSettingsEnabled(latestEnvelope, false),
				);
			} catch (error) {
				logger.log(
					isExpectedLifecycleInterruption(site.id, error) ? 'info' : 'warn',
					`Could not commit durable disabled intent during synchronous uninstall cleanup for site ${site.id}; deferred cleanup will retry. ${errorMessage(error)}`,
				);
			}
		}

		return forceRefresh;
	};

	const cleanupSiteForGlobalChange = async (
		siteId: string,
		mode: 'disabled' | 'uninstalling',
		generation: number,
		forceRefresh: boolean,
	): Promise<void> => withSiteLock(siteId, async () => {
		const globalCleanupIsCurrent = (): boolean => {
			const pending = deferredGlobalCleanups.get(siteId);
			return globalLifecycleState === mode &&
				globalLifecycleGeneration === generation &&
				pending?.mode === mode &&
				pending.generation === generation;
		};
		if (!globalCleanupIsCurrent()) {
			throw new ServerTransactionChangedError();
		}

		const site = siteData.getSite(siteId);
		if (!site) {
			return;
		}
		const siteStatus = siteProcessManager.getSiteStatus(site);
		if (!shouldReconcileManagedFiles(siteStatus)) {
			throw new ServerTransactionChangedError();
		}
		const detectedServer = detectSiteServer(site);
		if (!globalCleanupFilesystemReady(site, detectedServer)) {
			throw new ServerTransactionChangedError();
		}

		let server: RuntimeServer;
		try {
			server = resolveServer(site);
		} catch (error) {
			logger.log(
				'warn',
				`Could not resolve the site service during global cleanup for site ${site.id}; using fail-closed persistent cleanup. ${errorMessage(error)}`,
			);
			server = { ...detectedServer, service: null };
		}
		const transaction = serverTransactionFingerprint(site, server);
		const currentGlobalCleanupTarget = (): {
			server: RuntimeServer;
			site: Local.Site;
		} | null => {
			try {
				if (!globalCleanupIsCurrent()) {
					return null;
				}
				const currentSite = siteData.getSite(siteId);
				if (!currentSite) {
					return null;
				}
				const currentStatus = siteProcessManager.getSiteStatus(currentSite);
				if (!shouldReconcileManagedFiles(currentStatus)) {
					return null;
				}
				const currentDetectedServer = detectSiteServer(currentSite);
				if (!globalCleanupFilesystemReady(currentSite, currentDetectedServer)) {
					return null;
				}
				let currentServer: RuntimeServer;
				try {
					currentServer = resolveServer(currentSite);
				} catch {
					currentServer = { ...currentDetectedServer, service: null };
				}
				const currentTransaction = serverTransactionFingerprint(
					currentSite,
					currentServer,
				);
				if (!serverTransactionFingerprintsMatch(transaction, currentTransaction)) {
					return null;
				}
				return { server: currentServer, site: currentSite };
			} catch {
				return null;
			}
		};
		const assertGlobalCleanupTransactionCurrent = (): void => {
			if (!currentGlobalCleanupTarget()) {
				throw new ServerTransactionChangedError();
			}
		};
		const guardedManagedArtifactsExist = async (): Promise<boolean> => {
			return allManagedArtifactsExist(
				site,
				assertGlobalCleanupTransactionCurrent,
			);
		};
		const guardedCompileAllConfigs = async (): Promise<void> => {
			assertGlobalCleanupTransactionCurrent();
			await configTemplates.compileServiceConfigs(site);
			assertGlobalCleanupTransactionCurrent();
		};

		let envelopeBeforeCleanup: StoredSettingsEnvelope | undefined;
		let enabledBeforeCleanup = true;
		try {
			envelopeBeforeCleanup = readStoredSettingsEnvelope(site, server.kind);
			const settingsBeforeCleanup = server.kind === 'apache' || server.kind === 'nginx'
				? storedSettingsForServer(envelopeBeforeCleanup, server.kind)
				: fallbackStoredSettings(envelopeBeforeCleanup);
			enabledBeforeCleanup = settingsBeforeCleanup.enabled;
		} catch (error) {
			logger.log(
				'warn',
				`Could not read saved settings during global cleanup for site ${site.id}; preserving the unknown schema and forcing runtime cleanup. ${errorMessage(error)}`,
			);
		}

		const requiresRuntimeRefresh = forceRefresh || enabledBeforeCleanup;
		const artifactsBeforeCleanup = await guardedManagedArtifactsExist();
		if (!artifactsBeforeCleanup && !requiresRuntimeRefresh) {
			assertGlobalCleanupTransactionCurrent();
		} else if (server.kind === 'unsupported' || !server.service) {
			const result = await completeUnresolvedServiceCleanup({
				compileAllConfigs: guardedCompileAllConfigs,
				hasManagedArtifacts: guardedManagedArtifactsExist,
				isSiteRunning: () => {
					assertGlobalCleanupTransactionCurrent();
					return siteProcessManager.getSiteStatus(site) === 'running';
				},
				removeAllManagedFiles: () => removeAllManagedFiles(
					site,
					assertGlobalCleanupTransactionCurrent,
				),
			}, requiresRuntimeRefresh);
			logger.log(
				'warn',
				`Completed fail-closed persistent cleanup for site ${site.id} without a hard restart${result.changed ? '' : '; no managed files required removal'}.`,
			);
		} else {
			const changed = await removeAllManagedFiles(
				site,
				assertGlobalCleanupTransactionCurrent,
			);
			if (changed || requiresRuntimeRefresh) {
				await compileAndReload(
					site,
					server,
					false,
					assertGlobalCleanupTransactionCurrent,
				);
			}
			if (await guardedManagedArtifactsExist()) {
				throw new Error('Managed proxy files remained after global cleanup.');
			}
		}

		assertGlobalCleanupTransactionCurrent();
		if (mode === 'uninstalling') {
			const latestSite = siteData.getSite(site.id);
			if (!latestSite) {
				return;
			}
			const latestEnvelope = envelopeBeforeCleanup ??
				readStoredSettingsEnvelope(latestSite, server.kind);
			assertGlobalCleanupTransactionCurrent();
			persistSettings(site.id, setStoredSettingsEnabled(latestEnvelope, false));
		}
	});

	const scheduleDeferredGlobalCleanup = (
		siteId: string,
		mode: 'disabled' | 'uninstalling',
		generation: number,
		forceRefresh = false,
	): void => {
		const existing = deferredGlobalCleanups.get(siteId);
		if (
			existing &&
			existing.generation === generation &&
			existing.mode === mode
		) {
			existing.forceRefresh = existing.forceRefresh || forceRefresh;
			return;
		}
		if (existing) {
			cancelDeferredGlobalCleanup(siteId);
		}

		const pending: DeferredGlobalCleanup = {
			attempts: 0,
			forceRefresh,
			generation,
			mode,
			stableSamples: 0,
		};
		const scheduleNext = (): void => {
			if (deferredGlobalCleanups.get(siteId) !== pending) {
				return;
			}
			if (pending.attempts >= DEFERRED_GLOBAL_CLEANUP_MAX_ATTEMPTS) {
				cancelDeferredGlobalCleanup(siteId);
				logger.log(
					'error',
					`Deferred Media Proxy global ${mode === 'uninstalling' ? 'uninstall' : 'disable'} cleanup expired for site ${siteId} without touching transitional site files.${pending.lastError ? ` Last error: ${pending.lastError}` : ''}`,
				);
				return;
			}
			pending.timer = setTimeout(
				() => void poll(),
				DEFERRED_GLOBAL_CLEANUP_INTERVAL_MS,
			);
		};
		const poll = async (): Promise<void> => {
			if (deferredGlobalCleanups.get(siteId) !== pending) {
				return;
			}
			pending.timer = undefined;
			pending.attempts += 1;
			if (
				globalLifecycleState !== pending.mode ||
				globalLifecycleGeneration !== pending.generation
			) {
				cancelDeferredGlobalCleanup(siteId);
				return;
			}

			try {
				const site = siteData.getSite(siteId);
				if (!site) {
					cancelDeferredGlobalCleanup(siteId);
					return;
				}
				const siteStatus = siteProcessManager.getSiteStatus(site);
				if (siteLifecycleAccess(siteStatus) === 'destroying') {
					pending.attempts = 0;
					pending.stableSamples = 0;
					scheduleNext();
					return;
				}
				if (shouldReconcileManagedFiles(siteStatus)) {
					const server = detectSiteServer(site);
					pending.stableSamples = globalCleanupFilesystemReady(site, server)
						? pending.stableSamples + 1
						: 0;
				} else {
					pending.stableSamples = 0;
				}

				if (pending.stableSamples >= DEFERRED_GLOBAL_CLEANUP_STABLE_SAMPLES) {
					await cleanupSiteForGlobalChange(
						siteId,
						pending.mode,
						pending.generation,
						pending.forceRefresh,
					);
					if (deferredGlobalCleanups.get(siteId) === pending) {
						deferredGlobalCleanups.delete(siteId);
					}
					logger.log(
						'info',
						`Completed deferred Media Proxy global ${mode === 'uninstalling' ? 'uninstall' : 'disable'} cleanup for site ${siteId}.`,
					);
					return;
				}
			} catch (error) {
				pending.lastError = errorMessage(error);
				pending.stableSamples = 0;
			}
			scheduleNext();
		};

		deferredGlobalCleanups.set(siteId, pending);
		pending.timer = setTimeout(() => void poll(), 0);
	};

	const matchesThisAddon = (addon: unknown): boolean => {
		if (!addon || typeof addon !== 'object') {
			return false;
		}

		const candidate = addon as { name?: unknown; npmPackageName?: unknown };
		return candidate.npmPackageName === ADDON_ID || candidate.name === ADDON_ID;
	};

	const cleanUpForGlobalChange = (addon: unknown, uninstalling: boolean): void => {
		if (!matchesThisAddon(addon)) {
			return;
		}
		globalLifecycleGeneration += 1;
		const mode = uninstalling ? 'uninstalling' : 'disabled';
		globalLifecycleState = mode;
		for (const siteId of deferredReconciliations.keys()) {
			cancelDeferredReconciliation(siteId);
		}
		for (const siteId of deferredGlobalCleanups.keys()) {
			cancelDeferredGlobalCleanup(siteId);
		}
		for (const controller of originProbeControllers.values()) {
			controller.abort();
		}
		originProbeControllers.clear();

		for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
			try {
				const forceRefresh = synchronouslyPrepareSiteForGlobalChange(
					site,
					mode,
					globalLifecycleGeneration,
				);
				scheduleDeferredGlobalCleanup(
					site.id,
					mode,
					globalLifecycleGeneration,
					forceRefresh,
				);
			} catch (error) {
				logger.log(
					'warn',
					`Deferred Media Proxy global ${uninstalling ? 'uninstall' : 'disable'} cleanup for site ${site.id} after synchronous preparation failed; a forced retry was scheduled: ${errorMessage(error)}`,
				);
				scheduleDeferredGlobalCleanup(
					site.id,
					mode,
					globalLifecycleGeneration,
					true,
				);
			}
		}
	};

	const restoreAfterGlobalEnable = (addon: unknown): void => {
		if (!matchesThisAddon(addon)) {
			return;
		}

		globalLifecycleGeneration += 1;
		for (const siteId of deferredGlobalCleanups.keys()) {
			cancelDeferredGlobalCleanup(siteId);
		}
		globalLifecycleState = null;
		for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
			scheduleDeferredReconciliation(site.id, {
				configuredOnly: true,
				refreshMatchingEnabledRuntime: true,
			});
		}
	};

	const listenerRegistry = ipcMain as typeof ipcMain & {
		[LIFECYCLE_LISTENERS_KEY]?: {
			disable: (...args: unknown[]) => void;
			enable: (...args: unknown[]) => void;
			toggle: (...args: unknown[]) => void;
			uninstall: (...args: unknown[]) => void;
		};
	};
	const previousListeners = listenerRegistry[LIFECYCLE_LISTENERS_KEY];
	if (previousListeners) {
		ipcMain.removeListener('addonInstallerService:disable', previousListeners.disable);
		ipcMain.removeListener('addonInstallerService:enable', previousListeners.enable);
		ipcMain.removeListener('addonInstallerService:toggle', previousListeners.toggle);
		ipcMain.removeListener('addonInstallerService:uninstall', previousListeners.uninstall);
	}

	const disableListener = (_event: unknown, addon: unknown): void => {
		cleanUpForGlobalChange(addon, false);
	};
	const enableListener = (_event: unknown, addon: unknown): void => {
		restoreAfterGlobalEnable(addon);
	};
	const toggleListener = (_event: unknown, addon: unknown): void => {
		if (!matchesThisAddon(addon)) {
			return;
		}

		const enabledAddons = appState.getState().enabledAddons ?? {};
		if (enabledAddons[ADDON_ID]) {
			restoreAfterGlobalEnable(addon);
		} else {
			cleanUpForGlobalChange(addon, false);
		}
	};
	const uninstallListener = (_event: unknown, addon: unknown): void => {
		cleanUpForGlobalChange(addon, true);
	};
	listenerRegistry[LIFECYCLE_LISTENERS_KEY] = {
		disable: disableListener,
		enable: enableListener,
		toggle: toggleListener,
		uninstall: uninstallListener,
	};
	ipcMain.on('addonInstallerService:disable', disableListener);
	ipcMain.on('addonInstallerService:enable', enableListener);
	ipcMain.on('addonInstallerService:toggle', toggleListener);
	ipcMain.on('addonInstallerService:uninstall', uninstallListener);

	for (const channel of Object.values(IPC_CHANNELS)) {
		ipcMain.removeHandler(channel);
	}

	ipcMain.handle(IPC_CHANNELS.getOriginDiscoveryOptions, async (_event, siteId: string) => {
		try {
			requireSiteId(siteId);
			const site = siteData.getSite(siteId);
			if (!site) {
				return {
					canAutoPopulate: false,
					environments: [],
					message: 'This Local site no longer exists.',
					provider: 'none',
				};
			}
			const siteStatus = siteProcessManager.getSiteStatus(site);
			if (!shouldReconcileManagedFiles(siteStatus)) {
				return {
					canAutoPopulate: false,
					environments: [],
					message: lifecycleUnavailableReason(siteStatus),
					provider: 'none',
				};
			}
			const detectedServer = detectSiteServer(site);
			if (
				detectedServer.kind !== 'unsupported' &&
				!serverManagedFilesystemReady(site, detectedServer.kind)
			) {
				return {
					canAutoPopulate: false,
					environments: [],
					message: 'Local has not finished preparing this site. Media Proxy connection discovery is paused.',
					provider: 'none',
				};
			}
			const options = await getOriginDiscoveryOptions(
				site,
				wpEngineCapi,
				(error) => logger.log('warn', `WP Engine environment lookup failed: ${errorLogMessage(error)}`),
			);
			return detectSiteServer(site).kind === 'apache'
				? {
					...options,
					message: options.provider === 'wpengine' && options.canAutoPopulate
						? 'Connected to WP Engine. Select an environment to populate its Site URL; Apache resolves that hostname directly.'
						: 'Enter the remote Site URL. Apache resolves its hostname directly, so no remote IP or DNS lookup is needed.',
				}
				: options;
		} catch (error) {
			logger.log('warn', `Unable to load origin discovery options: ${errorMessage(error)}`);
			throw new Error(errorMessage(error));
		}
	});

	ipcMain.handle(
		IPC_CHANNELS.discoverOrigin,
		async (_event, siteId: string, request: OriginDiscoveryRequest) => {
			try {
				return await discoverOrigin(siteId, request);
			} catch (error) {
				logger.log('warn', `Origin discovery failed: ${errorLogMessage(error)}`);
				throw new Error(errorMessage(error));
			}
		},
	);

	ipcMain.handle(IPC_CHANNELS.getSiteState, async (_event, siteId: string) => {
		try {
			await reconcileSite(siteId);
		} catch (error) {
			if (isExpectedLifecycleInterruption(siteId, error)) {
				logger.log(
					'info',
					`Paused state-read reconciliation for site ${siteId} because Local changed or removed the site.`,
				);
			} else {
				logger.log('warn', `State-read reconciliation failed for site ${siteId}; returning the current persisted state. ${errorMessage(error)}`);
			}
		}
		try {
			return await getSiteState(siteId);
		} catch (error) {
			if (isExpectedLifecycleInterruption(siteId, error)) {
				logger.log(
					'info',
					`Returned lifecycle-unavailable Media Proxy state for site ${siteId} because Local changed or removed the site during a guarded read.`,
				);
				const site = siteData.getSite(siteId) ?? null;
				let siteStatus = 'deleting';
				if (site) {
					try {
						siteStatus = siteProcessManager.getSiteStatus(site);
					} catch {
						siteStatus = 'deleting';
					}
				}
				return lifecycleUnavailableSiteState(site, siteStatus);
			}
			logger.log('error', `Unable to read site state: ${errorMessage(error)}`);
			throw new Error(errorMessage(error));
		}
	});

	ipcMain.handle(IPC_CHANNELS.testOrigin, async (event, siteId: unknown, input: unknown, rawToken: unknown) => {
		const validatedSiteId = requireSiteId(siteId);
		const token = requireOriginProbeToken(rawToken);
		const key = originProbeKey(event.sender.id, validatedSiteId, token);
		const controller = new AbortController();
		if (originProbeControllers.has(key)) {
			throw new Error('This connection test is already running.');
		}
		originProbeControllers.set(key, controller);
		try {
			return await testOrigin(validatedSiteId, input, controller.signal);
		} catch (error) {
			logger.log(
				controller.signal.aborted ? 'info' : 'warn',
				`Origin test ${controller.signal.aborted ? 'stopped' : 'failed'}: ${errorLogMessage(error)}`,
			);
			throw new Error(errorMessage(error));
		} finally {
			if (originProbeControllers.get(key) === controller) {
				originProbeControllers.delete(key);
			}
		}
	});

	ipcMain.handle(IPC_CHANNELS.cancelOriginTest, (event, siteId: unknown, rawToken: unknown) => {
		const validatedSiteId = requireSiteId(siteId);
		const token = requireOriginProbeToken(rawToken);
		const controller = originProbeControllers.get(originProbeKey(event.sender.id, validatedSiteId, token));
		if (!controller) {
			return false;
		}

		controller.abort();
		return true;
	});

	ipcMain.handle(
		IPC_CHANNELS.applySettings,
		async (_event, siteId: string, input: unknown, expectedServerKind: unknown) => {
			try {
				return await applySettings(siteId, input, expectedServerKind);
			} catch (error) {
				logger.log(
					isExpectedLifecycleInterruption(siteId, error) ? 'info' : 'error',
					`Unable to apply settings for site ${siteId}: ${errorLogMessage(error)}`,
				);
				throw new Error(errorMessage(error));
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.setEnabled,
		async (_event, siteId: string, expectedServerKind: unknown, enabled: unknown) => {
			try {
				return await setEnabled(siteId, expectedServerKind, enabled);
			} catch (error) {
				logger.log(
					isExpectedLifecycleInterruption(siteId, error) ? 'info' : 'error',
					`Unable to change enabled intent for site ${siteId}: ${errorLogMessage(error)}`,
				);
				throw new Error(errorMessage(error));
			}
		},
	);

	LocalMain.HooksMain.addAction('siteStarted', (siteOrId: Local.Site | string) => {
		const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId?.id;
		if (!siteId) {
			return;
		}

		if (globalLifecycleState) {
			scheduleDeferredGlobalCleanup(
				siteId,
				globalLifecycleState,
				globalLifecycleGeneration,
			);
			return;
		}
		scheduleDeferredReconciliation(siteId, {
			configuredOnly: true,
			refreshMatchingEnabledRuntime: true,
		});
	});

	LocalMain.HooksMain.addAction('siteAdded', (siteOrId: Local.Site | string) => {
		const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId?.id;
		if (!siteId) {
			return;
		}

		if (globalLifecycleState) {
			scheduleDeferredGlobalCleanup(
				siteId,
				globalLifecycleState,
				globalLifecycleGeneration,
			);
			return;
		}
		scheduleDeferredReconciliation(siteId, {
			configuredOnly: true,
			refreshMatchingEnabledRuntime: true,
		});
	});

	LocalMain.HooksMain.addAction('siteDeleted', (siteOrId: Local.Site | string) => {
		const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId?.id;
		if (!siteId) {
			return;
		}

		cancelDeferredReconciliation(siteId);
		cancelDeferredGlobalCleanup(siteId);
		cancelOriginProbesForSite(siteId);
	});

	for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
		scheduleDeferredReconciliation(site.id, {
			configuredOnly: false,
			refreshMatchingEnabledRuntime: false,
		});
	}
}
