/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const scenario = process.argv[2];
const supportedScenarios = new Set([
	'passive-drift',
	'rollback-snapshot-disabled',
	'rollback-snapshot-enabled',
	'rollback-malformed-snapshot',
	'rollback-valid-managed',
	'same-value-halted-repair',
	'service-input-change',
	'startup-compiled-drift',
	'startup-noop',
	'target-service-missing',
]);
assert.ok(supportedScenarios.has(scenario), `unsupported scenario: ${scenario}`);

const libRoot = path.resolve(__dirname, '../../lib');
const calls = [];
const logs = [];
const hooks = new Map();
const updates = [];
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, handler) => ipcMain.handlers.set(channel, handler);
ipcMain.removeHandler = (channel) => ipcMain.handlers.delete(channel);

const initiallyEnabled = scenario !== 'rollback-snapshot-enabled';
const siteStatus = scenario === 'same-value-halted-repair' ? 'halted' : 'running';
const initialSettings = {
	enabled: initiallyEnabled,
	lastServerKind: 'nginx',
	profiles: {
		apache: { originIp: '', originSource: 'manual', siteUrl: 'http://media.example.com' },
		nginx: {
			originIp: '192.0.2.10',
			originSource: 'manual',
			siteUrl: 'http://media.example.com',
		},
	},
	schemaVersion: 2,
};
const site = {
	id: 'runtime-site',
	localMediaProxy: structuredClone(initialSettings),
	longPath: '/example/site',
	name: 'runtime-site',
	paths: { confTemplates: '/example/site/conf' },
	services: {
		'nginx-1.26.1+3': { name: 'nginx-1.26.1+3', role: 'http' },
	},
	webServer: 'nginx',
};
const service = {
	bin: { nginx: '/example/services/nginx' },
	configPath: '/example/runtime/conf/nginx',
	configVariables: {},
	env: {},
	runPath: '/example/runtime/run/nginx',
	siteConfigTemplatePath: '/example/site/conf/nginx',
};

let compiledMatches = scenario === 'startup-noop';
let sourceMatches = true;
let restartCalls = 0;
const rollbackSourceMatches = scenario === 'rollback-valid-managed';
const rollbackScenarios = new Set([
	'rollback-malformed-snapshot',
	'rollback-snapshot-disabled',
	'rollback-snapshot-enabled',
	'rollback-valid-managed',
]);

const cradle = {
	appState: {
		getState: () => ({ enabledAddons: { 'local-media-proxy': true } }),
	},
	capi: {},
	configTemplates: {
		compileConfigTemplates: async () => calls.push('unexpected-template-compiler'),
		compileServiceConfigs: async () => calls.push('compileServiceConfigs'),
	},
	lightningServices: {
		getSiteService: () => service,
	},
	localLogger: {
		child: () => ({
			log: (level, message) => logs.push([level, message]),
		}),
	},
	siteData: {
		getSite: (siteId) => siteId === site.id ? site : undefined,
		getSites: () => ({ [site.id]: site }),
		updateSite: (_siteId, update) => {
			calls.push('updateSite');
			updates.push(structuredClone(update.localMediaProxy));
			site.localMediaProxy = structuredClone(update.localMediaProxy);
		},
	},
	siteProcessManager: {
		getSiteStatus: () => siteStatus,
		hasRunningProcess: () => (
			siteStatus === 'running' && scenario !== 'target-service-missing'
		),
		restartSiteService: async (_site, serviceName) => {
			calls.push(`restart:${serviceName}`);
			restartCalls += 1;
			if (rollbackScenarios.has(scenario) && restartCalls === 1) {
				throw new Error('targeted restart failed');
			}
		},
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
Object.assign(siteConfig, {
	allManagedArtifactsExist: async () => false,
	applyServerManagedFiles: async () => {
		calls.push('applyServerManagedFiles');
		sourceMatches = true;
		return false;
	},
	captureAllManagedFiles: async () => {
		calls.push('captureAllManagedFiles');
		return [{ content: null, filePath: '/example/snapshot' }];
	},
	readApacheManagedModulesTemplate: async () => null,
	readServerManagedIncludeTemplate: async () => '# exact managed include\n',
	removeAllManagedFiles: async () => {
		calls.push('removeAllManagedFiles');
		sourceMatches = false;
		return false;
	},
	restoreManagedFiles: async () => {
		calls.push('restoreManagedFiles');
		sourceMatches = rollbackSourceMatches;
	},
	serverManagedFilesMatch: async () => sourceMatches,
	serverManagedFilesystemReady: () => true,
});

const nginx = require(path.join(libRoot, 'nginx.js'));
Object.assign(nginx, {
	compileAndValidateNginxConfig: async (_site, _service, _compiler, _exec, expected) => {
		calls.push(`compileNginx:${expected === null ? 'clean' : 'managed'}`);
		compiledMatches = true;
		if (scenario === 'service-input-change') {
			service.configVariables.revision = 2;
		}
	},
	nginxCompiledConfigMatches: async () => compiledMatches,
});

const origin = require(path.join(libRoot, 'origin.js'));
Object.assign(origin, {
	probeOrigin: async () => {
		calls.push('probeOrigin');
		return {
			statusCode: 200,
			trustedCertificateAuthoritiesPem: undefined,
			verifiedTlsHostname: 'media.example.com',
		};
	},
});

const server = require(path.join(libRoot, 'server.js'));
server.detectSiteServer = () => ({
	kind: 'nginx',
	requiresOriginIp: true,
	serviceName: 'nginx-1.26.1+3',
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

async function runNextTimer() {
	const first = [...timers.entries()].sort(([left], [right]) => left - right)[0];
	assert.ok(first, 'expected a deferred timer');
	timers.delete(first[0]);
	first[1]();
	await Promise.resolve();
}

async function flushAsyncWork() {
	for (let index = 0; index < 4; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

(async () => {
	try {
		const main = require(path.join(libRoot, 'main.js')).default;
		main({ electron: { ipcMain } });
		const { IPC_CHANNELS } = require(path.join(libRoot, 'constants.js'));

		let state;
		let operationError;
		if (scenario === 'passive-drift') {
			state = await ipcMain.handlers.get(IPC_CHANNELS.getSiteState)({}, site.id);
		} else if (scenario === 'startup-noop' || scenario === 'startup-compiled-drift') {
			await runNextTimer();
			await runNextTimer();
			await flushAsyncWork();
		} else if (scenario === 'same-value-halted-repair') {
			state = await ipcMain.handlers.get(IPC_CHANNELS.setEnabled)(
				{},
				site.id,
				'nginx',
				true,
			);
		} else {
			try {
				await ipcMain.handlers.get(IPC_CHANNELS.applySettings)(
					{},
					site.id,
					{
						enabled: true,
						originIp: '192.0.2.10',
						originSource: 'manual',
						siteUrl: 'http://media.example.com',
					},
					'nginx',
				);
			} catch (error) {
				operationError = error.message;
			}
		}

		process.stdout.write(`${JSON.stringify({
			calls,
			compiledMatches,
			finalEnabled: site.localMediaProxy.enabled,
			operationError,
			restartCalls,
			state: state && {
				applied: state.applied,
				needsAttention: state.needsAttention,
				siteStatus: state.siteStatus,
			},
			updates,
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
