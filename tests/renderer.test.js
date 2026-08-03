/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const rendererModule = require('../lib/renderer');
const { IPC_CHANNELS } = require('../lib/constants');
const {
	IPC_DISCOVERY_DEADLINE_MS,
	IPC_MUTATION_DEADLINE_MS,
	IPC_READ_DEADLINE_MS,
	connectionTestControlState,
	draftOriginKey,
	handoffFocusAfterRemovedControl,
	isIpcDeadlineError,
	originCandidateLabel,
	originCandidatesRequireSelection,
	originDiscoveryLayoutMode,
	overviewProxyStatusPresentation,
	overviewProxyStatusGuidance,
	originCapabilityControlState,
	proxyPrivacySummary,
	settingsActionAvailability,
	settingsDraftIsDirty,
	siteServerFingerprint,
	siteUrlIsUsableForDns,
	siteUrlUsesHttps,
	siteStatusPresentation,
	withIpcDeadline,
} = rendererModule;

test('describes the stronger Nginx header allowlist and Apache finite denylist accurately', () => {
	assert.match(proxyPrivacySummary('nginx'), /incoming visitor headers.*are not forwarded/);
	assert.match(proxyPrivacySummary('apache'), /named credential, nonce, CSRF, sensitive, and client-IP headers are stripped/);
	assert.match(proxyPrivacySummary('apache'), /cannot wildcard-remove arbitrary custom header names/);
	assert.doesNotMatch(proxyPrivacySummary('apache'), /visitor headers.*are not forwarded/);
});

test('recognizes when an Apache draft selects an HTTPS origin', () => {
	assert.equal(siteUrlUsesHttps('https://media.example.com'), true);
	assert.equal(siteUrlUsesHttps('http://media.example.com'), false);
	assert.equal(siteUrlUsesHttps('not a URL'), false);
});

test('blocks unsupported Apache HTTPS enable and test without blocking disable cleanup', () => {
	assert.deepEqual(originCapabilityControlState(true, false, 'https://media.example.com'), {
		blocksSave: true,
		blocksTest: true,
	});
	assert.deepEqual(originCapabilityControlState(false, false, 'https://media.example.com'), {
		blocksSave: false,
		blocksTest: true,
	});
	assert.deepEqual(originCapabilityControlState(true, false, 'http://media.example.com'), {
		blocksSave: false,
		blocksTest: false,
	});
});

test('keeps cleanup reachable only when the resolved runtime service can execute it', () => {
	assert.deepEqual(settingsActionAvailability(false, true, true, true), {
		canSave: false,
		canToggle: true,
	});
	assert.deepEqual(settingsActionAvailability(false, true, false, false), {
		canSave: true,
		canToggle: false,
	});
	assert.deepEqual(settingsActionAvailability(false, false, true, false), {
		canSave: false,
		canToggle: false,
	});
});

function createElement(type, props, ...children) {
	const { key = null, ...elementProps } = props || {};
	if (children.length > 0) {
		elementProps.children = children.length === 1 ? children[0] : children;
	}

	return { key, props: elementProps, type };
}

function createHookHarness(React) {
	const effects = [];
	const refs = [];
	const states = [];
	let cursor = 0;
	let pendingEffects = [];

	React.useState = (initialValue) => {
		const index = cursor++;
		if (!(index in states)) {
			states[index] = initialValue;
		}

		return [states[index], (value) => {
			states[index] = typeof value === 'function' ? value(states[index]) : value;
		}];
	};

	React.useRef = (initialValue) => {
		const index = cursor++;
		if (!(index in refs)) {
			refs[index] = { current: initialValue };
		}
		return refs[index];
	};

	React.useEffect = (effect, dependencies) => {
		const index = cursor++;
		const previous = effects[index];
		const changed = !previous
			|| dependencies.length !== previous.dependencies.length
			|| dependencies.some((value, dependencyIndex) => (
				value !== previous.dependencies[dependencyIndex]
			));

		if (changed) {
			pendingEffects.push({ dependencies, effect, index, previous });
		}
	};

	return {
		render(Component, props) {
			cursor = 0;
			pendingEffects = [];
			const tree = Component(props);
			for (const pending of pendingEffects) {
				pending.previous?.cleanup?.();
				effects[pending.index] = {
					cleanup: pending.effect(),
					dependencies: pending.dependencies,
				};
			}
			return tree;
		},
	};
}

function createRendererRegistration(invoke) {
	const contentHooks = new Map();
	const filters = new Map();
	const React = { createElement };

	rendererModule.default({
		React,
		electron: { ipcRenderer: { invoke } },
		hooks: {
			addContent: (hook, callback) => contentHooks.set(hook, callback),
			addFilter: (hook, callback) => filters.set(hook, callback),
		},
	});

	return { contentHooks, filters, React };
}

function createSiteState({
	applied,
	canEnable = true,
	enabled,
	enableUnavailableReason,
	lifecycleReady = true,
	needsAttention,
	originIp = '192.0.2.10',
	reason,
	requiresOriginIp = true,
	serverKind = 'nginx',
	siteStatus = 'running',
	siteUrl = 'https://example.com',
	supported = true,
	cleanupSupported = supported,
	supportsHttpsOrigin = true,
}) {
	return {
		applied,
		canEnable,
		cleanupSupported,
		enableUnavailableReason,
		lifecycleReady,
		needsAttention,
		reason,
		requiresOriginIp,
		serverKind,
		settings: {
			enabled,
			originIp,
			siteUrl,
		},
		siteStatus,
		supported,
		supportsHttpsOrigin,
	};
}

function deferred() {
	let reject;
	let resolve;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		reject = rejectPromise;
		resolve = resolvePromise;
	});
	return { promise, reject, resolve };
}

function findElement(node, predicate) {
	if (!node) {
		return null;
	}
	if (Array.isArray(node)) {
		for (const child of node) {
			const match = findElement(child, predicate);
			if (match) {
				return match;
			}
		}
		return null;
	}
	if (typeof node !== 'object') {
		return null;
	}
	if (predicate(node)) {
		return node;
	}
	return findElement(node.props?.children, predicate);
}

function findElements(node, predicate, matches = []) {
	if (!node) {
		return matches;
	}
	if (Array.isArray(node)) {
		for (const child of node) {
			findElements(child, predicate, matches);
		}
		return matches;
	}
	if (typeof node !== 'object') {
		return matches;
	}
	if (predicate(node)) {
		matches.push(node);
	}
	findElements(node.props?.children, predicate, matches);
	return matches;
}

function findLoadingIndicator(node, placementClass = '') {
	return findElement(node, (candidate) => {
		const classNames = String(candidate.props?.className ?? '').split(/\s+/);
		return classNames.includes('LocalMediaProxy__LoadingIndicator')
			&& classNames.includes('LocalMediaProxy__LoadingIndicator--Gray')
			&& (!placementClass || classNames.includes(placementClass));
	});
}

function assertNativeLoadingIndicator(indicator, placementClass = '') {
	assert.ok(indicator);
	assert.equal(indicator.type, 'div');
	assert.equal(indicator.props['aria-hidden'], true);
	const classNames = String(indicator.props.className).split(/\s+/);
	assert.ok(classNames.includes('LocalMediaProxy__LoadingIndicator'));
	assert.ok(classNames.includes('LocalMediaProxy__LoadingIndicator--Gray'));
	if (placementClass) {
		assert.ok(classNames.includes(placementClass));
	}
	const children = Array.isArray(indicator.props.children)
		? indicator.props.children
		: [indicator.props.children];
	assert.equal(children.length, 2);
	for (const child of children) {
		assert.equal(child.type, 'div');
		assert.equal(child.props.className, undefined);
	}
}

function elementText(node) {
	if (node === null || node === undefined || node === false) {
		return '';
	}
	if (Array.isArray(node)) {
		return node.map(elementText).join('');
	}
	if (typeof node === 'string' || typeof node === 'number') {
		return String(node);
	}
	return elementText(node.props?.children);
}

function flushPromises() {
	return new Promise((resolve) => setImmediate(resolve));
}

function installManualTimers() {
	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;
	const timers = new Map();
	let timerId = 0;
	global.setTimeout = (callback, delay) => {
		timerId += 1;
		timers.set(timerId, { callback, delay });
		return timerId;
	};
	global.clearTimeout = (id) => {
		timers.delete(id);
	};

	return {
		restore() {
			global.setTimeout = originalSetTimeout;
			global.clearTimeout = originalClearTimeout;
		},
		runNext(delay) {
			const timer = [...timers.entries()].find(([, entry]) => entry.delay === delay);
			assert.ok(timer, `missing ${delay}ms timer`);
			timer[1].callback();
		},
		timers,
	};
}

test('bounds renderer IPC waits, clears timers, and ignores late settlement', async () => {
	assert.equal(IPC_READ_DEADLINE_MS, 15_000);
	assert.equal(IPC_DISCOVERY_DEADLINE_MS, 30_000);
	assert.equal(IPC_MUTATION_DEADLINE_MS, 90_000);

	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;
	const callbacks = new Map();
	const cleared = [];
	let timerId = 0;
	global.setTimeout = (callback, delay) => {
		timerId += 1;
		callbacks.set(timerId, { callback, delay });
		return timerId;
	};
	global.clearTimeout = (id) => {
		cleared.push(id);
		callbacks.delete(id);
	};

	try {
		assert.equal(
			await withIpcDeadline(Promise.resolve('ready'), IPC_READ_DEADLINE_MS, 'timed out'),
			'ready',
		);
		assert.deepEqual(cleared, [1]);

		const raw = deferred();
		const bounded = withIpcDeadline(raw.promise, IPC_MUTATION_DEADLINE_MS, 'Outcome unconfirmed.');
		assert.equal(callbacks.get(2).delay, IPC_MUTATION_DEADLINE_MS);
		callbacks.get(2).callback();
		await assert.rejects(bounded, (error) => (
			isIpcDeadlineError(error) && error.message === 'Outcome unconfirmed.'
		));
		assert.deepEqual(cleared, [1, 2]);

		raw.resolve('late result');
		await flushPromises();
		await assert.rejects(bounded, /Outcome unconfirmed/);
		assert.deepEqual(cleared, [1, 2]);
	} finally {
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}
});

test('hands focus back only when the removed control still owns the interaction', () => {
	const body = {};
	const initiator = {};
	const focused = [];
	const preferred = {
		disabled: false,
		focus: () => focused.push('preferred'),
		isConnected: true,
	};
	const fallback = {
		disabled: false,
		focus: () => focused.push('fallback'),
		isConnected: true,
	};

	assert.equal(
		handoffFocusAfterRemovedControl({ activeElement: body, body }, initiator, preferred, fallback),
		true,
	);
	assert.deepEqual(focused, ['preferred']);

	focused.length = 0;
	assert.equal(
		handoffFocusAfterRemovedControl({ activeElement: initiator, body }, initiator, preferred, fallback),
		true,
	);
	assert.deepEqual(focused, ['preferred']);

	focused.length = 0;
	assert.equal(
		handoffFocusAfterRemovedControl(
			{ activeElement: body, body },
			initiator,
			{ ...preferred, disabled: true },
			fallback,
		),
		true,
	);
	assert.deepEqual(focused, ['fallback']);

	focused.length = 0;
	assert.equal(
		handoffFocusAfterRemovedControl({ activeElement: body, body }, initiator, null, fallback),
		true,
	);
	assert.deepEqual(focused, ['fallback']);

	focused.length = 0;
	assert.equal(
		handoffFocusAfterRemovedControl(
			{ activeElement: body, body },
			initiator,
			{ ...preferred, isConnected: false },
			fallback,
		),
		true,
	);
	assert.deepEqual(focused, ['fallback']);

	focused.length = 0;
	assert.equal(
		handoffFocusAfterRemovedControl(
			{ activeElement: { id: 'another-control' }, body },
			initiator,
			preferred,
			fallback,
		),
		false,
	);
	assert.equal(handoffFocusAfterRemovedControl(undefined, initiator, preferred, fallback), false);
	assert.deepEqual(focused, []);
});

