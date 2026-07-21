/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
	connectionTestControlState,
	draftOriginKey,
	originCandidateLabel,
	originCandidatesRequireSelection,
	settingsDraftIsDirty,
} = require('../lib/renderer');

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
