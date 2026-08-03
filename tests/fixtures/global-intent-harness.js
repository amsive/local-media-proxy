/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const mode = process.argv[2];
assert.ok(mode === 'disable' || mode === 'uninstall');

const libRoot = path.resolve(__dirname, '../../lib');
const calls = [];
const logs = [];
const hooks = new Map();
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, handler) => ipcMain.handlers.set(channel, handler);
ipcMain.removeHandler = (channel) => ipcMain.handlers.delete(channel);

function storedEnvelope(enabled, siteUrl, originIp = '192.0.2.10') {
	return {
		enabled,
		lastServerKind: 'nginx',
		profiles: {
			apache: { originIp: '', siteUrl: '' },
			nginx: { originIp, siteUrl },
		},
		schemaVersion: 2,
	};
}

const sites = {
	'cleanup-failure-site': {
		id: 'cleanup-failure-site',
		localMediaProxy: storedEnvelope(true, 'https://cleanup-failure.example.com'),
		longPath: path.resolve(__dirname, 'cleanup-failure-site'),
		name: 'cleanup-failure-site',
		paths: { confTemplates: path.resolve(__dirname, 'cleanup-failure-site/conf') },
	},
	'cleanup-retry-site': {
		id: 'cleanup-retry-site',
		localMediaProxy: storedEnvelope(true, 'https://cleanup-retry.example.com'),
		longPath: path.resolve(__dirname, 'cleanup-retry-site'),
		name: 'cleanup-retry-site',
		paths: { confTemplates: path.resolve(__dirname, 'cleanup-retry-site/conf') },
	},
	'disabled-site': {
		id: 'disabled-site',
		localMediaProxy: storedEnvelope(false, 'https://disabled.example.com'),
		longPath: path.resolve(__dirname, 'disabled-site'),
		name: 'disabled-site',
		paths: { confTemplates: path.resolve(__dirname, 'disabled-site/conf') },
	},
	'enabled-site': {
		id: 'enabled-site',
		localMediaProxy: storedEnvelope(true, 'https://enabled.example.com'),
		longPath: path.resolve(__dirname, 'enabled-site'),
		name: 'enabled-site',
		paths: { confTemplates: path.resolve(__dirname, 'enabled-site/conf') },
	},
	'invalid-site': {
		id: 'invalid-site',
		localMediaProxy: storedEnvelope(true, 'not-a-url'),
		longPath: path.resolve(__dirname, 'invalid-site'),
		name: 'invalid-site',
		paths: { confTemplates: path.resolve(__dirname, 'invalid-site/conf') },
	},
};
const initialSettings = Object.fromEntries(Object.entries(sites).map(([siteId, site]) => [
	siteId,
	JSON.parse(JSON.stringify(site.localMediaProxy)),
]));
const managedArtifacts = new Set(Object.keys(sites));
const compiledManaged = new Set(Object.keys(sites));
let deferredCleanupFailureThrown = false;

const service = {
	bin: { nginx: '/usr/bin/nginx' },
	configPath: path.resolve(__dirname, 'nginx-config'),
	runPath: path.resolve(__dirname, 'nginx-run'),
	serviceName: 'nginx',
	siteConfigTemplatePath: path.resolve(__dirname, 'nginx-template'),
};

const cradle = {
	appState: {
		getState: () => ({ enabledAddons: { 'local-media-proxy': true } }),
	},
	capi: {},
	configTemplates: {
		compileServiceConfigs: async (site) => calls.push(`compile:${site.id}`),
	},
	lightningServices: {
		getSiteService: (site) => ({ ...service, testSiteId: site.id }),
	},
	localLogger: {
		child: () => ({
			log: (level, message) => logs.push([level, message]),
		}),
	},
	siteData: {
		getSite: (siteId) => sites[siteId],
		getSites: () => sites,
		updateSite: (siteId, update) => {
			calls.push(`settings:${siteId}`);
			Object.assign(sites[siteId], update);
		},
	},
	siteProcessManager: {
		getSiteStatus: () => 'running',
		hasRunningProcess: () => true,
		restartSiteService: async (site) => calls.push(`restart:${site.id}`),
	},
};