test('keeps an active connection test cancellable', () => {
	assert.deepEqual(
		connectionTestControlState('', true, true),
		{ disabled: false, label: 'Test connection', showSpinner: false },
	);
	assert.deepEqual(
		connectionTestControlState('testing', true, true),
		{ disabled: false, label: 'Stop test', showSpinner: true },
	);
	assert.deepEqual(
		connectionTestControlState('stopping', true, true),
		{ disabled: true, label: 'Stopping…', showSpinner: true },
	);
	assert.equal(connectionTestControlState('saving', true, true).disabled, true);
	assert.equal(connectionTestControlState('', false, true).disabled, true);
	assert.equal(connectionTestControlState('', true, false).disabled, true);
});

test('draft verification keys change with Site URL, origin IP, TLS hostname, or environment', () => {
	const initial = draftOriginKey('https://example.com', '192.0.2.10', 'origin.example.com', 'production');
	assert.equal(initial, draftOriginKey(' https://example.com ', ' 192.0.2.10 ', ' origin.example.com ', 'production'));
	assert.equal(initial, draftOriginKey('https://example.com/', '192.0.2.10', 'origin.example.com', 'production'));
	assert.notEqual(initial, draftOriginKey('https://staging.example.com', '192.0.2.10', 'origin.example.com', 'production'));
	assert.notEqual(initial, draftOriginKey('https://example.com', '192.0.2.11', 'origin.example.com', 'production'));
	assert.notEqual(initial, draftOriginKey('https://example.com', '192.0.2.10', 'other.example.com', 'production'));
	assert.notEqual(initial, draftOriginKey('https://example.com', '192.0.2.10', 'origin.example.com', 'staging'));
});

test('draft dirty detection includes persisted discovery metadata', () => {
	const persisted = {
		enabled: false,
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originSource: 'wpengine',
		originTlsHostname: 'origin.wpengine.com',
		resolvedAt: '2026-07-16T20:00:00.000Z',
		siteUrl: 'https://example.com',
	};
	const matchingDraft = { ...persisted };

	assert.equal(settingsDraftIsDirty(matchingDraft, persisted), false);
	assert.equal(settingsDraftIsDirty({ ...matchingDraft, originSource: 'manual' }, persisted), true);
	assert.equal(
		settingsDraftIsDirty({ ...matchingDraft, resolvedAt: '2026-07-16T21:00:00.000Z' }, persisted),
		true,
	);
	assert.equal(settingsDraftIsDirty(
		{ ...matchingDraft, originSource: 'manual', resolvedAt: undefined },
		{ ...persisted, originSource: undefined, resolvedAt: undefined },
	), false);
});

test('presents persisted header status separately from unsaved draft state', () => {
	assert.deepEqual(siteStatusPresentation(true, true, false), {
		className: 'LocalMediaProxy__Status--Enabled',
		label: 'Enabled',
	});
	assert.deepEqual(siteStatusPresentation(false, false, false), {
		className: 'LocalMediaProxy__Status--Disabled',
		label: 'Disabled',
	});
	assert.deepEqual(siteStatusPresentation(true, false, false), {
		className: 'LocalMediaProxy__Status--Warning',
		label: 'Not applied',
	});
	assert.deepEqual(siteStatusPresentation(false, true, true), {
		className: 'LocalMediaProxy__Status--Warning',
		label: 'Cleanup pending · Unsaved changes',
	});
});

test('maps actual site state to clear Overview proxy statuses', () => {
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({ applied: true, enabled: true })),
		{
			className: 'LocalMediaProxy__OverviewStatus--Active',
			detail: 'Enabled and applied.',
			label: 'Active',
		},
	);
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({ applied: false, enabled: false })),
		{
			className: 'LocalMediaProxy__OverviewStatus--Inactive',
			detail: 'Disabled and not applied.',
			label: 'Inactive',
		},
	);
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({
			applied: true,
			enabled: true,
			siteStatus: 'halted',
		})),
		{
			className: 'LocalMediaProxy__OverviewStatus--Inactive',
			detail: 'Enabled and applied, but the Local site is not running.',
			label: 'Inactive',
		},
	);
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({ applied: false, enabled: true })),
		{
			className: 'LocalMediaProxy__OverviewStatus--Attention',
			detail: 'Enabled, but proxy configuration is not applied.',
			label: 'Needs attention',
		},
	);
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({ applied: true, enabled: false })),
		{
			className: 'LocalMediaProxy__OverviewStatus--Attention',
			detail: 'Disabled, but proxy configuration is still applied.',
			label: 'Needs attention',
		},
	);
	assert.deepEqual(overviewProxyStatusPresentation(null), {
		className: 'LocalMediaProxy__OverviewStatus--Unavailable',
		detail: 'Proxy status could not be loaded.',
		label: 'Unavailable',
	});
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({
			applied: false,
			enabled: false,
			reason: 'This site uses an unsupported web server.',
			supported: false,
		})),
		{
			className: 'LocalMediaProxy__OverviewStatus--Unavailable',
			detail: 'This site uses an unsupported web server.',
			label: 'Unavailable',
		},
	);
	assert.deepEqual(
		overviewProxyStatusPresentation(createSiteState({
			applied: false,
			enabled: true,
			needsAttention: true,
			reason: 'Runtime cleanup cannot be verified.',
			supported: false,
		})),
		{
			className: 'LocalMediaProxy__OverviewStatus--Attention',
			detail: 'Runtime cleanup cannot be verified.',
			label: 'Needs attention',
		},
	);
});

test('builds Overview tooltip guidance for ready, blocked, enabled, and failed states', () => {
	const inactivePresentation = overviewProxyStatusPresentation(createSiteState({
		applied: false,
		enabled: false,
	}));
	const unsupportedState = createSiteState({
		applied: false,
		canEnable: false,
		enabled: false,
		enableUnavailableReason: undefined,
		reason: 'This site uses an unsupported web server.',
		serverKind: 'unsupported',
		supported: false,
	});
	const unsupportedAttentionState = createSiteState({
		applied: false,
		canEnable: false,
		enabled: false,
		needsAttention: true,
		reason: 'Runtime cleanup requires attention.',
		serverKind: 'unsupported',
		supported: false,
	});
	assert.match(
		overviewProxyStatusGuidance(
			createSiteState({ applied: false, enabled: false }),
			inactivePresentation,
		),
		/Turn this on to apply the saved Nginx connection profile/,
	);
	assert.match(
		overviewProxyStatusGuidance(
			createSiteState({
				applied: false,
				canEnable: false,
				enabled: false,
				enableUnavailableReason: 'Save a valid Apache URL first.',
				requiresOriginIp: false,
				serverKind: 'apache',
			}),
			inactivePresentation,
		),
		/Save a valid Apache URL first/,
	);
	assert.match(
		overviewProxyStatusGuidance(
			createSiteState({ applied: true, enabled: true }),
			overviewProxyStatusPresentation(createSiteState({ applied: true, enabled: true })),
		),
		/Turn this off.*saved Nginx connection profile will be preserved/,
	);
	assert.match(
		overviewProxyStatusGuidance(null, inactivePresentation, 'Apply failed.'),
		/Apply failed.*Tools → Media Proxy/,
	);
	assert.equal(
		overviewProxyStatusGuidance(
			unsupportedState,
			overviewProxyStatusPresentation(unsupportedState),
		),
		'This site uses an unsupported web server. Select a supported web server in Local before configuring Media Proxy.',
	);
	assert.doesNotMatch(
		overviewProxyStatusGuidance(
			unsupportedState,
			overviewProxyStatusPresentation(unsupportedState),
		),
		/Runtime cleanup|current-server/,
	);
	assert.match(
		overviewProxyStatusGuidance(
			unsupportedAttentionState,
			overviewProxyStatusPresentation(unsupportedAttentionState),
		),
		/Tools → Media Proxy.*current web server profile and retry/,
	);
});

test('fingerprints the web server and service metadata in stable key order', () => {
	const first = siteServerFingerprint({
		id: 'site-a',
		services: {
			php: { name: 'php', role: 'php', version: '8.4' },
			nginx: { id: 'nginx-id', name: 'nginx', role: 'http', version: '1.27' },
		},
		webServer: 'nginx',
	});
	const reordered = siteServerFingerprint({
		id: 'site-a',
		services: {
			nginx: { id: 'nginx-id', name: 'nginx', role: 'http', version: '1.27' },
			php: { name: 'php', role: 'php', version: '8.4' },
		},
		webServer: 'nginx',
	});

	assert.equal(first, reordered);
	assert.notEqual(first, siteServerFingerprint({
		id: 'site-a',
		services: {
			apache: { id: 'apache-id', name: 'apache', role: 'http', version: '2.4' },
		},
		webServer: 'apache',
	}));
});

test('registers a keyed native Overview row while keeping controls in Tools', async () => {
	const pendingState = deferred();
	const { contentHooks, filters, React } = createRendererRegistration(
		() => pendingState.promise,
	);
	const overviewHook = contentHooks.get('SiteInfoOverview_TableList');

	assert.equal(typeof overviewHook, 'function');
	const element = overviewHook({ id: 'site-a', name: 'Example site' }, 'running');
	assert.equal(typeof element.type, 'function');
	assert.equal(element.key, 'local-media-proxy-overview-status-site-a');
	assert.deepEqual(element.props.site, { id: 'site-a', name: 'Example site' });
	assert.equal(element.props.siteStatus, 'running');

	const harness = createHookHarness(React);
	let tree = harness.render(element.type, element.props);
	assert.equal(tree.type, 'li');
	assert.equal(tree.props.className, 'TableListRow LocalMediaProxy LocalMediaProxy--OverviewRow');
	assert.equal(tree.props.children[0].type, 'strong');
	assert.equal(elementText(tree.props.children[0]), 'Media Proxy');
	assert.equal(tree.props.children[1].type, 'div');
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(
		findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'),
		null,
	);
	const loading = findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview');
	assertNativeLoadingIndicator(loading, 'LocalMediaProxy__LoadingIndicator--Overview');
	assert.equal(
		elementText(findElement(tree, (node) => node.props?.role === 'status')),
		'Checking Media Proxy status.',
	);

	pendingState.resolve(createSiteState({ applied: false, enabled: false }));
	await flushPromises();
	tree = harness.render(element.type, element.props);
	const toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.ok(toggle);
	assert.equal(toggle.props['aria-checked'], false);
	assert.equal(toggle.props['aria-labelledby'], 'local-media-proxy-overview-label-site-a');
	assert.equal(toggle.props.disabled, false);
	assert.equal(elementText(toggle), 'Off');
	const info = findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details');
	assert.ok(info);
	assert.equal(info.type, 'button');
	assert.equal(info.props.disabled, undefined);
	const infoIcon = findElement(info, (node) => (
		node.type === 'svg' && node.props?.className === 'LocalMediaProxy__OverviewInfoIcon'
	));
	assert.ok(infoIcon);
	assert.equal(infoIcon.props.height, 18);
	assert.equal(infoIcon.props.width, 18);
	assert.equal(infoIcon.props.viewBox, '0 0 18 18');
	assert.equal(infoIcon.props.children.type, 'path');
	assert.equal(infoIcon.props.children.props.clipRule, 'evenodd');
	assert.equal(infoIcon.props.children.props.fillRule, 'evenodd');
	assert.equal(
		infoIcon.props.children.props.d,
		'M9 16C12.866 16 16 12.866 16 9C16 5.13401 12.866 2 9 2C5.13403 2 2 5.13401 2 9C2 12.866 5.13403 16 9 16ZM9 18C13.9705 18 18 13.9706 18 9C18 4.02943 13.9705 0 9 0C4.02954 0 0 4.02943 0 9C0 13.9706 4.02954 18 9 18ZM7.875 8C7.32275 8 6.875 8.44772 6.875 9C6.875 9.55228 7.32275 10 7.875 10H8V12.9375C8 13.4898 8.44775 13.9375 9 13.9375C9.55225 13.9375 10 13.4898 10 12.9375V9C10 8.44772 9.55225 8 9 8H7.875ZM9 6.75C9.62134 6.75 10.125 6.24632 10.125 5.625C10.125 5.00368 9.62134 4.5 9 4.5C8.37866 4.5 7.875 5.00368 7.875 5.625C7.875 6.24632 8.37866 6.75 9 6.75Z',
	);
	const status = findElement(tree, (node) => node.props?.role === 'status');
	assert.ok(status);
	assert.equal(status.props['aria-atomic'], true);
	assert.equal(status.props['aria-live'], 'polite');
	assert.equal(elementText(status), 'Inactive: Disabled and not applied.');
	assert.equal(findElement(tree, (node) => node.props?.role === 'tooltip'), null);
	assert.equal(findElement(tree, (node) => node.type === 'section'), null);

	const tooltipAnchor = findElement(tree, (node) => (
		node.props?.className === 'LocalMediaProxy__OverviewTooltipAnchor'
	));
	tooltipAnchor.props.onFocus();
	tree = harness.render(element.type, element.props);
	const tooltip = findElement(tree, (node) => node.props?.role === 'tooltip');
	assert.ok(tooltip);
	assert.equal(tooltip.props.id, 'local-media-proxy-overview-tooltip-site-a');
	assert.match(elementText(tooltip), /Turn this on to apply the saved Nginx connection profile/);
	assert.equal(
		findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details').props['aria-describedby'],
		tooltip.props.id,
	);
	tooltipAnchor.props.onKeyDown({ key: 'Escape' });
	tree = harness.render(element.type, element.props);
	assert.equal(findElement(tree, (node) => node.props?.role === 'tooltip'), null);

	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;
	let tooltipDelay;
	let showTooltip;
	global.setTimeout = (callback, delay) => {
		showTooltip = callback;
		tooltipDelay = delay;
		return 1;
	};
	global.clearTimeout = () => {};
	try {
		tooltipAnchor.props.onMouseEnter();
		assert.equal(tooltipDelay, 300);
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'tooltip'), null);
		showTooltip();
		tree = harness.render(element.type, element.props);
		assert.ok(findElement(tree, (node) => node.props?.role === 'tooltip'));
		tooltipAnchor.props.onMouseLeave();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'tooltip'), null);
	} finally {
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}

	const toolsFilter = filters.get('siteInfoToolsItem');
	assert.equal(typeof toolsFilter, 'function');
	const menu = toolsFilter([]);
	assert.equal(menu.length, 1);
	assert.equal(menu[0].menuItem, 'Media Proxy');
	assert.equal(menu[0].path, '/local-media-proxy');
});

