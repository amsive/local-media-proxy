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
	'global-enable-configured-disabled-halted',
	'global-enable-configured-disabled-running',
	'global-enable-pristine-disabled-nginx',
	'site-start-matching',
	'site-start-configured-disabled-halted',
	'site-added-pristine-disabled-nginx',
	'site-start-pristine-disabled-nginx',
	'startup-configured-disabled-halted',
	'startup-configured-disabled-nginx',
	'startup-compiled-drift',
	'startup-enabled-halted-drift',
	'startup-noop',
	'startup-pristine-disabled-apache',
	'startup-pristine-disabled-nginx',
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
const isApacheRuntime = isImmediateApacheSwitch || scenario === 'startup-pristine-disabled-apache';
const pristineDisabledScenarios = new Set([
	'global-enable-pristine-disabled-nginx',
	'site-added-pristine-disabled-nginx',
	'site-start-pristine-disabled-nginx',
	'startup-pristine-disabled-nginx',
]);

const initiallyEnabled = !pristineDisabledScenarios.has(scenario) && !new Set([
	'global-enable-configured-disabled-halted',
	'global-enable-configured-disabled-running',
	'rollback-snapshot-enabled',
	'site-start-configured-disabled-halted',
	'startup-configured-disabled-halted',
	'startup-configured-disabled-nginx',
	'startup-pristine-disabled-apache',
	'supported-service-unavailable-disabled',
]).has(scenario);
const siteStatus = new Set([
	'global-enable-configured-disabled-halted',
	'same-value-halted-repair',
	'site-start-configured-disabled-halted',
	'startup-configured-disabled-halted',
	'startup-enabled-halted-drift',
]).has(scenario)
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
	services: isApacheRuntime
		? { 'apache-2.4.43+11': { name: 'apache-2.4.43+11', role: 'http' } }
		: { 'nginx-1.26.1+3': { name: 'nginx-1.26.1+3', role: 'http' } },
	webServer: isApacheRuntime ? 'apache' : 'nginx',
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
} else if (pristineDisabledScenarios.has(scenario)) {
	site.localMediaProxy = {
		enabled: false,
		lastServerKind: 'nginx',
		originIp: '',
		productionUrl: '',
		profiles: {
			apache: { originIp: '', productionUrl: '', siteUrl: '' },
			nginx: { originIp: '', productionUrl: '', siteUrl: '' },
		},
		schemaVersion: 2,
		siteUrl: '',
	};
} else if (scenario === 'startup-pristine-disabled-apache') {
	site.localMediaProxy = {
		enabled: false,
		lastServerKind: 'apache',
		profiles: {
			apache: {},
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
	bin: isApacheRuntime
		? { httpd: '/example/services/httpd' }
		: { nginx: '/example/services/nginx' },
	configPath: `/example/runtime/conf/${isApacheRuntime ? 'apache' : 'nginx'}`,
	configVariables: {},
	env: {},
	runPath: `/example/runtime/run/${isApacheRuntime ? 'apache' : 'nginx'}`,
	siteConfigTemplatePath: `/example/site/conf/${isApacheRuntime ? 'apache' : 'nginx'}`,
};

let compiledMatches = new Set([
	'global-enable-matching',
	'passive-switch-projection',
	'site-start-matching',
	'startup-noop',
	'startup-pristine-disabled-apache',
]).has(scenario);
let sourceMatches = true;
let refreshCalls = 0;
let restartCalls = 0;
let cleanCompileFailuresRemaining = scenario === 'corrupt-cleanup-retry' ? 1 : 0;
let serviceLookupCalls = 0;
let siteStatusCalls = 0;
let compiledMatchChecks = 0;
let filesystemReadyChecks = 0;
let managedArtifactChecks = 0;
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
	allManagedArtifactsExist: async () => {
		managedArtifactChecks += 1;
		return false;
	},
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
	serverManagedFilesystemReady: () => {
		filesystemReadyChecks += 1;
		return true;
	},
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
	nginxCompiledConfigMatches: async () => {
		compiledMatchChecks += 1;
		return compiledMatches;
	},
	refreshNginxService: async (
		_site,
		_service,
		_compiler,
		_exec,
		expected,
		isSiteRunning,
		isServiceRunning,
		options,
	) => {
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
		options?.assertCurrent?.();
		if (!isSiteRunning()) {
			return false;
		}
		if (!isServiceRunning()) {
			throw new Error(
				"Local no longer reports this site's Nginx service as running. Stop and start the site in Local, then retry.",
			);
		}
		calls.push('reloadNginx');
		refreshCalls += 1;
		if (rollbackScenarios.has(scenario) && refreshCalls === 1) {
			throw new Error('targeted reload failed');
		}
		return true;
	},
});

