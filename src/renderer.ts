/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ADDON_ID, ADDON_NAME, IPC_CHANNELS } from './constants';
import {
	lifecycleUnavailableReason,
	shouldReconcileManagedFiles,
} from './lifecycle';
import {
	installMarketplaceMetadataShim,
	type MarketplaceFetchHost,
} from './marketplace';
import type {
	HostingEnvironment,
	OriginAddressCandidate,
	OriginDiscoveryOptions,
	OriginSource,
	OriginSuggestion,
	PublicOriginProbeResult,
	SettingsInput,
	ServerKind,
	SiteState,
	StoredSettings,
} from './types';
import {
	siteUrlComparisonKey,
	siteUrlsAreEquivalent,
	validateAndNormalizeSiteUrl,
} from './validation';

export const IPC_READ_DEADLINE_MS = 15_000;
export const IPC_DISCOVERY_DEADLINE_MS = 30_000;
export const IPC_MUTATION_DEADLINE_MS = 90_000;
export const PASSIVE_STATE_REFRESH_DELAY_MS = 1_000;
export const PASSIVE_STATE_REFRESH_MAX_ATTEMPTS = 3;

const IPC_DEADLINE_ERROR_NAME = 'LocalMediaProxyIpcDeadlineError';
const OVERVIEW_STATE_TIMEOUT_MESSAGE = 'Media Proxy status could not be confirmed within 15 seconds. Its status is unconfirmed.';
const TOOLS_STATE_TIMEOUT_MESSAGE = 'Media Proxy settings could not be confirmed within 15 seconds. Their current state is unconfirmed.';
const DISCOVERY_OPTIONS_TIMEOUT_MESSAGE = 'Local hosting connection details could not be confirmed within 15 seconds.';
const ORIGIN_DISCOVERY_TIMEOUT_MESSAGE = 'Origin discovery did not finish within 30 seconds. Try again, or enter the connection details manually.';
const TOGGLE_TIMEOUT_MESSAGE = 'The Media Proxy status change did not finish within 90 seconds. Its outcome is unconfirmed. Reopen this view to refresh the status before trying again.';
const APPLY_TIMEOUT_MESSAGE = 'Save & apply did not finish within 90 seconds. Its outcome is unconfirmed. Reopen Media Proxy to refresh the settings before trying again.';
const RECOVERY_TIMEOUT_MESSAGE = 'Media Proxy status recovery could not be confirmed within 15 seconds.';

export function withIpcDeadline<T>(
	operation: Promise<T>,
	deadlineMs: number,
	timeoutMessage: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const settle = (): boolean => {
			if (settled) {
				return false;
			}

			settled = true;
			clearTimeout(timer);
			return true;
		};

		timer = setTimeout(() => {
			if (!settle()) {
				return;
			}
			const error = new Error(timeoutMessage);
			error.name = IPC_DEADLINE_ERROR_NAME;
			reject(error);
		}, deadlineMs);

		operation.then(
			(value) => {
				if (settle()) {
					resolve(value);
				}
			},
			(error: unknown) => {
				if (settle()) {
					reject(error);
				}
			},
		);
	});
}

export function isIpcDeadlineError(error: unknown): boolean {
	return error instanceof Error && error.name === IPC_DEADLINE_ERROR_NAME;
}

interface FocusTargetLike {
	disabled?: boolean;
	focus?: () => void;
	isConnected?: boolean;
}

interface FocusDocumentLike {
	activeElement?: unknown;
	body?: unknown;
}

interface PendingFocusHandoff {
	identity: string;
	initiator: FocusTargetLike | null;
	kind: 'save' | 'toggle';
}

export function handoffFocusAfterRemovedControl(
	documentLike: FocusDocumentLike | undefined,
	initiator: FocusTargetLike | null,
	preferredTarget: FocusTargetLike | null,
	fallbackTarget: FocusTargetLike | null,
): boolean {
	if (!documentLike) {
		return false;
	}

	const activeElement = documentLike.activeElement;
	if (
		activeElement &&
		activeElement !== documentLike.body &&
		activeElement !== initiator
	) {
		return false;
	}

	for (const target of [preferredTarget, fallbackTarget]) {
		if (
			!target ||
			target.disabled === true ||
			target.isConnected === false ||
			typeof target.focus !== 'function'
		) {
			continue;
		}

		target.focus();
		return true;
	}

	return false;
}

interface RendererContext {
	React: any;
	electron: {
		ipcRenderer: {
			invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
		};
	};
	hooks: {
		addContent: <Args extends unknown[]>(
			hook: string,
			callback: (...args: Args) => unknown,
			priority?: number,
		) => void;
		addFilter: (
			hook: string,
			callback: (
				items: unknown[],
				context?: SiteInfoToolsFilterContext,
			) => unknown[],
		) => void;
	};
}

interface RendererSite {
	id: string;
	name?: string;
	services?: Record<string, unknown>;
	webServer?: unknown;
}

interface SiteProps {
	site: RendererSite;
}

interface ProxyStatusRowProps extends SiteProps {
	siteStatus: string;
}

interface SiteInfoToolsFilterContext {
	routeChildrenProps?: Partial<ProxyStatusRowProps>;
}

interface Notice {
	message: string;
	variant: 'error' | 'neutral' | 'success' | 'warning';
}

interface LoadingIndicatorProps {
	className?: string;
}

interface OverviewSiteStateSnapshot {
	identity: string;
	value: SiteState | null;
}

function fingerprintValue(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: '';
}

export function siteServerFingerprint(site: RendererSite): string {
	const services = Object.entries(site.services ?? {})
		.map(([serviceKey, rawService]) => {
			const service = rawService && typeof rawService === 'object'
				? rawService as Record<string, unknown>
				: {};
			return [
				serviceKey,
				fingerprintValue(service.id),
				fingerprintValue(service.name),
				fingerprintValue(service.role),
				fingerprintValue(service.version),
			];
		})
		.sort((left, right) => left[0].localeCompare(right[0]));
	return JSON.stringify([fingerprintValue(site.webServer), services]);
}

export interface SiteStatusPresentation {
	className: string;
	label: string;
}

export function proxyPrivacySummary(serverKind: ServerKind): string {
	return serverKind === 'apache'
		? 'Only GET and HEAD are allowed; request bodies and standard browser, credential, nonce, CSRF, tracing, and client-IP headers are stripped. Missing-asset requests with unknown data-bearing headers fail closed before reaching the origin. Controlled Host and fixed add-on User-Agent headers are used for compatibility.'
		: 'Only GET and HEAD are allowed; incoming visitor headers and request bodies are not forwarded, and a fixed add-on User-Agent is used for compatibility.';
}

export interface OverviewProxyStatusPresentation {
	className: string;
	detail: string;
	label: 'Active' | 'Checking…' | 'Inactive' | 'Needs attention' | 'Unavailable';
}

export function siteStateNeedsPassiveRefresh(siteState: SiteState): boolean {
	const {
		applied,
		canEnable,
		cleanupSupported,
		lifecycleReady,
		needsAttention,
		settings,
	} = siteState;
	return Boolean(lifecycleReady &&
		needsAttention &&
		(
			(
				canEnable &&
				settings.enabled &&
				!applied
			) || (
				!settings.enabled &&
				cleanupSupported &&
				applied
			)
		));
}

export interface EnabledIntentToggleState {
	allowed: boolean;
	nextEnabled: boolean;
	repairingCleanup: boolean;
}

export function enabledIntentToggleState(siteState: SiteState): EnabledIntentToggleState {
	const persistedEnabled = siteState.settings.enabled;
	const repairingCleanup = !persistedEnabled && siteState.applied;
	return {
		allowed: persistedEnabled
			? siteState.cleanupSupported
			: repairingCleanup
				? siteState.cleanupSupported
				: siteState.canEnable,
		nextEnabled: repairingCleanup ? false : !persistedEnabled,
		repairingCleanup,
	};
}