test('refreshes Overview status for site changes and ignores stale IPC responses', async () => {
	const firstState = deferred();
	const secondState = deferred();
	const calls = [];
	const { contentHooks, React } = createRendererRegistration((channel, siteId) => {
		calls.push([channel, siteId]);
		return siteId === 'site-a' ? firstState.promise : secondState.promise;
	});
	const overviewHook = contentHooks.get('SiteInfoOverview_TableList');
	const firstElement = overviewHook({ id: 'site-a' }, 'running');
	const harness = createHookHarness(React);

	let tree = harness.render(firstElement.type, firstElement.props);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Checking Media Proxy status.');

	const secondProps = { site: { id: 'site-b' }, siteStatus: 'running' };
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Checking Media Proxy status.');
	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-b'],
	]);

	secondState.resolve(createSiteState({ applied: true, enabled: true }));
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props['aria-checked'], true);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Active: Enabled and applied.');

	firstState.resolve(createSiteState({ applied: false, enabled: false }));
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props['aria-checked'], true);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Active: Enabled and applied.');
});

test('refreshes Overview status when the Local site status changes', async () => {
	const calls = [];
	const { contentHooks, React } = createRendererRegistration(async (channel, siteId) => {
		calls.push([channel, siteId]);
		return createSiteState({
			applied: true,
			enabled: true,
			siteStatus: calls.length === 1 ? 'running' : 'halted',
		});
	});
	const overviewHook = contentHooks.get('SiteInfoOverview_TableList');
	const runningElement = overviewHook({ id: 'site-a' }, 'running');
	const harness = createHookHarness(React);

	harness.render(runningElement.type, runningElement.props);
	await flushPromises();
	let tree = harness.render(runningElement.type, runningElement.props);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Active: Enabled and applied.');

	const haltedElement = overviewHook({ id: 'site-a' }, 'halted');
	tree = harness.render(haltedElement.type, haltedElement.props);
	assertNativeLoadingIndicator(
		findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'),
		'LocalMediaProxy__LoadingIndicator--Overview',
	);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(
		findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'),
		null,
	);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Checking Media Proxy status.');
	await flushPromises();
	tree = harness.render(haltedElement.type, haltedElement.props);

	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-a'],
	]);
	assert.equal(
		elementText(findElement(tree, (node) => node.props?.role === 'status')),
		'Inactive: Enabled and applied, but the Local site is not running.',
	);
});

test('keeps Overview reads and controls out of Local lifecycle transitions', () => {
	for (const status of [
		'creating',
		'provisioning',
		'pulling_provisioning',
		'pulling_finalizing',
		'deleting',
		'future_local_status',
	]) {
		const calls = [];
		const { contentHooks, React } = createRendererRegistration((...args) => {
			calls.push(args);
			return Promise.resolve(createSiteState({ applied: false, enabled: false }));
		});
		const overviewHook = contentHooks.get('SiteInfoOverview_TableList');
		const element = overviewHook({ id: `site-${status}` }, status);
		const harness = createHookHarness(React);
		const tree = harness.render(element.type, element.props);

		assert.deepEqual(calls, [], `${status} must not invoke Media Proxy IPC`);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(
			findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'),
			null,
		);
		assert.equal(
			findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'),
			null,
			`${status} must not show an unbounded Media Proxy loader`,
		);
		assert.match(
			elementText(findElement(tree, (node) => node.props?.role === 'status')),
			/Local is .*Media Proxy will|will not access its files/i,
		);
	}
});

test('refreshes Overview state when same-site web-server metadata changes', async () => {
	const calls = [];
	const { contentHooks, React } = createRendererRegistration(async (channel, siteId) => {
		calls.push([channel, siteId]);
		return calls.length === 1
			? createSiteState({ applied: false, enabled: false })
			: createSiteState({
				applied: false,
				enabled: false,
				requiresOriginIp: false,
				serverKind: 'apache',
			});
	});
	const overviewHook = contentHooks.get('SiteInfoOverview_TableList');
	const firstElement = overviewHook({
		id: 'site-a',
		services: { nginx: { name: 'nginx', role: 'http', version: '1.27' } },
		webServer: 'nginx',
	}, 'running');
	const harness = createHookHarness(React);

	harness.render(firstElement.type, firstElement.props);
	await flushPromises();
	let tree = harness.render(firstElement.type, firstElement.props);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, false);

	const apacheProps = {
		site: {
			id: 'site-a',
			services: { apache: { name: 'apache', role: 'http', version: '2.4' } },
			webServer: 'apache',
		},
		siteStatus: 'running',
	};
	tree = harness.render(firstElement.type, apacheProps);
	assertNativeLoadingIndicator(
		findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'),
		'LocalMediaProxy__LoadingIndicator--Overview',
	);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(
		findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'),
		null,
	);
	assert.equal(
		elementText(findElement(tree, (node) => node.props?.role === 'status')),
		'Checking Media Proxy status.',
	);
	await flushPromises();
	tree = harness.render(firstElement.type, apacheProps);

	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-a'],
	]);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, false);
});

test('auto-saves the Overview switch through the guarded enabled-intent IPC', async () => {
	const toggled = deferred();
	const calls = [];
	const initialState = createSiteState({ applied: false, enabled: false });
	const { contentHooks, React } = createRendererRegistration((channel, ...args) => {
		calls.push([channel, ...args]);
		if (channel === IPC_CHANNELS.setEnabled) {
			return toggled.promise;
		}
		return Promise.resolve(initialState);
	});
	const overviewHook = contentHooks.get('SiteInfoOverview_TableList');
	const element = overviewHook({ id: 'site-a' }, 'running');
	const harness = createHookHarness(React);

	harness.render(element.type, element.props);
	await flushPromises();
	let tree = harness.render(element.type, element.props);
	let toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, false);
	assert.equal(toggle.props['aria-checked'], false);
	assert.ok(toggle.props.ref && Object.hasOwn(toggle.props.ref, 'current'));
	toggle.props.onClick({ currentTarget: { id: 'overview-initiator' } });

	tree = harness.render(element.type, element.props);
	toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle, null);
	assertNativeLoadingIndicator(
		findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'),
		'LocalMediaProxy__LoadingIndicator--Overview',
	);
	assert.equal(findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'), null);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Toggling Media Proxy status.');
	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.setEnabled, 'site-a', 'nginx', true],
	]);

	toggled.resolve(createSiteState({ applied: true, enabled: true }));
	await flushPromises();
	tree = harness.render(element.type, element.props);
	toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, false);
	assert.equal(toggle.props['aria-checked'], true);
});

test('fails closed immediately when an Overview mutation reaches its deadline', async () => {
	const timers = installManualTimers();
	const mutation = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const hypotheticalState = createSiteState({ applied: true, enabled: true });
	let stateReads = 0;
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				stateReads += 1;
				return Promise.resolve(stateReads === 1 ? initialState : hypotheticalState);
			}
			if (channel === IPC_CHANNELS.setEnabled) {
				return mutation.promise;
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.contentHooks.get('SiteInfoOverview_TableList')(
			{ id: 'site-a' },
			'running',
		);
		const harness = createHookHarness(registration.React);

		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.props?.role === 'switch').props.onClick();
		tree = harness.render(element.type, element.props);
		assert.ok(findElement(tree, (node) => node.props?.className?.includes('LoadingIndicator--Overview')));

		timers.runNext(IPC_MUTATION_DEADLINE_MS);
		await flushPromises();
		assert.equal(stateReads, 1);
		tree = harness.render(element.type, element.props);
		assert.equal(
			findElement(tree, (node) => node.props?.className?.includes('LoadingIndicator--Overview')),
			null,
		);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(
			findElement(tree, (node) => node.props?.className?.includes('LocalMediaProxy__OverviewControls'))
				.props['aria-busy'],
			false,
		);
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'alert')), /outcome is unconfirmed/i);
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'tooltip')), /outcome is unconfirmed/i);

		mutation.resolve(createSiteState({ applied: true, enabled: true }));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(stateReads, 1);
	} finally {
		timers.restore();
	}
});

test('clears Overview progress on backend rejection while bounded recovery restores authoritative state', async () => {
	const timers = installManualTimers();
	const initialState = createSiteState({ applied: false, enabled: false });
	const recoveredState = createSiteState({ applied: true, enabled: true });
	const recovery = deferred();
	let stateReads = 0;
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				stateReads += 1;
				return stateReads === 1 ? Promise.resolve(initialState) : recovery.promise;
			}
			if (channel === IPC_CHANNELS.setEnabled) {
				return Promise.reject(new Error(
					"Error invoking remote method 'local-media-proxy:set-enabled': Error: Apply failed.",
				));
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.contentHooks.get('SiteInfoOverview_TableList')(
			{ id: 'site-a' },
			'running',
		);
		const harness = createHookHarness(registration.React);

		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.props?.role === 'switch').props.onClick();
		tree = harness.render(element.type, element.props);
		assertNativeLoadingIndicator(
			findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'),
			'LocalMediaProxy__LoadingIndicator--Overview',
		);

		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(stateReads, 2);
		assert.equal(findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'alert')), 'Apply failed.');
		assert.match(
			elementText(findElement(tree, (node) => node.props?.role === 'tooltip')),
			/Apply failed.*Tools → Media Proxy/,
		);
		assert.ok([...timers.timers.values()].some(({ delay }) => delay === IPC_READ_DEADLINE_MS));

		recovery.resolve(recoveredState);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props['aria-checked'], true);
		assert.equal(findLoadingIndicator(tree, 'LocalMediaProxy__LoadingIndicator--Overview'), null);
	} finally {
		timers.restore();
	}
});

