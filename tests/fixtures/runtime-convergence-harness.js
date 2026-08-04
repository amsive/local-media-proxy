/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const scenario = process.argv[2];
const supportedScenarios = new Set([
	'corrupt-cleanup-failure-cancels',
	'corrupt-cleanup-failure-newer-event',
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
	'reconciliation-service-path-change-recovery',
	'rollback-snapshot-disabled',
	'rollback-snapshot-enabled',
	'rollback-malformed-snapshot',
	'rollback-valid-managed',
	'router-listener-unrelated-owner-rejected',
	'router-recovery-blocked-by-transitional-site',
	'changed-save-apply-reprobes',
	'explicit-test-reprobes',
	'same-value-halted-repair',
	'same-value-save-apply-fast-path',
	'same-value-wpengine-fast-path',
	'same-value-wpengine-provenance-mismatch',
	'service-path-change',
	'global-enable-matching',
	'global-enable-configured-disabled-halted',
	'global-enable-configured-disabled-running',
	'global-enable-pristine-disabled-nginx',
	'site-start-matching',
	'site-start-configured-disabled-halted',
	'site-added-pristine-disabled-nginx',
	'site-start-pristine-disabled-nginx',
	'startup-configured-disabled-halted',
	'startup-configured-disabled-clean-nginx',
	'startup-configured-disabled-nginx',
	'startup-compiled-drift',
	'startup-enabled-halted-drift',
	'startup-noop',
	'startup-pristine-disabled-apache',
	'startup-pristine-disabled-nginx',
	'supported-service-unavailable-disabled',
	'target-service-missing',
	'target-apache-service-missing',
	'target-service-missing-disable',
	'target-service-missing-save-disable',
	'target-service-missing-clean-disable',
	'target-service-missing-restart-timeout',
	'versioned-apache-stale-master-orphan-recovery',
	'versioned-nginx-stale-master-orphan-recovery',
	'versioned-nginx-stale-master-recovery',
	'versioned-nginx-stale-master-recovery-failure',
	'versioned-nginx-stale-master-restart-timeout',
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
const isRouterIdentityScenario = scenario === 'router-listener-unrelated-owner-rejected';
const isRouterLifecycleGuardScenario = scenario === 'router-recovery-blocked-by-transitional-site';
const isRouterScenario = isRouterIdentityScenario || isRouterLifecycleGuardScenario;
const isApacheRuntime = isImmediateApacheSwitch || new Set([
	'startup-pristine-disabled-apache',
	'target-apache-service-missing',
	'versioned-apache-stale-master-orphan-recovery',
]).has(scenario);
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
	'startup-configured-disabled-clean-nginx',
	'startup-configured-disabled-nginx',
	'startup-pristine-disabled-apache',
	'supported-service-unavailable-disabled',
	'target-service-missing-clean-disable',
	'versioned-nginx-stale-master-recovery-failure',
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
	frontendPort: 10080,
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
	'corrupt-cleanup-failure-cancels',
	'corrupt-cleanup-failure-newer-event',
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
if (new Set([
	'changed-save-apply-reprobes',
	'explicit-test-reprobes',
	'same-value-halted-repair',
	'same-value-save-apply-fast-path',
]).has(scenario)) {
	Object.assign(site.localMediaProxy.profiles.nginx, {
		lastOriginStatus: 200,
		lastVerifiedAt: '2026-08-04T12:00:00.000Z',
	});
}
if (new Set([
	'same-value-wpengine-fast-path',
	'same-value-wpengine-provenance-mismatch',
]).has(scenario)) {
	site.hostConnections = [{
		hostId: 'wpe',
		remoteSiteId: scenario === 'same-value-wpengine-provenance-mismatch'
			? 'different-site'
			: 'wp-site',
	}];
	site.localMediaProxy.profiles.nginx = {
		certificate: {
			fingerprint256: 'AA:BB',
			issuer: 'Example CA',
			subject: 'example-production.wpengine.com',
			validTo: 'Aug 04 12:00:00 2027 GMT',
		},
		lastOriginStatus: 200,
		lastVerifiedAt: '2026-08-04T12:00:00.000Z',
		originEnvironment: 'production',
		originIp: '192.0.2.10',
		originSource: 'wpengine',
		originTlsHostname: 'example-production.wpengine.com',
		originWpEngineInstallId: 'wp-install',
		originWpEngineSiteId: 'wp-site',
		resolvedAt: '2026-08-04T11:00:00.000Z',
		siteUrl: 'https://www.example.com',
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
	'startup-configured-disabled-clean-nginx',
	'startup-noop',
	'startup-pristine-disabled-apache',
	'target-service-missing-clean-disable',
]).has(scenario);
let sourceMatches = true;
let refreshCalls = 0;
let restartCalls = 0;
let cleanCompileFailuresRemaining = new Set([
	'corrupt-cleanup-failure-cancels',
	'corrupt-cleanup-failure-newer-event',
]).has(scenario) ? 1 : 0;
let serviceLookupCalls = 0;
let siteStatusCalls = 0;
let compiledMatchChecks = 0;
let filesystemReadyChecks = 0;
let managedArtifactChecks = 0;
let publishedSiteStartedEvents = 0;
const runningProcessChecks = [];
let nginxRuntimeRunning = true;
let reconciliationInterruptionsRemaining = scenario === 'reconciliation-service-path-change-recovery' ? 1 : 0;
const rollbackSourceMatches = new Set([
	'rollback-valid-managed',
]).has(scenario);
const rollbackScenarios = new Set([
	'rollback-malformed-snapshot',
	'rollback-snapshot-disabled',
	'rollback-snapshot-enabled',
	'rollback-valid-managed',
]);
const missingTargetProcessScenarios = new Set([
	'target-apache-service-missing',
	'target-service-missing',
	'target-service-missing-disable',
	'target-service-missing-save-disable',
	'target-service-missing-clean-disable',
	'target-service-missing-restart-timeout',
]);
const staleNginxScenarios = new Set([
	'versioned-nginx-stale-master-orphan-recovery',
	'versioned-nginx-stale-master-recovery',
	'versioned-nginx-stale-master-recovery-failure',
	'versioned-nginx-stale-master-restart-timeout',
]);
const staleServerScenarios = new Set([
	...staleNginxScenarios,
	'versioned-apache-stale-master-orphan-recovery',
]);
const churningStaleService = new Set([
	'versioned-apache-stale-master-orphan-recovery',
	'versioned-nginx-stale-master-orphan-recovery',
]).has(scenario);
const trackedProcessName = isApacheRuntime ? 'httpd' : 'nginx';
const trackedSiteProcess = {
	binPath: service.bin[trackedProcessName],
	childProcess: missingTargetProcessScenarios.has(scenario) || churningStaleService ? undefined : {
		exitCode: null,
		killed: false,
		pid: 4242,
		signalCode: null,
	},
	errored: missingTargetProcessScenarios.has(scenario),
	name: trackedProcessName,
	restart: async () => {
		calls.push(`restart:${trackedProcessName}`);
		restartCalls += 1;
		if (new Set([
			'target-service-missing-restart-timeout',
			'versioned-nginx-stale-master-restart-timeout',
		]).has(scenario)) {
			return new Promise(() => undefined);
		}
		if (missingTargetProcessScenarios.has(scenario)) {
			throw new Error('simulated targeted service restart failure');
		}
		trackedSiteProcess.errored = false;
		trackedSiteProcess.childProcess = {
			exitCode: null,
			killed: false,
			pid: 5252,
			signalCode: null,
		};
		if (staleNginxScenarios.has(scenario)) {
			nginxRuntimeRunning = true;
		}
	},
};
const routerMasterPid = process.pid + 100_000;
const trackedRouterProcess = {
	binPath: process.execPath,
	childProcess: {
		exitCode: null,
		killed: false,
		pid: routerMasterPid,
		signalCode: null,
	},
	errored: false,
	restarts: 1,
	restart: async () => calls.push('restart:router'),
};

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
		getLatestVersion: (serviceName) => serviceName === 'apache'
			? { bin: { httpd: '/example/services/httpd' } }
			: { bin: { nginx: '/example/services/nginx' } },
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
	router: isRouterScenario ? {
		_process: trackedRouterProcess,
		clearRouterBanner: () => calls.push('clearRouterBanner'),
		useLaunchd: false,
	} : undefined,
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
		_processGroups: {
			[site.id]: { processes: [trackedSiteProcess] },
		},
		getSiteStatus: () => {
			siteStatusCalls += 1;
			if (scenario === 'preflight-status-retry' && siteStatusCalls === 2) {
				throw new Error('simulated site-status failure');
			}
			return siteStatus;
		},
		getSiteStatuses: () => {
			calls.push('getSiteStatuses');
			return isRouterLifecycleGuardScenario
				? { [site.id]: 'running', 'sibling-site': 'pulling' }
				: { [site.id]: siteStatus };
		},
		hasRunningProcess: (_site, processName) => {
			runningProcessChecks.push(processName);
			return siteStatus === 'running' &&
				!missingTargetProcessScenarios.has(scenario) &&
				(
					!staleNginxScenarios.has(scenario) ||
					(processName === 'nginx' && nginxRuntimeRunning)
				);
		},
		restartSiteService: async (_site, serviceName) => {
			assert.equal(serviceName, trackedProcessName);
			await trackedSiteProcess.restart();
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
	execFilePromise: async (command) => {
		if (
			isRouterScenario &&
			typeof command === 'string' &&
			path.basename(command) === 'lsof'
		) {
			calls.push('lsof');
		}
		return '';
	},
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
function publishNewerSiteStartedEvent() {
	if (!new Set([
		'corrupt-cleanup-failure-newer-event',
		'reconciliation-service-path-change-recovery',
	]).has(scenario)) {
		return;
	}
	const [siteStarted] = hooks.get('siteStarted') || [];
	assert.equal(typeof siteStarted, 'function');
	publishedSiteStartedEvents += 1;
	siteStarted(site.id);
}
Object.assign(nginx, {
	compileAndValidateNginxConfig: async (_site, _service, _compiler, _exec, expected) => {
		calls.push(`compileNginx:${expected === null ? 'clean' : 'managed'}`);
		if (expected === null && cleanCompileFailuresRemaining > 0) {
			cleanCompileFailuresRemaining -= 1;
			publishNewerSiteStartedEvent();
			throw new Error('simulated clean compilation failure');
		}
		compiledMatches = true;
		if (scenario === 'service-path-change') {
			service.configPath = '/example/runtime/conf/nginx-replaced';
		}
		if (reconciliationInterruptionsRemaining > 0) {
			reconciliationInterruptionsRemaining -= 1;
			service.configPath = '/example/runtime/conf/nginx-replaced';
			publishNewerSiteStartedEvent();
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
		options,
	) => {
		calls.push(`compileNginx:${expected === null ? 'clean' : 'managed'}`);
		if (expected === null && cleanCompileFailuresRemaining > 0) {
			cleanCompileFailuresRemaining -= 1;
			publishNewerSiteStartedEvent();
			throw new Error('simulated clean compilation failure');
		}
		compiledMatches = true;
		if (scenario === 'service-path-change') {
			service.configPath = '/example/runtime/conf/nginx-replaced';
		}
		if (reconciliationInterruptionsRemaining > 0) {
			reconciliationInterruptionsRemaining -= 1;
			service.configPath = '/example/runtime/conf/nginx-replaced';
			publishNewerSiteStartedEvent();
		}
		options?.assertCurrent?.();
		if (!isSiteRunning()) {
			return false;
		}
		calls.push('reloadNginx');
		refreshCalls += 1;
		if (staleNginxScenarios.has(scenario) && refreshCalls === 1) {
			await options?.restartService?.();
			calls.push('reloadNginx');
			if (scenario === 'versioned-nginx-stale-master-recovery-failure') {
				throw new Error('replacement did not accept a reload');
			}
			return true;
		}
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
	refreshApacheService: async (
		_site,
		_service,
		_compiler,
		_exec,
		expectManaged,
		_isSiteRunning,
		_isServiceRunning,
		options,
	) => {
		calls.push(`compileApache:${expectManaged ? 'managed' : 'clean'}`);
		compiledMatches = true;
		if (scenario === 'versioned-apache-stale-master-orphan-recovery') {
			await options?.restartService?.();
			return true;
		}
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

const orphanRecovery = require(path.join(libRoot, 'orphan-recovery.js'));
const inspectExactResourceOwners = orphanRecovery.inspectExactResourceOwners;
const recoverExactResourceOrphans = orphanRecovery.recoverExactResourceOrphans;
orphanRecovery.inspectExactResourceOwners = async (...args) => {
	if (isRouterIdentityScenario) {
		calls.push(`inspectRouterListener:${args[0].port}`);
		const executablePath = fs.realpathSync(process.execPath);
		const uid = process.getuid();
		return [
			{ executablePath, parentPid: process.pid, pid: routerMasterPid, uid },
			{ executablePath, parentPid: routerMasterPid, pid: routerMasterPid + 1, uid },
			{ executablePath, parentPid: routerMasterPid + 20, pid: routerMasterPid + 21, uid },
		];
	}
	return inspectExactResourceOwners(...args);
};
orphanRecovery.recoverExactResourceOrphans = async (...args) => {
	if (isRouterLifecycleGuardScenario) {
		calls.push('recoverRouterResource');
		return { pids: [], status: 'missing' };
	}
	if (scenario === 'versioned-nginx-stale-master-recovery') {
		calls.push('unexpectedActiveListenerRecovery');
		return { pids: [], status: 'active' };
	}
	if (new Set([
		'versioned-apache-stale-master-orphan-recovery',
		'versioned-nginx-stale-master-orphan-recovery',
	]).has(scenario)) {
		assert.deepEqual([...args[1]].sort(), [
			'/example/services/httpd',
			'/example/services/nginx',
		]);
		calls.push('recoverPortOrphan');
		return { pids: [4242], status: 'recovered' };
	}
	return recoverExactResourceOrphans(...args);
};

let nextTimerId = 1;
const timers = new Map();
let boundedProcessRestartTimerId;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const hadLocalhostRouting = Object.hasOwn(global, 'localhostRouting');
const originalLocalhostRouting = global.localhostRouting;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (isRouterScenario) {
	global.localhostRouting = false;
}
if (
	isRouterLifecycleGuardScenario ||
	staleServerScenarios.has(scenario) ||
	scenario === 'target-service-missing-restart-timeout'
) {
	Object.defineProperty(process, 'platform', {
		...originalPlatformDescriptor,
		value: 'darwin',
	});
}
global.setTimeout = (callback, delay, ...args) => {
	const timerId = nextTimerId++;
	if (new Set([
		'target-service-missing-restart-timeout',
		'versioned-nginx-stale-master-restart-timeout',
	]).has(scenario) && delay === 5_000) {
		boundedProcessRestartTimerId = timerId;
	}
	if ((staleServerScenarios.has(scenario) || isRouterScenario) && delay === 100) {
		setImmediate(() => {
			if (churningStaleService && !trackedSiteProcess.childProcess) {
				trackedSiteProcess.errored = true;
			}
			callback(...args);
		});
		return timerId;
	}
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
		let retryCallsAfterOneRecoverySample;
		let retryTimersAfterFailure;
		let retryTimersAfterOneRecoverySample;
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
			if (timers.size > 0) {
				await runNextTimer();
				await flushAsyncWork();
			}
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
			scenario === 'startup-configured-disabled-clean-nginx' ||
			scenario === 'startup-configured-disabled-nginx' ||
			scenario === 'startup-pristine-disabled-apache' ||
			scenario === 'startup-compiled-drift' ||
			scenario === 'startup-enabled-halted-drift' ||
			scenario === 'reconciliation-service-path-change-recovery' ||
			scenario === 'corrupt-service-unavailable' ||
			scenario === 'corrupt-cleanup-failure-cancels' ||
			scenario === 'corrupt-cleanup-failure-newer-event' ||
			scenario === 'corrupt-schema-version' ||
			scenario === 'corrupt-profile-envelope'
		) {
			await runNextTimer();
			if (timers.size > 0) {
				await runNextTimer();
			}
			if (timers.size > 0) {
				await runNextTimer();
			}
			await flushAsyncWork();
			if (scenario === 'corrupt-cleanup-failure-cancels') {
				retryTimersAfterFailure = timers.size;
			}
			if (new Set([
				'corrupt-cleanup-failure-newer-event',
				'reconciliation-service-path-change-recovery',
			]).has(scenario)) {
				retryTimersAfterFailure = timers.size;
				await runNextTimer();
				await flushAsyncWork();
				retryTimersAfterOneRecoverySample = timers.size;
				retryCallsAfterOneRecoverySample = calls.length;
				await runNextTimer();
				await flushAsyncWork();
				if (timers.size > 0) {
					await runNextTimer();
					await flushAsyncWork();
				}
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
			if (timers.size > 0) {
				await runNextTimer();
			}
			await flushAsyncWork();
		} else if (scenario === 'target-service-missing-disable') {
			try {
				await ipcMain.handlers.get(IPC_CHANNELS.setEnabled)(
					{},
					site.id,
					isApacheRuntime ? 'apache' : 'nginx',
					false,
				);
			} catch (error) {
				operationError = error.message;
			}
		} else if (new Set([
			'target-service-missing-save-disable',
			'target-service-missing-clean-disable',
		]).has(scenario)) {
			try {
				state = await ipcMain.handlers.get(IPC_CHANNELS.applySettings)(
					{},
					site.id,
					{
						enabled: false,
						originIp: '192.0.2.10',
						originSource: 'manual',
						siteUrl: 'http://media.example.com',
					},
					'nginx',
				);
			} catch (error) {
				operationError = error.message;
			}
		} else if (scenario === 'same-value-halted-repair') {
			state = await ipcMain.handlers.get(IPC_CHANNELS.setEnabled)(
				{},
				site.id,
				'nginx',
				true,
			);
		} else if (scenario === 'explicit-test-reprobes') {
			await ipcMain.handlers.get(IPC_CHANNELS.testOrigin)(
				{ sender: { id: 1 } },
				site.id,
				{
					enabled: true,
					originIp: '192.0.2.10',
					originSource: 'manual',
					siteUrl: 'http://media.example.com',
				},
				'explicit-test',
			);
		} else if (new Set([
			'changed-save-apply-reprobes',
			'same-value-save-apply-fast-path',
			'same-value-wpengine-fast-path',
			'same-value-wpengine-provenance-mismatch',
		]).has(scenario)) {
			const wpEngine = scenario.startsWith('same-value-wpengine-');
			try {
				state = await ipcMain.handlers.get(IPC_CHANNELS.applySettings)(
					{},
					site.id,
					wpEngine
						? {
							enabled: true,
							originEnvironment: 'production',
							originIp: '192.0.2.10',
							originSource: 'wpengine',
							originTlsHostname: 'example-production.wpengine.com',
							resolvedAt: '2026-08-04T11:00:00.000Z',
							siteUrl: 'https://www.example.com',
						}
						: {
							enabled: true,
							originIp: scenario === 'changed-save-apply-reprobes'
								? '192.0.2.11'
								: '192.0.2.10',
							originSource: 'manual',
							siteUrl: 'http://media.example.com',
						},
					'nginx',
				);
			} catch (error) {
				operationError = error.message;
			}
		} else if (new Set([
			'target-service-missing-restart-timeout',
			'versioned-nginx-stale-master-restart-timeout',
		]).has(scenario)) {
			const pendingOperation = ipcMain.handlers.get(IPC_CHANNELS.applySettings)(
				{},
				site.id,
				{
					enabled: true,
					originIp: '192.0.2.10',
					originSource: 'manual',
					siteUrl: 'http://media.example.com',
				},
				'nginx',
			).catch((error) => {
				operationError = error.message;
			});
			await flushAsyncWork();
			assert.notEqual(
				boundedProcessRestartTimerId,
				undefined,
				'expected a bounded process-restart timer',
			);
			const restartTimeout = timers.get(boundedProcessRestartTimerId);
			assert.equal(typeof restartTimeout, 'function');
			timers.delete(boundedProcessRestartTimerId);
			restartTimeout();
			await pendingOperation;
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
					isApacheRuntime ? 'apache' : 'nginx',
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
			publishedSiteStartedEvents,
			refreshCalls,
			restartCalls,
			runningProcessChecks,
			retryCallsAfterOneRecoverySample,
			retryTimersAfterFailure,
			retryTimersAfterOneRecoverySample,
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
		if (hadLocalhostRouting) {
			global.localhostRouting = originalLocalhostRouting;
		} else {
			delete global.localhostRouting;
		}
		if (originalPlatformDescriptor) {
			Object.defineProperty(process, 'platform', originalPlatformDescriptor);
		}
	}
})().catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 1;
});