export function overviewProxyStatusPresentation(
	siteState: SiteState | null,
): OverviewProxyStatusPresentation {
	if (!siteState) {
		return {
			className: 'LocalMediaProxy__OverviewStatus--Unavailable',
			detail: 'Proxy status could not be loaded.',
			label: 'Unavailable',
		};
	}

	if (siteState.needsAttention) {
		return {
			className: 'LocalMediaProxy__OverviewStatus--Attention',
			detail: siteState.reason || 'Runtime cleanup requires attention.',
			label: 'Needs attention',
		};
	}

	if (!siteState.supported) {
		return {
			className: 'LocalMediaProxy__OverviewStatus--Unavailable',
			detail: siteState.reason || 'Media proxy is unavailable for this site.',
			label: 'Unavailable',
		};
	}

	if (
		siteState.settings.enabled &&
		siteState.applied &&
		siteState.siteStatus !== 'running'
	) {
		return {
			className: 'LocalMediaProxy__OverviewStatus--Inactive',
			detail: 'Enabled and applied, but the Local site is not running.',
			label: 'Inactive',
		};
	}

	if (siteState.settings.enabled === siteState.applied) {
		return siteState.applied
			? {
				className: 'LocalMediaProxy__OverviewStatus--Active',
				detail: 'Enabled and applied.',
				label: 'Active',
			}
			: {
				className: 'LocalMediaProxy__OverviewStatus--Inactive',
				detail: 'Disabled and not applied.',
				label: 'Inactive',
			};
	}

	return {
		className: 'LocalMediaProxy__OverviewStatus--Attention',
		detail: siteState.settings.enabled
			? 'Enabled, but proxy configuration is not applied.'
			: 'Disabled, but proxy configuration is still applied.',
		label: 'Needs attention',
	};
}

function serverProfileLabel(serverKind: ServerKind): string {
	return serverKind === 'apache'
		? 'Apache'
		: serverKind === 'nginx'
			? 'Nginx'
			: 'current web server';
}

export function overviewProxyStatusGuidance(
	siteState: SiteState | null,
	presentation: OverviewProxyStatusPresentation,
	operationError = '',
): string {
	if (operationError) {
		return `${operationError} Open Tools → Media Proxy to review the current profile and retry.`;
	}
	if (!siteState) {
		return presentation.detail;
	}
	if (
		presentation.label === 'Unavailable' &&
		(!siteState.supported || siteState.serverKind === 'unsupported')
	) {
		return `${presentation.detail} ${siteState.enableUnavailableReason || 'Select a supported web server in Local before configuring Media Proxy.'}`;
	}

	const profileLabel = serverProfileLabel(siteState.serverKind);
	const toggleState = enabledIntentToggleState(siteState);
	if (toggleState.repairingCleanup && siteState.cleanupSupported) {
		return `${presentation.detail} Activate the Off switch to retry cleanup while keeping the saved enabled intent off.`;
	}
	if (siteState.settings.enabled && !siteState.canEnable) {
		const cleanupGuidance = siteState.cleanupSupported
			? ' Turn this off to remove the managed proxy configuration while preserving the saved connection profile.'
			: '';
		return `${presentation.detail} The enabled intent is still on, but the ${profileLabel} connection profile is incomplete. ${siteState.enableUnavailableReason || `Configure and save a valid ${profileLabel} connection profile in Tools → Media Proxy before using this control.`}${cleanupGuidance}`;
	}
	if (siteState.needsAttention) {
		return `${presentation.detail} Open Tools → Media Proxy to review the ${profileLabel} profile and retry.`;
	}
	if (siteState.settings.enabled) {
		return siteState.cleanupSupported
			? `${presentation.detail} Turn this off to remove the managed proxy configuration. The saved ${profileLabel} connection profile will be preserved.`
			: `${presentation.detail} Open Tools → Media Proxy to review cleanup availability.`;
	}
	if (!siteState.canEnable) {
		return `${presentation.detail} ${siteState.enableUnavailableReason || `Configure and save a valid ${profileLabel} connection profile in Tools → Media Proxy before enabling.`}`;
	}

	return `${presentation.detail} Turn this on to apply the saved ${profileLabel} connection profile.`;
}

export function siteStatusPresentation(
	persistedEnabled: boolean,
	isApplied: boolean,
	draftDirty: boolean,
): SiteStatusPresentation {
	const persistedStatus = persistedEnabled
		? isApplied
			? 'Enabled'
			: 'Not applied'
		: isApplied
			? 'Cleanup pending'
			: 'Disabled';

	return {
		className: persistedEnabled && isApplied
			? 'LocalMediaProxy__Status--Enabled'
			: persistedEnabled || isApplied
				? 'LocalMediaProxy__Status--Warning'
				: 'LocalMediaProxy__Status--Disabled',
		label: draftDirty
			? `${persistedStatus} · Unsaved changes`
			: persistedStatus,
	};
}

export function draftOriginKey(
	siteUrl: string,
	originIp: string,
	originTlsHostname?: string,
	originEnvironment?: HostingEnvironment,
	requiresOriginIp = true,
): string {
	return requiresOriginIp
		? `${siteUrlComparisonKey(siteUrl)}\n${originIp.trim()}\n${originTlsHostname?.trim() ?? ''}\n${originEnvironment ?? ''}`
		: siteUrlComparisonKey(siteUrl);
}

export function settingsDraftIsDirty(
	draft: SettingsInput,
	persisted: StoredSettings,
	requiresOriginIp = true,
): boolean {
	return draft.enabled !== persisted.enabled ||
		(requiresOriginIp && draft.originIp !== persisted.originIp) ||
		(requiresOriginIp && draft.originEnvironment !== persisted.originEnvironment) ||
		(requiresOriginIp && (draft.originSource ?? 'manual') !== (persisted.originSource ?? 'manual')) ||
		(requiresOriginIp && (draft.originTlsHostname ?? '') !== (persisted.originTlsHostname ?? '')) ||
		(requiresOriginIp && (draft.resolvedAt ?? '') !== (persisted.resolvedAt ?? '')) ||
		draft.siteUrl !== persisted.siteUrl;
}

export function originCandidateLabel(candidate: OriginAddressCandidate): string {
	const family = candidate.family === 6 ? 'IPv6' : 'IPv4';
	const ttl = candidate.ttl === undefined ? '' : ` · TTL ${candidate.ttl}s`;
	return `${candidate.address} · ${family}${ttl}`;
}

export function originCandidatesRequireSelection(candidates: OriginAddressCandidate[]): boolean {
	return candidates.length > 1 || candidates.some((candidate) => Boolean(candidate.warning));
}

export type OriginDiscoveryLayoutMode = 'manual' | 'pending' | 'wpengine';

export function originDiscoveryLayoutMode(
	options: OriginDiscoveryOptions | null,
): OriginDiscoveryLayoutMode {
	if (!options) {
		return 'pending';
	}

	return options.provider === 'wpengine' && options.canAutoPopulate
		? 'wpengine'
		: 'manual';
}

export function siteUrlIsUsableForDns(siteUrl: string): boolean {
	try {
		validateAndNormalizeSiteUrl(siteUrl);
		return true;
	} catch {
		return false;
	}
}

export function siteUrlUsesHttps(siteUrl: string): boolean {
	try {
		return validateAndNormalizeSiteUrl(siteUrl).protocol === 'https:';
	} catch {
		return false;
	}
}

export function originCapabilityControlState(
	enabled: boolean,
	supportsHttpsOrigin: boolean,
	siteUrl: string,
): { blocksSave: boolean; blocksTest: boolean } {
	const unsupportedHttps = !supportsHttpsOrigin && siteUrlUsesHttps(siteUrl);
	return {
		blocksSave: enabled && unsupportedHttps,
		blocksTest: unsupportedHttps,
	};
}

export function settingsActionAvailability(
	supported: boolean,
	cleanupSupported: boolean,
	enabled: boolean,
	blocksSave: boolean,
): { canSave: boolean; canToggle: boolean } {
	return {
		canSave: (supported && !blocksSave) || (!enabled && cleanupSupported),
		canToggle: supported || (enabled && cleanupSupported),
	};
}

export interface ConnectionTestControlState {
	disabled: boolean;
	label: string;
	showSpinner: boolean;
}

export function connectionTestControlState(
	busy: string,
	supported: boolean,
	fieldsReady: boolean,
): ConnectionTestControlState {
	if (busy === 'testing') {
		return { disabled: false, label: 'Stop test', showSpinner: true };
	}
	if (busy === 'stopping') {
		return { disabled: true, label: 'Stopping…', showSpinner: true };
	}

	return {
		disabled: !supported || Boolean(busy) || !fieldsReady,
		label: 'Test connection',
		showSpinner: false,
	};
}

function cleanIpcError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
		.replace(/^Error:\s*/i, '');
}

function environmentLabel(environment: HostingEnvironment): string {
	return environment.charAt(0).toUpperCase() + environment.slice(1);
}