const localMainStub = {
	HooksMain: {
		addAction: (name, callback) => {
			const callbacks = hooks.get(name) || [];
			callbacks.push(callback);
			hooks.set(name, callbacks);
		},
	},
	execFilePromise: async (_command, args) => {
		calls.push(`exec:${args[0]}`);
		return '';
	},
	getServiceContainer: () => ({ cradle }),
};

const siteConfig = require(path.join(libRoot, 'site-config.js'));
siteConfig.allManagedArtifactsExist = async (site, assertCurrent) => {
	assertCurrent?.();
	return managedArtifacts.has(site.id);
};
siteConfig.applyServerManagedFiles = async (site, _origin, _options, _trust, assertCurrent) => {
	assertCurrent?.();
	managedArtifacts.add(site.id);
	calls.push(`apply:${site.id}`);
	return true;
};
siteConfig.captureAllManagedFiles = async (site, assertCurrent) => {
	assertCurrent?.();
	return [{ existed: managedArtifacts.has(site.id), siteId: site.id }];
};
siteConfig.removeAllManagedFiles = async (site, assertCurrent) => {
	assertCurrent?.();
	if (site.id === 'cleanup-retry-site' && !deferredCleanupFailureThrown) {
		deferredCleanupFailureThrown = true;
		calls.push(`remove-async-failed:${site.id}`);
		throw new Error('simulated deferred cleanup failure');
	}
	const changed = managedArtifacts.delete(site.id);
	calls.push(`remove-async:${site.id}:${changed}`);
	return changed;
};
siteConfig.removeAllManagedFilesSync = (site, assertCurrent) => {
	assertCurrent?.();
	if (site.id === 'cleanup-failure-site') {
		calls.push(`remove-sync-failed:${site.id}`);
		throw new Error('simulated synchronous cleanup failure');
	}
	const changed = managedArtifacts.delete(site.id);
	calls.push(`remove-sync:${site.id}:${changed}`);
	return changed;
};
siteConfig.restoreManagedFiles = async () => undefined;
siteConfig.readServerManagedIncludeTemplate = async (site, _options, assertCurrent) => {
	assertCurrent?.();
	return managedArtifacts.has(site.id) ? `managed:${site.id}` : null;
};
siteConfig.serverManagedFilesystemReady = () => true;
siteConfig.serverManagedFilesMatch = async (site, _origin, _options, _trust, assertCurrent) => {
	assertCurrent?.();
	return managedArtifacts.has(site.id);
};

const nginx = require(path.join(libRoot, 'nginx.js'));
nginx.nginxCompiledConfigMatches = async (runtimeService, expectedManagedInclude, assertCurrent) => {
	assertCurrent?.();
	return expectedManagedInclude === null
		? !compiledManaged.has(runtimeService.testSiteId)
		: compiledManaged.has(runtimeService.testSiteId);
};
nginx.compileAndValidateNginxConfig = async (
	site,
	_runtimeService,
	_configTemplates,
	_execFilePromise,
	expectedManagedInclude,
	assertCurrent,
) => {
	assertCurrent?.();
	if (expectedManagedInclude === null) {
		compiledManaged.delete(site.id);
	} else {
		compiledManaged.add(site.id);
	}
	calls.push(`compile:${site.id}`);
	assertCurrent?.();
};

const serverModule = require(path.join(libRoot, 'server.js'));
serverModule.detectSiteServer = () => ({
	kind: 'nginx',
	requiresOriginIp: true,
	serviceName: 'nginx',
});

let nextTimerId = 1;
const timers = new Map();
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
global.setTimeout = (callback, _delay, ...args) => {
	const timerId = nextTimerId++;
	timers.set(timerId, () => callback(...args));
	return timerId;
};
global.clearTimeout = (timerId) => timers.delete(timerId);