test('keeps invalid-profile Overview guidance available and gates both switch directions', async () => {
	const blockedState = createSiteState({
		applied: false,
		canEnable: false,
		enabled: false,
		enableUnavailableReason: 'Save a valid Nginx Site URL and Remote IP first.',
	});
	const blockedRegistration = createRendererRegistration(async () => blockedState);
	const blockedElement = blockedRegistration.contentHooks.get('SiteInfoOverview_TableList')(
		{ id: 'site-blocked' },
		'running',
	);
	const blockedHarness = createHookHarness(blockedRegistration.React);
	blockedHarness.render(blockedElement.type, blockedElement.props);
	await flushPromises();
	let tree = blockedHarness.render(blockedElement.type, blockedElement.props);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
	const info = findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details');
	assert.equal(info.props.disabled, undefined);
	findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__OverviewTooltipAnchor').props.onFocus();
	tree = blockedHarness.render(blockedElement.type, blockedElement.props);
	assert.match(
		elementText(findElement(tree, (node) => node.props?.role === 'tooltip')),
		/Save a valid Nginx Site URL and Remote IP first/,
	);

	const incompleteEnabledRegistration = createRendererRegistration(async () => createSiteState({
		applied: false,
		canEnable: false,
		cleanupSupported: true,
		enabled: true,
		enableUnavailableReason: 'Save the current Apache profile first.',
		requiresOriginIp: false,
		serverKind: 'apache',
	}));
	const cleanupElement = incompleteEnabledRegistration.contentHooks.get('SiteInfoOverview_TableList')(
		{ id: 'site-cleanup' },
		'running',
	);
	const cleanupHarness = createHookHarness(incompleteEnabledRegistration.React);
	cleanupHarness.render(cleanupElement.type, cleanupElement.props);
	await flushPromises();
	tree = cleanupHarness.render(cleanupElement.type, cleanupElement.props);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
	findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__OverviewTooltipAnchor').props.onFocus();
	tree = cleanupHarness.render(cleanupElement.type, cleanupElement.props);
	assert.match(
		elementText(findElement(tree, (node) => node.props?.role === 'tooltip')),
		/enabled intent is still on.*Apache connection profile is incomplete.*Save the current Apache profile first/i,
	);
});

test('times out the initial Overview read without exposing a false Off switch', async () => {
	const timers = installManualTimers();
	const pending = deferred();
	try {
		const registration = createRendererRegistration(() => pending.promise);
		const element = registration.contentHooks.get('SiteInfoOverview_TableList')(
			{ id: 'site-timeout' },
			'running',
		);
		const harness = createHookHarness(registration.React);
		let tree = harness.render(element.type, element.props);
		assert.ok(findElement(tree, (node) => node.props?.className?.includes('LoadingIndicator--Overview')));
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'), null);

		timers.runNext(IPC_READ_DEADLINE_MS);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.className?.includes('LoadingIndicator--Overview')), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.ok(findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'));
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'alert')), /status is unconfirmed/i);

		pending.resolve(createSiteState({ applied: true, enabled: true }));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	} finally {
		timers.restore();
	}
});

test('renders unavailable Overview status for IPC failure and unsupported sites', async () => {
	const failureRegistration = createRendererRegistration(async () => {
		throw new Error('IPC failed');
	});
	const failureHook = failureRegistration.contentHooks.get('SiteInfoOverview_TableList');
	const failureElement = failureHook({ id: 'site-failure' }, 'running');
	const failureHarness = createHookHarness(failureRegistration.React);
	failureHarness.render(failureElement.type, failureElement.props);
	await flushPromises();
	let tree = failureHarness.render(failureElement.type, failureElement.props);
	assert.equal(
		elementText(findElement(tree, (node) => node.props?.role === 'status')),
		'Unavailable: Proxy status could not be loaded.',
	);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.ok(findElement(tree, (node) => node.props?.['aria-label'] === 'Media proxy status details'));
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'alert')), 'IPC failed');
	assert.match(elementText(findElement(tree, (node) => node.props?.role === 'tooltip')), /IPC failed.*retry/);

	const unsupportedRegistration = createRendererRegistration(async () => createSiteState({
		applied: false,
		canEnable: false,
		enabled: false,
		reason: 'This site uses an unsupported web server.',
		serverKind: 'unsupported',
		supported: false,
	}));
	const unsupportedHook = unsupportedRegistration.contentHooks.get('SiteInfoOverview_TableList');
	const unsupportedElement = unsupportedHook({ id: 'site-unsupported' }, 'halted');
	const unsupportedHarness = createHookHarness(unsupportedRegistration.React);
	unsupportedHarness.render(unsupportedElement.type, unsupportedElement.props);
	await flushPromises();
	tree = unsupportedHarness.render(unsupportedElement.type, unsupportedElement.props);
	assert.equal(
		elementText(findElement(tree, (node) => node.props?.role === 'status')),
		'Unavailable: This site uses an unsupported web server.',
	);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
	findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__OverviewTooltipAnchor').props.onFocus();
	tree = unsupportedHarness.render(unsupportedElement.type, unsupportedElement.props);
	const unsupportedTooltip = elementText(findElement(tree, (node) => node.props?.role === 'tooltip'));
	assert.equal(
		unsupportedTooltip,
		'This site uses an unsupported web server. Select a supported web server in Local before configuring Media Proxy.',
	);
	assert.doesNotMatch(unsupportedTooltip, /current-server/);
});

