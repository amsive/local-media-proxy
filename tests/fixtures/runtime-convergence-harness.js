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
	'corrupt-cleanup-retry',
	'corrupt-passive-state',
	'corrupt-passive-transitioning',
	'corrupt-profile-envelope',
	'corrupt-service-unavailable',
	'corrupt-schema-version',
	'immediate-apache-switch-enable',
	'passive-drift',
	'passive-switch-projection',
	'preflight-service-retry',
	'preflight-status-retry',
	'reconciliation-interruption-retry',
	'rollback-snapshot-disabled',
	'rollback-snapshot-enabled',
	'rollback-malformed-snapshot',
	'rollback-valid-managed',
	'same-value-halted-repair',
	'service-input-change',
	'global-enable-matching',
	'site-start-matching',
	'startup-compiled-drift',
	'startup-noop',
	'supported-service-unavailable-disabled',
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

const isImmediateApacheSwitch = scenario === 'immediate-apache-switch-enable';

const initiallyEnabled = !new Set([
	'rollback-snapshot-enabled',
	'supported-service-unavailable-disabled',
]).has(scenario);
const siteStatus = scenario === 'same-value-halted-repair'
	? 'halted'
	: scenario === 'corrupt-passive-transitioning'
		? 'starting'
		: 'running';
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
	services: isImmediateApacheSwitch
		? { 'apache-2.4.43+11': { name: 'apache-2.4.43+11', role: 'http' } }
		: { 'nginx-1.26.1+3': { name: 'nginx-1.26.1+3', role: 'http' } },
	webServer: isImmediateApacheSwitch ? 'apache' : 'nginx',
};
if (new Set([
	'corrupt-cleanup-retry',
	'corrupt-passive-state',
	'corrupt-passive-transitioning',
	'corrupt-schema-version',
	'corrupt-service-unavailable',
]).has(scenario)) {
	site.localMediaProxy = {
		enabled: true,
		profiles: structuredClone(initialSettings.profiles),
		schemaVersion: 3,
	};
} else if (scenario === 'corrupt-profile-envelope') {
	site.localMediaProxy = {
		enabled: true,
		profiles: null,
		schemaVersion: 2,
	};
} else if (scenario === 'passive-switch-projection') {
	site.localMediaProxy = {
		enabled: false,
		lastServerKind: 'apache',
		profiles: {
			apache: { originIp: '', siteUrl: 'https://carried.example.com' },
			nginx: {},
		},
		schemaVersion: 2,
	};
} else if (isImmediateApacheSwitch) {
	site.localMediaProxy = {
		enabled: false,
		lastServerKind: 'nginx',
		profiles: {
			apache: {},
			nginx: {
				originIp: '192.0.2.10',
				originSource: 'manual',
				siteUrl: 'https://carried.example.com',
			},
		},
		schemaVersion: 2,
	};
}
const storedSettingsBeforeReconciliation = structuredClone(site.localMediaProxy);
const service = {
	bin: isImmediateApacheSwitch
		? { httpd: '/example/services/httpd' }
		: { nginx: '/example/services/nginx' },
	configPath: `/example/runtime/conf/${isImmediateApacheSwitch ? 'apache' : 'nginx'}`,
	configVariables: {},
	env: {},
	runPath: `/example/runtime/run/${isImmediateApacheSwitch ? 'apache' : 'nginx'}`,
	siteConfigTemplatePath: `/example/site/conf/${isImmediateApacheSwitch ? 'apache' : 'nginx'}`,
};

let compiledMatches = new Set([
	'global-enable-matching',
	'passive-switch-projection',
	'site-start-matching',
	'startup-noop',
]).has(scenario);
let sourceMatches = true;
let restartCalls = 0;
let cleanCompileFailuresRemaining = scenario === 'corrupt-cleanup-retry' ? 1 : 0;
let serviceLookupCalls = 0;
let siteStatusCalls = 0;
let reconciliationInterruptionsRemaining = scenario === 'reconciliation-interruption-retry' ? 1 : 0;
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
		getSiteService: () => {
			serviceLookupCalls += 1;
			if (scenario === 'preflight-service-retry' && serviceLookupCalls === 2) {
				throw new Error('simulated service lookup failure');
			}
			return new Set([
				'corrupt-service-unavailable',
				'supported-service-unavailable-disabled',
			]).has(scenario) ? null : service;
		},
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
		getSiteStatus: () => {
			siteStatusCalls += 1;
			if (scenario === 'preflight-status-retry' && siteStatusCalls === 2) {
				throw new Error('simulated site-status failure');
			}
			return siteStatus;
		},
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
	readApacheManagedModulesTemplate: async () => '# exact managed modules\n',
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
		if (expected === null && cleanCompileFailuresRemaining > 0) {
			cleanCompileFailuresRemaining -= 1;
			throw new Error('simulated clean compilation failure');
		}
		compiledMatches = true;
		if (scenario === 'service-input-change') {
			service.configVariables.revision = 2;
		}
		if (reconciliationInterruptionsRemaining > 0) {
			reconciliationInterruptionsRemaining -= 1;
			service.configVariables.revision = 2;
		}
	},
	nginxCompiledConfigMatches: async () => compiledMatches,
});

