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
	connectionTestControlState,
	draftOriginKey,
	originCandidateLabel,
	originCandidatesRequireSelection,
	originDiscoveryLayoutMode,
	overviewProxyStatusPresentation,
	originCapabilityControlState,
	proxyPrivacySummary,
	settingsActionAvailability,
	settingsDraftIsDirty,
	siteUrlIsUsableForDns,
	siteUrlUsesHttps,
	siteStatusPresentation,
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
	enabled,
	needsAttention,
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
		cleanupSupported,
		needsAttention,
		reason,
		requiresOriginIp,
		serverKind,
		settings: {
			enabled,
			originIp: '192.0.2.10',
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

test('registers a keyed native Overview row while keeping controls in Tools', () => {
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
	const tree = harness.render(element.type, element.props);
	assert.equal(tree.type, 'li');
	assert.equal(tree.props.className, 'TableListRow LocalMediaProxy LocalMediaProxy--OverviewRow');
	assert.equal(tree.props.children[0].type, 'strong');
	assert.equal(elementText(tree.props.children[0]), 'Proxy status');
	assert.equal(tree.props.children[1].type, 'div');
	const status = findElement(tree, (node) => node.props?.role === 'status');
	assert.ok(status);
	assert.equal(status.props['aria-atomic'], true);
	assert.equal(status.props['aria-label'], 'Checking…: Loading proxy status.');
	assert.equal(status.props['aria-live'], 'polite');
	assert.match(status.props.className, /LocalMediaProxy__OverviewStatus--Loading/);
	assert.equal(elementText(status), 'Checking…Loading proxy status.');
	assert.equal(findElement(tree, (node) => node.type === 'button'), null);
	assert.equal(findElement(tree, (node) => node.type === 'section'), null);

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
	assert.equal(elementText(tree), 'Proxy statusChecking…Loading proxy status.');

	const secondProps = { site: { id: 'site-b' }, siteStatus: 'running' };
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(elementText(tree), 'Proxy statusChecking…Loading proxy status.');
	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-b'],
	]);

	secondState.resolve(createSiteState({ applied: true, enabled: true }));
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(elementText(tree), 'Proxy statusActiveEnabled and applied.');

	firstState.resolve(createSiteState({ applied: false, enabled: false }));
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);
	assert.equal(elementText(tree), 'Proxy statusActiveEnabled and applied.');
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
	assert.equal(elementText(tree), 'Proxy statusActiveEnabled and applied.');

	const haltedElement = overviewHook({ id: 'site-a' }, 'halted');
	tree = harness.render(haltedElement.type, haltedElement.props);
	tree = harness.render(haltedElement.type, haltedElement.props);
	assert.equal(elementText(tree), 'Proxy statusChecking…Loading proxy status.');
	await flushPromises();
	tree = harness.render(haltedElement.type, haltedElement.props);

	assert.deepEqual(calls, [
		[IPC_CHANNELS.getSiteState, 'site-a'],
		[IPC_CHANNELS.getSiteState, 'site-a'],
	]);
	assert.equal(
		elementText(tree),
		'Proxy statusInactiveEnabled and applied, but the Local site is not running.',
	);
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
	assert.equal(elementText(tree), 'Proxy statusUnavailableProxy status could not be loaded.');

	const unsupportedRegistration = createRendererRegistration(async () => createSiteState({
		applied: false,
		enabled: false,
		reason: 'Local Media Proxy currently supports Nginx sites only.',
		supported: false,
	}));
	const unsupportedHook = unsupportedRegistration.contentHooks.get('SiteInfoOverview_TableList');
	const unsupportedElement = unsupportedHook({ id: 'site-unsupported' }, 'halted');
	const unsupportedHarness = createHookHarness(unsupportedRegistration.React);
	unsupportedHarness.render(unsupportedElement.type, unsupportedElement.props);
	await flushPromises();
	tree = unsupportedHarness.render(unsupportedElement.type, unsupportedElement.props);
	assert.equal(
		elementText(tree),
		'Proxy statusUnavailableLocal Media Proxy currently supports Nginx sites only.',
	);
});