const originalModuleLoad = Module._load;
Module._load = function loadWithLocalStub(request, parent, isMain) {
	if (request === '@getflywheel/local/main') {
		return localMainStub;
	}
	return originalModuleLoad.call(this, request, parent, isMain);
};

function assertSettingsUnchanged() {
	for (const [siteId, expected] of Object.entries(initialSettings)) {
		assert.deepEqual(sites[siteId].localMediaProxy, expected);
	}
	assert.equal(calls.some((call) => call.startsWith('settings:')), false);
}

async function settleTimers() {
	let idleRounds = 0;
	for (let round = 0; round < 100 && idleRounds < 5; round += 1) {
		const pending = [...timers.entries()];
		for (const [timerId, callback] of pending) {
			if (!timers.delete(timerId)) {
				continue;
			}
			callback();
		}
		await new Promise((resolve) => setImmediate(resolve));
		idleRounds = timers.size === 0 ? idleRounds + 1 : 0;
	}
	assert.equal(timers.size, 0, 'lifecycle work should settle deterministically');
}

(async () => {
	try {
		const main = require(path.join(libRoot, 'main.js')).default;
		main({ electron: { ipcMain } });
		assert.equal(timers.size, Object.keys(sites).length);

		ipcMain.emit(`addonInstallerService:${mode}`, {}, {
			name: 'local-media-proxy',
			npmPackageName: 'local-media-proxy',
		});

		assertSettingsUnchanged();
		assert.deepEqual([...managedArtifacts], ['cleanup-failure-site']);
		assert.equal(
			calls.filter((call) => call.startsWith('remove-sync')).length,
			Object.keys(sites).length,
		);

		await settleTimers();
		assertSettingsUnchanged();
		assert.deepEqual([...managedArtifacts], []);
		const deferredGlobalCleanups = calls.filter(
			(call) => call.startsWith('remove-async'),
		).length;
		assert.equal(deferredGlobalCleanups, Object.keys(sites).length + 1);

		ipcMain.emit('addonInstallerService:enable', {}, {
			name: 'local-media-proxy',
			npmPackageName: 'local-media-proxy',
		});
		await settleTimers();

		assertSettingsUnchanged();
		assert.equal(managedArtifacts.has('enabled-site'), true);
		assert.equal(managedArtifacts.has('cleanup-failure-site'), true);
		assert.equal(managedArtifacts.has('cleanup-retry-site'), true);
		assert.equal(managedArtifacts.has('disabled-site'), false);
		assert.equal(managedArtifacts.has('invalid-site'), false);
		assert.equal(calls.filter((call) => call === 'apply:enabled-site').length, 1);
		assert.equal(calls.some((call) => call === 'apply:invalid-site'), false);
		assert.equal(logs.some(([, message]) => (
			message.includes('invalid-site') &&
			message.includes('retaining global enabled intent')
		)), true);

		process.stdout.write(`${JSON.stringify({
			deferredCleanupFailures: calls.filter(
				(call) => call.startsWith('remove-async-failed:'),
			).length,
			disabledApplied: managedArtifacts.has('disabled-site'),
			failClosedReconciliations: calls.filter(
				(call) => call.startsWith('remove-async'),
			).length - deferredGlobalCleanups,
			globalAsyncCleanups: deferredGlobalCleanups,
			enabledApplied: managedArtifacts.has('enabled-site'),
			invalidApplied: managedArtifacts.has('invalid-site'),
			mode,
			settingsWrites: calls.filter((call) => call.startsWith('settings:')).length,
			synchronousCleanupFailures: calls.filter(
				(call) => call.startsWith('remove-sync-failed:'),
			).length,
			synchronousCleanups: calls.filter((call) => call.startsWith('remove-sync')).length,
		})}\n`);
	} finally {
		Module._load = originalModuleLoad;
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}
})().catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 1;
});