test('scopes compact Overview switch and tooltip styles for light and dark themes', () => {
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
	const overviewRules = [...stylesheet.matchAll(/([^{}]+Overview[^{}]+)\s*\{[^{}]*\}/g)]
		.map((match) => match[1].trim());
	const rule = (selector) => {
		const start = stylesheet.indexOf(`${selector} {`);
		assert.notEqual(start, -1, `missing ${selector}`);
		const end = stylesheet.indexOf('}', start);
		assert.notEqual(end, -1, `unterminated ${selector}`);
		return stylesheet.slice(start, end + 1);
	};

	assert.ok(overviewRules.length >= 12);
	for (const selector of overviewRules) {
		assert.match(selector, /\.LocalMediaProxy/);
	}
	assert.match(
		stylesheet,
		/\.LocalMediaProxy\.LocalMediaProxy--OverviewRow \{[\s\S]{0,160}max-width: none;[\s\S]{0,80}padding: 0;/,
	);
	const controls = rule('.LocalMediaProxy .LocalMediaProxy__OverviewControls');
	assert.match(controls, /align-items: center;/);
	assert.match(controls, /gap: 0;/);

	const overviewSwitch = rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitch');
	assert.match(overviewSwitch, /background: #c7c4c4;/);
	assert.match(overviewSwitch, /border-radius: 1\.6em;/);
	assert.match(overviewSwitch, /box-shadow: none;/);
	assert.match(overviewSwitch, /box-sizing: border-box;/);
	assert.match(overviewSwitch, /font-family: "Museo Sans Rounded", sans-serif;/);
	assert.match(overviewSwitch, /font-size: 10px;/);
	assert.match(overviewSwitch, /height: 20px;/);
	assert.match(overviewSwitch, /padding: \.5em;/);
	assert.match(overviewSwitch, /transition: background 200ms ease 0ms;/);
	assert.match(overviewSwitch, /width: 48px;/);

	const knob = rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitch::before');
	assert.match(knob, /box-shadow: none;/);
	assert.match(knob, /display: block;/);
	assert.match(knob, /height: 12px;/);
	assert.match(knob, /left: 0;/);
	assert.match(knob, /position: relative;/);
	assert.match(knob, /top: -1px;/);
	assert.match(knob, /transition: left 200ms ease 0ms;/);
	assert.match(knob, /width: 12px;/);

	const label = rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitchLabel');
	assert.match(label, /font-size: 11px;/);
	assert.match(label, /font-weight: 900;/);
	assert.match(label, /left: 20px;/);
	assert.match(label, /line-height: 22px;/);
	assert.match(label, /top: 0;/);

	assert.match(rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitch--Checked'), /background: #267048;/);
	assert.match(
		rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitch--Checked::before'),
		/left: calc\(100% - 12px\);/,
	);
	const checkedLabel = rule('.LocalMediaProxy .LocalMediaProxy__OverviewSwitch--Checked .LocalMediaProxy__OverviewSwitchLabel');
	assert.match(checkedLabel, /left: 8px;/);
	assert.match(checkedLabel, /top: -1px;/);
	assert.match(rule('.Theme__Dark .LocalMediaProxy .LocalMediaProxy__OverviewSwitch'), /background: #434344;/);
	assert.match(rule('.Theme__Dark .LocalMediaProxy .LocalMediaProxy__OverviewSwitch--Checked'), /background: #51bb7b;/);

	const tooltipAnchor = rule('.LocalMediaProxy .LocalMediaProxy__OverviewTooltipAnchor');
	assert.match(tooltipAnchor, /align-items: center;/);
	assert.match(tooltipAnchor, /margin-left: 10px;/);
	const infoButton = rule('.LocalMediaProxy .LocalMediaProxy__OverviewInfoButton');
	assert.match(infoButton, /color: #5d5e5e;/);
	assert.match(infoButton, /height: 18px;/);
	assert.match(infoButton, /padding: 0;/);
	assert.match(infoButton, /width: 18px;/);
	const infoIcon = rule('.LocalMediaProxy .LocalMediaProxy__OverviewInfoIcon');
	assert.match(infoIcon, /fill: currentColor;/);
	assert.match(infoIcon, /height: 18px;/);
	assert.match(infoIcon, /width: 18px;/);

	const tooltip = rule('.LocalMediaProxy .LocalMediaProxy__OverviewTooltip');
	assert.match(tooltip, /background: #ffffff;/);
	assert.match(tooltip, /animation: LocalMediaProxyTooltipEnter 120ms cubic-bezier\(\.2, \.3, \.25, \.9\) both;/);
	assert.match(tooltip, /border: 1px solid #e7e7e7;/);
	assert.match(tooltip, /border-radius: 4px;/);
	assert.match(tooltip, /bottom: calc\(100% \+ 10px\);/);
	assert.match(tooltip, /box-shadow: 0 0 5px 0 rgb\(0 0 0 \/ 14%\);/);
	assert.match(tooltip, /color: #434344;/);
	assert.match(tooltip, /font-size: 14px;/);
	assert.match(tooltip, /font-weight: 300;/);
	assert.match(tooltip, /max-width: 250px;/);
	assert.match(tooltip, /padding: 10px 15px;/);
	assert.match(tooltip, /text-align: center;/);
	assert.match(tooltip, /transform-origin: 50% 100%;/);

	const tooltipArrow = rule('.LocalMediaProxy .LocalMediaProxy__OverviewTooltip::after');
	assert.match(tooltipArrow, /border-radius: 0 0 4px 0;/);
	assert.match(tooltipArrow, /bottom: -8px;/);
	assert.match(tooltipArrow, /clip-path: polygon\(-100% 200%, 200% -100%, 200% 200%\);/);
	assert.match(tooltipArrow, /height: 16px;/);
	assert.match(tooltipArrow, /left: calc\(50% - 8px\);/);
	assert.match(tooltipArrow, /width: 16px;/);
	const darkTooltip = rule('.Theme__Dark .LocalMediaProxy .LocalMediaProxy__OverviewTooltip');
	assert.match(darkTooltip, /background: #262727;/);
	assert.match(darkTooltip, /border-color: #5d5e5e;/);
	assert.match(darkTooltip, /color: #c7c4c4;/);
	assert.match(rule('.Theme__Dark .LocalMediaProxy .LocalMediaProxy__OverviewInfoButton'), /color: #9f9c9c;/);
	assert.match(stylesheet, /\.LocalMediaProxy \.LocalMediaProxy__OverviewSwitch:focus-visible/);
	assert.match(stylesheet, /outline: 5px auto -webkit-focus-ring-color;/);
	assert.doesNotMatch(stylesheet, /LocalMediaProxy__OverviewBadge|LocalMediaProxy__OverviewDetail/);
	assert.doesNotMatch(stylesheet, /OverviewStatus--Attention \.LocalMediaProxy__OverviewInfoButton/);
});

test('covers the scoped native two-dot loading adaptation and reduced-motion support', () => {
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
	const rule = (selector) => {
		const start = stylesheet.indexOf(`${selector} {`);
		assert.notEqual(start, -1, `missing ${selector}`);
		const end = stylesheet.indexOf('}', start);
		return stylesheet.slice(start, end + 1);
	};
	const indicator = rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator');
	assert.match(indicator, /display: inline-block;/);
	assert.match(indicator, /height: 16px;/);
	assert.match(indicator, /margin: 0 auto;/);
	assert.match(indicator, /text-align: center;/);
	assert.match(indicator, /vertical-align: middle;/);
	assert.match(indicator, /width: auto;/);
	assert.doesNotMatch(indicator, /line-height/);

	const dot = rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator > div');
	assert.match(dot, /animation: LocalMediaProxy__loadingBounce 1\.4s infinite ease-in-out both;/);
	assert.match(dot, /border-radius: 100%;/);
	assert.match(dot, /display: inline-block;/);
	assert.match(dot, /height: 9px;/);
	assert.match(dot, /margin: 0 4px;/);
	assert.match(dot, /width: 9px;/);
	assert.match(
		rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator--Gray > div'),
		/background-color: #c7c4c4;/,
	);
	assert.match(rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator > div:first-child'), /animation-delay: -0\.32s;/);
	assert.match(rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator > div:nth-child(2)'), /animation-delay: -0\.16s;/);
	assert.match(rule('.LocalMediaProxy .LocalMediaProxy__LoadingIndicator--Overview'), /margin: 0 14px 0 0;/);
	assert.match(stylesheet, /0%,\s*80%,\s*100% \{\s*transform: scale\(0\);/);
	assert.match(stylesheet, /40% \{\s*transform: scale\(1\);/);
	assert.match(stylesheet, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.LocalMediaProxy \.LocalMediaProxy__LoadingIndicator > div \{\s*animation: none;\s*transform: scale\(1\);/);
	assert.doesNotMatch(stylesheet, /Theme__Dark[^{}]*Loading(?:Indicator|Dot)/);
});

test('renders action feedback immediately above the action row with accessible announcements', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
	const unsupportedWarningIndex = rendererSource.indexOf('siteState?.supported === false && e(');
	const cardIndex = rendererSource.indexOf("{ className: 'LocalMediaProxy__Card' }");
	const fieldsIndex = rendererSource.indexOf("{ className: 'LocalMediaProxy__Fields' }");
	const feedbackIndex = rendererSource.indexOf('notice && e(', cardIndex);
	const actionsIndex = rendererSource.indexOf("{ className: 'LocalMediaProxy__Actions' }");

	assert.ok(unsupportedWarningIndex >= 0 && unsupportedWarningIndex < cardIndex);
	assert.ok(cardIndex >= 0 && cardIndex < fieldsIndex);
	assert.ok(fieldsIndex < feedbackIndex);
	assert.ok(feedbackIndex < actionsIndex);
	assert.match(
		rendererSource.slice(feedbackIndex, actionsIndex),
		/'aria-live': notice\.variant === 'error' \? undefined : 'polite',[\s\S]*role: notice\.variant === 'error' \? 'alert' : 'status',[\s\S]*tabIndex: -1/,
	);
	assert.match(
		stylesheet,
		/\.LocalMediaProxy__ActionFeedback \+ \.LocalMediaProxy__Actions \{\s*margin-top: 0;\s*\}/,
	);
});

test('keeps action feedback until a relevant change or the next action', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const toolsToggleStart = rendererSource.indexOf('const toggleEnabled = async (\n\t\t\tnextEnabled: boolean,');
	const toolsToggleTry = rendererSource.indexOf('\n\t\t\ttry {', toolsToggleStart);
	const saveStart = rendererSource.indexOf('const saveSettings = async (initiator: FocusTargetLike | null)');
	const saveTry = rendererSource.indexOf('\n\t\t\ttry {', saveStart);

	assert.doesNotMatch(rendererSource, /const editEnabled|onClick: \(\) => editEnabled/);
	assert.ok(toolsToggleStart >= 0 && toolsToggleTry > toolsToggleStart);
	assert.match(rendererSource.slice(toolsToggleStart, toolsToggleTry), /setNotice\(null\);/);
	assert.ok(saveStart >= 0 && saveTry > saveStart);
	assert.match(rendererSource.slice(saveStart, saveTry), /setNotice\(null\);/);
	assert.match(
		rendererSource,
		/const editSiteUrl = \(value: string\): void => \{[\s\S]{0,220}setSiteUrl\(value\);[\s\S]{0,120}clearActionFeedback\(\);[\s\S]{0,120}if \(preservesOriginIdentity\)/,
	);
	assert.match(
		rendererSource,
		/const invalidateTest = \(\): void => \{[\s\S]{0,120}setTestedDraftKey\(null\);[\s\S]{0,120}clearActionFeedback\(\);/,
	);
	assert.match(rendererSource, /setSelectedEnvironment\(event\.target\.value\);[\s\S]{0,160}invalidateTest\(\);/);
	assert.match(rendererSource, /const chooseCandidate[\s\S]{0,300}invalidateTest\(\);/);
	assert.match(rendererSource, /const discover[\s\S]{0,300}setNotice\(null\);/);
	assert.match(rendererSource, /const testConnection[\s\S]{0,300}setNotice\(null\);/);
});

test('tracks mutation initiators and wires restored focus targets through refs', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');

	assert.match(rendererSource, /const overviewInfoRef = React\.useRef/);
	assert.match(rendererSource, /const overviewSwitchRef = React\.useRef/);
	assert.match(rendererSource, /const actionFeedbackRef = React\.useRef/);
	assert.match(rendererSource, /const enableSwitchRef = React\.useRef/);
	assert.match(rendererSource, /const saveButtonRef = React\.useRef/);
	assert.match(rendererSource, /const pendingFocusHandoff = React\.useRef/);

	assert.match(
		rendererSource,
		/const toggleEnabled = async \(initiator: FocusTargetLike \| null\): Promise<void> => \{[\s\S]*?pendingFocusHandoff\.current = \{\s*identity: statusIdentity,\s*initiator,\s*kind: 'toggle',\s*\};/,
	);
	assert.match(
		rendererSource,
		/onClick: \(event\?: \{ currentTarget\?: FocusTargetLike \}\) => void toggleEnabled\(\s*event\?\.currentTarget \?\? overviewSwitchRef\.current,\s*\),\s*ref: overviewSwitchRef/,
	);
	assert.match(
		rendererSource,
		/handoffFocusAfterRemovedControl\([\s\S]*?pending\.initiator,\s*overviewSwitchRef\.current,\s*overviewInfoRef\.current,\s*\);/,
	);

	assert.match(
		rendererSource,
		/const saveSettings = async \(initiator: FocusTargetLike \| null\): Promise<void> => \{[\s\S]*?pendingFocusHandoff\.current = \{\s*identity: panelIdentity,\s*initiator,\s*kind: 'save',\s*\};/,
	);
	assert.match(
		rendererSource,
		/const toggleEnabled = async \(\s*nextEnabled: boolean,\s*initiator: FocusTargetLike \| null,\s*\): Promise<void> => \{[\s\S]*?pendingFocusHandoff\.current = \{\s*identity: panelIdentity,\s*initiator,\s*kind: 'toggle',\s*\};/,
	);
	assert.match(
		rendererSource,
		/onClick: \(event\?: \{ currentTarget\?: FocusTargetLike \}\) => void toggleEnabled\(\s*!enabled,\s*event\?\.currentTarget \?\? enableSwitchRef\.current,\s*\),\s*ref: enableSwitchRef/,
	);
	assert.match(
		rendererSource,
		/onClick: \(event\?: \{ currentTarget\?: FocusTargetLike \}\) => void saveSettings\(\s*event\?\.currentTarget \?\? saveButtonRef\.current,\s*\),\s*ref: saveButtonRef/,
	);
	assert.match(
		rendererSource,
		/handoffFocusAfterRemovedControl\([\s\S]*?pending\.initiator,\s*pending\.kind === 'toggle' \? enableSwitchRef\.current : saveButtonRef\.current,\s*actionFeedbackRef\.current,\s*\);/,
	);
});

test('renders accessible candidate labels with family and TTL', () => {
	assert.equal(originCandidateLabel({
		address: '2001:db8::10',
		family: 6,
		source: 'public-dns',
		ttl: 120,
	}), '2001:db8::10 · IPv6 · TTL 120s');
});

test('requires an explicit choice for multiple or warned IP candidates', () => {
	const safeCandidate = {
		address: '93.184.216.34',
		family: 4,
		source: 'public-dns',
	};
	assert.equal(originCandidatesRequireSelection([safeCandidate]), false);
	assert.equal(originCandidatesRequireSelection([
		safeCandidate,
		{ ...safeCandidate, address: '93.184.216.35' },
	]), true);
	assert.equal(originCandidatesRequireSelection([{
		...safeCandidate,
		address: '127.0.0.1',
		warning: 'Private address',
	}]), true);
});

test('uses WP Engine controls only when provider discovery is available', () => {
	const base = {
		environments: [],
		message: 'Provider status',
	};

	assert.equal(originDiscoveryLayoutMode(null), 'pending');
	assert.equal(originDiscoveryLayoutMode({ ...base, canAutoPopulate: false, provider: 'none' }), 'manual');
	assert.equal(originDiscoveryLayoutMode({ ...base, canAutoPopulate: false, provider: 'flywheel' }), 'manual');
	assert.equal(originDiscoveryLayoutMode({ ...base, canAutoPopulate: false, provider: 'wpengine' }), 'manual');
	assert.equal(originDiscoveryLayoutMode({ ...base, canAutoPopulate: true, provider: 'wpengine' }), 'wpengine');
});

test('enables public DNS discovery only for a usable Site URL', () => {
	assert.equal(siteUrlIsUsableForDns(''), false);
	assert.equal(siteUrlIsUsableForDns('example.com'), false);
	assert.equal(siteUrlIsUsableForDns('ftp://example.com'), false);
	assert.equal(siteUrlIsUsableForDns('https://example.com/uploads/'), false);
	assert.equal(siteUrlIsUsableForDns('https://example.com'), true);
	assert.equal(siteUrlIsUsableForDns(' http://staging.example.com:8080/ '), true);
});

test('renders provider-aware controls and fields in accessible vertical order', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
	const connectionSetupIndex = rendererSource.indexOf("e('h3', null, 'Connection setup')");
	const wpEngineControlsIndex = rendererSource.indexOf("discoveryLayout === 'wpengine' && e(");
	const fieldsIndex = rendererSource.indexOf("{ className: 'LocalMediaProxy__Fields' }");
	const siteUrlLabelIndex = rendererSource.indexOf("htmlFor: `${ADDON_ID}-site-url`", fieldsIndex);
	const remoteIpLabelIndex = rendererSource.indexOf("htmlFor: `${ADDON_ID}-origin-ip`", fieldsIndex);
	const dnsButtonIndex = rendererSource.indexOf("? 'Finding…' : 'Find via public DNS')", remoteIpLabelIndex);
	const discoveryResultIndex = rendererSource.indexOf("{ className: 'LocalMediaProxy__DiscoveryResult' }", remoteIpLabelIndex);

	assert.ok(connectionSetupIndex >= 0 && connectionSetupIndex < wpEngineControlsIndex);
	assert.ok(wpEngineControlsIndex < fieldsIndex);
	assert.ok(fieldsIndex < siteUrlLabelIndex);
	assert.ok(siteUrlLabelIndex < remoteIpLabelIndex);
	assert.ok(remoteIpLabelIndex < dnsButtonIndex);
	assert.ok(dnsButtonIndex < discoveryResultIndex);
	assert.match(rendererSource, /discoveryLayout !== 'pending' && e\('button', \{[\s\S]{0,500}disabled: Boolean\(busy\) \|\| !supported \|\| !canDiscoverFromDns,[\s\S]{0,300}busy === 'discovering' \? 'Finding…' : 'Find via public DNS'/);
	assert.match(rendererSource, /e\('label', \{ htmlFor: `\$\{ADDON_ID\}-site-url` \}, 'Site URL'\)[\s\S]{0,800}id: `\$\{ADDON_ID\}-site-url`/);
	assert.match(rendererSource, /e\('label', \{ htmlFor: `\$\{ADDON_ID\}-origin-ip` \}, 'Remote IP address'\)[\s\S]{0,800}id: `\$\{ADDON_ID\}-origin-ip`/);
	assert.match(stylesheet, /\.LocalMediaProxy__Fields \{[\s\S]{0,220}grid-template-columns: minmax\(0, 1fr\);/);
	assert.match(stylesheet, /\.LocalMediaProxy__OriginIpRow \{[\s\S]{0,180}display: flex;/);
});

test('keeps public DNS available as a manual alternative for every resolved provider', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const dnsButtonGuard = "discoveryLayout !== 'pending' && e('button', {";

	assert.equal((rendererSource.match(/discoveryLayout !== 'pending'/g) ?? []).length, 2);
	assert.ok(rendererSource.includes(dnsButtonGuard));
	assert.match(rendererSource, /discoveryLayout !== 'pending' && e\(\s*'p',[\s\S]{0,180}id: `\$\{ADDON_ID\}-dns-help`/);
	assert.match(rendererSource, /busy === 'discovering' \? 'Finding…' : 'Find via public DNS'/);
	assert.doesNotMatch(rendererSource, /discoveryLayout === 'manual' && e\('button'/);
});

test('keeps provider suggestions editable and invalidates derived verification on manual edits', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const editSiteUrl = rendererSource.slice(
		rendererSource.indexOf('const editSiteUrl'),
		rendererSource.indexOf('const editOriginIp'),
	);
	const editOriginIp = rendererSource.slice(
		rendererSource.indexOf('const editOriginIp'),
		rendererSource.indexOf('const applySuggestion'),
	);
	const applySuggestionIndex = rendererSource.indexOf('const applySuggestion');
	const applySuggestion = rendererSource.slice(
		applySuggestionIndex,
		rendererSource.indexOf('const discover =', applySuggestionIndex),
	);

	assert.match(editSiteUrl, /setSiteUrl\(value\)/);
	assert.match(editSiteUrl, /setOriginSource\('manual'\)/);
	assert.match(editSiteUrl, /setOriginEnvironment\(undefined\)/);
	assert.match(editSiteUrl, /setOriginTlsHostname\(undefined\)/);
	assert.match(editSiteUrl, /setSuggestion\(null\)/);
	assert.match(editSiteUrl, /setSelectedCandidate\(''\)/);
	assert.match(editSiteUrl, /invalidateTest\(\)/);
	assert.match(editOriginIp, /setOriginIp\(value\)/);
	assert.match(editOriginIp, /setOriginSource\('manual'\)/);
	assert.match(editOriginIp, /setSuggestion\(null\)/);
	assert.match(editOriginIp, /invalidateTest\(\)/);
	assert.match(applySuggestion, /originCandidatesRequireSelection\(nextSuggestion\.addresses\)/);
	assert.match(applySuggestion, /setOriginIp\(requiresOriginIp \? soleCandidate\?\.address \?\? '' : ''\)/);
	assert.match(applySuggestion, /setTestedDraftKey\(null\)/);
	assert.doesNotMatch(applySuggestion, /setEnabled|saveSettings/);
});

test('announces provider discovery warnings to assistive technology', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	assert.equal(
		(rendererSource.match(/'aria-live': 'polite',[\s\S]{0,120}className: 'LocalMediaProxy__DiscoveryWarning',[\s\S]{0,120}role: 'status'/g) ?? []).length,
		2,
	);
});

test('wires cancellable connection tests and accessible spinner states', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');

	assert.match(rendererSource, /IPC_CHANNELS\.cancelOriginTest, site\.id, token/);
	assert.match(rendererSource, /cancelOriginTest, site\.id, token\)[\s\S]{0,80}\.catch\(\(\) => undefined\)/);
	assert.match(rendererSource, /activeProbeToken/);
	assert.match(rendererSource, /\/Connection test stopped\\\.\$\/\.test\(message\)/);
	assert.match(rendererSource, /message: stopped \? 'Connection test stopped\.' : message/);
	assert.match(rendererSource, /result\.originTlsHostname/);
	assert.match(rendererSource, /className: 'LocalMediaProxy__Spinner'/);
	assert.match(rendererSource, /'aria-hidden': true/);
	assert.match(rendererSource, /Activate Stop test to cancel/);
	assert.match(stylesheet, /@keyframes LocalMediaProxy__spin/);
	assert.match(stylesheet, /@media \(prefers-reduced-motion: reduce\)/);
});

test('explains remote IP and connection-test limits without implying a direct origin is required', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');

	assert.match(rendererSource, /'Remote IP address'/);
	assert.match(rendererSource, /A proxy, CDN, or load-balancer IP can also work when it serves the Site URL/);
	assert.match(rendererSource, /verifies reachability and, for HTTPS, certificate identity and trust—not a media file/);
	assert.match(rendererSource, /verify an actual missing upload after applying/);
	assert.doesNotMatch(rendererSource, /Test direct connection/);
	assert.doesNotMatch(rendererSource, /Origin server IP address/);
});

test('clears derived TLS identity when an origin IP is edited manually', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');

	assert.match(
		rendererSource,
		/const editOriginIp = \(value: string\): void => \{[\s\S]{0,300}setOriginIp\(value\);[\s\S]{0,120}setOriginSource\('manual'\);[\s\S]{0,120}setOriginEnvironment\(undefined\);[\s\S]{0,120}setOriginTlsHostname\(undefined\);/,
	);
});

test('keeps the button cursor consistent over nested text and spinner elements', () => {
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');

	assert.match(stylesheet, /\.LocalMediaProxy__Button \{[\s\S]*?cursor: pointer;[\s\S]*?\}/);
	assert.match(stylesheet, /\.LocalMediaProxy__Button--Test > \* \{\s*pointer-events: none;\s*\}/);
	assert.match(stylesheet, /\.LocalMediaProxy__Button:disabled \{\s*cursor: not-allowed;/);
});

test('renders URL-only Apache controls while leaving Nginx IP and DNS controls unchanged', async () => {
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const renderPanel = async (state) => {
		const registration = createRendererRegistration(async (channel) => (
			channel === IPC_CHANNELS.getSiteState ? state : discovery
		));
		const menu = registration.filters.get('siteInfoToolsItem')([]);
		const element = menu[0].render({ site: { id: 'site-a', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		return harness.render(element.type, element.props);
	};

	const apacheTree = await renderPanel(createSiteState({
		applied: false,
		enabled: false,
		requiresOriginIp: false,
		serverKind: 'apache',
	}));
	assert.ok(findElement(apacheTree, (node) => node.props?.id === 'local-media-proxy-site-url'));
	assert.equal(findElement(apacheTree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.doesNotMatch(elementText(apacheTree), /Find via public DNS|Remote IP address/);
	assert.match(elementText(apacheTree), /Apache uses this hostname for DNS, HTTP Host, TLS SNI, and certificate verification/);

	const nginxTree = await renderPanel(createSiteState({ applied: false, enabled: false }));
	assert.ok(findElement(nginxTree, (node) => node.props?.id === 'local-media-proxy-site-url'));
	assert.ok(findElement(nginxTree, (node) => node.props?.id === 'local-media-proxy-origin-ip'));
	assert.match(elementText(nginxTree), /Find via public DNS|Remote IP address/);
});

test('auto-saves the Tools switch without round-tripping connection profile fields', async () => {
	const calls = [];
	const toggleResult = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const registration = createRendererRegistration((channel, ...args) => {
		calls.push([channel, ...args]);
		if (channel === IPC_CHANNELS.getSiteState) {
			return Promise.resolve(initialState);
		}
		if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
			return Promise.resolve(discovery);
		}
		if (channel === IPC_CHANNELS.setEnabled) {
			return toggleResult.promise;
		}
		throw new Error(`Unexpected channel: ${channel}`);
	});
	const menu = registration.filters.get('siteInfoToolsItem')([]);
	const element = menu[0].render({ site: { id: 'site-a', name: 'Example site' } });
	const harness = createHookHarness(registration.React);

	harness.render(element.type, element.props);
	await flushPromises();
	let tree = harness.render(element.type, element.props);
	let toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, false);
	assert.equal(toggle.props['aria-checked'], false);
	assert.ok(toggle.props.ref && Object.hasOwn(toggle.props.ref, 'current'));
	assert.match(elementText(tree), /switch is saved and applied immediately/);
	toggle.props.onClick({ currentTarget: { id: 'tools-toggle-initiator' } });

	tree = harness.render(element.type, element.props);
	toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle, null);
	const toggleLoading = findElement(tree, (node) => (
		node.props?.className === 'LocalMediaProxy__ToggleLoadingSlot'
	));
	assert.ok(toggleLoading);
	assert.equal(toggleLoading.type, 'div');
	assert.equal(toggleLoading.props['aria-busy'], true);
	assertNativeLoadingIndicator(findLoadingIndicator(toggleLoading));
	assert.match(elementText(tree), /Toggling Media Proxy status/);
	assert.deepEqual(calls.filter(([channel]) => channel === IPC_CHANNELS.setEnabled), [
		[IPC_CHANNELS.setEnabled, 'site-a', 'nginx', true],
	]);
	assert.equal(calls.some(([channel]) => channel === IPC_CHANNELS.applySettings), false);

	toggleResult.resolve(createSiteState({ applied: true, enabled: true }));
	await flushPromises();
	tree = harness.render(element.type, element.props);
	toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props['aria-checked'], true);
	assert.equal(toggle.props.disabled, false);
	assert.match(elementText(tree), /Media proxy enabled/);
	const toggleFeedback = findElement(tree, (node) => (
		String(node.props?.className ?? '').includes('LocalMediaProxy__ActionFeedback')
	));
	assert.equal(toggleFeedback.props.tabIndex, -1);
	assert.ok(toggleFeedback.props.ref && Object.hasOwn(toggleFeedback.props.ref, 'current'));
});

test('fails closed immediately when a Tools toggle reaches its deadline', async () => {
	const timers = installManualTimers();
	const mutation = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const hypotheticalState = createSiteState({ applied: true, enabled: true });
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	let stateReads = 0;
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				stateReads += 1;
				return Promise.resolve(stateReads === 1 ? initialState : hypotheticalState);
			}
			if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
				return Promise.resolve(discovery);
			}
			if (channel === IPC_CHANNELS.setEnabled) {
				return mutation.promise;
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-a', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.props?.role === 'switch').props.onClick();
		tree = harness.render(element.type, element.props);
		assert.ok(findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ToggleLoadingSlot'));

		timers.runNext(IPC_MUTATION_DEADLINE_MS);
		await flushPromises();
		assert.equal(stateReads, 1);
		tree = harness.render(element.type, element.props);
		assert.equal(tree.props['aria-busy'], false);
		assert.equal(findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ToggleLoadingSlot'), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'alert')), /outcome is unconfirmed/i);

		mutation.resolve(createSiteState({ applied: true, enabled: true }));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(stateReads, 1);
	} finally {
		timers.restore();
	}
});

test('clears Tools progress on backend rejection and stays unavailable when recovery fails', async () => {
	const timers = installManualTimers();
	const recovery = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	let stateReads = 0;
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				stateReads += 1;
				return stateReads === 1 ? Promise.resolve(initialState) : recovery.promise;
			}
			if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
				return Promise.resolve(discovery);
			}
			if (channel === IPC_CHANNELS.setEnabled) {
				return Promise.reject(new Error('Toggle failed.'));
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-a', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.props?.role === 'switch').props.onClick();
		tree = harness.render(element.type, element.props);
		assertNativeLoadingIndicator(findLoadingIndicator(
			findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ToggleLoadingSlot'),
		));

		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(stateReads, 2);
		assert.equal(tree.props['aria-busy'], false);
		assert.equal(findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ToggleLoadingSlot'), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'alert')), 'Toggle failed.');
		assert.ok([...timers.timers.values()].some(({ delay }) => delay === IPC_READ_DEADLINE_MS));

		recovery.reject(new Error('Recovery failed.'));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(tree.props['aria-busy'], false);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.match(elementText(tree), /Status unavailable/);
		assert.equal(
			findElement(tree, (node) => node.type === 'button' && elementText(node) === 'Save & apply').props.disabled,
			true,
		);
		assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'alert')), 'Toggle failed.');
	} finally {
		timers.restore();
	}
});

test('blocks Tools toggles for dirty or invalid profiles and guards full profile saves by server kind', async () => {
	const calls = [];
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const initialState = createSiteState({ applied: false, enabled: false });
	const registration = createRendererRegistration(async (channel, ...args) => {
		calls.push([channel, ...args]);
		if (channel === IPC_CHANNELS.getSiteState) {
			return initialState;
		}
		if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
			return discovery;
		}
		if (channel === IPC_CHANNELS.applySettings) {
			return createSiteState({
				applied: false,
				enabled: false,
				siteUrl: args[1].siteUrl,
			});
		}
		throw new Error(`Unexpected channel: ${channel}`);
	});
	const menu = registration.filters.get('siteInfoToolsItem')([]);
	const element = menu[0].render({ site: { id: 'site-a', name: 'Example site' } });
	const harness = createHookHarness(registration.React);

	harness.render(element.type, element.props);
	await flushPromises();
	let tree = harness.render(element.type, element.props);
	let save = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	));
	assert.equal(save.props.disabled, true);
	const siteUrlInput = findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url');
	siteUrlInput.props.onChange({ target: { value: 'https://changed.example.com' } });
	tree = harness.render(element.type, element.props);
	let toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, true);
	assert.match(elementText(tree), /Save connection changes before changing proxy status/);
	save = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	));
	assert.equal(save.props.disabled, false);
	assert.ok(save.props.ref && Object.hasOwn(save.props.ref, 'current'));
	save.props.onClick({ currentTarget: { id: 'tools-save-initiator' } });
	tree = harness.render(element.type, element.props);
	assert.equal(findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	)), null);
	const saveLoading = findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ButtonLoadingSlot');
	assert.ok(saveLoading);
	assert.equal(saveLoading.type, 'div');
	assert.equal(saveLoading.props['aria-busy'], true);
	assertNativeLoadingIndicator(findLoadingIndicator(saveLoading));
	assert.match(elementText(tree), /Saving and applying Media Proxy settings/);
	assert.equal(
		findElement(tree, (node) => node.type === 'button' && elementText(node) === 'Test connection').props.disabled,
		true,
	);
	await flushPromises();
	tree = harness.render(element.type, element.props);
	assert.match(elementText(tree), /Nginx connection profile saved.*media proxy remains disabled/i);
	const saveFeedback = findElement(tree, (node) => (
		String(node.props?.className ?? '').includes('LocalMediaProxy__ActionFeedback')
	));
	assert.equal(saveFeedback.props.tabIndex, -1);
	assert.ok(saveFeedback.props.ref && Object.hasOwn(saveFeedback.props.ref, 'current'));
	const applyCall = calls.find(([channel]) => channel === IPC_CHANNELS.applySettings);
	assert.equal(applyCall[1], 'site-a');
	assert.equal(applyCall[2].siteUrl, 'https://changed.example.com');
	assert.equal(applyCall[3], 'nginx');

	const renderInvalid = async (enabled) => {
		const invalidState = createSiteState({
			applied: false,
			canEnable: false,
			enabled,
			enableUnavailableReason: 'Save a valid profile first.',
		});
		const invalidRegistration = createRendererRegistration(async (channel) => (
			channel === IPC_CHANNELS.getSiteState ? invalidState : discovery
		));
		const invalidElement = invalidRegistration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: `site-invalid-${enabled}`, name: 'Invalid site' } });
		const invalidHarness = createHookHarness(invalidRegistration.React);
		invalidHarness.render(invalidElement.type, invalidElement.props);
		await flushPromises();
		return invalidHarness.render(invalidElement.type, invalidElement.props);
	};

	tree = await renderInvalid(false);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
	assert.match(elementText(tree), /Save a valid profile first/);
	tree = await renderInvalid(true);
	toggle = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, true);
	assert.match(elementText(tree), /enabled intent is still on.*Save a valid profile first/i);
});

test('fails closed on a Tools apply deadline while preserving the unsaved draft', async () => {
	const timers = installManualTimers();
	const mutation = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const hypotheticalState = createSiteState({ applied: true, enabled: true });
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	let stateReads = 0;
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				stateReads += 1;
				return Promise.resolve(stateReads === 1 ? initialState : hypotheticalState);
			}
			if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
				return Promise.resolve(discovery);
			}
			if (channel === IPC_CHANNELS.applySettings) {
				return mutation.promise;
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-a', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url')
			.props.onChange({ target: { value: 'https://changed.example.com' } });
		tree = harness.render(element.type, element.props);
		findElement(tree, (node) => node.type === 'button' && elementText(node) === 'Save & apply')
			.props.onClick();
		tree = harness.render(element.type, element.props);
		assert.ok(findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ButtonLoadingSlot'));

		timers.runNext(IPC_MUTATION_DEADLINE_MS);
		await flushPromises();
		assert.equal(stateReads, 1);
		tree = harness.render(element.type, element.props);
		assert.equal(tree.props['aria-busy'], false);
		assert.equal(findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__ButtonLoadingSlot'), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'alert')), /outcome is unconfirmed/i);
		assert.equal(
			findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value,
			'https://changed.example.com',
		);
		assert.equal(
			findElement(tree, (node) => node.type === 'button' && elementText(node) === 'Save & apply').props.disabled,
			true,
		);

		mutation.resolve(createSiteState({
			applied: true,
			enabled: true,
			siteUrl: 'https://late.example.com',
		}));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(
			findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value,
			'https://changed.example.com',
		);
		assert.equal(stateReads, 1);
	} finally {
		timers.restore();
	}
});

test('rehydrates the Tools panel for a same-site server switch and ignores stale state', async () => {
	const staleTransitionState = deferred();
	const calls = [];
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const nginxState = createSiteState({
		applied: false,
		enabled: false,
		siteUrl: 'https://nginx.example.com',
	});
	const apacheState = createSiteState({
		applied: false,
		enabled: false,
		requiresOriginIp: false,
		serverKind: 'apache',
		siteUrl: 'https://apache.example.com',
	});
	let stateRead = 0;
	const registration = createRendererRegistration((channel, ...args) => {
		calls.push([channel, ...args]);
		if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
			return Promise.resolve(discovery);
		}
		if (channel !== IPC_CHANNELS.getSiteState) {
			throw new Error(`Unexpected channel: ${channel}`);
		}

		stateRead += 1;
		if (stateRead === 1) {
			return Promise.resolve(nginxState);
		}
		if (stateRead === 2) {
			return staleTransitionState.promise;
		}
		return Promise.resolve(apacheState);
	});
	const menu = registration.filters.get('siteInfoToolsItem')([]);
	const initialProps = {
		site: {
			id: 'site-a',
			name: 'Example site',
			services: { nginx: { name: 'nginx', role: 'http', version: '1.27' } },
			webServer: 'nginx',
		},
	};
	const element = menu[0].render(initialProps);
	const harness = createHookHarness(registration.React);

	harness.render(element.type, element.props);
	await flushPromises();
	let tree = harness.render(element.type, element.props);
	let siteUrlInput = findElement(tree, (node) => (
		node.props?.id === 'local-media-proxy-site-url'
	));
	assert.equal(siteUrlInput.props.value, 'https://nginx.example.com');
	siteUrlInput.props.onChange({ target: { value: 'https://unsaved-nginx.example.com' } });
	tree = harness.render(element.type, element.props);
	assert.equal(
		findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value,
		'https://unsaved-nginx.example.com',
	);
	assert.match(elementText(tree), /Unsaved changes/);

	const transitionalProps = {
		site: {
			...initialProps.site,
			webServer: 'apache',
		},
	};
	tree = harness.render(element.type, transitionalProps);
	assert.equal(tree.props.className, 'LocalMediaProxy LocalMediaProxy--Loading');
	assertNativeLoadingIndicator(findLoadingIndicator(tree));
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.doesNotMatch(elementText(tree), /Unsaved changes/);
	const apacheProps = {
		site: {
			id: 'site-a',
			name: 'Example site',
			services: { apache: { name: 'apache', role: 'http', version: '2.4' } },
			webServer: 'apache',
		},
	};
	tree = harness.render(element.type, apacheProps);
	assert.equal(tree.props.className, 'LocalMediaProxy LocalMediaProxy--Loading');
	assertNativeLoadingIndicator(findLoadingIndicator(tree));
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.equal(elementText(tree), 'Loading media proxy settings…');
	await flushPromises();
	tree = harness.render(element.type, apacheProps);

	siteUrlInput = findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url');
	assert.equal(siteUrlInput.props.value, 'https://apache.example.com');
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.doesNotMatch(elementText(tree), /Unsaved changes/);

	staleTransitionState.resolve(nginxState);
	await flushPromises();
	tree = harness.render(element.type, apacheProps);
	assert.equal(
		findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value,
		'https://apache.example.com',
	);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.equal(
		calls.filter(([channel]) => channel === IPC_CHANNELS.getSiteState).length,
		3,
	);
});

test('renders a handed-off Site URL in both server-switch directions without inventing Nginx IP data', async () => {
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const cases = [
		{
			from: createSiteState({
				applied: true,
				enabled: true,
				siteUrl: 'https://media.example.com',
			}),
			fromServer: 'nginx',
			to: createSiteState({
				applied: true,
				enabled: true,
				requiresOriginIp: false,
				serverKind: 'apache',
				siteUrl: 'https://media.example.com',
			}),
			toServer: 'apache',
		},
		{
			from: createSiteState({
				applied: true,
				enabled: true,
				requiresOriginIp: false,
				serverKind: 'apache',
				siteUrl: 'https://files.example.com',
			}),
			fromServer: 'apache',
			to: createSiteState({
				applied: false,
				canEnable: false,
				enabled: true,
				enableUnavailableReason: 'Remote IP address must be a valid IPv4 or IPv6 address.',
				needsAttention: true,
				originIp: '',
				siteUrl: 'https://files.example.com',
			}),
			toServer: 'nginx',
		},
	];

	for (const switchCase of cases) {
		let currentState = switchCase.from;
		const registration = createRendererRegistration(async (channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				return currentState;
			}
			if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
				return discovery;
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const menuItem = registration.filters.get('siteInfoToolsItem')([])[0];
		const siteProps = (serverKind) => ({
			site: {
				id: 'site-a',
				name: 'Example site',
				services: {
					[serverKind]: {
						name: serverKind,
						role: 'http',
						version: serverKind === 'apache' ? '2.4' : '1.27',
					},
				},
				webServer: serverKind,
			},
		});
		const initialElement = menuItem.render(siteProps(switchCase.fromServer));
		const harness = createHookHarness(registration.React);
		harness.render(initialElement.type, initialElement.props);
		await flushPromises();
		harness.render(initialElement.type, initialElement.props);

		currentState = switchCase.to;
		const switchedElement = menuItem.render(siteProps(switchCase.toServer));
		harness.render(switchedElement.type, switchedElement.props);
		await flushPromises();
		const tree = harness.render(switchedElement.type, switchedElement.props);
		assert.equal(
			findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value,
			switchCase.to.settings.siteUrl,
		);
		assert.doesNotMatch(elementText(tree), /Unsaved changes/);
		const originIpInput = findElement(
			tree,
			(node) => node.props?.id === 'local-media-proxy-origin-ip',
		);
		if (switchCase.toServer === 'apache') {
			assert.equal(originIpInput, null);
		} else {
			assert.equal(originIpInput.props.value, '');
			assert.match(elementText(tree), /Remote IP address must be a valid IPv4 or IPv6 address/);
			assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
		}
	}
});

test('gates Tools controls when the current Apache profile or service cannot enable', async () => {
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const renderPanel = async (state) => {
		const registration = createRendererRegistration(async (channel) => (
			channel === IPC_CHANNELS.getSiteState ? state : discovery
		));
		const menu = registration.filters.get('siteInfoToolsItem')([]);
		const element = menu[0].render({ site: { id: 'site-a', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		return {
			element,
			harness,
			tree: harness.render(element.type, element.props),
		};
	};
	const controls = (tree) => ({
		save: findElement(tree, (node) => node.type === 'button' && /Save & apply/.test(elementText(node))),
		switch: findElement(tree, (node) => node.props?.role === 'switch'),
	});

	for (const state of [
		createSiteState({
			applied: true,
			canEnable: false,
			cleanupSupported: true,
			enabled: true,
			enableUnavailableReason: 'This Apache profile requires HTTPS support.',
			requiresOriginIp: false,
			serverKind: 'apache',
			supported: true,
			supportsHttpsOrigin: false,
		}),
		createSiteState({
			applied: true,
			canEnable: false,
			cleanupSupported: true,
			enabled: true,
			enableUnavailableReason: 'Apache proxy support is unavailable.',
			requiresOriginIp: false,
			serverKind: 'apache',
			supported: false,
			supportsHttpsOrigin: false,
		}),
	]) {
		const rendered = await renderPanel(state);
		const panelControls = controls(rendered.tree);
		assert.equal(panelControls.switch.props.disabled, true);
		assert.equal(panelControls.save.props.disabled, true);
		assert.match(elementText(rendered.tree), /enabled intent is still on/);
	}

	const serviceNull = await renderPanel(createSiteState({
		applied: false,
		canEnable: false,
		cleanupSupported: false,
		enabled: true,
		requiresOriginIp: false,
		serverKind: 'apache',
		supported: false,
		supportsHttpsOrigin: false,
	}));
	const blockedControls = controls(serviceNull.tree);
	assert.equal(blockedControls.switch.props.disabled, true);
	assert.equal(blockedControls.save.props.disabled, true);
});

test('keeps Tools IPC and controls out of Local lifecycle transitions', () => {
	for (const status of [
		'creating',
		'provisioning',
		'pulling_provisioning',
		'pulling_finalizing',
		'deleting',
		'deleting_backup',
		'provisioning_error',
		'future_local_status',
	]) {
		const calls = [];
		const registration = createRendererRegistration((...args) => {
			calls.push(args);
			return Promise.resolve(createSiteState({ applied: false, enabled: false }));
		});
		const element = registration.filters.get('siteInfoToolsItem')(
			[],
			{
				routeChildrenProps: {
					site: { id: `site-${status}`, name: 'Example site' },
					siteStatus: status,
				},
			},
		)[0].render();
		const harness = createHookHarness(registration.React);
		const tree = harness.render(element.type, element.props);

		assert.deepEqual(calls, [], `${status} must not invoke Media Proxy IPC`);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'), null);
		assert.equal(findElement(tree, (node) => node.type === 'button'), null);
		assert.equal(findLoadingIndicator(tree), null);
		assert.match(
			elementText(findElement(tree, (node) => node.props?.role === 'status')),
			/Local (?:is|could not).*Media Proxy|Media Proxy will/i,
		);
	}
});

test('rehydrates Tools after a same-site Local lifecycle transition', async () => {
	const calls = [];
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const registration = createRendererRegistration(async (channel, siteId) => {
		calls.push([channel, siteId]);
		return channel === IPC_CHANNELS.getSiteState
			? createSiteState({ applied: false, enabled: false })
			: discovery;
	});
	const filter = registration.filters.get('siteInfoToolsItem');
	const site = { id: 'site-a', name: 'Example site' };
	const panelFor = (siteStatus) => filter(
		[],
		{ routeChildrenProps: { site, siteStatus } },
	)[0].render();
	const runningElement = panelFor('running');
	const harness = createHookHarness(registration.React);

	harness.render(runningElement.type, runningElement.props);
	await flushPromises();
	let tree = harness.render(runningElement.type, runningElement.props);
	assert.ok(findElement(tree, (node) => node.props?.role === 'switch'));
	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getOriginDiscoveryOptions, 'site-a'],
	]);

	const pullingElement = panelFor('pulling_finalizing');
	tree = harness.render(pullingElement.type, pullingElement.props);
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'), null);
	assert.equal(findLoadingIndicator(tree), null);
	assert.match(elementText(tree), /still pulling.*remain inactive/i);
	assert.equal(calls.length, 2, 'transitioning status must not issue additional IPC');

	const readyElement = panelFor('running');
	tree = harness.render(readyElement.type, readyElement.props);
	assertNativeLoadingIndicator(findLoadingIndicator(tree));
	await flushPromises();
	tree = harness.render(readyElement.type, readyElement.props);

	assert.ok(findElement(tree, (node) => node.props?.role === 'switch'));
	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getOriginDiscoveryOptions, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getOriginDiscoveryOptions, 'site-a'],
	]);
});

test('fails closed when site state cannot be loaded', async () => {
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const registration = createRendererRegistration(async (channel) => {
		if (channel === IPC_CHANNELS.getSiteState) {
			throw new Error('Site state unavailable.');
		}
		return discovery;
	});
	const menu = registration.filters.get('siteInfoToolsItem')([]);
	const element = menu[0].render({ site: { id: 'site-a', name: 'Example site' } });
	const harness = createHookHarness(registration.React);

	let tree = harness.render(element.type, element.props);
	const initialLoading = findLoadingIndicator(tree);
	assertNativeLoadingIndicator(initialLoading);
	assert.equal(elementText(findElement(tree, (node) => node.props?.role === 'status')), 'Loading media proxy settings…');
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	await flushPromises();
	tree = harness.render(element.type, element.props);
	const enableSwitch = findElement(tree, (node) => node.props?.role === 'switch');
	const testButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Test connection'
	));
	const saveButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	));
	const error = findElement(tree, (node) => (
		node.props?.role === 'alert' && elementText(node) === 'Site state unavailable.'
	));

	assert.equal(enableSwitch, null);
	assert.match(elementText(tree), /Status unavailable/);
	assert.equal(testButton.props.disabled, true);
	assert.equal(saveButton.props.disabled, true);
	assert.ok(error);
	assert.match(elementText(tree), /Unavailable/);
});

