/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { createHash } from 'node:crypto';
import {
	apacheCompiledConfigMatches,
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
import {
	nginxCompiledConfigMatches,
	refreshNginxService,
} from './nginx';
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
	applyServerManagedFiles,
	captureAllManagedFiles,
	removeAllManagedFiles,
	removeAllManagedFilesSync,
	readApacheManagedModulesTemplate,
	readServerManagedIncludeTemplate,
	restoreManagedFiles,
	serverManagedFilesystemReady,
	serverManagedFilesMatch,
} from './site-config';
import { detectSiteServer, type SiteServerAdapter } from './server';
import {
	carrySiteUrlToPristineServerProfile,
	fallbackStoredSettings,
	normalizeStoredSettingsEnvelope,
	originPairMatches,
	preserveStoredBlankCurrentProfile,
	replaceStoredSettingsForServer,
	serializeStoredSettingsEnvelope,
	setStoredSettingsEnabled,
	setStoredSettingsLastServer,
	storedSettingsEnvelopeNeedsMigration,
	storedSettingsForServer,
	storedSettingsHaveValidDisabledIntent,
	storedSettingsRequireBackgroundReconciliation,
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
	skipHaltedDisabledProfile?: boolean;
}

interface DeferredReconciliation {
	attempts: number;
	options: ReconcileOptions;
	revision: number;
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

function failClosedSettingsForInvalidEnvelope(
	value: unknown,
	serverKind: 'apache' | 'nginx' | 'unsupported',
): StoredSettings {
	const fallbackEnvelope = normalizeStoredSettingsEnvelope(undefined, serverKind);
	const fallback = serverKind === 'apache' || serverKind === 'nginx'
		? storedSettingsForServer(fallbackEnvelope, serverKind)
		: fallbackStoredSettings(fallbackEnvelope);
	const raw = value && typeof value === 'object' && !Array.isArray(value)
		? value as { enabled?: unknown }
		: undefined;
	return {
		...fallback,
		enabled: raw?.enabled === true,
	};
}

function shouldSkipHaltedDisabledReconciliation(
	site: Local.Site,
	siteStatus: string,
	options: ReconcileOptions,
): boolean {
	return options.skipHaltedDisabledProfile === true &&
		siteStatus === 'halted' &&
		storedSettingsHaveValidDisabledIntent(
			(site as SiteWithSettings)[SITE_SETTINGS_KEY],
		);
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

function stableRuntimeInput(value: unknown, ancestors = new Set<object>()): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		return `string:${JSON.stringify(value)}`;
	}
	if (typeof value === 'number') {
		return `number:${Number.isNaN(value) ? 'NaN' : String(value)}`;
	}
	if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'undefined') {
		return `${typeof value}:${String(value)}`;
	}
	if (typeof value === 'function' || typeof value === 'symbol') {
		throw new Error('Local returned unsupported web-server compiler inputs.');
	}
	if (ancestors.has(value)) {
		throw new Error('Local returned circular web-server compiler inputs.');
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `array:[${value.map((entry) => stableRuntimeInput(entry, ancestors)).join(',')}]`;
		}
		const entries = Object.keys(value).sort().map((key) => (
			`${JSON.stringify(key)}:${stableRuntimeInput((value as Record<string, unknown>)[key], ancestors)}`
		));
		return `object:{${entries.join(',')}}`;
	} finally {
		ancestors.delete(value);
	}
}

