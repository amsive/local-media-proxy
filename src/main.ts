/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
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
	originResponseOutcome,
	probeOrigin,
	trustedCertificateAuthoritiesPem,
} from './origin';
import {
	applyManagedFiles,
	captureManagedFiles,
	managedArtifactsExist,
	managedFilesMatch,
	removeManagedFiles,
	removeManagedFilesSync,
	restoreManagedFiles,
} from './site-config';
import {
	normalizeStoredSettings,
	originPairMatches,
	serializeStoredSettings,
} from './settings';
import type {
	OriginDiscoveryRequest,
	OriginSuggestion,
	PublicOriginProbeResult,
	SettingsInput,
	SiteState,
	StoredSettings,
} from './types';
import {
	sanitizeDisabledSettings,
	validateAndNormalizeOrigin,
	validateSettingsInput,
} from './validation';

type SiteWithSettings = Local.Site & {
	[SITE_SETTINGS_KEY]?: unknown;
};

const siteOperationQueues = new Map<string, Promise<void>>();
const LIFECYCLE_LISTENERS_KEY = Symbol.for('amsive.local-media-proxy.lifecycle-listeners');

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorLogMessage(error: unknown): string {
	if (error instanceof Error && error.cause !== undefined) {
		return `${error.message} Cause: ${errorMessage(error.cause)}`;
	}

	return errorMessage(error);
}

function readStoredSettings(site: Local.Site): StoredSettings {
	return normalizeStoredSettings((site as SiteWithSettings)[SITE_SETTINGS_KEY]);
}