export default function renderer(context: RendererContext): void {
	const { React, hooks } = context;
	const { ipcRenderer } = context.electron;
	const e = React.createElement;
	const stylesheetPath = path.resolve(__dirname, '../style.css');
	const loadingIndicator = ({ className = '' }: LoadingIndicatorProps = {}) => e(
		'div',
		{
			'aria-hidden': true,
			className: `LocalMediaProxy__LoadingIndicator LocalMediaProxy__LoadingIndicator--Gray${className ? ` ${className}` : ''}`,
		},
		e('div'),
		e('div'),
	);

	installMarketplaceMetadataShim(
		globalThis as unknown as MarketplaceFetchHost,
	);

	const ProxyStatusRow = ({ site, siteStatus }: ProxyStatusRowProps) => {
		const [busy, setBusy] = React.useState(false);
		const [operationError, setOperationError] = React.useState('');
		const [siteStateSnapshot, setSiteStateSnapshot] = React.useState(
			undefined as OverviewSiteStateSnapshot | undefined,
		);
		const [tooltipOpen, setTooltipOpen] = React.useState(false);
		const operationEpoch = React.useRef(0);
		const overviewInfoRef = React.useRef(null as FocusTargetLike | null);
		const overviewSwitchRef = React.useRef(null as FocusTargetLike | null);
		const pendingFocusHandoff = React.useRef(null as PendingFocusHandoff | null);
		const siteEpoch = React.useRef(0);
		const tooltipTimer = React.useRef(undefined as ReturnType<typeof setTimeout> | undefined);
		const serverFingerprint = siteServerFingerprint(site);
		const statusIdentity = JSON.stringify([site.id, siteStatus, serverFingerprint]);
		const lifecycleReady = shouldReconcileManagedFiles(siteStatus);
		const stateMatchesIdentity = siteStateSnapshot?.identity === statusIdentity;
		const siteState = stateMatchesIdentity ? siteStateSnapshot.value : undefined;
		const busyForCurrentIdentity = stateMatchesIdentity && busy;
		const visibleOperationError = stateMatchesIdentity ? operationError : '';

		React.useEffect(() => {
			const epoch = ++siteEpoch.current;
			operationEpoch.current += 1;
			const passiveOperationEpoch = operationEpoch.current;
			let passiveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
			pendingFocusHandoff.current = null;
			setBusy(false);
			setOperationError('');
			setSiteStateSnapshot(undefined);
			setTooltipOpen(false);
			clearTimeout(tooltipTimer.current);
			tooltipTimer.current = undefined;

			if (!lifecycleReady) {
				return () => {
					if (siteEpoch.current === epoch) {
						siteEpoch.current += 1;
					}
				};
			}

			const loadState = (attempt: number): void => {
				if (
					siteEpoch.current !== epoch ||
					operationEpoch.current !== passiveOperationEpoch
				) {
					return;
				}
				void withIpcDeadline(
					ipcRenderer.invoke(IPC_CHANNELS.getSiteState, site.id),
					IPC_READ_DEADLINE_MS,
					OVERVIEW_STATE_TIMEOUT_MESSAGE,
				)
					.then((value: unknown) => {
						if (
							siteEpoch.current !== epoch ||
							operationEpoch.current !== passiveOperationEpoch
						) {
							return;
						}
						const nextState = value as SiteState;
						setSiteStateSnapshot({ identity: statusIdentity, value: nextState });
						if (
							siteStateNeedsPassiveRefresh(nextState) &&
							attempt < PASSIVE_STATE_REFRESH_MAX_ATTEMPTS
						) {
							passiveRefreshTimer = setTimeout(
								() => loadState(attempt + 1),
								PASSIVE_STATE_REFRESH_DELAY_MS,
							);
						}
					})
					.catch((error: unknown) => {
						if (
							siteEpoch.current !== epoch ||
							operationEpoch.current !== passiveOperationEpoch
						) {
							return;
						}
						if (attempt === 0) {
							setSiteStateSnapshot({ identity: statusIdentity, value: null });
							setOperationError(cleanIpcError(error));
							setTooltipOpen(true);
						} else if (attempt < PASSIVE_STATE_REFRESH_MAX_ATTEMPTS) {
							passiveRefreshTimer = setTimeout(
								() => loadState(attempt + 1),
								PASSIVE_STATE_REFRESH_DELAY_MS,
							);
						}
					});
			};
			loadState(0);

			return () => {
				clearTimeout(passiveRefreshTimer);
				clearTimeout(tooltipTimer.current);
				tooltipTimer.current = undefined;
				if (siteEpoch.current === epoch) {
					siteEpoch.current += 1;
				}
			};
		}, [statusIdentity]);

		const presentation: OverviewProxyStatusPresentation = !lifecycleReady
			? {
				className: 'LocalMediaProxy__OverviewStatus--Unavailable',
				detail: lifecycleUnavailableReason(siteStatus),
				label: 'Unavailable',
			}
			: siteState === undefined
			? {
				className: 'LocalMediaProxy__OverviewStatus--Loading',
				detail: 'Loading proxy status.',
				label: 'Checking…',
			}
			: overviewProxyStatusPresentation(siteState);
		const persistedEnabled = siteState?.settings.enabled === true;
		const enabledToggleState = siteState
			? enabledIntentToggleState(siteState)
			: null;
		const canToggle = siteState?.settingsReadOnly !== true &&
			enabledToggleState?.allowed === true;
		const toggleDisabled = busyForCurrentIdentity || !canToggle;
		const labelId = `${ADDON_ID}-overview-label-${site.id}`;
		const tooltipId = `${ADDON_ID}-overview-tooltip-${site.id}`;
		const guidance = overviewProxyStatusGuidance(
			siteState === undefined ? null : siteState,
			presentation,
			visibleOperationError,
		);
		const showProgress = lifecycleReady && (
			siteState === undefined ||
			busyForCurrentIdentity
		);
		const showControls = lifecycleReady && !showProgress;
		const statusAnnouncement = !lifecycleReady
			? lifecycleUnavailableReason(siteStatus)
			: siteState === undefined
			? 'Checking Media Proxy status.'
			: busyForCurrentIdentity
				? 'Toggling Media Proxy status.'
				: `${presentation.label}: ${presentation.detail}`;
		const closeTooltip = (): void => {
			clearTimeout(tooltipTimer.current);
			tooltipTimer.current = undefined;
			setTooltipOpen(false);
		};
		const openTooltip = (): void => {
			clearTimeout(tooltipTimer.current);
			tooltipTimer.current = undefined;
			setTooltipOpen(true);
		};
		const openTooltipAfterDelay = (): void => {
			clearTimeout(tooltipTimer.current);
			tooltipTimer.current = setTimeout(() => {
				tooltipTimer.current = undefined;
				setTooltipOpen(true);
			}, 300);
		};

		React.useEffect(() => {
			const pending = pendingFocusHandoff.current;
			if (!pending) {
				return;
			}
			if (pending.identity !== statusIdentity) {
				pendingFocusHandoff.current = null;
				return;
			}
			if (siteState === undefined || busyForCurrentIdentity) {
				return;
			}

			handoffFocusAfterRemovedControl(
				(globalThis as unknown as { document?: FocusDocumentLike }).document,
				pending.initiator,
				overviewSwitchRef.current,
				overviewInfoRef.current,
			);
			pendingFocusHandoff.current = null;
		}, [busyForCurrentIdentity, siteState, statusIdentity, visibleOperationError]);

		const toggleEnabled = async (initiator: FocusTargetLike | null): Promise<void> => {
			if (!siteState || siteState.serverKind === 'unsupported' || toggleDisabled) {
				return;
			}
			const requestId = ++operationEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			pendingFocusHandoff.current = {
				identity: statusIdentity,
				initiator,
				kind: 'toggle',
			};
			setBusy(true);
			setOperationError('');
			try {
				const nextState = await withIpcDeadline(
					ipcRenderer.invoke(
						IPC_CHANNELS.setEnabled,
						site.id,
						siteState.serverKind,
						enabledIntentToggleState(siteState).nextEnabled,
					) as Promise<SiteState>,
					IPC_MUTATION_DEADLINE_MS,
					TOGGLE_TIMEOUT_MESSAGE,
				);
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setSiteStateSnapshot({ identity: statusIdentity, value: nextState });
				}
			} catch (error) {
				if (
					operationEpoch.current !== requestId ||
					siteEpoch.current !== currentSiteEpoch
				) {
					return;
				}
				const message = cleanIpcError(error);
				setSiteStateSnapshot({ identity: statusIdentity, value: null });
				setOperationError(message);
				setTooltipOpen(true);
				setBusy(false);

				if (!isIpcDeadlineError(error)) {
					void withIpcDeadline(
						ipcRenderer.invoke(
							IPC_CHANNELS.getSiteState,
							site.id,
						) as Promise<SiteState>,
						IPC_READ_DEADLINE_MS,
						RECOVERY_TIMEOUT_MESSAGE,
					)
						.then((currentState) => {
							if (
								operationEpoch.current === requestId &&
								siteEpoch.current === currentSiteEpoch
							) {
								setSiteStateSnapshot({
									identity: statusIdentity,
									value: currentState,
								});
							}
						})
						.catch(() => {
							if (
								operationEpoch.current === requestId &&
								siteEpoch.current === currentSiteEpoch
							) {
								setSiteStateSnapshot({ identity: statusIdentity, value: null });
							}
						});
				}
			} finally {
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setBusy(false);
				}
			}
		};

		return e(
			'li',
			{ className: 'TableListRow LocalMediaProxy LocalMediaProxy--OverviewRow' },
			e('strong', { id: labelId }, 'Media Proxy'),
			e(
				'div',
				null,
				e(
					'div',
					{
						'aria-busy': showProgress,
						className: `LocalMediaProxy__OverviewControls ${presentation.className}`,
					},
					showProgress && loadingIndicator({
						className: 'LocalMediaProxy__LoadingIndicator--Overview',
					}),
					showControls && siteState && e(
						'button',
						{
							'aria-checked': persistedEnabled,
							'aria-labelledby': labelId,
							className: `LocalMediaProxy__OverviewSwitch${persistedEnabled ? ' LocalMediaProxy__OverviewSwitch--Checked' : ''}`,
							disabled: toggleDisabled,
							onClick: (event?: { currentTarget?: FocusTargetLike }) => void toggleEnabled(
								event?.currentTarget ?? overviewSwitchRef.current,
							),
							ref: overviewSwitchRef,
							role: 'switch',
							type: 'button',
						},
						e('span', {
							'aria-hidden': true,
							className: 'LocalMediaProxy__OverviewSwitchLabel',
						}, persistedEnabled ? 'On' : 'Off'),
					),
					showControls && e(
						'span',
						{
							className: 'LocalMediaProxy__OverviewTooltipAnchor',
							onBlur: closeTooltip,
							onFocus: openTooltip,
							onKeyDown: (event: { key: string }) => {
								if (event.key === 'Escape') {
									closeTooltip();
								}
							},
							onMouseEnter: openTooltipAfterDelay,
							onMouseLeave: closeTooltip,
						},
						e(
							'button',
							{
								'aria-describedby': tooltipOpen ? tooltipId : undefined,
								'aria-label': 'Media proxy status details',
								className: 'LocalMediaProxy__OverviewInfoButton',
								ref: overviewInfoRef,
								type: 'button',
							},
							e(
								'svg',
								{
									'aria-hidden': true,
									className: 'LocalMediaProxy__OverviewInfoIcon',
									focusable: 'false',
									height: 18,
									viewBox: '0 0 18 18',
									width: 18,
									xmlns: 'http://www.w3.org/2000/svg',
								},
								e('path', {
									clipRule: 'evenodd',
									d: 'M9 16C12.866 16 16 12.866 16 9C16 5.13401 12.866 2 9 2C5.13403 2 2 5.13401 2 9C2 12.866 5.13403 16 9 16ZM9 18C13.9705 18 18 13.9706 18 9C18 4.02943 13.9705 0 9 0C4.02954 0 0 4.02943 0 9C0 13.9706 4.02954 18 9 18ZM7.875 8C7.32275 8 6.875 8.44772 6.875 9C6.875 9.55228 7.32275 10 7.875 10H8V12.9375C8 13.4898 8.44775 13.9375 9 13.9375C9.55225 13.9375 10 13.4898 10 12.9375V9C10 8.44772 9.55225 8 9 8H7.875ZM9 6.75C9.62134 6.75 10.125 6.24632 10.125 5.625C10.125 5.00368 9.62134 4.5 9 4.5C8.37866 4.5 7.875 5.00368 7.875 5.625C7.875 6.24632 8.37866 6.75 9 6.75Z',
									fillRule: 'evenodd',
								}),
							),
						),
						tooltipOpen && e(
							'span',
							{
								className: 'LocalMediaProxy__OverviewTooltip',
								id: tooltipId,
								role: 'tooltip',
							},
							guidance,
						),
					),
					e('span', {
						'aria-atomic': true,
						'aria-live': 'polite',
						className: 'LocalMediaProxy__VisuallyHidden',
						role: 'status',
					}, statusAnnouncement),
					visibleOperationError && e('span', {
						className: 'LocalMediaProxy__VisuallyHidden',
						role: 'alert',
					}, visibleOperationError),
				),
			),
		);
	};

	const MediaProxyPanel = ({ site, siteStatus = 'running' }: ProxyStatusRowProps) => {
		const [busy, setBusy] = React.useState('');
		const [discoveryLoading, setDiscoveryLoading] = React.useState(false);
		const [discoveryOptions, setDiscoveryOptions] = React.useState(null as OriginDiscoveryOptions | null);
		const [enabled, setEnabled] = React.useState(false);
		const [loadedIdentity, setLoadedIdentity] = React.useState(null as string | null);
		const [notice, setNotice] = React.useState(null as Notice | null);
		const [originEnvironment, setOriginEnvironment] = React.useState(undefined as HostingEnvironment | undefined);
		const [originIp, setOriginIp] = React.useState('');
		const [originSource, setOriginSource] = React.useState('manual' as OriginSource);
		const [originTlsHostname, setOriginTlsHostname] = React.useState(undefined as string | undefined);
		const [resolvedAt, setResolvedAt] = React.useState(undefined as string | undefined);
		const [selectedCandidate, setSelectedCandidate] = React.useState('');
		const [selectedEnvironment, setSelectedEnvironment] = React.useState('' as HostingEnvironment | '');
		const [siteState, setSiteState] = React.useState(null as SiteState | null);
		const [siteUrl, setSiteUrl] = React.useState('');
		const [suggestion, setSuggestion] = React.useState(null as OriginSuggestion | null);
		const [testedDraftKey, setTestedDraftKey] = React.useState(null as string | null);
		const actionFeedbackRef = React.useRef(null as FocusTargetLike | null);
		const siteEpoch = React.useRef(0);
		const discoveryEpoch = React.useRef(0);
		const enableSwitchRef = React.useRef(null as FocusTargetLike | null);
		const operationEpoch = React.useRef(0);
		const activeProbeToken = React.useRef(null as string | null);
		const pendingFocusHandoff = React.useRef(null as PendingFocusHandoff | null);
		const saveButtonRef = React.useRef(null as FocusTargetLike | null);
		const serverFingerprint = siteServerFingerprint(site);
		const panelIdentity = JSON.stringify([site.id, siteStatus, serverFingerprint]);
		const lifecycleReady = shouldReconcileManagedFiles(siteStatus);

		const hydrate = (nextState: SiteState): void => {
			setSiteState(nextState);
			setEnabled(nextState.settings.enabled);
			setOriginEnvironment(nextState.settings.originEnvironment);
			setOriginIp(nextState.settings.originIp);
			setOriginSource(nextState.settings.originSource ?? 'manual');
			setOriginTlsHostname(nextState.settings.originTlsHostname);
			setResolvedAt(nextState.settings.resolvedAt);
			setSiteUrl(nextState.settings.siteUrl);
			setSuggestion(null);
			setSelectedCandidate('');
			setTestedDraftKey(
				nextState.settings.lastVerifiedAt &&
				typeof nextState.settings.lastOriginStatus === 'number' &&
				nextState.settings.lastOriginStatus >= 200 &&
				nextState.settings.lastOriginStatus < 300
				? draftOriginKey(
					nextState.settings.siteUrl,
					nextState.settings.originIp,
						nextState.settings.originTlsHostname,
						nextState.settings.originEnvironment,
						nextState.requiresOriginIp,
				)
				: null,
			);
		};

		React.useEffect(() => {
			const epoch = ++siteEpoch.current;
			let passiveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanUp = (): void => {
				clearTimeout(passiveRefreshTimer);
				if (siteEpoch.current === epoch) {
					const token = activeProbeToken.current;
					if (token) {
						activeProbeToken.current = null;
						void ipcRenderer.invoke(IPC_CHANNELS.cancelOriginTest, site.id, token)
							.catch(() => undefined);
					}
					siteEpoch.current += 1;
					discoveryEpoch.current += 1;
					operationEpoch.current += 1;
				}
			};
			discoveryEpoch.current += 1;
			operationEpoch.current += 1;
			const passiveOperationEpoch = operationEpoch.current;
			pendingFocusHandoff.current = null;
			setBusy('');
			setLoadedIdentity(null);
			setSiteState(null);
			setDiscoveryLoading(lifecycleReady);
			setDiscoveryOptions(null);
			setEnabled(false);
			setNotice(null);
			setOriginEnvironment(undefined);
			setOriginIp('');
			setOriginSource('manual');
			setOriginTlsHostname(undefined);
			setResolvedAt(undefined);
			setSelectedCandidate('');
			setSelectedEnvironment('');
			setSiteUrl('');
			setSuggestion(null);
			setTestedDraftKey(null);

			if (!lifecycleReady) {
				setLoadedIdentity(panelIdentity);
				return cleanUp;
			}

			const schedulePassiveRefresh = (nextState: SiteState, attempt: number): void => {
				if (
					!siteStateNeedsPassiveRefresh(nextState) ||
					attempt >= PASSIVE_STATE_REFRESH_MAX_ATTEMPTS ||
					siteEpoch.current !== epoch ||
					operationEpoch.current !== passiveOperationEpoch
				) {
					return;
				}
				passiveRefreshTimer = setTimeout(() => {
					if (
						siteEpoch.current !== epoch ||
						operationEpoch.current !== passiveOperationEpoch
					) {
						return;
					}
					void withIpcDeadline(
						ipcRenderer.invoke(IPC_CHANNELS.getSiteState, site.id),
						IPC_READ_DEADLINE_MS,
						TOOLS_STATE_TIMEOUT_MESSAGE,
					)
						.then((value: unknown) => {
							if (
								siteEpoch.current !== epoch ||
								operationEpoch.current !== passiveOperationEpoch
							) {
								return;
							}
							const refreshedState = value as SiteState;
							setSiteState(refreshedState);
							schedulePassiveRefresh(refreshedState, attempt + 1);
						})
						.catch(() => {
							if (
								siteEpoch.current === epoch &&
								operationEpoch.current === passiveOperationEpoch
							) {
								schedulePassiveRefresh(nextState, attempt + 1);
							}
						});
				}, PASSIVE_STATE_REFRESH_DELAY_MS);
			};

			withIpcDeadline(
				ipcRenderer.invoke(IPC_CHANNELS.getSiteState, site.id),
				IPC_READ_DEADLINE_MS,
				TOOLS_STATE_TIMEOUT_MESSAGE,
			)
				.then((value: unknown) => {
					if (siteEpoch.current === epoch) {
						const nextState = value as SiteState;
						hydrate(nextState);
						schedulePassiveRefresh(nextState, 0);
					}
				})
				.catch((error: unknown) => {
					if (siteEpoch.current === epoch) {
						setNotice({ message: cleanIpcError(error), variant: 'error' });
					}
				})
				.finally(() => {
					if (siteEpoch.current === epoch) {
						setLoadedIdentity(panelIdentity);
					}
				});

			withIpcDeadline(
				ipcRenderer.invoke(IPC_CHANNELS.getOriginDiscoveryOptions, site.id),
				IPC_READ_DEADLINE_MS,
				DISCOVERY_OPTIONS_TIMEOUT_MESSAGE,
			)
				.then((value: unknown) => {
					if (siteEpoch.current !== epoch) {
						return;
					}

					const options = value as OriginDiscoveryOptions;
					setDiscoveryOptions(options);
					setSelectedEnvironment(options.selectedEnvironment ?? '');
				})
				.catch((error: unknown) => {
					if (siteEpoch.current === epoch) {
						setDiscoveryOptions({
							canAutoPopulate: false,
							environments: [],
							message: `${cleanIpcError(error)} Manual entry remains available.`,
							provider: 'none',
						});
					}
				})
				.finally(() => {
					if (siteEpoch.current === epoch) {
						setDiscoveryLoading(false);
					}
				});

			return cleanUp;
		}, [panelIdentity]);

		const settings = (): SettingsInput => ({
			enabled,
			originEnvironment,
			originIp,
			originSource,
			originTlsHostname,
			resolvedAt,
			siteUrl,
		});

		const clearActionFeedback = (): void => {
			setNotice(null);
		};

		const recoverAuthoritativeSiteState = (
			requestId: number,
			currentSiteEpoch: number,
		): void => {
			void withIpcDeadline(
				ipcRenderer.invoke(
					IPC_CHANNELS.getSiteState,
					site.id,
				) as Promise<SiteState>,
				IPC_READ_DEADLINE_MS,
				RECOVERY_TIMEOUT_MESSAGE,
			)
				.then((currentState) => {
					if (
						operationEpoch.current === requestId &&
						siteEpoch.current === currentSiteEpoch
					) {
						hydrate(currentState);
					}
				})
				.catch(() => {
					if (
						operationEpoch.current === requestId &&
						siteEpoch.current === currentSiteEpoch
					) {
						setSiteState(null);
					}
				});
		};

		const invalidateTest = (): void => {
			setTestedDraftKey(null);
			clearActionFeedback();
		};

		const editSiteUrl = (value: string): void => {
			const preservesOriginIdentity = siteUrlsAreEquivalent(siteUrl, value);
			setSiteUrl(value);
			clearActionFeedback();
			if (preservesOriginIdentity) {
				return;
			}
			setOriginSource('manual');
			setOriginEnvironment(undefined);
			setOriginTlsHostname(undefined);
			setResolvedAt(undefined);
			setSuggestion(null);
			setSelectedCandidate('');
			invalidateTest();
		};

		const editOriginIp = (value: string): void => {
			setOriginIp(value);
			setOriginSource('manual');
			setOriginEnvironment(undefined);
			setOriginTlsHostname(undefined);
			setResolvedAt(undefined);
			setSuggestion(null);
			setSelectedCandidate('');
			invalidateTest();
		};

		const applySuggestion = (nextSuggestion: OriginSuggestion): void => {
			const requiresOriginIp = siteState?.requiresOriginIp !== false;
			const selectionRequired = originCandidatesRequireSelection(nextSuggestion.addresses);
			const soleCandidate = !selectionRequired && nextSuggestion.addresses.length === 1
				? nextSuggestion.addresses[0]
				: undefined;
			setSuggestion(nextSuggestion);
			setSiteUrl(nextSuggestion.siteUrl);
			setOriginIp(requiresOriginIp ? soleCandidate?.address ?? '' : '');
			setSelectedCandidate(requiresOriginIp ? soleCandidate?.address ?? '' : '');
			setOriginSource(nextSuggestion.provider === 'wpengine' ? 'wpengine' : 'dns');
			setOriginEnvironment(nextSuggestion.provider === 'wpengine'
				? nextSuggestion.environment
				: undefined);
			setOriginTlsHostname(requiresOriginIp ? nextSuggestion.originTlsHostname : undefined);
			setResolvedAt(nextSuggestion.resolvedAt);
			setTestedDraftKey(null);
			setNotice({
				message: !requiresOriginIp
					? 'Suggested Site URL populated. Apache will use its hostname for DNS, HTTP Host, TLS SNI, and certificate verification. Test the connection before enabling the proxy.'
					: selectionRequired
					? 'Site URL populated. Select an IP address, then test the connection.'
					: 'Suggested Site URL and remote IP populated. Test the connection before enabling the proxy.',
				variant: 'neutral',
			});
		};

		const discover = async (mode: 'dns' | 'wpengine'): Promise<void> => {
			const requestId = ++discoveryEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			setBusy('discovering');
			setNotice(null);

			try {
				const request = mode === 'wpengine'
					? { environment: selectedEnvironment, mode: 'wpengine' as const }
					: { mode: 'dns' as const, siteUrl };
				const result = await withIpcDeadline(
					ipcRenderer.invoke(
						IPC_CHANNELS.discoverOrigin,
						site.id,
						request,
					) as Promise<OriginSuggestion>,
					IPC_DISCOVERY_DEADLINE_MS,
					ORIGIN_DISCOVERY_TIMEOUT_MESSAGE,
				);
				if (
					discoveryEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					applySuggestion(result);
				}
			} catch (error) {
				if (
					discoveryEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setNotice({ message: cleanIpcError(error), variant: 'error' });
				}
			} finally {
				if (
					discoveryEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setBusy('');
				}
			}
		};

		const chooseCandidate = (address: string): void => {
			setSelectedCandidate(address);
			setOriginIp(address);
			setOriginSource(suggestion?.provider === 'wpengine' ? 'wpengine' : 'dns');
			setResolvedAt(suggestion?.resolvedAt);
			invalidateTest();
		};

		const stopConnectionTest = async (): Promise<void> => {
			const token = activeProbeToken.current;
			if (!token) {
				return;
			}

			const currentSiteEpoch = siteEpoch.current;
			setBusy('stopping');
			setNotice(null);
			try {
				const cancelled = await ipcRenderer.invoke(
					IPC_CHANNELS.cancelOriginTest,
					site.id,
					token,
				) as boolean;
				if (
					siteEpoch.current === currentSiteEpoch &&
					activeProbeToken.current === token &&
					!cancelled
				) {
					setBusy('testing');
				}
			} catch (error) {
				if (
					siteEpoch.current === currentSiteEpoch &&
					activeProbeToken.current === token
				) {
					setBusy('testing');
					setNotice({ message: cleanIpcError(error), variant: 'error' });
				}
			}
		};

		const testConnection = async (): Promise<void> => {
			const requestId = ++operationEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			const token = `${currentSiteEpoch}:${requestId}:${Date.now()}`;
			activeProbeToken.current = token;
			setBusy('testing');
			setNotice(null);
			try {
				const result = await ipcRenderer.invoke(
					IPC_CHANNELS.testOrigin,
					site.id,
					{ ...settings(), enabled: true },
					token,
				) as PublicOriginProbeResult;
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					const verifiedTlsHostname = result.originTlsHostname ?? originTlsHostname;
					if (result.originTlsHostname && result.originTlsHostname !== originTlsHostname) {
						setOriginTlsHostname(result.originTlsHostname);
						if (originSource !== 'wpengine') {
							setOriginSource('manual');
							setOriginEnvironment(undefined);
							setResolvedAt(undefined);
						}
					}
					setTestedDraftKey(result.outcome === 'success'
						? draftOriginKey(
							siteUrl,
							originIp,
							verifiedTlsHostname,
							originEnvironment,
							siteState?.requiresOriginIp !== false,
						)
						: null);
					setNotice({ message: result.message, variant: result.outcome });
				}
			} catch (error) {
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					const message = cleanIpcError(error);
					const stopped = /Connection test stopped\.$/.test(message);
					setTestedDraftKey(null);
					setNotice({
						message: stopped ? 'Connection test stopped.' : message,
						variant: stopped ? 'neutral' : 'error',
					});
				}
			} finally {
				if (activeProbeToken.current === token) {
					activeProbeToken.current = null;
				}
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setBusy('');
				}
			}
		};

		const saveSettings = async (initiator: FocusTargetLike | null): Promise<void> => {
			if (!siteState || siteState.serverKind === 'unsupported') {
				return;
			}
			const requestId = ++operationEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			const expectedServerKind = siteState.serverKind;
			pendingFocusHandoff.current = {
				identity: panelIdentity,
				initiator,
				kind: 'save',
			};
			setBusy('saving');
			setNotice(null);
			try {
				const nextState = await withIpcDeadline(
					ipcRenderer.invoke(
						IPC_CHANNELS.applySettings,
						site.id,
						settings(),
						expectedServerKind,
					) as Promise<SiteState>,
					IPC_MUTATION_DEADLINE_MS,
					APPLY_TIMEOUT_MESSAGE,
				);
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					hydrate(nextState);
					setNotice({
						message: nextState.settings.enabled
							? `Media proxy enabled. ${nextState.serverKind === 'apache' ? 'Apache' : 'Nginx'} now checks local uploads first and fetches only safe missing upload assets from the configured site.`
							: `${nextState.serverKind === 'apache' ? 'Apache' : 'Nginx'} connection profile saved. The media proxy remains disabled.`,
						variant: 'success',
					});
				}
			} catch (error) {
				const message = cleanIpcError(error);
				if (
					operationEpoch.current !== requestId ||
					siteEpoch.current !== currentSiteEpoch
				) {
					return;
				}
				setSiteState(null);
				setNotice({ message, variant: 'error' });
				setBusy('');

				if (!isIpcDeadlineError(error)) {
					recoverAuthoritativeSiteState(requestId, currentSiteEpoch);
				}
			} finally {
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setBusy('');
				}
			}
		};

		const toggleEnabled = async (
			nextEnabled: boolean,
			initiator: FocusTargetLike | null,
		): Promise<void> => {
			if (!siteState || siteState.serverKind === 'unsupported') {
				return;
			}
			const requestId = ++operationEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			const expectedServerKind = siteState.serverKind;
			pendingFocusHandoff.current = {
				identity: panelIdentity,
				initiator,
				kind: 'toggle',
			};
			setBusy('toggling');
			setNotice(null);
			try {
				const nextState = await withIpcDeadline(
					ipcRenderer.invoke(
						IPC_CHANNELS.setEnabled,
						site.id,
						expectedServerKind,
						nextEnabled,
					) as Promise<SiteState>,
					IPC_MUTATION_DEADLINE_MS,
					TOGGLE_TIMEOUT_MESSAGE,
				);
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					hydrate(nextState);
					setNotice({
						message: nextState.settings.enabled
							? `Media proxy enabled. ${nextState.serverKind === 'apache' ? 'Apache' : 'Nginx'} now checks local uploads first and fetches only safe missing upload assets from the configured site.`
							: 'Media proxy disabled. The managed web-server configuration was removed.',
						variant: 'success',
					});
				}
			} catch (error) {
				const message = cleanIpcError(error);
				if (
					operationEpoch.current !== requestId ||
					siteEpoch.current !== currentSiteEpoch
				) {
					return;
				}
				setSiteState(null);
				setNotice({ message, variant: 'error' });
				setBusy('');

				if (!isIpcDeadlineError(error)) {
					recoverAuthoritativeSiteState(requestId, currentSiteEpoch);
				}
			} finally {
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setBusy('');
				}
			}
		};

		React.useEffect(() => {
			const pending = pendingFocusHandoff.current;
			if (!pending) {
				return;
			}
			if (pending.identity !== panelIdentity) {
				pendingFocusHandoff.current = null;
				return;
			}
			if (loadedIdentity !== panelIdentity || busy) {
				return;
			}

			handoffFocusAfterRemovedControl(
				(globalThis as unknown as { document?: FocusDocumentLike }).document,
				pending.initiator,
				pending.kind === 'toggle' ? enableSwitchRef.current : saveButtonRef.current,
				actionFeedbackRef.current,
			);
			pendingFocusHandoff.current = null;
		}, [busy, loadedIdentity, notice, panelIdentity, siteState]);

		const lifecycleUnavailableMessage = !lifecycleReady
			? lifecycleUnavailableReason(siteStatus)
			: siteState?.lifecycleReady === false
				? siteState.reason || 'Local is changing this site. Media Proxy will be available when Local finishes.'
				: null;

		if (lifecycleUnavailableMessage) {
			return e(
				'main',
				{
					'aria-labelledby': `${ADDON_ID}-title`,
					className: 'LocalMediaProxy',
				},
				e(
					'div',
					{ className: 'LocalMediaProxy__Heading' },
					e('h2', { id: `${ADDON_ID}-title` }, ADDON_NAME),
				),
				e(
					'div',
					{
						'aria-live': 'polite',
						className: 'LocalMediaProxy__ActionFeedback LocalMediaProxy__Banner LocalMediaProxy__Banner--neutral',
						role: 'status',
					},
					lifecycleUnavailableMessage,
				),
			);
		}

		if (loadedIdentity !== panelIdentity) {
			return e(
				'div',
				{
					'aria-busy': true,
					'aria-live': 'polite',
					className: 'LocalMediaProxy LocalMediaProxy--Loading',
					role: 'status',
				},
				loadingIndicator(),
				e('span', { className: 'LocalMediaProxy__VisuallyHidden' }, 'Loading media proxy settings…'),
			);
		}

		const supported = siteState?.supported === true;
		const cleanupSupported = siteState?.cleanupSupported === true;
		const settingsReadOnly = siteState?.settingsReadOnly === true;
		const requiresOriginIp = siteState?.requiresOriginIp === true;
		const isApplied = Boolean(siteState?.applied);
		const persistedEnabled = Boolean(siteState?.settings.enabled);
		const enabledToggleState = siteState
			? enabledIntentToggleState(siteState)
			: null;
		const {
			blocksSave: capabilityBlocksSave,
			blocksTest: capabilityBlocksTest,
		} = originCapabilityControlState(
			enabled,
			siteState?.supportsHttpsOrigin !== false,
			siteUrl,
		);
		const draftDirty = siteState
			? settingsDraftIsDirty(settings(), siteState.settings, requiresOriginIp)
			: false;
		const status = !siteState
			? { className: 'LocalMediaProxy__Status--Warning', label: 'Unavailable' }
			: siteState.needsAttention
			? { className: 'LocalMediaProxy__Status--Warning', label: 'Needs attention' }
			: siteStatusPresentation(persistedEnabled, isApplied, draftDirty);
		const fieldsMissing = enabled && (
			!siteUrl.trim() ||
			(requiresOriginIp && !originIp.trim()) ||
			capabilityBlocksSave
		);
		const siteUrlHelp = !requiresOriginIp
			? siteState?.httpsUnavailableReason
				? 'This Local Apache bundle supports HTTP origins only because its platform package does not include mod_ssl. Enter an http:// Site URL, or use Nginx when an HTTPS origin is required.'
				: 'Enter only the scheme and hostname, plus an optional port, without a path. Apache uses this hostname for DNS, HTTP Host, TLS SNI, and certificate verification.'
			: originTlsHostname
			? `Enter only the scheme and hostname, plus an optional port, without a path. WP Engine TLS identity is ${originTlsHostname}; HTTP Host remains the Site URL.`
			: 'Enter only the scheme and hostname, plus an optional port, without a path. HTTPS is recommended.';
		const actionAvailability = settingsActionAvailability(
			supported,
			cleanupSupported,
			enabled,
			capabilityBlocksSave,
		);
		const canRepairUnchangedProfile = Boolean(
			!draftDirty &&
			enabled &&
			persistedEnabled &&
			siteState?.needsAttention &&
			siteState.canEnable,
		);
		const canSave = !settingsReadOnly &&
			(draftDirty || canRepairUnchangedProfile) && actionAvailability.canSave;
		const canToggleEnabled = !settingsReadOnly && enabledToggleState?.allowed === true;
		const toggleBlockedByDraft = draftDirty;
		const toggleHelp = toggleBlockedByDraft
			? 'Save connection changes before changing proxy status.'
			: enabledToggleState?.repairingCleanup && cleanupSupported
				? 'The saved enabled intent is off, but managed proxy configuration remains. Activate this Off switch to retry cleanup without enabling the proxy.'
			: siteState?.canEnable !== true
				? persistedEnabled && cleanupSupported
					? `The enabled intent is still on, but this web server profile is incomplete. ${siteState?.enableUnavailableReason || 'Configure and save a valid connection profile before enabling again.'} Turn this off to remove the managed proxy configuration while preserving the saved connection profile.`
					: persistedEnabled
					? `The enabled intent is still on, but this web server profile is incomplete. ${siteState?.enableUnavailableReason || 'Configure and save a valid connection profile before using this switch.'}`
					: siteState?.enableUnavailableReason || 'Configure and save a valid connection profile for the current web server before enabling.'
				: 'This switch is saved and applied immediately. Connection profile changes still use Save & apply.';
		const draftVerified = testedDraftKey === draftOriginKey(
			siteUrl,
			originIp,
			originTlsHostname,
			originEnvironment,
			requiresOriginIp,
		);
		const providerLabel = discoveryOptions?.provider === 'wpengine'
			? 'WP Engine'
			: discoveryOptions?.provider === 'flywheel'
				? 'Flywheel'
				: 'Manual';
		const discoveryLayout = originDiscoveryLayoutMode(discoveryOptions);
		const canDiscoverFromDns = siteUrlIsUsableForDns(siteUrl);
		const testControl = connectionTestControlState(
			busy,
			supported && !settingsReadOnly && !capabilityBlocksTest,
			Boolean(siteUrl.trim() && (!requiresOriginIp || originIp.trim())),
		);
		const toolsBusyAnnouncement = busy === 'toggling'
			? 'Toggling Media Proxy status.'
			: busy === 'saving'
				? 'Saving and applying Media Proxy settings.'
				: busy === 'testing'
					? 'Testing connection. Activate Stop test to cancel.'
					: busy === 'stopping'
						? 'Stopping connection test.'
						: busy === 'discovering'
							? 'Discovering origin connection details.'
							: '';

		return e(
			'main',
			{
				'aria-busy': Boolean(busy && busy !== 'testing' && busy !== 'stopping'),
				'aria-labelledby': `${ADDON_ID}-title`,
				className: 'LocalMediaProxy',
			},
			e(
				'div',
				{ className: 'LocalMediaProxy__Heading' },
				e('div', null,
					e('h2', { id: `${ADDON_ID}-title` }, ADDON_NAME),
					e('p', null, `Configure a local-first remote media fallback for ${site.name || 'this site'}.`),
				),
				e('span', { className: `LocalMediaProxy__Status ${status.className}` }, status.label),
			),
			siteState?.supported === false && e(
				'div',
				{
					className: 'LocalMediaProxy__Banner LocalMediaProxy__Banner--warning',
					role: 'status',
				},
				siteState?.reason || 'This site uses an unsupported web server.',
			),
			siteState?.settingsReadOnly && siteState.reason && e(
				'div',
				{
					className: 'LocalMediaProxy__Banner LocalMediaProxy__Banner--warning',
					role: 'status',
				},
				siteState.reason,
			),
			siteState?.httpsUnavailableReason && e(
				'div',
				{
					className: 'LocalMediaProxy__Banner LocalMediaProxy__Banner--warning',
					role: 'status',
				},
				siteState.httpsUnavailableReason,
			),
			e(
				'section',
				{ className: 'LocalMediaProxy__Card' },
				e(
					'div',
					{ className: 'LocalMediaProxy__EnableRow' },
					e('div', null,
						e('h3', { id: `${ADDON_ID}-enable-title` }, 'Enable for this site'),
						e('p', null, 'This setting is independent for every site in Local.'),
						e('p', {
							className: 'LocalMediaProxy__EnableHelp',
							id: `${ADDON_ID}-enable-help`,
						}, toggleHelp),
					),
					busy === 'toggling'
						? e(
							'div',
							{
								'aria-busy': true,
								className: 'LocalMediaProxy__ToggleLoadingSlot',
							},
							loadingIndicator(),
						)
						: siteState
							? e('button', {
								'aria-checked': enabled,
								'aria-describedby': `${ADDON_ID}-enable-help`,
								'aria-labelledby': `${ADDON_ID}-enable-title`,
								className: `LocalMediaProxy__Switch${enabled ? ' LocalMediaProxy__Switch--Checked' : ''}`,
								disabled: Boolean(busy) || toggleBlockedByDraft || !canToggleEnabled,
								onClick: (event?: { currentTarget?: FocusTargetLike }) => void toggleEnabled(
									enabledToggleState?.nextEnabled ?? !enabled,
									event?.currentTarget ?? enableSwitchRef.current,
								),
								ref: enableSwitchRef,
								role: 'switch',
								type: 'button',
							})
							: e('span', {
								className: 'LocalMediaProxy__ToggleUnavailable',
							}, 'Status unavailable'),
				),
				e(
					'div',
					{ className: 'LocalMediaProxy__Discovery' },
					e('div', { className: 'LocalMediaProxy__DiscoveryHeading' },
						e('div', null,
							e('h3', null, 'Connection setup'),
							e('p', {
								'aria-live': discoveryLoading ? 'polite' : undefined,
								role: discoveryLoading ? 'status' : undefined,
							}, discoveryLoading ? 'Checking the Local hosting connection…' : discoveryOptions?.message),
						),
						discoveryLoading
							? e(
								'div',
								{
									'aria-busy': true,
									className: 'LocalMediaProxy__DiscoveryLoadingSlot',
								},
								loadingIndicator(),
							)
							: e('span', { className: 'LocalMediaProxy__Provider' }, providerLabel),
					),
					discoveryLayout === 'wpengine' && e(
						'div',
						{ className: 'LocalMediaProxy__DiscoveryControls' },
						e('div', { className: 'LocalMediaProxy__Field LocalMediaProxy__Field--Compact' },
							e('label', { htmlFor: `${ADDON_ID}-environment` }, 'WP Engine environment'),
							e(
								'select',
								{
									className: 'LocalMediaProxy__Input LocalMediaProxy__Select',
									disabled: Boolean(busy) || settingsReadOnly,
									id: `${ADDON_ID}-environment`,
									onChange: (event: { target: { value: HostingEnvironment } }) => {
										setSelectedEnvironment(event.target.value);
										setSuggestion(null);
										setSelectedCandidate('');
										invalidateTest();
									},
									value: selectedEnvironment,
								},
								discoveryOptions.environments.map((option: OriginDiscoveryOptions['environments'][number]) => e(
									'option',
									{ key: option.environment, value: option.environment },
									`${environmentLabel(option.environment)} — ${option.name}${option.current ? ' (connected)' : ''}`,
								)),
							),
						),
						e('button', {
							className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Secondary',
							disabled: Boolean(busy) || settingsReadOnly || !selectedEnvironment,
							onClick: () => discover('wpengine'),
							type: 'button',
						}, busy === 'discovering' ? 'Discovering…' : 'Auto-populate from WP Engine'),
					),
				),
				e(
					'div',
					{ className: 'LocalMediaProxy__Fields' },
					e(
						'div',
						{ className: 'LocalMediaProxy__Field' },
						e('label', { htmlFor: `${ADDON_ID}-site-url` }, 'Site URL'),
						e('input', {
							'aria-describedby': fieldsMissing && !siteUrl.trim()
								? `${ADDON_ID}-site-url-help ${ADDON_ID}-site-url-error`
								: `${ADDON_ID}-site-url-help`,
							'aria-invalid': fieldsMissing && !siteUrl.trim(),
							className: `LocalMediaProxy__Input${fieldsMissing && !siteUrl.trim() ? ' LocalMediaProxy__Input--Invalid' : ''}`,
							disabled: !supported || settingsReadOnly || Boolean(busy),
							id: `${ADDON_ID}-site-url`,
							onChange: (event: { target: { value: string } }) => editSiteUrl(event.target.value),
							placeholder: 'https://example.com',
							type: 'url',
							value: siteUrl,
						}),
						fieldsMissing && !siteUrl.trim() && e(
							'p',
							{
								className: 'LocalMediaProxy__Error',
								id: `${ADDON_ID}-site-url-error`,
								role: 'alert',
							},
							'Enter the remote Site URL.',
						),
						e('p', { className: 'LocalMediaProxy__Help', id: `${ADDON_ID}-site-url-help` }, siteUrlHelp),
					),
					requiresOriginIp && e(
						'div',
						{ className: 'LocalMediaProxy__Field' },
						e('label', { htmlFor: `${ADDON_ID}-origin-ip` }, 'Remote IP address'),
						e('div', { className: 'LocalMediaProxy__OriginIpRow' },
							e('input', {
								'aria-describedby': fieldsMissing && !originIp.trim()
									? `${ADDON_ID}-origin-ip-help ${ADDON_ID}-origin-ip-error`
									: `${ADDON_ID}-origin-ip-help`,
								'aria-invalid': fieldsMissing && !originIp.trim(),
								className: `LocalMediaProxy__Input${fieldsMissing && !originIp.trim() ? ' LocalMediaProxy__Input--Invalid' : ''}`,
								disabled: !supported || settingsReadOnly || Boolean(busy),
								id: `${ADDON_ID}-origin-ip`,
								onChange: (event: { target: { value: string } }) => editOriginIp(event.target.value),
								placeholder: '203.0.113.10',
								type: 'text',
								value: originIp,
							}),
							discoveryLayout !== 'pending' && e('button', {
								'aria-describedby': `${ADDON_ID}-dns-help`,
								className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Secondary LocalMediaProxy__Button--Dns',
								disabled: Boolean(busy) || settingsReadOnly || !supported || !canDiscoverFromDns,
								onClick: () => discover('dns'),
								type: 'button',
							}, busy === 'discovering' ? 'Finding…' : 'Find via public DNS'),
						),
						fieldsMissing && !originIp.trim() && e(
							'p',
							{
								className: 'LocalMediaProxy__Error',
								id: `${ADDON_ID}-origin-ip-error`,
								role: 'alert',
							},
							'Enter a valid remote IPv4 or IPv6 address.',
						),
						suggestion && e(
							'div',
							{ className: 'LocalMediaProxy__DiscoveryResult' },
							originCandidatesRequireSelection(suggestion.addresses) && e(
								'div',
								{ className: 'LocalMediaProxy__Field' },
								e('label', { htmlFor: `${ADDON_ID}-candidate` }, 'Remote IP candidate'),
								e(
									'select',
									{
										className: 'LocalMediaProxy__Input LocalMediaProxy__Select',
										disabled: Boolean(busy) || settingsReadOnly,
										id: `${ADDON_ID}-candidate`,
										onChange: (event: { target: { value: string } }) => chooseCandidate(event.target.value),
										value: selectedCandidate,
									},
									e('option', { value: '' }, 'Select an address to test'),
									suggestion.addresses.map((candidate: OriginAddressCandidate) => e(
										'option',
										{ key: candidate.address, value: candidate.address },
										originCandidateLabel(candidate),
									)),
								),
							),
							e('p', {
								'aria-live': 'polite',
								className: 'LocalMediaProxy__DiscoveryWarning',
								role: 'status',
							}, suggestion.warning),
							selectedCandidate && suggestion.addresses.find((candidate: OriginAddressCandidate) => candidate.address === selectedCandidate)?.warning && e(
								'p',
								{
									'aria-live': 'polite',
									className: 'LocalMediaProxy__DiscoveryWarning',
									role: 'status',
								},
								suggestion.addresses.find((candidate: OriginAddressCandidate) => candidate.address === selectedCandidate)?.warning,
							),
						),
						discoveryLayout !== 'pending' && e(
							'p',
							{ className: 'LocalMediaProxy__Help', id: `${ADDON_ID}-dns-help` },
							'Public DNS may return a direct origin, CDN, reverse proxy, or load balancer address. Compatible proxy or CDN addresses can work, but every result must be tested.',
						),
						e('p', { className: 'LocalMediaProxy__Help', id: `${ADDON_ID}-origin-ip-help` }, 'A provider-supplied origin IP is preferred when available. A proxy, CDN, or load-balancer IP can also work when it serves the Site URL; test this connection before enabling, then verify an actual missing upload after applying.'),
					),
				),
				notice && e(
					'div',
					{
						'aria-live': notice.variant === 'error' ? undefined : 'polite',
						className: `LocalMediaProxy__ActionFeedback LocalMediaProxy__Banner LocalMediaProxy__Banner--${notice.variant}`,
						ref: actionFeedbackRef,
						role: notice.variant === 'error' ? 'alert' : 'status',
						tabIndex: -1,
					},
					notice.message,
				),
				e(
					'div',
					{ className: 'LocalMediaProxy__Actions' },
					e('span', {
						'aria-atomic': true,
						'aria-live': 'polite',
						className: 'LocalMediaProxy__VisuallyHidden',
						role: 'status',
					}, toolsBusyAnnouncement),
					draftVerified && e('span', { className: 'LocalMediaProxy__DraftVerified' }, 'Connection test passed'),
					e('button', {
						'aria-busy': busy === 'testing' || busy === 'stopping',
						className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Secondary LocalMediaProxy__Button--Test',
						disabled: testControl.disabled,
						onClick: busy === 'testing' ? stopConnectionTest : testConnection,
						type: 'button',
					},
					testControl.showSpinner && e('span', {
						'aria-hidden': true,
						className: 'LocalMediaProxy__Spinner',
					}),
					e('span', null, testControl.label)),
					busy === 'saving'
						? e(
							'div',
							{
								'aria-busy': true,
								className: 'LocalMediaProxy__ButtonLoadingSlot',
							},
							loadingIndicator(),
						)
						: e('button', {
							className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Primary LocalMediaProxy__Button--Save',
							disabled: !canSave || Boolean(busy) || fieldsMissing,
							onClick: (event?: { currentTarget?: FocusTargetLike }) => void saveSettings(
								event?.currentTarget ?? saveButtonRef.current,
							),
							ref: saveButtonRef,
							type: 'button',
						}, 'Save & apply'),
				),
			),
			e(
				'section',
				{ className: 'LocalMediaProxy__Details', 'aria-label': 'How the proxy works' },
				e('h3', null, 'Local-first and narrowly scoped'),
				e('ul', null,
					e('li', null, 'Existing upload assets continue to come from the local uploads directory.'),
					e('li', null, 'Only safe missing files under /wp-content/uploads/ are fetched.'),
					e('li', null, proxyPrivacySummary(siteState?.serverKind ?? 'unsupported')),
				e('li', null, requiresOriginIp
					? 'HTTPS identity and chain are verified against standard CA roots and the published Cloudflare Origin CA roots.'
					: 'Apache resolves the Site URL hostname and uses that same identity for HTTP Host, TLS SNI, and certificate verification.'),
					e('li', null, 'A successful connection test verifies reachability and, for HTTPS, certificate identity and trust—not a media file. After applying, test an actual missing upload through the Local site.'),
				),
			),
			!draftDirty && siteState?.settings.lastVerifiedAt && e(
				'p',
				{ className: 'LocalMediaProxy__Verification' },
				`Last connection test: ${new Date(siteState.settings.lastVerifiedAt).toLocaleString()} (HTTP ${siteState.settings.lastOriginStatus ?? 'unknown'}).`,
			),
		);
	};

	hooks.addContent('stylesheets', () => e('link', {
		href: stylesheetPath,
		key: `${ADDON_ID}-stylesheet`,
		rel: 'stylesheet',
	}));

	hooks.addContent(
		'SiteInfoOverview_TableList',
		(site: SiteProps['site'], siteStatus: string) => e(ProxyStatusRow, {
			key: `${ADDON_ID}-overview-status-${site.id}`,
			site,
			siteStatus,
		}),
	);

	hooks.addFilter('siteInfoToolsItem', (menu, context) => [
		...menu,
		{
			menuItem: 'Media Proxy',
			path: `/${ADDON_ID}`,
			render: (props?: Partial<ProxyStatusRowProps>) => {
				const routeProps = context?.routeChildrenProps;
				const site = routeProps?.site ?? props?.site;
				if (!site) {
					return null;
				}
				return e(MediaProxyPanel, {
					site,
					siteStatus: routeProps?.siteStatus ?? props?.siteStatus ?? 'running',
				});
			},
		},
	]);
}
