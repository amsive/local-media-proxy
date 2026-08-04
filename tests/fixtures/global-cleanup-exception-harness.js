/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const libRoot = path.resolve(__dirname, '../../lib');
const calls = [];
const logs = [];
const hooks = new Map();
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, handler) => ipcMain.handlers.set(channel, handler);
ipcMain.removeHandler = (channel) => ipcMain.handlers.delete(channel);

const site = {
	id: 'validation-site',
	longPath: path.resolve(__dirname, 'validation-site'),
	name: 'validation-site',
};
let statusReadCount = 0;

const cradle = {
	appState: {
		getState: () => ({ enabledAddons: {} }),
	},
	capi: {},
	configTemplates: {
		compileServiceConfigs: async () => calls.push('compileServiceConfigs'),
	},
	lightningServices: {
		getSiteService: () => null,
	},
	localLogger: {
		child: () => ({
			log: (level, message) => logs.push([level, message]),
		}),
	},
	siteData: {
		getSite: (siteId) => siteId === site.id ? site : undefined,
		getSites: () => ({ [site.id]: site }),
		updateSite: () => calls.push('updateSite'),
	},
	siteProcessManager: {
		getSiteStatus: () => {
			statusReadCount += 1;
			if (statusReadCount === 1) {
				return 'running';
			}
			throw new Error('validation fingerprint status failure');
		},
		hasRunningProcess: () => false,
		restartSiteService: async () => calls.push('restartSiteService'),
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
	execFilePromise: async () => '',
	getServiceContainer: () => ({ cradle }),
};

const siteConfig = require(path.join(libRoot, 'site-config.js'));
siteConfig.serverManagedFilesystemReady = () => {
	calls.push('serverManagedFilesystemReady');
	return true;
};
siteConfig.removeAllManagedFilesSync = () => {
	calls.push('removeAllManagedFilesSync');
	return true;
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

try {
	const main = require(path.join(libRoot, 'main.js')).default;
	main({ electron: { ipcMain } });
	assert.equal(timers.size, 0, 'startup should skip an untouched disabled site');

	ipcMain.emit('addonInstallerService:disable', {}, {
		name: 'local-media-proxy',
		npmPackageName: 'local-media-proxy',
	});

	assert.equal(
		statusReadCount,
		2,
		'fingerprint construction must perform the throwing second status read',
	);
	assert.equal(
		calls.filter((call) => call === 'removeAllManagedFilesSync').length,
		0,
		'the exception occurs before synchronous managed-file cleanup',
	);
	assert.equal(
		timers.size,
		1,
		'the failed synchronous preparation must leave one deferred cleanup retry',
	);
	const deferredPreparationWarnings = logs.filter(([level, message]) => (
		level === 'warn' &&
		message.includes(
			'Deferred Media Proxy global disable cleanup for site validation-site ' +
			'after synchronous preparation failed; a forced retry was scheduled',
		)
	));
	assert.equal(deferredPreparationWarnings.length, 1);

	process.stdout.write(`${JSON.stringify({
		deferredPreparationWarnings: deferredPreparationWarnings.length,
		deferredTimersAfterFailure: timers.size,
		statusReadCount,
		synchronousRemovalCalls: calls.filter(
			(call) => call === 'removeAllManagedFilesSync',
		).length,
	})}\n`);
} finally {
	Module._load = originalModuleLoad;
	global.setTimeout = originalSetTimeout;
	global.clearTimeout = originalClearTimeout;
}