function getNginxServiceName(site: Local.Site): string | null {
	for (const [serviceName, service] of Object.entries(site.services ?? {})) {
		const normalizedName = `${serviceName} ${(service as { name?: string }).name ?? ''}`.toLowerCase();
		if (normalizedName.includes('nginx')) {
			return serviceName;
		}
	}

	return null;
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
	let globalLifecycleState: 'disabled' | 'uninstalling' | null = null;

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

	const requireSite = (siteId: string): Local.Site => {
		requireSiteId(siteId);

		const site = siteData.getSite(siteId);
		if (!site) {
			throw new Error('The selected Local site no longer exists.');
		}

		return site;
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

	const persistSettings = (siteId: string, settings: StoredSettings): void => {
		siteData.updateSite(siteId, {
			id: siteId,
			[SITE_SETTINGS_KEY]: serializeStoredSettings(settings),
		} as unknown as Partial<Local.SiteJSON>);
	};

	const compileAndReload = async (site: Local.Site, serviceName: string): Promise<boolean> => {
		await configTemplates.compileServiceConfigs(site);
		if (siteProcessManager.getSiteStatus(site) === 'running') {
			const service = lightningServices.getSiteService(site, serviceName);
			if (!service) {
				throw new Error(`Local could not load the ${serviceName} service for this site.`);
			}

			const reloadResult = await reloadNginxWithFallback(
				service,
				LocalMain.execFilePromise,
				async () => {
					await siteProcessManager.restartSiteService(site, serviceName);
					return siteProcessManager.hasRunningProcess(site, serviceName);
				},
				() => (
					siteProcessManager.getSiteStatus(site) === 'running' &&
					siteProcessManager.hasRunningProcess(site)
				),
			);
			if (reloadResult === 'restarted') {
				logger.log('warn', `Restarted the ${serviceName} service for site ${site.id} after its Nginx master PID became stale.`);
			}
			return true;
		}

		return false;
	};

	const rollbackTransaction = async (
		site: Local.Site,
		serviceName: string | null,
		previousSettings: StoredSettings,
		snapshots: Awaited<ReturnType<typeof captureManagedFiles>>,
		originalError: unknown,
	): Promise<never> => {
		const rollbackErrors: string[] = [];

		try {
			persistSettings(site.id, previousSettings);
		} catch (error) {
			rollbackErrors.push(`settings: ${errorMessage(error)}`);
		}

		try {
			await restoreManagedFiles(snapshots);
		} catch (error) {
			rollbackErrors.push(`files: ${errorMessage(error)}`);
		}

		if (serviceName) {
			try {
				await compileAndReload(site, serviceName);
			} catch (error) {
				rollbackErrors.push(`Nginx reload: ${errorMessage(error)}`);
			}
		}

		if (rollbackErrors.length > 0) {
			const rollbackSummary = rollbackErrors.join('; ');
			logger.log('error', `Rollback failed for site ${site.id}: ${rollbackSummary}`);
			throw new Error(`${errorMessage(originalError)} Rollback also failed (${rollbackSummary}).`);
		}

		throw originalError instanceof Error
			? originalError
			: new Error(errorMessage(originalError));
	};

	const abortForGlobalLifecycle = async (
		site: Local.Site,
		serviceName: string | null,
		previousSettings: StoredSettings,
		originalError: unknown,
	): Promise<never> => {
		const cleanupErrors: string[] = [];
		const restoredSettings = globalLifecycleState === 'uninstalling'
			? { ...previousSettings, enabled: false }
			: previousSettings;

		try {
			persistSettings(site.id, restoredSettings);
		} catch (error) {
			cleanupErrors.push(`settings: ${errorMessage(error)}`);
		}

		try {
			await removeManagedFiles(site);
		} catch (error) {
			cleanupErrors.push(`files: ${errorMessage(error)}`);
		}

		if (serviceName) {
			try {
				await compileAndReload(site, serviceName);
			} catch (error) {
				cleanupErrors.push(`Nginx reload: ${errorMessage(error)}`);
			}
		}

		const suffix = cleanupErrors.length > 0
			? ` Cleanup also failed (${cleanupErrors.join('; ')}).`
			: '';
		throw new Error(`${errorMessage(originalError)}${suffix}`);
	};

	const getSiteState = async (siteId: string): Promise<SiteState> => {
		const site = requireSite(siteId);
		const nginxService = getNginxServiceName(site);
		const settings = readStoredSettings(site);
		let applied = false;

		if (nginxService) {
			if (settings.enabled) {
				try {
					if (
						settings.originSource === 'wpengine' &&
						(
							!settings.originWpEngineInstallId ||
							!settings.originWpEngineSiteId ||
							getWpEngineConnectionSiteId(site) !== settings.originWpEngineSiteId
						)
					) {
						throw new Error('The saved WP Engine origin no longer matches this Local site connection.');
					}
					const origin = validateAndNormalizeOrigin(settings);
					const trustBundle = origin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					applied = await managedFilesMatch(site, origin, trustBundle);
				} catch {
					applied = false;
				}
			} else {
				applied = await managedArtifactsExist(site);
			}
		}

		return {
			applied,
			reason: nginxService
				? undefined
				: 'Local Media Proxy currently supports Nginx sites only.',
			settings,
			siteStatus: siteProcessManager.getSiteStatus(site),
			supported: Boolean(nginxService),
		};
	};

	const applySettings = async (
		siteId: string,
		input: unknown,
	): Promise<SiteState> => withSiteLock(siteId, async () => {
		assertGloballyActive();
		const normalizedInput = validateSettingsInput(input);
		const site = requireSite(siteId);
		const nginxService = getNginxServiceName(site);

		const previousSettings = readStoredSettings(site);
		let nextSettings: StoredSettings;

		if (normalizedInput.enabled) {
			const authoritativeWpEngine = await assertAuthoritativeWpEngineIdentity(site, normalizedInput);
			if (!nginxService) {
				throw new Error('Local Media Proxy currently supports Nginx sites only.');
			}

			const origin = validateAndNormalizeOrigin(normalizedInput);
			const probe = await probeOrigin(origin);
			const verifiedOrigin = {
				...origin,
				tlsHostname: probe.verifiedTlsHostname ?? origin.tlsHostname,
			};
			assertGloballyActive();
			const snapshots = await captureManagedFiles(site);
			assertGloballyActive();
			nextSettings = {
				certificate: probe.certificate,
				enabled: true,
				lastOriginStatus: probe.statusCode,
				lastVerifiedAt: new Date().toISOString(),
				originEnvironment: normalizedInput.originEnvironment,
				originIp: verifiedOrigin.originIp,
				originSource: normalizedInput.originSource ?? 'manual',
				originTlsHostname: verifiedOrigin.tlsHostname === verifiedOrigin.hostname
					? undefined
					: verifiedOrigin.tlsHostname,
				originWpEngineInstallId: authoritativeWpEngine?.wpEngineInstallId,
				originWpEngineSiteId: authoritativeWpEngine?.wpEngineSiteId,
				resolvedAt: normalizedInput.resolvedAt,
				siteUrl: verifiedOrigin.siteUrl,
			};

			try {
				persistSettings(siteId, nextSettings);
				await applyManagedFiles(
					site,
					verifiedOrigin,
					probe.trustedCertificateAuthoritiesPem,
				);
				assertGloballyActive();
				const restarted = await compileAndReload(site, nginxService);
				assertGloballyActive();
				logger.log('info', `Enabled media proxy for site ${siteId}${restarted ? ' and reloaded Nginx' : ''}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, nginxService, previousSettings, error);
				}
				return rollbackTransaction(
					site,
					nginxService,
					previousSettings,
					snapshots,
					error,
				);
			}
		} else {
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
			const snapshots = await captureManagedFiles(site);
			assertGloballyActive();
			nextSettings = {
				...disabled,
				certificate: preserveVerification ? previousSettings.certificate : undefined,
				lastOriginStatus: preserveVerification ? previousSettings.lastOriginStatus : undefined,
				lastVerifiedAt: preserveVerification ? previousSettings.lastVerifiedAt : undefined,
				originWpEngineInstallId,
				originWpEngineSiteId,
			};

			try {
				persistSettings(siteId, nextSettings);
				const changed = await removeManagedFiles(site);
				assertGloballyActive();
				if (changed && nginxService) {
					await compileAndReload(site, nginxService);
					assertGloballyActive();
				}
				logger.log('info', `Disabled media proxy for site ${siteId}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, nginxService, previousSettings, error);
				}
				return rollbackTransaction(
					site,
					nginxService,
					previousSettings,
					snapshots,
					error,
				);
			}
		}

		return getSiteState(siteId);
	});

	const discoverOrigin = async (
		siteId: string,
		request: OriginDiscoveryRequest,
	): Promise<OriginSuggestion> => {
		const site = requireSite(siteId);
		if (!request || typeof request !== 'object') {
			throw new Error('A valid origin discovery request is required.');
		}

		if (request.mode === 'wpengine') {
			return discoverWpEngineOrigin(
				site,
				request.environment,
				wpEngineCapi,
			);
		}

		if (request.mode === 'dns') {
			return discoverDnsOrigin(request.siteUrl);
		}

		throw new Error('The requested origin discovery mode is not supported.');
	};

	const testOrigin = async (
		siteId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<PublicOriginProbeResult> => {
		const normalizedInput = validateSettingsInput(input);
		await assertAuthoritativeWpEngineIdentity(requireSite(siteId), normalizedInput);
		const origin = validateAndNormalizeOrigin(normalizedInput);
		const probe = await probeOrigin(origin, { signal });
		const verifiedTlsHostname = probe.verifiedTlsHostname ?? origin.tlsHostname;
		const security = origin.protocol === 'https:'
			? verifiedTlsHostname === origin.hostname
				? ` Certificate ${probe.certificate?.subject ?? 'identity'} matched ${origin.hostname}.`
				: normalizedInput.originSource === 'wpengine'
					? ` Certificate ${probe.certificate?.subject ?? 'identity'} matched the WP Engine origin ${verifiedTlsHostname}; requests retain Host ${origin.hostHeader}.`
					: ` Certificate ${probe.certificate?.subject ?? 'identity'} matched verified WP Engine infrastructure as ${verifiedTlsHostname}; requests retain Host ${origin.hostHeader}.`
			: ' The connection is unencrypted because the URL uses HTTP.';

		return {
			certificate: probe.certificate,
			message: originResponseOutcome(probe.statusCode) === 'success'
				? `The configured remote endpoint responded with HTTP ${probe.statusCode}.${security} This test checks reachability and, for HTTPS, certificate identity and trust—not a media file. After applying, verify an actual missing upload through the Local site.`
				: `The configured remote endpoint responded with HTTP ${probe.statusCode}, so network reachability was confirmed but media access was not verified.${security} Check the exact remote upload or try another remote IP.`,
			originTlsHostname: verifiedTlsHostname === origin.hostname
				? undefined
				: verifiedTlsHostname,
			outcome: originResponseOutcome(probe.statusCode),
			statusCode: probe.statusCode,
		};
	};

	const reconcileSite = async (siteId: string): Promise<void> => {
		await withSiteLock(siteId, async () => {
			if (globalLifecycleState) {
				return;
			}

			const site = siteData.getSite(siteId);
			if (!site) {
				return;
			}

			const nginxService = getNginxServiceName(site);
			if (!nginxService) {
				return;
			}

			const settings = readStoredSettings(site);
			let normalizedOrigin: ReturnType<typeof validateAndNormalizeOrigin> | undefined;
			if (!settings.enabled) {
				if (!await managedArtifactsExist(site)) {
					return;
				}
			} else {
				try {
					await assertStoredWpEngineConnection(site, settings);
					normalizedOrigin = validateAndNormalizeOrigin(settings);
				} catch (validationError) {
					const cleanupErrors: string[] = [];
					const retainEnabledIntent = shouldRetainWpEngineSettingsAfterVerificationError(validationError);
					if (!retainEnabledIntent) {
						try {
							persistSettings(site.id, { ...settings, enabled: false });
						} catch (error) {
							cleanupErrors.push(`settings: ${errorMessage(error)}`);
						}
					}

					let changed = false;
					try {
						changed = await removeManagedFiles(site);
					} catch (error) {
						cleanupErrors.push(`files: ${errorMessage(error)}`);
					}

					if (changed) {
						try {
							await compileAndReload(site, nginxService);
						} catch (error) {
							cleanupErrors.push(`Nginx reload: ${errorMessage(error)}`);
						}
					}

					const reason = errorMessage(validationError);
					logger.log(
						'warn',
						retainEnabledIntent
							? `Removed unverified media proxy configuration for site ${site.id} while retaining enabled settings for a later retry: ${reason}`
							: `Disabled invalid media proxy settings for site ${site.id}: ${reason}`,
					);
					if (cleanupErrors.length > 0) {
						throw new Error(`${reason} Fail-closed cleanup also failed (${cleanupErrors.join('; ')}).`);
					}
					return;
				}

				const trustBundle = normalizedOrigin.protocol === 'https:'
					? trustedCertificateAuthoritiesPem()
					: undefined;

				if (await managedFilesMatch(site, normalizedOrigin, trustBundle)) {
					return;
				}
			}

			const snapshots = await captureManagedFiles(site);
			try {
				assertGloballyActive();
				let changed: boolean;
				if (settings.enabled) {
					const origin = normalizedOrigin ?? validateAndNormalizeOrigin(settings);
					const trustBundle = origin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					changed = await applyManagedFiles(site, origin, trustBundle);
				} else {
					changed = await removeManagedFiles(site);
				}
				assertGloballyActive();

				if (changed) {
					await compileAndReload(site, nginxService);
					assertGloballyActive();
				}
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, nginxService, settings, error);
				}
				return rollbackTransaction(
					site,
					nginxService,
					settings,
					snapshots,
					error,
				);
			}
		});
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
		globalLifecycleState = uninstalling ? 'uninstalling' : 'disabled';
		for (const controller of originProbeControllers.values()) {
			controller.abort();
		}
		originProbeControllers.clear();

		const cleanups: Promise<unknown>[] = [];
		for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
			const nginxService = getNginxServiceName(site);

			try {
				const changedSynchronously = removeManagedFilesSync(site);
				if (uninstalling) {
					persistSettings(site.id, {
						...readStoredSettings(site),
						enabled: false,
					});
				}

				cleanups.push(withSiteLock(site.id, async () => {
					const changedAfterPendingOperations = await removeManagedFiles(site);
					if (uninstalling) {
						persistSettings(site.id, {
							...readStoredSettings(site),
							enabled: false,
						});
					}
					if ((changedSynchronously || changedAfterPendingOperations) && nginxService) {
						await compileAndReload(site, nginxService);
					}
				}));
			} catch (error) {
				logger.log('error', `Global cleanup failed for site ${site.id}: ${errorMessage(error)}`);
			}
		}

		void Promise.allSettled(cleanups).then((results) => {
			for (const result of results) {
				if (result.status === 'rejected') {
					logger.log('error', `Global cleanup reload failed: ${errorMessage(result.reason)}`);
				}
			}
		});
	};

	const restoreAfterGlobalEnable = (addon: unknown): void => {
		if (!matchesThisAddon(addon)) {
			return;
		}

		globalLifecycleState = null;
		for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
			void reconcileSite(site.id).catch((error) => {
				logger.log('warn', `Re-enable reconciliation failed for site ${site.id}: ${errorMessage(error)}`);
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
			return await getOriginDiscoveryOptions(
				requireSite(siteId),
				wpEngineCapi,
				(error) => logger.log('warn', `WP Engine environment lookup failed: ${errorLogMessage(error)}`),
			);
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
				`Origin test ${controller.signal.aborted ? 'stopped' : 'failed'}: ${errorMessage(error)}`,
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
		async (_event, siteId: string, input: unknown) => {
			try {
				return await applySettings(siteId, input);
			} catch (error) {
				logger.log('error', `Unable to apply settings for site ${siteId}: ${errorMessage(error)}`);
				throw new Error(errorMessage(error));
			}
		},
	);

	LocalMain.HooksMain.addAction('siteStarted', (siteOrId: Local.Site | string) => {
		const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId?.id;
		if (!siteId) {
			return Promise.resolve();
		}

		return reconcileSite(siteId).catch((error) => {
			logger.log('warn', `Unable to reconcile site ${siteId}: ${errorMessage(error)}`);
		});
	});

	for (const site of Object.values(siteData.getSites()) as Local.Site[]) {
		void reconcileSite(site.id).catch((error) => {
			logger.log('warn', `Startup reconciliation failed for site ${site.id}: ${errorMessage(error)}`);
		});
	}
}