const apache = require(path.join(libRoot, 'apache.js'));
Object.assign(apache, {
	apacheCompiledConfigMatches: async () => {
		compiledMatchChecks += 1;
		return compiledMatches;
	},
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
server.detectSiteServer = () => isApacheRuntime
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
		} else if (pristineDisabledScenarios.has(scenario)) {
			if (scenario === 'global-enable-pristine-disabled-nginx') {
				ipcMain.emit(
					'addonInstallerService:enable',
					{},
					{ npmPackageName: 'local-media-proxy' },
				);
			} else if (scenario === 'site-added-pristine-disabled-nginx') {
				const [siteAdded] = hooks.get('siteAdded') || [];
				assert.equal(typeof siteAdded, 'function');
				siteAdded(site.id);
			} else if (scenario === 'site-start-pristine-disabled-nginx') {
				const [siteStarted] = hooks.get('siteStarted') || [];
				assert.equal(typeof siteStarted, 'function');
				siteStarted(site.id);
			}
			await flushAsyncWork();
		} else if (
			scenario === 'startup-noop' ||
			scenario === 'startup-configured-disabled-halted' ||
			scenario === 'startup-configured-disabled-nginx' ||
			scenario === 'startup-pristine-disabled-apache' ||
			scenario === 'startup-compiled-drift' ||
			scenario === 'startup-enabled-halted-drift' ||
			scenario === 'reconciliation-interruption-retry' ||
			scenario === 'corrupt-service-unavailable' ||
			scenario === 'corrupt-cleanup-retry' ||
			scenario === 'corrupt-schema-version' ||
			scenario === 'corrupt-profile-envelope'
		) {
			await runNextTimer();
			if (timers.size > 0) {
				await runNextTimer();
			}
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
		} else if (
			scenario === 'site-start-matching' ||
			scenario === 'site-start-configured-disabled-halted'
		) {
			const [siteStarted] = hooks.get('siteStarted') || [];
			assert.equal(typeof siteStarted, 'function');
			siteStarted(site.id);
			await runNextTimer();
			await runNextTimer();
			await flushAsyncWork();
		} else if (
			scenario === 'global-enable-matching' ||
			scenario === 'global-enable-configured-disabled-halted' ||
			scenario === 'global-enable-configured-disabled-running'
		) {
			ipcMain.emit(
				'addonInstallerService:enable',
				{},
				{ npmPackageName: 'local-media-proxy' },
			);
			await runNextTimer();
			if (timers.size > 0) {
				await runNextTimer();
			}
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
			compiledMatchChecks,
			compiledMatches,
			filesystemReadyChecks,
			finalEnabled: site.localMediaProxy.enabled,
			finalStoredSettings: site.localMediaProxy,
			operationError,
			managedArtifactChecks,
			pendingTimers: timers.size,
			preflightCallsAfterOneRecoverySample,
			preflightTimersAfterFailure,
			preflightTimersAfterOneRecoverySample,
			projectedSiteUrl,
			refreshCalls,
			restartCalls,
			retryTimersAfterFailure,
			stateCanEnable: state?.canEnable,
			stateCleanupSupported: state?.cleanupSupported,
			stateEnabledIntent: state?.settings.enabled,
			stateLifecycleReady: state?.lifecycleReady,
			stateSettingsReadOnly: state?.settingsReadOnly,
			serviceLookupCalls,
			siteStatusCalls,
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