const apache = require(path.join(libRoot, 'apache.js'));
Object.assign(apache, {
	apacheCompiledConfigMatches: async () => compiledMatches,
	inspectApacheRuntimeCapabilities: async () => ({
		https: true,
		http: true,
	}),
	refreshApacheService: async (_site, _service, _compiler, _exec, expectManaged) => {
		calls.push(`compileApache:${expectManaged ? 'managed' : 'clean'}`);
		compiledMatches = true;
		restartCalls += 1;
		return true;
	},
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
server.detectSiteServer = () => isImmediateApacheSwitch
	? {
		kind: 'apache',
		requiresOriginIp: false,
		serviceName: 'apache-2.4.43+11',
	}
	: {
		kind: 'nginx',
		requiresOriginIp: true,
		serviceName: 'nginx-1.26.1+3',
	};

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
		let preflightCallsAfterOneRecoverySample;
		let projectedSiteUrl;
		let preflightTimersAfterFailure;
		let preflightTimersAfterOneRecoverySample;
		let retryTimersAfterFailure;
		if (
			scenario === 'corrupt-passive-state' ||
			scenario === 'corrupt-passive-transitioning' ||
			scenario === 'passive-drift' ||
			scenario === 'passive-switch-projection' ||
			scenario === 'supported-service-unavailable-disabled'
		) {
			state = await ipcMain.handlers.get(IPC_CHANNELS.getSiteState)({}, site.id);
		} else if (
			scenario === 'preflight-service-retry' ||
			scenario === 'preflight-status-retry'
		) {
			await runNextTimer();
			await runNextTimer();
			await flushAsyncWork();
			preflightTimersAfterFailure = timers.size;
			await runNextTimer();
			await flushAsyncWork();
			preflightTimersAfterOneRecoverySample = timers.size;
			preflightCallsAfterOneRecoverySample = calls.length;
			await runNextTimer();
			await flushAsyncWork();
		} else if (
			scenario === 'startup-noop' ||
				scenario === 'startup-compiled-drift' ||
				scenario === 'reconciliation-interruption-retry' ||
				scenario === 'corrupt-service-unavailable' ||
				scenario === 'corrupt-cleanup-retry' ||
				scenario === 'corrupt-schema-version' ||
			scenario === 'corrupt-profile-envelope'
		) {
			await runNextTimer();
			await runNextTimer();
			await flushAsyncWork();
			if (scenario === 'corrupt-cleanup-retry') {
				retryTimersAfterFailure = timers.size;
				await runNextTimer();
				await runNextTimer();
				await flushAsyncWork();
			}
			if (scenario === 'reconciliation-interruption-retry') {
				retryTimersAfterFailure = timers.size;
				await runNextTimer();
				await runNextTimer();
				await flushAsyncWork();
			}
		} else if (scenario === 'site-start-matching') {
			const [siteStarted] = hooks.get('siteStarted') || [];
			assert.equal(typeof siteStarted, 'function');
			siteStarted(site.id);
			await runNextTimer();
			await runNextTimer();
			await flushAsyncWork();
		} else if (scenario === 'global-enable-matching') {
			ipcMain.emit(
				'addonInstallerService:enable',
				{},
				{ npmPackageName: 'local-media-proxy' },
			);
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
		} else if (isImmediateApacheSwitch) {
			const projected = await ipcMain.handlers.get(IPC_CHANNELS.getSiteState)({}, site.id);
			projectedSiteUrl = projected.settings.siteUrl;
			state = await ipcMain.handlers.get(IPC_CHANNELS.setEnabled)(
				{},
				site.id,
				'apache',
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
			finalStoredSettings: site.localMediaProxy,
			operationError,
			pendingTimers: timers.size,
			preflightCallsAfterOneRecoverySample,
			preflightTimersAfterFailure,
			preflightTimersAfterOneRecoverySample,
			projectedSiteUrl,
			restartCalls,
			retryTimersAfterFailure,
			stateCanEnable: state?.canEnable,
			stateCleanupSupported: state?.cleanupSupported,
			stateEnabledIntent: state?.settings.enabled,
			stateLifecycleReady: state?.lifecycleReady,
			stateSettingsReadOnly: state?.settingsReadOnly,
			state: state && {
				applied: state.applied,
				needsAttention: state.needsAttention,
				reason: state.reason,
				siteUrl: state.settings.siteUrl,
				siteStatus: state.siteStatus,
			},
			updates,
			storedSettingsBeforeReconciliation,
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