function serviceInputsDigest(service: ApacheRuntimeService | null): string | null {
	if (!service) {
		return null;
	}
	return createHash('sha256')
		.update(stableRuntimeInput({
			configVariables: service.configVariables,
			env: service.env,
		}))
		.digest('hex');
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
			serviceInputsDigest: serviceInputsDigest(server.service),
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
			const currentServer = resolveServer(currentSite);
			const current = serverTransactionFingerprint(currentSite, currentServer);
			if (
				current === null ||
				!serverTransactionFingerprintsMatch(expected, current)
			) {
				return false;
			}
			return expected.serverKind === 'unsupported' || (
				currentServer.kind !== 'unsupported' &&
				serverManagedFilesystemReady(
					currentSite,
					currentServer.kind,
					managedFileOptions(currentServer),
				)
			);
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
			const server = resolveServer(currentSite);
			return server.kind !== 'unsupported' &&
				!serverManagedFilesystemReady(
					currentSite,
					server.kind,
					managedFileOptions(server),
				);
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
			!serverManagedFilesystemReady(site, server.kind, managedFileOptions(server))
		) {
			throw new Error(
				'Local has not finished preparing this site\'s web-server files. Wait for Local to finish, then retry.',
			);
		}
		return transaction;
	};

	const managedFileOptions = (server: RuntimeServer): {
		apacheHttpdBinary?: string;
		configPath?: string;
		runPath?: string;
		serverKind: 'apache' | 'nginx';
		siteConfigTemplatePath?: string;
	} => {
		if (server.kind === 'unsupported') {
			throw new Error(server.reason || 'This site uses an unsupported web server.');
		}
		return {
			apacheHttpdBinary: server.kind === 'apache' ? server.service?.bin?.httpd : undefined,
			configPath: server.service?.configPath,
			runPath: server.service?.runPath,
			serverKind: server.kind,
			siteConfigTemplatePath: server.service?.siteConfigTemplatePath,
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
		const server = resolveServer(site);
		if (
			server.kind !== 'unsupported' &&
			server.service &&
			!serverManagedFilesystemReady(site, server.kind, managedFileOptions(server))
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

	const serverCompiledConfigMatches = async (
		site: Local.Site,
		server: RuntimeServer,
		expectManaged: boolean,
		assertCurrent: () => void = (): void => undefined,
	): Promise<boolean> => {
		assertCurrent();
		if (server.kind === 'unsupported' || !server.service) {
			return false;
		}
		const options = managedFileOptions(server);
		const expectedManagedInclude = expectManaged
			? await readServerManagedIncludeTemplate(site, options, assertCurrent)
			: null;
		const expectedManagedModules = expectManaged && server.kind === 'apache'
			? await readApacheManagedModulesTemplate(site, options, assertCurrent)
			: null;
		if (
			expectManaged && (
				expectedManagedInclude === null ||
				(server.kind === 'apache' && expectedManagedModules === null)
			)
		) {
			return false;
		}
		const matches = server.kind === 'apache'
			? await apacheCompiledConfigMatches(
				server.service,
				expectedManagedInclude,
				expectedManagedModules,
				assertCurrent,
			)
			: await nginxCompiledConfigMatches(server.service, expectedManagedInclude, assertCurrent);
		assertCurrent();
		return matches;
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
		const options = managedFileOptions(server);
		const expectedManagedInclude = expectManaged
			? await readServerManagedIncludeTemplate(site, options, assertCurrent)
			: null;
		const expectedManagedModules = expectManaged && server.kind === 'apache'
			? await readApacheManagedModulesTemplate(site, options, assertCurrent)
			: null;
		if (
			expectManaged && (
				expectedManagedInclude === null ||
				(server.kind === 'apache' && expectedManagedModules === null)
			)
		) {
			throw new Error(`The managed ${server.kind} include template is unavailable.`);
		}
		const serviceName = server.serviceName;
		if (server.kind === 'apache') {
			const processName = 'httpd';
			const targetServiceRunning = (): boolean => {
				assertCurrent();
				return siteProcessManager.hasRunningProcess(site, processName);
			};
			const shouldRefreshApacheTarget = (): boolean => {
				assertCurrent();
				const siteStatus = siteProcessManager.getSiteStatus(site);
				const targetWasRunning = targetServiceRunning();
				if (siteStatus === 'running' && !targetWasRunning) {
					throw new Error(
						"Local no longer reports this site's Apache service as running. Stop and start the site in Local, then retry.",
					);
				}
				return shouldRefreshRuntime(siteStatus, targetWasRunning);
			};
			const refreshed = await refreshApacheService(
				site,
				server.service,
				configTemplates,
				LocalMain.execFilePromise,
				expectManaged,
				shouldRefreshApacheTarget,
				targetServiceRunning,
				{
					assertCurrent,
					expectedManagedInclude: expectedManagedInclude ?? undefined,
					expectedManagedModules: expectedManagedModules ?? undefined,
				},
			);
			assertCurrent();
			return refreshed;
		}

		const targetSiteRunning = (): boolean => {
			assertCurrent();
			return siteProcessManager.getSiteStatus(site) === 'running';
		};
		const targetServiceRunning = (): boolean => {
			assertCurrent();
			return siteProcessManager.hasRunningProcess(site, serviceName);
		};
		const refreshed = await refreshNginxService(
			site,
			server.service,
			configTemplates,
			LocalMain.execFilePromise,
			expectedManagedInclude,
			targetSiteRunning,
			targetServiceRunning,
			{ assertCurrent },
		);
		assertCurrent();
		return refreshed;
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
					!serverManagedFilesystemReady(
						currentSite,
						currentServer.kind,
						managedFileOptions(currentServer),
					)
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
				let restoredManagedSourceMatches = false;
				if (previousEnvelope.enabled) {
					try {
						const previousSettings = storedSettingsForServer(
							previousEnvelope,
							rollbackTarget.server.kind,
						);
						const previousOrigin = validateAndNormalizeOrigin(previousSettings, {
							requiresOriginIp: rollbackTarget.server.requiresOriginIp,
						});
						const trustBundle = previousOrigin.protocol === 'https:'
							? trustedCertificateAuthoritiesPem()
							: undefined;
						restoredManagedSourceMatches = await serverManagedFilesMatch(
							rollbackTarget.site,
							previousOrigin,
							managedFileOptions(rollbackTarget.server),
							trustBundle,
							assertRollbackTransactionCurrent,
						);
					} catch (error) {
						if (isServerTransactionChangedError(error)) {
							throw error;
						}
						restoredManagedSourceMatches = false;
					}
				}
				if (!restoredManagedSourceMatches) {
					await removeAllManagedFiles(
						rollbackTarget.site,
						assertRollbackTransactionCurrent,
						managedFileOptions(rollbackTarget.server),
					);
					assertRollbackTransactionCurrent();
				}
				await compileAndReload(
					rollbackTarget.site,
					rollbackTarget.server,
					restoredManagedSourceMatches,
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
		let settings: StoredSettings;
		let settingsReadOnly = false;
		let stateReason = reason;
		try {
			const envelope = site
				? readStoredSettingsEnvelope(site, server.kind)
				: normalizeStoredSettingsEnvelope(undefined, 'unsupported');
			settings = server.kind === 'apache' || server.kind === 'nginx'
				? storedSettingsForServer(envelope, server.kind)
				: fallbackStoredSettings(envelope);
		} catch (settingsError) {
			settingsReadOnly = true;
			settings = failClosedSettingsForInvalidEnvelope(
				site ? (site as SiteWithSettings)[SITE_SETTINGS_KEY] : undefined,
				server.kind,
			);
			stateReason = `${reason} ${errorMessage(settingsError)} The saved value and enabled intent were retained for recovery.`;
		}
		return {
			applied: false,
			canEnable: false,
			cleanupSupported: false,
			enableUnavailableReason: stateReason,
			lifecycleReady: false,
			needsAttention: false,
			reason: stateReason,
			requiresOriginIp: server.requiresOriginIp,
			serverKind: server.kind,
			settings,
			settingsReadOnly,
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
		const server = resolveServer(site);
		if (
			detectedServer.kind !== 'unsupported' &&
			server.service &&
			!serverManagedFilesystemReady(site, detectedServer.kind, managedFileOptions(server))
		) {
			return lifecycleUnavailableSiteState(
				site,
				siteStatus,
				'Local has not finished preparing this site\'s web-server files. Media Proxy will remain inactive until they are ready.',
			);
		}
		const transaction = serverTransactionFingerprint(site, server);
		const assertSiteStateTransactionCurrent = (): void => {
			if (!serverTransactionIsCurrent(siteId, transaction)) {
				throw new ServerTransactionChangedError();
			}
		};
		assertSiteStateTransactionCurrent();
		const rawStoredSettings = (site as SiteWithSettings)[SITE_SETTINGS_KEY];
		let storedEnvelope: StoredSettingsEnvelope;
		try {
			storedEnvelope = readStoredSettingsEnvelope(site, server.kind);
		} catch (settingsError) {
			const settings = failClosedSettingsForInvalidEnvelope(rawStoredSettings, server.kind);
			const cleanupSupported = server.kind !== 'unsupported' && Boolean(server.service);
			const managedArtifactsPresent = await allManagedArtifactsExist(
				site,
				assertSiteStateTransactionCurrent,
				server.kind === 'unsupported' ? undefined : managedFileOptions(server),
			);
			const compiledConfigIsClean = cleanupSupported
				? await serverCompiledConfigMatches(
					site,
					server,
					false,
					assertSiteStateTransactionCurrent,
				)
				: false;
			const cleanupPending = cleanupSupported && (
				managedArtifactsPresent || !compiledConfigIsClean
			);
			const reason = `${errorMessage(settingsError)} The saved value and enabled intent were retained for recovery. ${
				!cleanupSupported
					? 'Runtime cleanup cannot be verified because Local could not resolve a supported web-server service. Stop the site to prevent requests, restore an unambiguous service, and retry.'
					: cleanupPending
						? 'Runtime cleanup is pending and will retry while this site is available; a previously compiled proxy may remain active until cleanup is verified. Stop the site to prevent requests immediately.'
						: 'Managed runtime configuration is inactive.'
			} This add-on version will not overwrite the unknown value. Restore a valid site-settings backup or install a compatible add-on version before configuring this profile again.`;
			return {
				applied: false,
				canEnable: false,
				cleanupSupported,
				enableUnavailableReason: reason,
				lifecycleReady: true,
				needsAttention: true,
				reason,
				requiresOriginIp: server.requiresOriginIp,
				serverKind: server.kind,
				settings,
				settingsReadOnly: true,
				siteStatus,
				supported: cleanupSupported,
				supportsHttpsOrigin: server.kind === 'nginx',
			};
		}
		const intentPreservedEnvelope = server.kind === 'apache' || server.kind === 'nginx'
			? preserveStoredBlankCurrentProfile(
				storedEnvelope,
				rawStoredSettings,
				server.kind,
			)
			: storedEnvelope;
		const envelope = server.kind === 'apache' || server.kind === 'nginx'
			? carrySiteUrlToPristineServerProfile(intentPreservedEnvelope, server.kind)
			: intentPreservedEnvelope;
		const settings = server.kind === 'apache' || server.kind === 'nginx'
			? storedSettingsForServer(envelope, server.kind)
			: fallbackStoredSettings(envelope);
		const managedArtifactsPresent = await allManagedArtifactsExist(
			site,
			assertSiteStateTransactionCurrent,
			server.kind === 'unsupported' ? undefined : managedFileOptions(server),
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
		let compiledMatches = false;

		if (server.kind !== 'unsupported' && server.service) {
			if (settings.enabled) {
				try {
					if (!normalizedOrigin || !canEnable) {
						throw new Error(enableUnavailableReason || 'The current connection profile is incomplete.');
					}
					const trustBundle = normalizedOrigin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					const sourceMatches = await serverManagedFilesMatch(
						site,
						normalizedOrigin,
						managedFileOptions(server),
						trustBundle,
						assertSiteStateTransactionCurrent,
					);
					compiledMatches = sourceMatches && await serverCompiledConfigMatches(
						site,
						server,
						true,
						assertSiteStateTransactionCurrent,
					);
					applied = sourceMatches && compiledMatches;
				} catch (error) {
					if (isExpectedLifecycleInterruption(siteId, error)) {
						throw error;
					}
					applied = false;
				}
			} else {
				compiledMatches = await serverCompiledConfigMatches(
					site,
					server,
					false,
					assertSiteStateTransactionCurrent,
				);
				applied = managedArtifactsPresent || !compiledMatches;
			}
		}
		const needsAttention = (
			runtimeUnavailable && (
				server.kind !== 'unsupported' ||
				settings.enabled ||
				managedArtifactsPresent
			)
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
					managedFileOptions(server),
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
						server.kind === 'unsupported' ? undefined : managedFileOptions(server),
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
					managedFileOptions(server),
				);
				const compiledConfigIsClean = server.kind !== 'unsupported' && server.service
					? await serverCompiledConfigMatches(
						site,
						server,
						false,
						() => assertServerTransactionCurrent(siteId, transaction),
					)
					: true;
				const changed = await runServerTransactionMutation(
					() => assertServerTransactionCurrent(siteId, transaction),
					() => removeAllManagedFiles(
						site,
						() => assertServerTransactionCurrent(siteId, transaction),
						managedFileOptions(server),
					),
				);
				if (
					server.kind !== 'unsupported' &&
					server.service &&
					(changed || !compiledConfigIsClean)
				) {
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
		const previousEnvelope = readStoredSettingsEnvelope(site, expectedServerKind);
		const intentPreservedEnvelope = preserveStoredBlankCurrentProfile(
			previousEnvelope,
			(site as SiteWithSettings)[SITE_SETTINGS_KEY],
			expectedServerKind,
		);
		const envelope = carrySiteUrlToPristineServerProfile(
			intentPreservedEnvelope,
			expectedServerKind,
		);
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
				managedFileOptions(server),
			);
			const compiledConfigIsClean = await serverCompiledConfigMatches(
				site,
				server,
				false,
				() => assertServerTransactionCurrent(siteId, transaction),
			);
			const changed = await runServerTransactionMutation(
				() => assertServerTransactionCurrent(siteId, transaction),
				() => removeAllManagedFiles(
					site,
					() => assertServerTransactionCurrent(siteId, transaction),
					managedFileOptions(server),
				),
			);
			if (changed || !compiledConfigIsClean) {
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
				previousEnvelope,
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
	): Promise<boolean> => {
		try {
			return await withSiteLock(siteId, async () => {
				if (globalLifecycleState) {
					return false;
				}

				const site = siteData.getSite(siteId);
				if (!site) {
					return true;
				}
				const rawStoredSettings = (site as SiteWithSettings)[SITE_SETTINGS_KEY];
				if (
					options.configuredOnly &&
					!storedSettingsRequireBackgroundReconciliation(rawStoredSettings)
				) {
					return true;
				}
				const siteStatusAllowsReconciliation = (candidate: Local.Site): boolean => (
					shouldReconcileManagedFiles(siteProcessManager.getSiteStatus(candidate))
				);
				const initialSiteStatus = siteProcessManager.getSiteStatus(site);
				if (!shouldReconcileManagedFiles(initialSiteStatus)) {
					return false;
				}
				if (shouldSkipHaltedDisabledReconciliation(site, initialSiteStatus, options)) {
					return true;
				}

				const detectedServer = detectSiteServer(site);
				if (detectedServer.kind === 'unsupported') {
					return false;
				}
				const server = resolveServer(site);
				if (!serverManagedFilesystemReady(
					site,
					detectedServer.kind,
					server.service ? managedFileOptions(server) : undefined,
				)) {
					return false;
				}
				const transaction = serverTransactionFingerprint(site, server);
				const reconciliationCanMutate = (): boolean => {
					const latestSite = siteData.getSite(siteId);
					if (!latestSite || !siteStatusAllowsReconciliation(latestSite)) {
						return false;
					}
					const latestServer = resolveServer(latestSite);
					if (
						latestServer.kind === 'unsupported' ||
						!serverManagedFilesystemReady(
							latestSite,
							latestServer.kind,
							latestServer.service ? managedFileOptions(latestServer) : undefined,
						)
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
				let previousEnvelope: StoredSettingsEnvelope;
				try {
					previousEnvelope = readStoredSettingsEnvelope(site, server.kind);
				} catch (settingsError) {
					if (!server.service) {
						throw new Error(
							`${errorMessage(settingsError)} ${runtimeCleanupUnavailableReason(server)}`,
						);
					}
					try {
						await runServerTransactionMutation(
							assertReconciliationTransactionCurrent,
							() => removeAllManagedFiles(
								site,
								assertReconciliationTransactionCurrent,
								managedFileOptions(server),
							),
						);
						await compileAndReload(
							site,
							server,
							false,
							assertReconciliationTransactionCurrent,
						);
						if (await allManagedArtifactsExist(
							site,
							assertReconciliationTransactionCurrent,
							managedFileOptions(server),
						)) {
							throw new Error('Managed proxy files remained after invalid-settings cleanup.');
						}
					} catch (cleanupError) {
						if (isServerTransactionChangedError(cleanupError)) {
							throw cleanupError;
						}
						throw new Error(
							`${errorMessage(settingsError)} Fail-closed cleanup also failed (${errorMessage(cleanupError)}).`,
						);
					}
					logger.log(
						'warn',
						`Removed media proxy configuration for site ${site.id} because its saved settings could not be parsed; the stored value was retained for recovery: ${errorMessage(settingsError)}`,
					);
					return true;
				}
				const intentPreservedEnvelope = server.kind === 'apache' || server.kind === 'nginx'
					? preserveStoredBlankCurrentProfile(
						previousEnvelope,
						rawStoredSettings,
						server.kind,
					)
					: previousEnvelope;
				const reconciledEnvelope = server.kind === 'apache' || server.kind === 'nginx'
					? carrySiteUrlToPristineServerProfile(intentPreservedEnvelope, server.kind)
					: intentPreservedEnvelope;
				const settings = server.kind === 'apache' || server.kind === 'nginx'
					? storedSettingsForServer(reconciledEnvelope, server.kind)
					: fallbackStoredSettings(reconciledEnvelope);
				let normalizedOrigin: ReturnType<typeof validateAndNormalizeOrigin> | undefined;
				if (server.kind === 'unsupported' || !server.service) {
					if (!settings.enabled && !await allManagedArtifactsExist(
						site,
						assertReconciliationTransactionCurrent,
						server.kind === 'unsupported' ? undefined : managedFileOptions(server),
					)) {
						return true;
					}
					throw new Error(runtimeCleanupUnavailableReason(server));
				}
				const nextEnvelope = setStoredSettingsLastServer(reconciledEnvelope, server.kind);
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
				let compiledConfigMatches = false;
				if (!settings.enabled) {
					const managedArtifactsPresent = await allManagedArtifactsExist(
						site,
						assertReconciliationTransactionCurrent,
						managedFileOptions(server),
					);
					compiledConfigMatches = await serverCompiledConfigMatches(
						site,
						server,
						false,
						assertReconciliationTransactionCurrent,
					);
					if (!managedArtifactsPresent && compiledConfigMatches) {
						if (rawStoredSettings !== undefined) {
							return persistReconciledEnvelope();
						}
						return true;
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
							return false;
						}
						const snapshots = await captureAllManagedFiles(
							site,
							assertReconciliationTransactionCurrent,
							managedFileOptions(server),
						);
						if (!reconciliationCanMutate()) {
							return false;
						}
						const cleanupErrors: string[] = [];

						let changed = false;
						try {
							changed = await runServerTransactionMutation(
								assertReconciliationTransactionCurrent,
								() => removeAllManagedFiles(
									site,
									assertReconciliationTransactionCurrent,
									managedFileOptions(server),
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
						if (cleanupErrors.length === 0) {
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
						}

						const reason = errorMessage(validationError);
						if (cleanupErrors.length > 0) {
							throw new Error(`${reason} Fail-closed cleanup also failed (${cleanupErrors.join('; ')}).`);
						}
						logger.log(
							'warn',
							`Removed unverified media proxy configuration for site ${site.id} while retaining global enabled intent for the current ${server.kind} profile: ${reason}`,
						);
						return true;
					}

					const trustBundle = normalizedOrigin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;

					const managedFilesMatch = await serverManagedFilesMatch(
						site,
						normalizedOrigin,
						managedFileOptions(server),
						trustBundle,
						assertReconciliationTransactionCurrent,
					);
					if (managedFilesMatch) {
						compiledConfigMatches = await serverCompiledConfigMatches(
							site,
							server,
							true,
							assertReconciliationTransactionCurrent,
						);
						if (
							compiledConfigMatches &&
							!options.refreshMatchingEnabledRuntime
						) {
							return persistReconciledEnvelope();
						}
					}
				}

				const snapshots = await captureAllManagedFiles(
					site,
					assertReconciliationTransactionCurrent,
					managedFileOptions(server),
				);
				try {
					assertGloballyActive();
					if (!reconciliationCanMutate()) {
						return false;
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
								managedFileOptions(server),
							),
						);
					}

					if (
						changed ||
						!compiledConfigMatches ||
						Boolean(settings.enabled && options.refreshMatchingEnabledRuntime)
					) {
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
					return true;
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
				return false;
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
		if (!existing && options.configuredOnly) {
			const site = siteData.getSite(siteId);
			if (
				!site ||
				!storedSettingsRequireBackgroundReconciliation(
					(site as SiteWithSettings)[SITE_SETTINGS_KEY],
				)
			) {
				return;
			}
		}
		if (existing) {
			existing.options = {
				configuredOnly: existing.options.configuredOnly && options.configuredOnly,
				refreshMatchingEnabledRuntime: Boolean(
					existing.options.refreshMatchingEnabledRuntime ||
					options.refreshMatchingEnabledRuntime,
				),
				skipHaltedDisabledProfile: Boolean(
					existing.options.skipHaltedDisabledProfile &&
					options.skipHaltedDisabledProfile,
				),
			};
			existing.revision += 1;
			return;
		}

		const pending: DeferredReconciliation = {
			attempts: 0,
			options: { ...options },
			revision: 0,
			stableSamples: 0,
		};
		let poll: () => void;
		const scheduleNextPoll = (): void => {
			if (deferredReconciliations.get(siteId) !== pending) {
				return;
			}
			if (pending.attempts >= DEFERRED_RECONCILIATION_MAX_ATTEMPTS) {
				cancelDeferredReconciliation(siteId);
				logger.log(
					'info',
					`Deferred Media Proxy reconciliation expired for site ${siteId} without reaching a stable, verified runtime state.`,
				);
				return;
			}
			pending.timer = setTimeout(poll, DEFERRED_RECONCILIATION_INTERVAL_MS);
		};
		poll = (): void => {
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
			if (
				pending.options.configuredOnly &&
				!storedSettingsRequireBackgroundReconciliation(
					(site as SiteWithSettings)[SITE_SETTINGS_KEY],
				)
			) {
				cancelDeferredReconciliation(siteId);
				return;
			}
			let siteStatus: string;
			try {
				siteStatus = siteProcessManager.getSiteStatus(site);
			} catch (error) {
				pending.stableSamples = 0;
				logger.log('warn', `Unable to read lifecycle status for site ${siteId}: ${errorMessage(error)}`);
				scheduleNextPoll();
				return;
			}
			if (shouldCancelDeferredReconciliation(siteStatus)) {
				cancelDeferredReconciliation(siteId);
				return;
			}
			if (shouldSkipHaltedDisabledReconciliation(site, siteStatus, pending.options)) {
				cancelDeferredReconciliation(siteId);
				return;
			}

			if (shouldReconcileManagedFiles(siteStatus)) {
				let server: RuntimeServer;
				try {
					const detected = detectSiteServer(site);
					server = detected.kind === 'unsupported'
						? { ...detected, service: null }
						: resolveServer(site);
				} catch (error) {
					pending.stableSamples = 0;
					logger.log('warn', `Unable to identify the web server for site ${siteId}: ${errorMessage(error)}`);
					scheduleNextPoll();
					return;
				}
				if (server.kind === 'unsupported') {
					cancelDeferredReconciliation(siteId);
					return;
				}
				try {
					pending.stableSamples = server.service && serverManagedFilesystemReady(
						site,
						server.kind,
						managedFileOptions(server),
					)
						? pending.stableSamples + 1
						: 0;
				} catch (error) {
					if (
						isExpectedLifecycleFilesystemAbsence(error) ||
						isExpectedLifecycleInterruption(siteId, error)
					) {
						pending.stableSamples = 0;
						logger.log('info', `Media Proxy paths for site ${siteId} changed during deferred reconciliation; retrying after Local stabilizes.`);
						scheduleNextPoll();
						return;
					}
					cancelDeferredReconciliation(siteId);
					logger.log('warn', `Unsafe Media Proxy paths for site ${siteId}: ${errorMessage(error)}`);
					return;
				}
				if (pending.stableSamples >= DEFERRED_RECONCILIATION_STABLE_SAMPLES) {
					const reconcileOptions = { ...pending.options };
					const reconcileRevision = pending.revision;
					pending.stableSamples = 0;
					void reconcileSite(siteId, reconcileOptions).then((converged) => {
						if (deferredReconciliations.get(siteId) !== pending) {
							return;
						}
						if (!converged) {
							pending.options.refreshMatchingEnabledRuntime = true;
							scheduleNextPoll();
						} else if (pending.revision === reconcileRevision) {
							cancelDeferredReconciliation(siteId);
						} else {
							scheduleNextPoll();
						}
					}).catch((error) => {
						if (deferredReconciliations.get(siteId) !== pending) {
							return;
						}
						if (isExpectedLifecycleInterruption(siteId, error)) {
							logger.log(
								'info',
								`Paused Media Proxy reconciliation for site ${siteId} because Local changed or removed the site during a guarded read.`,
							);
						} else {
							logger.log('warn', `Unable to reconcile site ${siteId}: ${errorMessage(error)}`);
						}
						pending.options.refreshMatchingEnabledRuntime = true;
						scheduleNextPoll();
					});
					return;
				}
			} else {
				pending.stableSamples = 0;
			}

			scheduleNextPoll();
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
		server: RuntimeServer,
	): boolean => {
		if (server.kind === 'apache' || server.kind === 'nginx') {
			return serverManagedFilesystemReady(
				site,
				server.kind,
				server.service ? managedFileOptions(server) : undefined,
			);
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
		let server: RuntimeServer;
		try {
			detectedServer = detectSiteServer(site);
			try {
				server = resolveServer(site);
			} catch {
				server = { ...detectedServer, service: null };
			}
			if (!globalCleanupFilesystemReady(site, server)) {
				return false;
			}
		} catch (error) {
			logger.log(
				isExpectedLifecycleInterruption(site.id, error) ? 'info' : 'warn',
				`Deferred synchronous Media Proxy ${mode === 'uninstalling' ? 'uninstall' : 'disable'} cleanup for ready site ${site.id} because its managed paths were unavailable: ${errorMessage(error)}`,
			);
			return false;
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
				let currentServer: RuntimeServer;
				try {
					currentServer = resolveServer(currentSite);
				} catch {
					currentServer = { ...currentDetectedServer, service: null };
				}
				if (!globalCleanupFilesystemReady(currentSite, currentServer)) {
					return null;
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

		let forceRefresh = true;
		try {
			assertSynchronousGlobalCleanupCurrent();
			const envelopeBeforeCleanup = readStoredSettingsEnvelope(site, server.kind);
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
				server.kind === 'unsupported' ? undefined : managedFileOptions(server),
			) || forceRefresh;
			assertSynchronousGlobalCleanupCurrent();
		} catch (error) {
			forceRefresh = true;
			logger.log(
				isExpectedLifecycleInterruption(site.id, error) ? 'info' : 'warn',
				`Synchronous Media Proxy global cleanup for site ${site.id} was incomplete; deferred cleanup will retry. ${errorMessage(error)}`,
			);
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
		if (!globalCleanupFilesystemReady(site, server)) {
			throw new ServerTransactionChangedError();
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
				let currentServer: RuntimeServer;
				try {
					currentServer = resolveServer(currentSite);
				} catch {
					currentServer = { ...currentDetectedServer, service: null };
				}
				if (!globalCleanupFilesystemReady(currentSite, currentServer)) {
					return null;
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
				server.kind === 'unsupported' ? undefined : managedFileOptions(server),
			);
		};
		const guardedCompileAllConfigs = async (): Promise<void> => {
			assertGlobalCleanupTransactionCurrent();
			await configTemplates.compileServiceConfigs(site);
			assertGlobalCleanupTransactionCurrent();
		};

		let enabledBeforeCleanup = true;
		try {
			const envelopeBeforeCleanup = readStoredSettingsEnvelope(site, server.kind);
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

		const compiledConfigIsClean = server.kind !== 'unsupported' && server.service
			? await serverCompiledConfigMatches(
				site,
				server,
				false,
				assertGlobalCleanupTransactionCurrent,
			)
			: false;
		const requiresRuntimeRefresh = forceRefresh || enabledBeforeCleanup || !compiledConfigIsClean;
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
					server.kind === 'unsupported' ? undefined : managedFileOptions(server),
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
				managedFileOptions(server),
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
					const detected = detectSiteServer(site);
					let server: RuntimeServer;
					try {
						server = resolveServer(site);
					} catch {
						server = { ...detected, service: null };
					}
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
				skipHaltedDisabledProfile: true,
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
			const runtimeServer = detectedServer.kind === 'unsupported'
				? { ...detectedServer, service: null }
				: resolveServer(site);
			if (
				detectedServer.kind !== 'unsupported' &&
				runtimeServer.service &&
				!serverManagedFilesystemReady(
					site,
					detectedServer.kind,
					managedFileOptions(runtimeServer),
				)
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
			configuredOnly: true,
			refreshMatchingEnabledRuntime: false,
			skipHaltedDisabledProfile: true,
		});
	}
}
