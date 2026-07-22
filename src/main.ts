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
	synchronousCleanupRequiresRefresh,
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
	serverManagedFilesMatch,
} from './site-config';
import { detectSiteServer, type SiteServerAdapter } from './server';
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

function readStoredSettings(site: Local.Site): StoredSettings {
	return normalizeStoredSettings((site as SiteWithSettings)[SITE_SETTINGS_KEY]);
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

	const compileAndReload = async (
		site: Local.Site,
		server: RuntimeServer,
		expectManaged: boolean,
	): Promise<boolean> => {
		if (!server.serviceName || server.kind === 'unsupported' || !server.service) {
			throw new Error(server.reason || 'Local could not load the web-server service for this site.');
		}
		const serviceName = server.serviceName;
		if (server.kind === 'apache') {
			const processName = 'httpd';
			return refreshApacheService(
				site,
				server.service,
				configTemplates,
				LocalMain.execFilePromise,
				expectManaged,
				() => siteProcessManager.getSiteStatus(site) === 'running',
				() => siteProcessManager.hasRunningProcess(site, processName),
			);
		}

		await configTemplates.compileServiceConfigs(site);
		if (siteProcessManager.getSiteStatus(site) === 'running') {
			const reloadResult = await reloadNginxWithFallback(
				server.service,
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
		previousSettings: StoredSettings,
		snapshots: Awaited<ReturnType<typeof captureAllManagedFiles>>,
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

		if (server.serviceName && server.kind !== 'unsupported') {
			try {
				await compileAndReload(
					site,
					server,
					server.kind === 'apache'
						? apacheSnapshotHasCompleteManagedConfig(site, snapshots)
						: previousSettings.enabled,
				);
			} catch (error) {
				rollbackErrors.push(`${server.kind} restore: ${errorMessage(error)}`);
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
		server: RuntimeServer,
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
			await removeAllManagedFiles(site);
		} catch (error) {
			cleanupErrors.push(`files: ${errorMessage(error)}`);
		}

		if (server.serviceName && server.kind !== 'unsupported') {
			try {
				await compileAndReload(site, server, false);
			} catch (error) {
				cleanupErrors.push(`${server.kind} cleanup: ${errorMessage(error)}`);
			}
		}

		const suffix = cleanupErrors.length > 0
			? ` Cleanup also failed (${cleanupErrors.join('; ')}).`
			: '';
		throw new Error(`${errorMessage(originalError)}${suffix}`);
	};

	const getSiteState = async (siteId: string): Promise<SiteState> => {
		const site = requireSite(siteId);
		const server = resolveServer(site);
		const settings = readStoredSettings(site);
		const managedArtifactsPresent = await allManagedArtifactsExist(site);
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
		const configuredForHttps = (() => {
			try {
				return validateAndNormalizeOrigin(settings, {
					requiresOriginIp: server.requiresOriginIp,
				}).protocol === 'https:';
			} catch {
				return false;
			}
		})();
		const apacheCapabilityUnavailable = server.kind === 'apache' && (
			!apacheCapabilities?.http || (configuredForHttps && !apacheCapabilities.https)
		);
		const needsAttention = (
			runtimeUnavailable && (settings.enabled || managedArtifactsPresent)
		) || Boolean(settings.enabled && apacheCapabilityUnavailable);
		let applied = false;

		if (server.kind !== 'unsupported' && server.service) {
			if (settings.enabled) {
				try {
					if (
						server.kind === 'nginx' &&
						settings.originSource === 'wpengine' &&
						(
							!settings.originWpEngineInstallId ||
							!settings.originWpEngineSiteId ||
							getWpEngineConnectionSiteId(site) !== settings.originWpEngineSiteId
						)
					) {
						throw new Error('The saved WP Engine origin no longer matches this Local site connection.');
					}
					const origin = validateAndNormalizeOrigin(settings, {
						requiresOriginIp: server.requiresOriginIp,
					});
					const trustBundle = origin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					applied = await serverManagedFilesMatch(
						site,
						origin,
						managedFileOptions(server),
						trustBundle,
					);
				} catch {
					applied = false;
				}
			} else {
				applied = managedArtifactsPresent;
			}
		}

		return {
			applied,
			cleanupSupported: server.kind !== 'unsupported' && Boolean(server.service),
			httpsUnavailableReason: apacheCapabilities?.http && !apacheCapabilities.https
				? apacheCapabilities.reason
				: undefined,
			needsAttention,
			reason: needsAttention
				? runtimeUnavailable
					? runtimeCleanupUnavailableReason(server)
					: apacheCapabilities?.reason || capabilityInspectionReason
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
			siteStatus: siteProcessManager.getSiteStatus(site),
			supported: server.kind !== 'unsupported' && Boolean(server.service) && (
				server.kind !== 'apache' || apacheCapabilities?.http === true
			),
			supportsHttpsOrigin: server.kind !== 'apache' || apacheCapabilities?.https === true,
		};
	};

	const applySettings = async (
		siteId: string,
		input: unknown,
	): Promise<SiteState> => withSiteLock(siteId, async () => {
		assertGloballyActive();
		const site = requireSite(siteId);
		const server = resolveServer(site);
		const normalizedInput = validateSettingsInput(input, {
			requiresOriginIp: server.requiresOriginIp,
		});

		const previousSettings = readStoredSettings(site);
		let nextSettings: StoredSettings;

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
			assertGloballyActive();
			const snapshots = await captureAllManagedFiles(site);
			assertGloballyActive();
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

			try {
				persistSettings(siteId, nextSettings);
				await applyServerManagedFiles(
					site,
					verifiedOrigin,
					managedFileOptions(server),
					probe.trustedCertificateAuthoritiesPem,
				);
				assertGloballyActive();
				const restarted = await compileAndReload(site, server, true);
				assertGloballyActive();
				logger.log('info', `Enabled media proxy for site ${siteId}${restarted ? ` and refreshed ${server.kind}` : ''}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, server, previousSettings, error);
				}
				return rollbackTransaction(
					site,
					server,
					previousSettings,
					snapshots,
					error,
				);
			}
		} else {
			if (
				(server.kind === 'unsupported' || !server.service) &&
				(previousSettings.enabled || await allManagedArtifactsExist(site))
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
			const snapshots = await captureAllManagedFiles(site);
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
				const changed = await removeAllManagedFiles(site);
				assertGloballyActive();
				if ((changed || previousSettings.enabled) && server.kind !== 'unsupported' && server.service) {
					await compileAndReload(site, server, false);
					assertGloballyActive();
				}
				logger.log('info', `Disabled media proxy for site ${siteId}.`);
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, server, previousSettings, error);
				}
				return rollbackTransaction(
					site,
					server,
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
		const site = requireSite(siteId);
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

	const reconcileSite = async (siteId: string): Promise<void> => {
		await withSiteLock(siteId, async () => {
			if (globalLifecycleState) {
				return;
			}

			const site = siteData.getSite(siteId);
			if (!site) {
				return;
			}

			const server = resolveServer(site);

			const settings = readStoredSettings(site);
			let normalizedOrigin: ReturnType<typeof validateAndNormalizeOrigin> | undefined;
			if (server.kind === 'unsupported' || !server.service) {
				if (!settings.enabled && !await allManagedArtifactsExist(site)) {
					return;
				}
				throw new Error(runtimeCleanupUnavailableReason(server));
			}
			if (!settings.enabled) {
				if (!await allManagedArtifactsExist(site)) {
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
					const cleanupErrors: string[] = [];
					const retainEnabledIntent = validationError instanceof ApacheCapabilityUnavailableError ||
						shouldRetainWpEngineSettingsAfterVerificationError(validationError);
					if (!retainEnabledIntent) {
						try {
							persistSettings(site.id, { ...settings, enabled: false });
						} catch (error) {
							cleanupErrors.push(`settings: ${errorMessage(error)}`);
						}
					}

					let changed = false;
					try {
						changed = await removeAllManagedFiles(site);
					} catch (error) {
						cleanupErrors.push(`files: ${errorMessage(error)}`);
					}

					if (cleanupRequiresRefresh(changed, settings.enabled)) {
						try {
							await compileAndReload(site, server, false);
						} catch (error) {
							cleanupErrors.push(`${server.kind} cleanup: ${errorMessage(error)}`);
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

				if (await serverManagedFilesMatch(
					site,
					normalizedOrigin,
					managedFileOptions(server),
					trustBundle,
				)) {
					return;
				}
			}

			const snapshots = await captureAllManagedFiles(site);
			try {
				assertGloballyActive();
				let changed: boolean;
				if (settings.enabled) {
					const origin = normalizedOrigin ?? validateAndNormalizeOrigin(settings, {
						requiresOriginIp: server.requiresOriginIp,
					});
					const trustBundle = origin.protocol === 'https:'
						? trustedCertificateAuthoritiesPem()
						: undefined;
					changed = await applyServerManagedFiles(
						site,
						origin,
						managedFileOptions(server),
						trustBundle,
					);
				} else {
					changed = await removeAllManagedFiles(site);
				}
				assertGloballyActive();

				if (changed) {
					await compileAndReload(site, server, settings.enabled);
					assertGloballyActive();
				}
			} catch (error) {
				if (globalLifecycleState) {
					return abortForGlobalLifecycle(site, server, settings, error);
				}
				return rollbackTransaction(
					site,
					server,
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
			let server: RuntimeServer | null = null;
			try {
				server = resolveServer(site);
			} catch (error) {
				logger.log('warn', `Could not resolve the site service during global cleanup for site ${site.id}; using fail-closed persistent cleanup. ${errorMessage(error)}`);
			}
			const settingsBeforeCleanup = readStoredSettings(site);
			if (uninstalling) {
				try {
					persistSettings(site.id, { ...settingsBeforeCleanup, enabled: false });
				} catch (error) {
					logger.log('warn', `Initial uninstall intent update failed for site ${site.id}; async cleanup will retry. ${errorMessage(error)}`);
				}
			}
			const changedSynchronously = synchronousCleanupRequiresRefresh(
				() => removeAllManagedFilesSync(site),
				(error) => logger.log('warn', `Synchronous global cleanup failed for site ${site.id}; async cleanup will retry and force a runtime refresh. ${errorMessage(error)}`),
			);

			cleanups.push(withSiteLock(site.id, async () => {
				const errors: string[] = [];
				try {
					if (!server || server.kind === 'unsupported' || !server.service) {
						const result = await completeUnresolvedServiceCleanup({
							compileAllConfigs: () => configTemplates.compileServiceConfigs(site),
							hasManagedArtifacts: () => allManagedArtifactsExist(site),
							isSiteRunning: () => siteProcessManager.getSiteStatus(site) === 'running',
							removeAllManagedFiles: () => removeAllManagedFiles(site),
						}, changedSynchronously || settingsBeforeCleanup.enabled);
						logger.log('warn', `Completed fail-closed persistent cleanup for site ${site.id} without a hard restart${result.changed ? '' : '; no managed files required removal'}.`);
					} else {
						const changedAfterPendingOperations = await removeAllManagedFiles(site);
						if (changedSynchronously || changedAfterPendingOperations || settingsBeforeCleanup.enabled) {
							await compileAndReload(site, server, false);
						}
					}
				} catch (error) {
					errors.push(`runtime cleanup: ${errorMessage(error)}`);
				}
				if (uninstalling) {
					try {
						persistSettings(site.id, {
							...readStoredSettings(site),
							enabled: false,
						});
					} catch (error) {
						errors.push(`disabled intent: ${errorMessage(error)}`);
					}
				}
				if (errors.length > 0) {
					throw new Error(errors.join('; '));
				}
			}));
		}

		void Promise.allSettled(cleanups).then((results) => {
			const failures = results.flatMap((result, index) => (
				result.status === 'rejected'
					? [`cleanup ${index + 1}: ${errorMessage(result.reason)}`]
					: []
			));
			if (failures.length > 0) {
				logger.log('error', `Global ${uninstalling ? 'uninstall' : 'disable'} cleanup incomplete; stop affected sites before retrying. ${failures.join('; ')}`);
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
			const site = requireSite(siteId);
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
		async (_event, siteId: string, input: unknown) => {
			try {
				return await applySettings(siteId, input);
			} catch (error) {
				logger.log('error', `Unable to apply settings for site ${siteId}: ${errorLogMessage(error)}`);
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