test('times out the initial Tools read and ignores its late result', async () => {
	const timers = installManualTimers();
	const pending = deferred();
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	try {
		const registration = createRendererRegistration((channel) => (
			channel === IPC_CHANNELS.getSiteState ? pending.promise : Promise.resolve(discovery)
		));
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-timeout', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		let tree = harness.render(element.type, element.props);
		assertNativeLoadingIndicator(findLoadingIndicator(tree));
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		await flushPromises();

		timers.runNext(IPC_READ_DEADLINE_MS);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findLoadingIndicator(tree), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		assert.match(elementText(findElement(tree, (node) => node.props?.role === 'alert')), /current state is unconfirmed/i);

		pending.resolve(createSiteState({ applied: true, enabled: true }));
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	} finally {
		timers.restore();
	}
});

test('shows Tools after site state resolves while discovery remains bounded and in-panel', async () => {
	const timers = installManualTimers();
	const pendingDiscovery = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	try {
		const registration = createRendererRegistration((channel) => (
			channel === IPC_CHANNELS.getSiteState
				? Promise.resolve(initialState)
				: pendingDiscovery.promise
		));
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-discovery-timeout', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		let tree = harness.render(element.type, element.props);
		assert.equal(tree.props.className, 'LocalMediaProxy LocalMediaProxy--Loading');
		assertNativeLoadingIndicator(findLoadingIndicator(tree));
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(tree.props.className, 'LocalMediaProxy');
		assert.equal(tree.props['aria-busy'], false);
		assert.equal(tree.props.role, undefined);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, false);
		assert.ok(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'));
		const discoveryHeading = findElement(tree, (node) => (
			node.props?.className === 'LocalMediaProxy__DiscoveryHeading'
		));
		const discoveryLoadingSlot = findElement(discoveryHeading, (node) => (
			node.props?.className === 'LocalMediaProxy__DiscoveryLoadingSlot'
		));
		assert.equal(discoveryLoadingSlot.type, 'div');
		assert.equal(discoveryLoadingSlot.props['aria-busy'], true);
		const discoveryStatus = findElement(discoveryHeading, (node) => (
			node.props?.role === 'status'
		));
		assert.ok(discoveryStatus);
		assert.equal(discoveryStatus.props['aria-live'], 'polite');
		assert.match(elementText(discoveryStatus), /Checking the Local hosting connection/);
		assertNativeLoadingIndicator(findLoadingIndicator(discoveryHeading));
		assert.match(elementText(discoveryHeading), /Checking the Local hosting connection/);

		timers.runNext(IPC_READ_DEADLINE_MS);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findLoadingIndicator(
			findElement(tree, (node) => node.props?.className === 'LocalMediaProxy__DiscoveryHeading'),
		), null);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, false);
		assert.match(elementText(tree), /connection details could not be confirmed.*Manual entry remains available/i);

		pendingDiscovery.resolve({
			canAutoPopulate: true,
			environments: [{ current: true, environment: 'production', name: 'Late environment' }],
			message: 'Late provider result',
			provider: 'wpengine',
			selectedEnvironment: 'production',
		});
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.doesNotMatch(elementText(tree), /Late provider result|Late environment/);
		assert.match(elementText(tree), /Manual entry remains available/);
	} finally {
		timers.restore();
	}
});