test('scopes Overview row and light/dark status styles under LocalMediaProxy', () => {
	const stylesheet = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
	const overviewRules = [...stylesheet.matchAll(/([^{}]+Overview[^{}]+)\s*\{[^{}]*\}/g)]
		.map((match) => match[1].trim());

	assert.ok(overviewRules.length >= 8);
	for (const selector of overviewRules) {
		assert.match(selector, /\.LocalMediaProxy/);
	}
	assert.match(
		stylesheet,
		/\.LocalMediaProxy\.LocalMediaProxy--OverviewRow \{[\s\S]{0,160}max-width: none;[\s\S]{0,80}padding: 0;/,
	);
	assert.match(stylesheet, /\.LocalMediaProxy \.LocalMediaProxy__OverviewStatus \{/);
	assert.match(
		stylesheet,
		/\.Theme__Dark \.LocalMediaProxy \.LocalMediaProxy__OverviewStatus--Active \.LocalMediaProxy__OverviewBadge \{/,
	);
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
		/'aria-live': notice\.variant === 'error' \? undefined : 'polite',[\s\S]*role: notice\.variant === 'error' \? 'alert' : 'status'/,
	);
	assert.match(
		stylesheet,
		/\.LocalMediaProxy__ActionFeedback \+ \.LocalMediaProxy__Actions \{\s*margin-top: 0;\s*\}/,
	);
});

test('keeps action feedback until a relevant change or the next action', () => {
	const rendererSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer.ts'), 'utf8');

	assert.match(
		rendererSource,
		/const editEnabled = \(value: boolean\): void => \{[\s\S]{0,120}setEnabled\(value\);[\s\S]{0,120}clearActionFeedback\(\);/,
	);
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
	assert.match(rendererSource, /const saveSettings[\s\S]{0,300}setNotice\(null\);/);
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

test('renders cleanup controls for capability-limited Apache but blocks a missing service', async () => {
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
			cleanupSupported: true,
			enabled: true,
			requiresOriginIp: false,
			serverKind: 'apache',
			supported: true,
			supportsHttpsOrigin: false,
		}),
		createSiteState({
			applied: true,
			cleanupSupported: true,
			enabled: true,
			requiresOriginIp: false,
			serverKind: 'apache',
			supported: false,
			supportsHttpsOrigin: false,
		}),
	]) {
		const rendered = await renderPanel(state);
		let panelControls = controls(rendered.tree);
		assert.equal(panelControls.switch.props.disabled, false);
		panelControls.switch.props.onClick();
		rendered.tree = rendered.harness.render(rendered.element.type, rendered.element.props);
		panelControls = controls(rendered.tree);
		assert.equal(panelControls.save.props.disabled, false);
	}

	const serviceNull = await renderPanel(createSiteState({
		applied: false,
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

	harness.render(element.type, element.props);
	await flushPromises();
	const tree = harness.render(element.type, element.props);
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

	assert.equal(enableSwitch.props.disabled, true);
	assert.equal(testButton.props.disabled, true);
	assert.equal(saveButton.props.disabled, true);
	assert.ok(error);
	assert.match(elementText(tree), /Unavailable/);
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
	harness.render(firstElement.type, secondProps);
	tree = harness.render(firstElement.type, secondProps);
	assert.match(elementText(tree), /Loading media proxy settings/);
	await flushPromises();
	tree = harness.render(firstElement.type, secondProps);

	enableSwitch = findElement(tree, (node) => node.props?.role === 'switch');
	const testButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Test connection'
	));
	const saveButton = findElement(tree, (node) => (
		node.type === 'button' && elementText(node) === 'Save & apply'
	));

	assert.equal(enableSwitch.props.disabled, true);
	assert.equal(testButton.props.disabled, true);
	assert.equal(saveButton.props.disabled, true);
	assert.ok(findElement(tree, (node) => (
		node.props?.role === 'alert' && elementText(node) === 'Second site state unavailable.'
	)));
});
