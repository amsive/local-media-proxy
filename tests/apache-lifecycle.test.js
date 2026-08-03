/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

function sourceSection(startMarker, endMarker, source = mainSource) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
	return source.slice(start, end);
}

function assertInOrder(source, markers, message) {
	let offset = 0;
	for (const marker of markers) {
		const index = source.indexOf(marker, offset);
		assert.notEqual(index, -1, `${message}: missing ${marker}`);
		offset = index + marker.length;
	}
}

test('Apache apply snapshots both servers and rollback restores runtime before committing prior settings', () => {
	const applyBranch = mainSource.slice(
		mainSource.indexOf('if (normalizedInput.enabled)'),
		mainSource.indexOf('} else {', mainSource.indexOf('if (normalizedInput.enabled)')),
	);
	assert.match(
		applyBranch,
		/snapshots = await captureAllManagedFiles\([\s\S]{0,80}site,[\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	assert.match(applyBranch, /runServerTransactionMutation\([\s\S]{0,220}applyServerManagedFiles\(/);
	assert.match(applyBranch, /await compileAndReload\([\s\S]{0,80}site,[\s\S]{0,80}server,[\s\S]{0,80}true,[\s\S]{0,120}assertServerTransactionCurrent/);
	assert.match(applyBranch, /return rollbackTransaction\([\s\S]{0,180}snapshots,[\s\S]{0,80}error/);

	const rollback = sourceSection(
		'const rollbackTransaction = async',
		'const abortForGlobalLifecycle',
	);
	assert.match(rollback, /await restoreManagedFiles\(snapshots, assertRollbackTransactionCurrent\)/);
	assert.match(
		rollback,
		/restoredManagedSourceMatches = await serverManagedFilesMatch\([\s\S]{0,160}rollbackTarget\.site,[\s\S]{0,240}managedFileOptions\(rollbackTarget\.server\)/,
	);
	assert.match(
		rollback,
		/if \(!restoredManagedSourceMatches\) \{[\s\S]{0,220}removeAllManagedFiles\([\s\S]{0,180}assertRollbackTransactionCurrent/,
	);
	assertInOrder(
		rollback,
		[
			'await restoreManagedFiles(snapshots, assertRollbackTransactionCurrent)',
			'await compileAndReload(',
			'assertRollbackTransactionCurrent();',
			'persistSettings(site.id, previousEnvelope)',
		],
		'rollback must restore files and runtime before committing prior settings',
	);
});

test('Apache refresh observes Local runtime process name httpd without using its non-settling hard restart', () => {
	const compileAndReload = sourceSection(
		'const compileAndReload = async',
		'const runtimeCleanupUnavailableReason',
	);
	const refreshBranch = compileAndReload.slice(
		compileAndReload.indexOf("if (server.kind === 'apache')"),
		compileAndReload.indexOf('await compileAndValidateNginxConfig'),
	);
	assert.match(refreshBranch, /const processName = 'httpd'/);
	assert.match(refreshBranch, /hasRunningProcess\(site, processName\)/);
	assert.match(refreshBranch, /shouldRefreshRuntime\(/);
	assert.doesNotMatch(refreshBranch, /restartSiteService/);
});

test('global disable and uninstall clean runtime without changing per-site enabled intent', () => {
	const cleanupEntry = sourceSection(
		'const cleanUpForGlobalChange',
		'const restoreAfterGlobalEnable',
	);
	assert.match(cleanupEntry, /globalLifecycleGeneration \+= 1/);
	assert.match(cleanupEntry, /const mode = uninstalling \? 'uninstalling' : 'disabled'[\s\S]{0,80}globalLifecycleState = mode/);
	assert.match(cleanupEntry, /for \(const siteId of deferredReconciliations\.keys\(\)\)[\s\S]{0,120}cancelDeferredReconciliation\(siteId\)/);
	assertInOrder(
		cleanupEntry,
		[
			'const forceRefresh = synchronouslyPrepareSiteForGlobalChange(',
			'scheduleDeferredGlobalCleanup(',
			'globalLifecycleGeneration,',
			'forceRefresh,',
		],
		'global cleanup must synchronously persist safe cleanup before scheduling runtime work',
	);

	const synchronousCleanup = sourceSection(
		'const synchronouslyPrepareSiteForGlobalChange',
		'const cleanupSiteForGlobalChange',
	);
	assert.ok(
		synchronousCleanup.indexOf('shouldReconcileManagedFiles(siteStatus)') <
		synchronousCleanup.indexOf('detectedServer = detectSiteServer(site)') &&
		synchronousCleanup.indexOf('detectedServer = detectSiteServer(site)') <
		synchronousCleanup.indexOf('globalCleanupFilesystemReady(site, server)') &&
		synchronousCleanup.indexOf('globalCleanupFilesystemReady(site, server)') <
		synchronousCleanup.indexOf('readStoredSettingsEnvelope(site, server.kind)') &&
		synchronousCleanup.indexOf('readStoredSettingsEnvelope(site, server.kind)') <
		synchronousCleanup.indexOf('removeAllManagedFilesSync('),
		'synchronous cleanup must check lifecycle and filesystem readiness before settings or managed-file access',
	);
	assert.match(
		synchronousCleanup,
		/removeAllManagedFilesSync\([\s\S]{0,120}assertSynchronousGlobalCleanupCurrent/,
	);
	assert.doesNotMatch(synchronousCleanup, /persistSettings|setStoredSettingsEnabled/);

	const cleanupWorker = sourceSection(
		'const cleanupSiteForGlobalChange',
		'const scheduleDeferredGlobalCleanup',
	);
	assert.match(cleanupWorker, /withSiteLock\(siteId/);
	assert.match(cleanupWorker, /removeAllManagedFiles\([\s\S]{0,100}assertGlobalCleanupTransactionCurrent/);
	assert.match(cleanupWorker, /compileAndReload\([\s\S]{0,120}assertGlobalCleanupTransactionCurrent/);
	assert.match(cleanupWorker, /const requiresRuntimeRefresh = forceRefresh \|\| enabledBeforeCleanup/);
	assertInOrder(cleanupWorker, [
		'const changed = await removeAllManagedFiles(',
		'await compileAndReload(',
		'if (await guardedManagedArtifactsExist())',
		'assertGlobalCleanupTransactionCurrent();',
	], 'global cleanup must remove files and refresh runtime transactionally');
	assert.doesNotMatch(cleanupWorker, /persistSettings|setStoredSettingsEnabled/);
});

test('startup and Local lifecycle reconciliation wait for stable ready sites without blocking hooks', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.match(reconcile, /serverManagedFilesMatch\(/);
	assert.match(reconcile, /applyServerManagedFiles\(/);
	assert.match(reconcile, /removeAllManagedFiles\([\s\S]{0,80}site,[\s\S]{0,100}assertReconciliationTransactionCurrent/);
	assert.match(reconcile, /compileAndReload\([\s\S]{0,80}site,[\s\S]{0,80}server,[\s\S]{0,80}settings\.enabled,[\s\S]{0,80}assertReconciliationTransactionCurrent/);
	assert.doesNotMatch(reconcile, /forcedAfterSiteStarted/);
	assert.match(reconcile, /options\.configuredOnly && rawStoredSettings === undefined[\s\S]{0,80}return/);
	assert.match(reconcile, /shouldReconcileManagedFiles\(siteProcessManager\.getSiteStatus\(candidate\)\)/);
	assert.ok(
		reconcile.indexOf('siteStatusAllowsReconciliation(site)') < reconcile.indexOf('const detectedServer = detectSiteServer(site)') &&
		reconcile.indexOf('serverManagedFilesystemReady(site, detectedServer.kind)') < reconcile.indexOf('const server = resolveServer(site)'),
		'background reconciliation must reject Local transition states before resolving or mutating server templates',
	);
	assert.match(reconcile, /normalizedOrigin = validateAndNormalizeOrigin[\s\S]{0,180}await assertApacheOriginCapability\(server, normalizedOrigin\.protocol\)/);
	const invalidCleanup = reconcile.slice(
		reconcile.indexOf('catch (validationError)'),
		reconcile.indexOf('const trustBundle = normalizedOrigin.protocol'),
	);
	assertInOrder(
		invalidCleanup,
		[
			'removeAllManagedFiles(',
			'await compileAndReload(',
			'assertReconciliationTransactionCurrent',
		],
		'invalid-profile cleanup must remove managed files before a guarded runtime refresh',
	);
	assert.match(reconcile, /retaining global enabled intent for the current \$\{server\.kind\} profile/);
	assert.match(reconcile, /cleanupRequiresRefresh\(changed, settings\.enabled\)/);
	assert.match(reconcile, /nextEnvelope !== previousEnvelope \|\|[\s\S]{0,100}storedSettingsEnvelopeNeedsMigration\(rawStoredSettings\)/);
	assert.match(
		reconcile,
		/const persistReconciledEnvelope = \(\): boolean => \{[\s\S]{0,180}reconciliationCanMutate\(\)[\s\S]{0,180}persistSettings\(site\.id, nextEnvelope\)/,
	);
	assert.match(mainSource, /HooksMain\.addAction\('siteStarted'/);
	assert.match(
		mainSource,
		/HooksMain\.addAction\('siteStarted'[\s\S]{0,350}scheduleDeferredReconciliation\(siteId, \{[\s\S]{0,120}configuredOnly: true,[\s\S]{0,120}refreshMatchingEnabledRuntime: true/,
	);
	assert.doesNotMatch(
		mainSource.slice(
			mainSource.indexOf("HooksMain.addAction('siteStarted'"),
			mainSource.indexOf("HooksMain.addAction('siteAdded'"),
		),
		/return (?:await )?reconcileSite|return reconcileSite/,
	);
	assert.match(mainSource, /HooksMain\.addAction\('siteAdded'/);
	assert.match(mainSource, /HooksMain\.addAction\('siteDeleted'[\s\S]{0,300}cancelDeferredReconciliation\(siteId\)[\s\S]{0,120}cancelOriginProbesForSite\(siteId\)/);
	assert.match(mainSource, /DEFERRED_RECONCILIATION_MAX_ATTEMPTS = 900/);
	assert.match(mainSource, /DEFERRED_RECONCILIATION_STABLE_SAMPLES = 2/);
	assert.match(reconcile, /const managedFilesMatch = await serverManagedFilesMatch\(/);
	assert.match(reconcile, /compiledConfigMatches = await serverCompiledConfigMatches\(/);
	assert.match(
		reconcile,
		/if \(compiledConfigMatches\) \{[\s\S]{0,100}persistReconciledEnvelope\(\);[\s\S]{0,80}return/,
	);
	assert.match(mainSource, /for \(const site of Object\.values\(siteData\.getSites\(\)\)[\s\S]{0,220}scheduleDeferredReconciliation\(site\.id/);
});

test('server reconciliation carries Site URL inside the site lock and commits it transactionally', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.equal(
		(mainSource.match(/carrySiteUrlToPristineServerProfile\(/g) ?? []).length,
		1,
		'Site URL handoff must occur only in server reconciliation',
	);
	assert.equal(
		(mainSource.match(/preserveStoredBlankCurrentProfile\(/g) ?? []).length,
		1,
		'legacy blank intent must be preserved only in server reconciliation',
	);
	assertInOrder(
		reconcile,
		[
			'await withSiteLock(siteId, async () => {',
			'const previousEnvelope = readStoredSettingsEnvelope(site, server.kind)',
			'preserveStoredBlankCurrentProfile(',
			'carrySiteUrlToPristineServerProfile(intentPreservedEnvelope, server.kind)',
			'const settings =',
			'storedSettingsForServer(reconciledEnvelope, server.kind)',
		],
		'profile handoff must use only the normalized current site envelope under its lock',
	);
	assert.match(
		reconcile,
		/const nextEnvelope = setStoredSettingsLastServer\(reconciledEnvelope, server\.kind\)/,
	);
	assert.match(
		reconcile,
		/if \(managedFilesMatch\) \{[\s\S]{0,260}serverCompiledConfigMatches\([\s\S]{0,180}if \(compiledConfigMatches\) \{[\s\S]{0,100}persistReconciledEnvelope\(\)/,
		'a complete carried profile may be persisted without mutation only after exact compiled convergence',
	);
	assert.match(
		reconcile,
		/if \(changed \|\| !compiledConfigMatches\) \{[\s\S]{0,300}compileAndReload\([\s\S]{0,220}persistReconciledEnvelope\(\)/,
		'a carried profile must establish runtime convergence whenever source or compiled state is stale',
	);

	const invalidCleanup = reconcile.slice(
		reconcile.indexOf('catch (validationError)'),
		reconcile.indexOf('const trustBundle = normalizedOrigin.protocol'),
	);
	assertInOrder(
		invalidCleanup,
		[
			'removeAllManagedFiles(',
			'await compileAndReload(',
			'if (cleanupErrors.length === 0)',
			'persistReconciledEnvelope()',
		],
		'an incomplete carried profile may persist only after fail-closed cleanup succeeds',
	);
	assert.match(
		invalidCleanup,
		/rollbackTransaction\([\s\S]{0,180}previousEnvelope,[\s\S]{0,100}snapshots/,
		'lifecycle rollback must restore the pre-handoff envelope',
	);
	assert.doesNotMatch(
		mainSource.slice(
			mainSource.indexOf('const getSiteState = async'),
			mainSource.indexOf('const reconcileSite'),
		),
		/carrySiteUrlToPristineServerProfile/,
		'passive state assembly must not perform a cross-profile handoff',
	);
});

test('reconciliation rechecks current status and server identity immediately before mutation branches', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.match(
		reconcile,
		/const transaction = serverTransactionFingerprint\(site, server\)[\s\S]{0,300}const reconciliationCanMutate = \(\): boolean => \{[\s\S]{0,180}siteData\.getSite\(siteId\)[\s\S]{0,180}siteStatusAllowsReconciliation\(latestSite\)/,
	);
	assert.match(
		reconcile,
		/return serverTransactionIsCurrent\(siteId, transaction\)/,
	);

	const invalidCleanup = reconcile.slice(
		reconcile.indexOf('catch (validationError)'),
		reconcile.indexOf('const trustBundle = normalizedOrigin.protocol'),
	);
	assert.ok(
		invalidCleanup.indexOf('if (!reconciliationCanMutate())') < invalidCleanup.indexOf('removeAllManagedFiles('),
		'invalid-profile cleanup must recheck status after awaited validation',
	);
	assert.match(
		invalidCleanup,
		/if \(!reconciliationCanMutate\(\)\) \{[\s\S]{0,180}rollbackTransaction\([\s\S]{0,200}snapshots,[\s\S]{0,100}new ServerTransactionChangedError/,
	);
	assert.match(
		invalidCleanup,
		/compileAndReload\([\s\S]{0,120}false,[\s\S]{0,100}assertReconciliationTransactionCurrent/,
	);
	assertInOrder(
		invalidCleanup,
		[
			'removeAllManagedFiles(',
			'await compileAndReload(',
			'persistReconciledEnvelope()',
		],
		'invalid-profile reconciliation must commit metadata after cleanup and runtime refresh',
	);
	assert.ok(
		invalidCleanup.indexOf('if (cleanupErrors.length > 0)') < invalidCleanup.lastIndexOf('logger.log('),
		'invalid cleanup must not log successful removal before every cleanup step succeeds',
	);

	const driftRepair = reconcile.slice(
		reconcile.lastIndexOf('const snapshots = await captureAllManagedFiles('),
		reconcile.indexOf('const matchesThisAddon'),
	);
	assertInOrder(
		driftRepair,
		[
			'assertReconciliationTransactionCurrent,',
			'assertReconciliationTransactionCurrent()',
			'runServerTransactionMutation(',
			'applyServerManagedFiles(',
		],
		'drift repair must recheck status and server identity before mutation',
	);
	assert.ok(
		driftRepair.indexOf('runServerTransactionMutation(') < driftRepair.indexOf('applyServerManagedFiles(') &&
		driftRepair.indexOf('applyServerManagedFiles(') < driftRepair.indexOf('await compileAndReload('),
		'post-mutation transaction checks must enter rollback before runtime refresh',
	);
	assertInOrder(
		driftRepair,
		[
			'applyServerManagedFiles(',
			'await compileAndReload(',
			'persistReconciledEnvelope()',
		],
		'enabled reconciliation must commit metadata after files and runtime',
	);
	assert.match(
		driftRepair,
		/return rollbackTransaction\([\s\S]{0,180}previousEnvelope,[\s\S]{0,100}snapshots/,
	);
});

test('interactive apply, save-disable, and toggle commit settings only after files and runtime are current', () => {
	const apply = mainSource.slice(
		mainSource.indexOf('const applySettingsLocked'),
		mainSource.indexOf('const applySettings = async'),
	);
	const toggle = mainSource.slice(
		mainSource.indexOf('const setEnabled = async'),
		mainSource.indexOf('const discoverOrigin = async'),
	);

	assert.match(apply, /const transaction = beginInteractiveServerTransaction\(site, server\)/);
	assert.match(
		apply,
		/captureAllManagedFiles\([\s\S]{0,80}site,[\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	const enableBranch = apply.slice(
		apply.indexOf('if (normalizedInput.enabled)'),
		apply.indexOf('} else {', apply.indexOf('if (normalizedInput.enabled)')),
	);
	const saveDisableBranch = apply.slice(
		apply.indexOf('} else {', apply.indexOf('if (normalizedInput.enabled)')),
	);
	assertInOrder(
		enableBranch,
		[
			'try {',
			'snapshots = await captureAllManagedFiles(',
			'applyServerManagedFiles(',
			'compileAndReload(',
			'commitInteractiveSettings(siteId, transaction, nextEnvelope)',
		],
		'enable apply must commit last',
	);
	assertInOrder(
		saveDisableBranch,
		[
			'try {',
			'snapshots = await captureAllManagedFiles(',
			'removeAllManagedFiles(',
			'compileAndReload(',
			'commitInteractiveSettings(siteId, transaction, nextEnvelope)',
		],
		'saved disable must commit last',
	);

	assert.match(toggle, /const transaction = beginInteractiveServerTransaction\(site, server\)/);
	assertInOrder(
		toggle,
		[
			'try {',
			'snapshots = await captureAllManagedFiles(',
			'removeAllManagedFiles(',
			'compileAndReload(',
			'commitInteractiveSettings(siteId, transaction, disabledEnvelope)',
		],
		'enabled-only toggle must commit last',
	);

	const commit = sourceSection(
		'const commitInteractiveSettings',
		'const compileAndReload',
	);
	assertInOrder(
		commit,
		[
			'assertServerTransactionCurrent(siteId, transaction)',
			'persistSettings(siteId, envelope)',
		],
		'interactive settings commit must verify the transaction immediately before persistence',
	);

	const rollback = mainSource.slice(
		mainSource.indexOf('const rollbackTransaction = async'),
		mainSource.indexOf('const abortForGlobalLifecycle'),
	);
	assert.match(rollback, /const currentSite = siteData\.getSite\(site\.id\)/);
	assert.match(rollback, /!shouldReconcileManagedFiles\(siteStatus\)[\s\S]{0,220}return null/);
	assert.match(
		rollback,
		/serverManagedFilesystemReady\([\s\S]{0,100}currentSite,[\s\S]{0,100}currentServer\.kind,[\s\S]{0,120}managedFileOptions\(currentServer\)/,
	);
	assert.match(
		rollback,
		/serverTransactionFingerprintsMatch\([\s\S]{0,80}expectedTransaction,[\s\S]{0,80}currentTransaction/,
	);
	assert.match(rollback, /Skipped Media Proxy rollback writes[\s\S]{0,120}return throwOriginalError\(\)/);
	assert.match(rollback, /compileAndReload\([\s\S]{0,80}rollbackTarget\.site,[\s\S]{0,80}rollbackTarget\.server/);
	assert.match(rollback, /restoreManagedFiles\(snapshots, assertRollbackTransactionCurrent\)/);
	assert.match(rollback, /assertRollbackTransactionCurrent\(\);\s*persistSettings\(site\.id, previousEnvelope\)/);
	assert.match(
		rollback,
		/catch \(error\) \{\s*if \(isServerTransactionChangedError\(error\)\) \{[\s\S]{0,500}deferred reconciliation will verify the stable state[\s\S]{0,180}return throwOriginalError\(\)[\s\S]{0,120}\}\s*rollbackErrors\.push/,
	);
	assert.doesNotMatch(rollback, /compileAndReload\([\s\S]{0,80}\bsite,[\s\S]{0,80}\b_server/);
});

test('site-state IPC reports persisted and compiled drift without reconciling or writing', () => {
	const handler = mainSource.slice(
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.getSiteState'),
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.testOrigin'),
	);
	assert.doesNotMatch(handler, /reconcileSite|withSiteLock|applyServerManagedFiles|removeAllManagedFiles|compileAndReload|persistSettings/);
	assert.match(handler, /return await getSiteState\(siteId\)/);
	assert.match(handler, /isExpectedLifecycleInterruption\(siteId, error\)[\s\S]{0,240}logger\.log\([\s\S]{0,80}'info'/);
	assert.match(mainSource, /Boolean\(!settings\.enabled && applied\)/);
	assert.match(mainSource, /profile is disabled, but managed proxy configuration remains and cleanup is required/);
});

test('state and discovery reads stay metadata-only until Local lifecycle and templates are ready', () => {
	const stateReader = mainSource.slice(
		mainSource.indexOf('const getSiteState = async'),
		mainSource.indexOf('const applySettingsLocked'),
	);
	assert.ok(
		stateReader.indexOf('siteProcessManager.getSiteStatus(site)') <
		stateReader.indexOf('const detectedServer = detectSiteServer(site)'),
	);
	assert.ok(
		stateReader.indexOf('shouldReconcileManagedFiles(siteStatus)') <
		stateReader.indexOf('const server = resolveServer(site)') &&
		stateReader.indexOf('const server = resolveServer(site)') <
		stateReader.indexOf('!serverManagedFilesystemReady('),
	);
	assert.doesNotMatch(
		stateReader,
		/applyServerManagedFiles|removeAllManagedFiles|compileAndReload|restartSiteService|persistSettings/,
	);
	assert.match(stateReader, /return lifecycleUnavailableSiteState\(null, 'deleting'\)/);
	assert.match(stateReader, /lifecycleReady: true/);
	assert.match(mainSource, /const lifecycleUnavailableSiteState[\s\S]{0,900}lifecycleReady: false/);

	const discoveryHandler = mainSource.slice(
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.getOriginDiscoveryOptions'),
		mainSource.indexOf('IPC_CHANNELS.discoverOrigin'),
	);
	assert.match(discoveryHandler, /shouldReconcileManagedFiles\(siteStatus\)[\s\S]{0,220}lifecycleUnavailableReason\(siteStatus\)/);
	assert.ok(
		discoveryHandler.indexOf('serverManagedFilesystemReady(site, detectedServer.kind)') <
		discoveryHandler.indexOf('await getOriginDiscoveryOptions('),
	);

	const stateHandler = mainSource.slice(
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.getSiteState'),
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.testOrigin'),
	);
	assert.match(
		stateHandler,
		/isExpectedLifecycleInterruption\(siteId, error\)[\s\S]{0,700}lifecycleUnavailableSiteState\(site, siteStatus\)/,
	);
});

test('runtime convergence behavior is passive, drift-aware, halted-safe, and snapshot-transactional', () => {
	const runScenario = (scenario) => JSON.parse(execFileSync(
		process.execPath,
		[path.resolve(__dirname, 'fixtures/runtime-convergence-harness.js'), scenario],
		{ encoding: 'utf8' },
	));

	const passive = runScenario('passive-drift');
	assert.deepEqual(passive.calls, []);
	assert.deepEqual(passive.state, {
		applied: false,
		needsAttention: true,
		siteStatus: 'running',
	});
	assert.deepEqual(passive.updates, []);

	const startupNoop = runScenario('startup-noop');
	assert.deepEqual(startupNoop.calls, []);
	assert.equal(startupNoop.restartCalls, 0);

	const startupRepair = runScenario('startup-compiled-drift');
	assert.deepEqual(startupRepair.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'restart:nginx-1.26.1+3',
	]);
	assert.equal(startupRepair.restartCalls, 1);

	const haltedRepair = runScenario('same-value-halted-repair');
	assert.deepEqual(haltedRepair.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'updateSite',
	]);
	assert.equal(haltedRepair.restartCalls, 0);
	assert.deepEqual(haltedRepair.state, {
		applied: true,
		needsAttention: false,
		siteStatus: 'halted',
	});

	for (const [scenario, restoredCompile, restoredEnabled, failClosedCleanup] of [
		['rollback-valid-managed', 'compileNginx:managed', true, false],
		['rollback-snapshot-enabled', 'compileNginx:clean', false, true],
		['rollback-snapshot-disabled', 'compileNginx:clean', true, true],
		['rollback-malformed-snapshot', 'compileNginx:clean', true, true],
	]) {
		const rollback = runScenario(scenario);
		assert.equal(rollback.operationError, 'targeted restart failed');
		assert.equal(rollback.restartCalls, 2);
		assert.deepEqual(rollback.calls, [
			'probeOrigin',
			'captureAllManagedFiles',
			'applyServerManagedFiles',
			'compileNginx:managed',
			'restart:nginx-1.26.1+3',
			'restoreManagedFiles',
			...(failClosedCleanup ? ['removeAllManagedFiles'] : []),
			restoredCompile,
			'restart:nginx-1.26.1+3',
			'updateSite',
		]);
		assert.equal(rollback.finalEnabled, restoredEnabled);
		assert.equal(rollback.updates.length, 1);
		assert.equal(rollback.updates[0].enabled, restoredEnabled);
	}

	const missingTarget = runScenario('target-service-missing');
	assert.match(missingTarget.operationError, /Nginx service as running/);
	assert.equal(missingTarget.restartCalls, 0);
	assert.equal(missingTarget.updates.length, 0);

	const changedInputs = runScenario('service-input-change');
	assert.match(changedInputs.operationError, /web-server identity or lifecycle status/);
	assert.equal(changedInputs.restartCalls, 0);
	assert.equal(changedInputs.updates.length, 0);
});

test('unsupported site state preserves dedicated renderer guidance without masking service failures', () => {
	const stateReader = mainSource.slice(
		mainSource.indexOf('const getSiteState = async'),
		mainSource.indexOf('const applySettingsLocked'),
	);
	assert.match(
		stateReader,
		/if \(runtimeUnavailable\) \{\s*if \(server\.kind !== 'unsupported'\) \{\s*enableUnavailableReason = runtimeCleanupUnavailableReason\(server\)/,
	);
	assert.match(
		stateReader,
		/const canEnable = server\.kind !== 'unsupported' && !enableUnavailableReason/,
	);
	assert.match(
		stateReader,
		/reason: needsAttention[\s\S]{0,180}server\.kind === 'unsupported'[\s\S]{0,80}server\.reason/,
	);
});

test('enabled-only toggle cleanup preserves both saved connection profiles transactionally', () => {
	const toggle = mainSource.slice(
		mainSource.indexOf('const setEnabled = async'),
		mainSource.indexOf('const discoverOrigin = async'),
	);
	assert.match(toggle, /const disabledEnvelope = setStoredSettingsEnabled\(envelope, false\)/);
	assertInOrder(
		toggle,
		[
			'const disabledEnvelope = setStoredSettingsEnabled(envelope, false)',
			'removeAllManagedFiles(',
			'compileAndReload(',
			'commitInteractiveSettings(siteId, transaction, disabledEnvelope)',
		],
		'toggle cleanup must retain profiles while committing disabled intent last',
	);
	assert.match(toggle, /rollbackTransaction\([\s\S]{0,160}envelope,[\s\S]{0,100}snapshots/);
	assert.doesNotMatch(toggle, /replaceStoredSettingsForServer/);
});

test('global cleanup retries each site independently after two stable ready samples', () => {
	assert.match(mainSource, /const deferredGlobalCleanups = new Map<string, DeferredGlobalCleanup>\(\)/);
	assert.match(mainSource, /let globalLifecycleGeneration = 0/);
	assert.match(mainSource, /DEFERRED_GLOBAL_CLEANUP_STABLE_SAMPLES = 2/);

	const scheduler = sourceSection(
		'const scheduleDeferredGlobalCleanup',
		'const matchesThisAddon',
	);
	assert.match(scheduler, /existing\.generation === generation[\s\S]{0,80}existing\.mode === mode/);
	assert.match(scheduler, /existing\.forceRefresh = existing\.forceRefresh \|\| forceRefresh/);
	assert.match(scheduler, /const pending: DeferredGlobalCleanup = \{[\s\S]{0,160}forceRefresh,[\s\S]{0,100}generation,[\s\S]{0,100}mode,[\s\S]{0,100}stableSamples: 0/);
	assert.match(scheduler, /globalLifecycleGeneration !== pending\.generation[\s\S]{0,100}cancelDeferredGlobalCleanup\(siteId\)/);
	assert.match(scheduler, /const site = siteData\.getSite\(siteId\)[\s\S]{0,100}if \(!site\) \{\s*cancelDeferredGlobalCleanup\(siteId\)/);
	assert.match(
		scheduler,
		/siteLifecycleAccess\(siteStatus\) === 'destroying'[\s\S]{0,80}pending\.attempts = 0[\s\S]{0,80}pending\.stableSamples = 0[\s\S]{0,80}scheduleNext\(\)[\s\S]{0,80}return/,
	);
	const destroyingBranch = scheduler.slice(
		scheduler.indexOf("if (siteLifecycleAccess(siteStatus) === 'destroying')"),
		scheduler.indexOf('if (shouldReconcileManagedFiles(siteStatus))'),
	);
	assert.doesNotMatch(destroyingBranch, /cancelDeferredGlobalCleanup/);
	assert.match(scheduler, /pending\.timer = undefined;\s*pending\.attempts \+= 1/);
	assert.match(
		scheduler,
		/if \(shouldReconcileManagedFiles\(siteStatus\)\)[\s\S]{0,260}pending\.stableSamples = globalCleanupFilesystemReady\(site, server\)[\s\S]{0,100}\+ 1[\s\S]{0,100}: 0;[\s\S]{0,80}\} else \{\s*pending\.stableSamples = 0/,
	);
	assert.match(
		scheduler,
		/pending\.stableSamples >= DEFERRED_GLOBAL_CLEANUP_STABLE_SAMPLES[\s\S]{0,160}cleanupSiteForGlobalChange\([\s\S]{0,160}pending\.generation,[\s\S]{0,100}pending\.forceRefresh/,
	);
	const statusPolling = scheduler.slice(
		scheduler.indexOf('const siteStatus = siteProcessManager.getSiteStatus(site)'),
		scheduler.indexOf('if (pending.stableSamples >= DEFERRED_GLOBAL_CLEANUP_STABLE_SAMPLES)'),
	);
	assert.doesNotMatch(statusPolling, /cancelDeferredGlobalCleanup/);
	assert.match(statusPolling, /\} else \{\s*pending\.stableSamples = 0/);
	assert.match(scheduler, /pending\.stableSamples = 0;[\s\S]{0,900}scheduleNext\(\)/);
	assert.match(
		scheduler,
		/catch \(error\) \{[\s\S]{0,100}pending\.lastError = errorMessage\(error\)[\s\S]{0,100}pending\.stableSamples = 0[\s\S]{0,100}scheduleNext\(\)/,
	);

	const cleanupEntry = sourceSection(
		'const cleanUpForGlobalChange',
		'const restoreAfterGlobalEnable',
	);
	assert.match(
		cleanupEntry,
		/for \(const site of Object\.values\(siteData\.getSites\(\)\)[\s\S]{0,120}try \{[\s\S]{0,300}synchronouslyPrepareSiteForGlobalChange\([\s\S]{0,300}scheduleDeferredGlobalCleanup\([\s\S]{0,300}catch \(error\)/,
	);

	const worker = sourceSection(
		'const cleanupSiteForGlobalChange',
		'const scheduleDeferredGlobalCleanup',
	);
	assert.match(worker, /withSiteLock\(siteId/);
	assert.match(worker, /globalLifecycleState === mode[\s\S]{0,80}globalLifecycleGeneration === generation/);
});

test('global cleanup defers the affected site when synchronous preparation throws', () => {
	const result = JSON.parse(execFileSync(
		process.execPath,
		[path.resolve(__dirname, 'fixtures/global-cleanup-exception-harness.js')],
		{ encoding: 'utf8' },
	));

	assert.deepEqual(result, {
		deferredPreparationWarnings: 1,
		deferredTimersAfterFailure: 1,
		statusReadCount: 2,
		synchronousRemovalCalls: 0,
	});
});

test('global disable and uninstall preserve enabled intent through deferred cleanup and re-enable', () => {
	for (const mode of ['disable', 'uninstall']) {
		const result = JSON.parse(execFileSync(
			process.execPath,
			[
				path.resolve(__dirname, 'fixtures/global-intent-harness.js'),
				mode,
			],
			{ encoding: 'utf8' },
		));

		assert.deepEqual(result, {
			deferredCleanupFailures: 1,
			disabledApplied: false,
			enabledApplied: true,
			failClosedReconciliations: 1,
			globalAsyncCleanups: 6,
			invalidApplied: false,
			mode,
			settingsWrites: 0,
			synchronousCleanupFailures: 1,
			synchronousCleanups: 5,
		});
	}
});

test('Local hooks route global-inactive sites to cleanup and cancel every deferred site task on deletion', () => {
	const started = sourceSection(
		"HooksMain.addAction('siteStarted'",
		"HooksMain.addAction('siteAdded'",
	);
	const added = sourceSection(
		"HooksMain.addAction('siteAdded'",
		"HooksMain.addAction('siteDeleted'",
	);
	for (const hook of [started, added]) {
		assert.match(
			hook,
			/if \(globalLifecycleState\) \{[\s\S]{0,180}scheduleDeferredGlobalCleanup\([\s\S]{0,120}globalLifecycleGeneration[\s\S]{0,80}return/,
		);
		assert.ok(
			hook.indexOf('scheduleDeferredGlobalCleanup(') <
			hook.indexOf('scheduleDeferredReconciliation('),
			'global-inactive hook routing must choose cleanup before normal reconciliation',
		);
	}

	const deleted = sourceSection(
		"HooksMain.addAction('siteDeleted'",
		'for (const site of Object.values(siteData.getSites())',
	);
	assertInOrder(
		deleted,
		[
			'cancelDeferredReconciliation(siteId)',
			'cancelDeferredGlobalCleanup(siteId)',
			'cancelOriginProbesForSite(siteId)',
		],
		'site deletion must cancel every deferred add-on task',
	);

	const reenable = sourceSection(
		'const restoreAfterGlobalEnable',
		'const listenerRegistry',
	);
	assertInOrder(
		reenable,
		[
			'globalLifecycleGeneration += 1',
			'for (const siteId of deferredGlobalCleanups.keys())',
			'cancelDeferredGlobalCleanup(siteId)',
			'globalLifecycleState = null',
			'scheduleDeferredReconciliation(site.id',
		],
		're-enable must invalidate cleanup generations before scheduling reconciliation',
	);
});

test('all lifecycle-managed file mutations receive a current-transaction callback', () => {
	const apply = sourceSection(
		'const applySettingsLocked',
		'const applySettings = async',
	);
	assert.match(
		apply,
		/applyServerManagedFiles\([\s\S]{0,260}\(\) => assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	assert.match(
		apply,
		/removeAllManagedFiles\([\s\S]{0,120}\(\) => assertServerTransactionCurrent\(siteId, transaction\)/,
	);

	const toggle = sourceSection(
		'const setEnabled = async',
		'const discoverOrigin = async',
	);
	assert.match(
		toggle,
		/removeAllManagedFiles\([\s\S]{0,120}\(\) => assertServerTransactionCurrent\(siteId, transaction\)/,
	);

	const reconcile = sourceSection(
		'const reconcileSite',
		'const cancelDeferredReconciliation',
	);
	assert.match(
		reconcile,
		/applyServerManagedFiles\([\s\S]{0,260}assertReconciliationTransactionCurrent/,
	);
	assert.match(
		reconcile,
		/removeAllManagedFiles\([\s\S]{0,120}assertReconciliationTransactionCurrent/,
	);

	const rollback = sourceSection(
		'const rollbackTransaction = async',
		'const abortForGlobalLifecycle',
	);
	assert.match(rollback, /restoreManagedFiles\(snapshots, assertRollbackTransactionCurrent\)/);

	const globalCleanup = sourceSection(
		'const cleanupSiteForGlobalChange',
		'const scheduleDeferredGlobalCleanup',
	);
	assert.match(
		globalCleanup,
		/removeAllManagedFiles\([\s\S]{0,120}assertGlobalCleanupTransactionCurrent/,
	);
});

test('all lifecycle-sensitive managed-file reads are fenced and lifecycle races stay informational', () => {
	const stateReader = sourceSection(
		'const getSiteState = async',
		'const applySettingsLocked',
	);
	assert.match(
		stateReader,
		/allManagedArtifactsExist\([\s\S]{0,100}assertSiteStateTransactionCurrent/,
	);
	assert.match(
		stateReader,
		/serverManagedFilesMatch\([\s\S]{0,260}assertSiteStateTransactionCurrent/,
	);

	const apply = sourceSection(
		'const applySettingsLocked',
		'const applySettings = async',
	);
	assert.match(
		apply,
		/captureAllManagedFiles\([\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	assert.match(
		apply,
		/allManagedArtifactsExist\([\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	assert.match(apply, /let snapshots:[\s\S]{0,120}try \{\s*snapshots = await captureAllManagedFiles/);

	const reconcile = sourceSection(
		'const reconcileSite',
		'const cancelDeferredReconciliation',
	);
	assert.match(
		reconcile,
		/allManagedArtifactsExist\([\s\S]{0,120}assertReconciliationTransactionCurrent/,
	);
	assert.match(
		reconcile,
		/serverManagedFilesMatch\([\s\S]{0,260}assertReconciliationTransactionCurrent/,
	);
	assert.match(
		reconcile,
		/captureAllManagedFiles\([\s\S]{0,120}assertReconciliationTransactionCurrent/,
	);
	assert.match(
		reconcile,
		/catch \(error\) \{[\s\S]{0,160}isExpectedLifecycleInterruption\(siteId, error\)[\s\S]{0,220}'info'/,
	);

	const globalCleanup = sourceSection(
		'const cleanupSiteForGlobalChange',
		'const scheduleDeferredGlobalCleanup',
	);
	assert.match(
		globalCleanup,
		/allManagedArtifactsExist\([\s\S]{0,100}assertGlobalCleanupTransactionCurrent/,
	);

	const lifecycleClassifier = sourceSection(
		'const isExpectedLifecycleInterruption',
		'const beginInteractiveServerTransaction',
	);
	assert.match(lifecycleClassifier, /isServerTransactionChangedError\(error\)/);
	assert.match(lifecycleClassifier, /isExpectedLifecycleFilesystemAbsence\(error\)/);

	const handlers = mainSource.slice(
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.getSiteState'),
		mainSource.indexOf("HooksMain.addAction('siteStarted'"),
	);
	assert.match(
		handlers,
		/isExpectedLifecycleInterruption\(siteId, error\) \? 'info' : 'error'/,
	);
});

test('unsupported ambiguity and transient service lookup failure defer cleanup without mutations', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	const unavailableStart = reconcile.indexOf("if (server.kind === 'unsupported' || !server.service)");
	const unavailableEnd = reconcile.indexOf('const nextEnvelope', unavailableStart);
	const unavailableBranch = reconcile.slice(unavailableStart, unavailableEnd);
	assert.match(unavailableBranch, /throw new Error\(runtimeCleanupUnavailableReason\(server\)\)/);
	assert.doesNotMatch(unavailableBranch, /persistSettings|removeAllManagedFiles|compileAndReload|restartSiteService/);

	const disableStart = mainSource.indexOf('} else {', mainSource.indexOf('if (normalizedInput.enabled)'));
	const disableGuardEnd = mainSource.indexOf('let disabled = sanitizeDisabledSettings', disableStart);
	const disableGuard = mainSource.slice(disableStart, disableGuardEnd);
	assert.match(disableGuard, /server\.kind === 'unsupported' \|\| !server\.service/);
	assert.match(
		disableGuard,
		/previousSettings\.enabled \|\| await allManagedArtifactsExist\([\s\S]{0,100}site,[\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	assert.match(disableGuard, /throw new Error\(runtimeCleanupUnavailableReason\(server\)\)/);
	assert.doesNotMatch(disableGuard, /persistSettings|removeAllManagedFiles|compileAndReload|restartSiteService/);

	const globalCleanup = sourceSection(
		'const cleanupSiteForGlobalChange',
		'const scheduleDeferredGlobalCleanup',
	);
	assert.ok(
		globalCleanup.indexOf('shouldReconcileManagedFiles(siteStatus)') <
		globalCleanup.indexOf('server = resolveServer(site)'),
	);
	assert.match(globalCleanup, /server\.kind === 'unsupported' \|\| !server\.service/);
	assert.match(globalCleanup, /completeUnresolvedServiceCleanup\(\{/);
	assert.match(globalCleanup, /compileAllConfigs: guardedCompileAllConfigs/);
	assert.doesNotMatch(globalCleanup, /siteProcessManager\.restart\(site\)/);
	assert.match(globalCleanup, /server = resolveServer\(site\)[\s\S]{0,240}using fail-closed persistent cleanup/);
	assert.match(globalCleanup, /preserving the unknown schema and forcing runtime cleanup/);
	assert.match(
		globalCleanup,
		/const compiledConfigIsClean = server\.kind !== 'unsupported' && server\.service[\s\S]{0,260}: false;[\s\S]{0,180}const requiresRuntimeRefresh = forceRefresh \|\| enabledBeforeCleanup \|\| !compiledConfigIsClean/,
		'unresolved compiled runtime must remain unknown and force the stopped-site cleanup gate',
	);
	assert.match(globalCleanup, /removeAllManagedFiles: \(\) => removeAllManagedFiles\([\s\S]{0,100}assertGlobalCleanupTransactionCurrent/);
	assert.match(globalCleanup, /Completed fail-closed persistent cleanup/);
	assert.doesNotMatch(globalCleanup, /removeAllManagedFilesSync|synchronousCleanupRequiresRefresh/);
});

test('Apache probing and discovery never use Nginx split-IP or TLS fallback behavior', () => {
	const apacheDiscovery = mainSource.slice(
		mainSource.indexOf("if (detectSiteServer(site).kind === 'apache')"),
		mainSource.indexOf('return discoverWpEngineOrigin', mainSource.indexOf("if (detectSiteServer(site).kind === 'apache')")),
	);
	assert.match(mainSource, /validateSettingsInput\(input, \{[\s\S]{0,100}requiresOriginIp: server\.requiresOriginIp/);
	assert.match(mainSource, /allowWpEngineTlsFallback: server\.kind === 'nginx'/);
	assert.match(mainSource, /await assertApacheOriginCapability\(server, origin\.protocol\)[\s\S]{0,500}await probeOrigin/);
	assert.match(apacheDiscovery, /addresses: \[\]/);
	assert.doesNotMatch(apacheDiscovery, /originTlsHostname|stableAddresses|cname/);
	assert.match(mainSource, /Apache resolves the Site URL hostname directly; a remote-IP lookup is not used/);
});