test('times out user-triggered origin discovery, restores Tools controls, and ignores a late result', async () => {
	const timers = installManualTimers();
	const pendingDiscovery = deferred();
	const initialState = createSiteState({ applied: false, enabled: false });
	const discoveryOptions = {
		canAutoPopulate: true,
		environments: [{ current: true, environment: 'production', name: 'Example production' }],
		message: 'Connected to WP Engine',
		provider: 'wpengine',
		selectedEnvironment: 'production',
	};
	try {
		const registration = createRendererRegistration((channel) => {
			if (channel === IPC_CHANNELS.getSiteState) {
				return Promise.resolve(initialState);
			}
			if (channel === IPC_CHANNELS.getOriginDiscoveryOptions) {
				return Promise.resolve(discoveryOptions);
			}
			if (channel === IPC_CHANNELS.discoverOrigin) {
				return pendingDiscovery.promise;
			}
			throw new Error(`Unexpected channel: ${channel}`);
		});
		const element = registration.filters.get('siteInfoToolsItem')([])[0]
			.render({ site: { id: 'site-discovery-action-timeout', name: 'Example site' } });
		const harness = createHookHarness(registration.React);
		harness.render(element.type, element.props);
		await flushPromises();
		let tree = harness.render(element.type, element.props);
		let discoverButton = findElement(tree, (node) => (
			node.type === 'button' && elementText(node) === 'Auto-populate from WP Engine'
		));
		assert.equal(discoverButton.props.disabled, false);

		discoverButton.props.onClick();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, true);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-environment').props.disabled, true);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.disabled, true);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip').props.disabled, true);
		assert.ok(findElement(tree, (node) => (
			node.type === 'button' && elementText(node) === 'Discovering…'
		)));

		timers.runNext(IPC_DISCOVERY_DEADLINE_MS);
		await flushPromises();
		tree = harness.render(element.type, element.props);
		discoverButton = findElement(tree, (node) => (
			node.type === 'button' && elementText(node) === 'Auto-populate from WP Engine'
		));
		assert.equal(discoverButton.props.disabled, false);
		assert.equal(findElement(tree, (node) => node.props?.role === 'switch').props.disabled, false);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-environment').props.disabled, false);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.disabled, false);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip').props.disabled, false);
		const timeoutAlert = findElement(tree, (node) => node.props?.role === 'alert');
		assert.match(elementText(timeoutAlert), /did not finish within 30 seconds.*Try again.*manually/i);

		pendingDiscovery.resolve({
			addresses: [{ address: '192.0.2.99', family: 4, source: 'wpengine-stable-ip' }],
			environment: 'production',
			provider: 'wpengine',
			resolvedAt: '2026-07-22T22:00:00.000Z',
			siteUrl: 'https://late.example.com',
			warning: 'Late suggestion',
		});
		await flushPromises();
		tree = harness.render(element.type, element.props);
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url').props.value, 'https://example.com');
		assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip').props.value, '192.0.2.10');
		assert.doesNotMatch(elementText(tree), /Late suggestion|late\.example\.com/);
	} finally {
		timers.restore();
	}
});

