/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ADDON_ID, ADDON_NAME, IPC_CHANNELS } from './constants';
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
	SiteState,
	StoredSettings,
} from './types';
import {
	siteUrlComparisonKey,
	siteUrlsAreEquivalent,
} from './validation';

interface RendererContext {
	React: any;
	electron: {
		ipcRenderer: {
			invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
		};
	};
	hooks: {
		addContent: (hook: string, callback: () => unknown) => void;
		addFilter: (hook: string, callback: (items: unknown[]) => unknown[]) => void;
	};
}

interface SiteProps {
	site: {
		id: string;
		name?: string;
	};
}

interface Notice {
	message: string;
	variant: 'error' | 'neutral' | 'success' | 'warning';
}

export function draftOriginKey(
	siteUrl: string,
	originIp: string,
	originTlsHostname?: string,
	originEnvironment?: HostingEnvironment,
): string {
	return `${siteUrlComparisonKey(siteUrl)}\n${originIp.trim()}\n${originTlsHostname?.trim() ?? ''}\n${originEnvironment ?? ''}`;
}

export function settingsDraftIsDirty(
	draft: SettingsInput,
	persisted: StoredSettings,
): boolean {
	return draft.enabled !== persisted.enabled ||
		draft.originIp !== persisted.originIp ||
		draft.originEnvironment !== persisted.originEnvironment ||
		(draft.originSource ?? 'manual') !== (persisted.originSource ?? 'manual') ||
		(draft.originTlsHostname ?? '') !== (persisted.originTlsHostname ?? '') ||
		(draft.resolvedAt ?? '') !== (persisted.resolvedAt ?? '') ||
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

	installMarketplaceMetadataShim(
		globalThis as unknown as MarketplaceFetchHost,
	);

	const MediaProxyPanel = ({ site }: SiteProps) => {
		const [busy, setBusy] = React.useState('');
		const [discoveryLoading, setDiscoveryLoading] = React.useState(false);
		const [discoveryOptions, setDiscoveryOptions] = React.useState(null as OriginDiscoveryOptions | null);
		const [enabled, setEnabled] = React.useState(false);
		const [loaded, setLoaded] = React.useState(false);
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
		const siteEpoch = React.useRef(0);
		const discoveryEpoch = React.useRef(0);
		const operationEpoch = React.useRef(0);
		const activeProbeToken = React.useRef(null as string | null);

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
				)
				: null,
			);
		};

		React.useEffect(() => {
			const epoch = ++siteEpoch.current;
			discoveryEpoch.current += 1;
			operationEpoch.current += 1;
			setBusy('');
			setLoaded(false);
			setDiscoveryLoading(true);
			setDiscoveryOptions(null);
			setNotice(null);
			setSuggestion(null);

			ipcRenderer.invoke(IPC_CHANNELS.getSiteState, site.id)
				.then((value: unknown) => {
					if (siteEpoch.current === epoch) {
						hydrate(value as SiteState);
					}
				})
				.catch((error: unknown) => {
					if (siteEpoch.current === epoch) {
						setNotice({ message: cleanIpcError(error), variant: 'error' });
					}
				})
				.finally(() => {
					if (siteEpoch.current === epoch) {
						setLoaded(true);
					}
				});

			ipcRenderer.invoke(IPC_CHANNELS.getOriginDiscoveryOptions, site.id)
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

			return () => {
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
		}, [site.id]);

		const settings = (): SettingsInput => ({
			enabled,
			originEnvironment,
			originIp,
			originSource,
			originTlsHostname,
			resolvedAt,
			siteUrl,
		});

		const invalidateTest = (): void => {
			setTestedDraftKey(null);
			setNotice(null);
		};

		const editSiteUrl = (value: string): void => {
			const preservesOriginIdentity = siteUrlsAreEquivalent(siteUrl, value);
			setSiteUrl(value);
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
			const selectionRequired = originCandidatesRequireSelection(nextSuggestion.addresses);
			const soleCandidate = !selectionRequired && nextSuggestion.addresses.length === 1
				? nextSuggestion.addresses[0]
				: undefined;
			setSuggestion(nextSuggestion);
			setSiteUrl(nextSuggestion.siteUrl);
			setOriginIp(soleCandidate?.address ?? '');
			setSelectedCandidate(soleCandidate?.address ?? '');
			setOriginSource(nextSuggestion.provider === 'wpengine' ? 'wpengine' : 'dns');
			setOriginEnvironment(nextSuggestion.provider === 'wpengine'
				? nextSuggestion.environment
				: undefined);
			setOriginTlsHostname(nextSuggestion.originTlsHostname);
			setResolvedAt(nextSuggestion.resolvedAt);
			setTestedDraftKey(null);
			setNotice({
				message: selectionRequired
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
				const result = await ipcRenderer.invoke(
					IPC_CHANNELS.discoverOrigin,
					site.id,
					request,
				) as OriginSuggestion;
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
						? draftOriginKey(siteUrl, originIp, verifiedTlsHostname, originEnvironment)
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

		const saveSettings = async (): Promise<void> => {
			const requestId = ++operationEpoch.current;
			const currentSiteEpoch = siteEpoch.current;
			setBusy('saving');
			setNotice(null);
			try {
				const nextState = await ipcRenderer.invoke(
					IPC_CHANNELS.applySettings,
					site.id,
					settings(),
				) as SiteState;
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					hydrate(nextState);
					setNotice({
						message: nextState.settings.enabled
							? 'Media proxy enabled. Nginx now checks local uploads first and fetches only missing images from the configured site.'
							: 'Media proxy disabled. The managed Nginx configuration was removed.',
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
				try {
					const currentState = await ipcRenderer.invoke(
						IPC_CHANNELS.getSiteState,
						site.id,
					) as SiteState;
					if (
						operationEpoch.current === requestId &&
						siteEpoch.current === currentSiteEpoch
					) {
						hydrate(currentState);
					}
				} catch {
					// Preserve the original apply error when state refresh also fails.
				}
				if (
					operationEpoch.current === requestId &&
					siteEpoch.current === currentSiteEpoch
				) {
					setNotice({ message, variant: 'error' });
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

		if (!loaded) {
			return e('div', { className: 'LocalMediaProxy LocalMediaProxy--Loading' }, 'Loading media proxy settings…');
		}

		const supported = siteState?.supported !== false;
		const isApplied = Boolean(siteState?.applied);
		const persistedEnabled = Boolean(siteState?.settings.enabled);
		const cleanupAvailable = !supported && (persistedEnabled || isApplied);
		const draftDirty = siteState
			? settingsDraftIsDirty(settings(), siteState.settings)
			: false;
		const persistedStatus = persistedEnabled
			? isApplied
				? 'Enabled'
				: 'Not applied'
			: isApplied
				? 'Cleanup pending'
				: 'Disabled';
		const statusLabel = draftDirty
			? `${persistedStatus} · Unsaved changes`
			: persistedStatus;
		const statusClass = persistedEnabled && isApplied
			? 'LocalMediaProxy__Status--Enabled'
			: persistedEnabled || isApplied
				? 'LocalMediaProxy__Status--Warning'
				: 'LocalMediaProxy__Status--Disabled';
		const fieldsMissing = enabled && (!siteUrl.trim() || !originIp.trim());
		const siteUrlHelp = originTlsHostname
			? `Enter only the scheme and hostname, plus an optional port, without a path. WP Engine TLS identity is ${originTlsHostname}; HTTP Host remains the Site URL.`
			: 'Enter only the scheme and hostname, plus an optional port, without a path. HTTPS is recommended.';
		const canSave = supported || (!enabled && cleanupAvailable);
		const draftVerified = testedDraftKey === draftOriginKey(
			siteUrl,
			originIp,
			originTlsHostname,
			originEnvironment,
		);
		const providerLabel = discoveryOptions?.provider === 'wpengine'
			? 'WP Engine'
			: discoveryOptions?.provider === 'flywheel'
				? 'Flywheel'
				: 'Manual';
		const testControl = connectionTestControlState(
			busy,
			supported,
			Boolean(siteUrl.trim() && originIp.trim()),
		);

		return e(
			'main',
			{
				'aria-busy': Boolean(
					(busy && busy !== 'testing' && busy !== 'stopping') || discoveryLoading,
				),
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
				e('span', { className: `LocalMediaProxy__Status ${statusClass}` }, statusLabel),
			),
			!supported && e(
				'div',
				{
					className: 'LocalMediaProxy__Banner LocalMediaProxy__Banner--warning',
					role: 'status',
				},
				siteState?.reason || 'This site uses an unsupported web server.',
			),
			notice && e(
				'div',
				{
					'aria-live': notice.variant === 'error' ? undefined : 'polite',
					className: `LocalMediaProxy__Banner LocalMediaProxy__Banner--${notice.variant}`,
					role: notice.variant === 'error' ? 'alert' : 'status',
				},
				notice.message,
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
					),
					e('button', {
						'aria-checked': enabled,
						'aria-labelledby': `${ADDON_ID}-enable-title`,
						className: `LocalMediaProxy__Switch${enabled ? ' LocalMediaProxy__Switch--Checked' : ''}`,
						disabled: Boolean(busy) || (!supported && !enabled),
						onClick: () => setEnabled(!enabled),
						role: 'switch',
						type: 'button',
					}),
				),
				e(
					'div',
					{ className: 'LocalMediaProxy__Discovery' },
					e('div', { className: 'LocalMediaProxy__DiscoveryHeading' },
						e('div', null,
							e('h3', null, 'Connection setup'),
							e('p', null, discoveryLoading ? 'Checking the Local hosting connection…' : discoveryOptions?.message),
						),
						e('span', { className: 'LocalMediaProxy__Provider' }, providerLabel),
					),
					discoveryOptions?.canAutoPopulate && e(
						'div',
						{ className: 'LocalMediaProxy__DiscoveryControls' },
						e('div', { className: 'LocalMediaProxy__Field LocalMediaProxy__Field--Compact' },
							e('label', { htmlFor: `${ADDON_ID}-environment` }, 'WP Engine environment'),
							e(
								'select',
								{
									className: 'LocalMediaProxy__Input LocalMediaProxy__Select',
									disabled: Boolean(busy),
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
							disabled: Boolean(busy) || !selectedEnvironment,
							onClick: () => discover('wpengine'),
							type: 'button',
						}, busy === 'discovering' ? 'Discovering…' : 'Auto-populate from WP Engine'),
					),
					e(
						'div',
						{ className: 'LocalMediaProxy__DnsAction' },
						e('p', null, 'Public DNS may return a direct origin, CDN, reverse proxy, or load balancer address. Compatible proxy or CDN addresses can work, but every result must be tested.'),
						e('button', {
							className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Secondary',
							disabled: Boolean(busy) || !siteUrl.trim(),
							onClick: () => discover('dns'),
							type: 'button',
						}, busy === 'discovering' ? 'Finding…' : 'Find IP addresses'),
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
									disabled: Boolean(busy),
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
							disabled: !supported || Boolean(busy),
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
					e(
						'div',
						{ className: 'LocalMediaProxy__Field' },
						e('label', { htmlFor: `${ADDON_ID}-origin-ip` }, 'Remote IP address'),
						e('input', {
							'aria-describedby': fieldsMissing && !originIp.trim()
								? `${ADDON_ID}-origin-ip-help ${ADDON_ID}-origin-ip-error`
								: `${ADDON_ID}-origin-ip-help`,
							'aria-invalid': fieldsMissing && !originIp.trim(),
							className: `LocalMediaProxy__Input${fieldsMissing && !originIp.trim() ? ' LocalMediaProxy__Input--Invalid' : ''}`,
							disabled: !supported || Boolean(busy),
							id: `${ADDON_ID}-origin-ip`,
							onChange: (event: { target: { value: string } }) => editOriginIp(event.target.value),
							placeholder: '203.0.113.10',
							type: 'text',
							value: originIp,
						}),
						fieldsMissing && !originIp.trim() && e(
							'p',
							{
								className: 'LocalMediaProxy__Error',
								id: `${ADDON_ID}-origin-ip-error`,
								role: 'alert',
							},
							'Enter a valid remote IPv4 or IPv6 address.',
						),
						e('p', { className: 'LocalMediaProxy__Help', id: `${ADDON_ID}-origin-ip-help` }, 'A provider-supplied origin IP is preferred when available. A proxy, CDN, or load-balancer IP can also work when it serves the Site URL; test this connection before enabling, then verify an actual missing upload after applying.'),
					),
				),
				e(
					'div',
					{ className: 'LocalMediaProxy__Actions' },
					e('span', {
						'aria-live': 'polite',
						className: 'LocalMediaProxy__VisuallyHidden',
					}, busy === 'testing'
						? 'Testing connection. Activate Stop test to cancel.'
						: busy === 'stopping'
							? 'Stopping connection test.'
							: ''),
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
					e('button', {
						className: 'LocalMediaProxy__Button LocalMediaProxy__Button--Primary',
						disabled: !canSave || Boolean(busy) || fieldsMissing,
						onClick: saveSettings,
						type: 'button',
					}, busy === 'saving' ? 'Applying…' : 'Save & apply'),
				),
			),
			e(
				'section',
				{ className: 'LocalMediaProxy__Details', 'aria-label': 'How the proxy works' },
				e('h3', null, 'Local-first and narrowly scoped'),
				e('ul', null,
					e('li', null, 'Existing images continue to come from the local uploads directory.'),
					e('li', null, 'Only missing image files under /wp-content/uploads/ are fetched.'),
					e('li', null, 'Only GET and HEAD are allowed; visitor headers and request bodies are not forwarded, and a fixed add-on User-Agent is used for compatibility.'),
					e('li', null, 'HTTPS identity and chain are verified against standard CA roots and the published Cloudflare Origin CA roots.'),
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

	hooks.addFilter('siteInfoToolsItem', (menu) => [
		...menu,
		{
			menuItem: 'Media Proxy',
			path: `/${ADDON_ID}`,
			render: (props: SiteProps) => e(MediaProxyPanel, props),
		},
	]);
}