test('clears prior capabilities when a site switch fails to load state', async () => {
	const discovery = {
		canAutoPopulate: false,
		environments: [],
		message: 'Manual setup',
		provider: 'none',
	};
	const registration = createRendererRegistration(async (channel, siteId) => {
		if (channel !== IPC_CHANNELS.getSiteState) {
			return discovery;
		}
		if (siteId === 'site-b') {
			throw new Error('Second site state unavailable.');
		}
		return createSiteState({ applied: true, enabled: true });
	});
	const menu = registration.filters.get('siteInfoToolsItem')([]);
	const firstElement = menu[0].render({ site: { id: 'site-a', name: 'First site' } });
	const harness = createHookHarness(registration.React);

	harness.render(firstElement.type, firstElement.props);
	await flushPromises();
	let tree = harness.render(firstElement.type, firstElement.props);
	let enableSwitch = findElement(tree, (node) => node.props?.role === 'switch');
	assert.equal(enableSwitch.props.disabled, false);

	const secondProps = { site: { id: 'site-b', name: 'Second site' } };
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(tree.props.className, 'LocalMediaProxy LocalMediaProxy--Loading');
	assertNativeLoadingIndicator(findLoadingIndicator(tree));
	assert.equal(findElement(tree, (node) => node.props?.role === 'switch'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-site-url'), null);
	assert.equal(findElement(tree, (node) => node.props?.id === 'local-media-proxy-origin-ip'), null);
	assert.equal(elementText(tree), 'Loading media proxy settings…');
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);

	enableSwitch = findElement(tree, (node) => node.props?.role === 'switch');
	const testButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Test connection'
	));
	const saveButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	));

	assert.equal(enableSwitch, null);
	assert.match(elementText(tree), /Status unavailable/);
	assert.equal(testButton.props.disabled, true);
	assert.equal(saveButton.props.disabled, true);
	assert.ok(findElement(tree, (node) => (
		node.props?.role === 'alert' && elementText(node) === 'Second site state unavailable.'
	)));
});
