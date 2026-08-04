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
		mainSource.indexOf('let disabled = sanitizeDisabledSettings'),
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

test('Apache and Nginx stale-master recovery restarts only the exact captured service process', () => {
	const recovery = sourceSection(
		'const recoverStaleSiteService = async',
		'const routerProcessHasLiveChild',
	);
	const compileAndReload = sourceSection(
		'const compileAndReload = async',
		'const runtimeCleanupUnavailableReason',
	);
	const refreshBranch = compileAndReload.slice(
		compileAndReload.indexOf("if (server.kind === 'apache')"),
		compileAndReload.indexOf('const targetSiteRunning'),
	);
	assert.match(refreshBranch, /const processName = 'httpd'/);
	assert.match(refreshBranch, /hasRunningProcess\(site, processName\)/);
	assert.match(refreshBranch, /shouldRefreshRuntime\(/);
	assert.match(refreshBranch, /restartService: recoverStaleServerMaster \? async \(\) =>/);
	assert.match(refreshBranch, /recoverStaleSiteService\(/);
	assert.doesNotMatch(refreshBranch, /restartSiteService/);
	const nginxBranch = compileAndReload.slice(
		compileAndReload.indexOf('const targetSiteRunning'),
	);
	assert.match(nginxBranch, /refreshNginxService\(/);
	assert.match(nginxBranch, /const processName = 'nginx'/);
	assert.match(nginxBranch, /recoverStaleSiteService\(/);
	assert.doesNotMatch(nginxBranch, /restartSiteService\(site, processName\)/);
	assert.doesNotMatch(nginxBranch, /hasRunningProcess\(site, processName\)/);
	assert.match(recovery, /knownSiteWebServerExecutables\(site, server\)/);
	assert.match(
		recovery,
		/const disposition = await waitForSiteProcessDisposition\([\s\S]{0,320}disposition === 'settled'[\s\S]{0,180}recoverExactLocalResource\(/,
	);
	assert.equal(
		(recovery.match(/exactRestartableSiteProcess\(site, processName, executablePath\)/g) ?? []).length,
		1,
		'the captured process must be revalidated immediately before restart',
	);
	assert.equal(
		(recovery.match(/waitForSiteProcessDisposition\(/g) ?? []).length,
		2,
		'the same captured process must be observed before and after restart',
	);
	assert.match(recovery, /await restartCapturedLocalProcess\(/);
	assert.doesNotMatch(recovery, /restartSiteService|waitForTrackedSiteService/);
});

test('captured Local process restarts share one five-second timeout without retry claims', () => {
	const helper = sourceSection(
		'const restartCapturedLocalProcess = async',
		'const exactRestartableSiteProcess',
	);
	assert.match(helper, /await Promise\.race\(/);
	assert.match(helper, /LOCAL_PROCESS_RESTART_TIMEOUT_MS/);
	assert.match(helper, /clearTimeout\(timeout\)/);
	assert.match(helper, /Local may still be completing it/);
	assert.equal(
		(mainSource.match(/await restartCapturedLocalProcess\(/g) ?? []).length,
		3,
		'stale site, initially missing site, and router restarts must all be bounded',
	);
	assert.doesNotMatch(
		mainSource,
		/await (?:restartableProcess|routerProcess)\.restart!?\(\)/,
	);
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
	assert.match(
		reconcile,
		/options\.configuredOnly &&[\s\S]{0,100}!storedSettingsRequireBackgroundReconciliation\(rawStoredSettings\)[\s\S]{0,80}return/,
	);
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
		/HooksMain\.addAction\('siteStarted'[\s\S]{0,350}scheduleDeferredReconciliation\(siteId, \{[\s\S]{0,120}configuredOnly: true/,
	);
	assert.doesNotMatch(mainSource, /refreshMatchingEnabledRuntime/);
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
	assert.match(mainSource, /DEFERRED_RECONCILIATION_STABLE_SAMPLES = 3/);
	assert.match(
		reconcile,
		/catch \(validationError\)[\s\S]{0,3600}await ensureServerRuntimeReady\(site, server, transaction\)[\s\S]{0,180}const trustBundle/,
	);
	const scheduler = sourceSection(
		'const scheduleDeferredReconciliation',
		'const cancelDeferredGlobalCleanup',
	);
	assert.match(
		scheduler,
		/!existing && options\.configuredOnly[\s\S]{0,260}!storedSettingsRequireBackgroundReconciliation\([\s\S]{0,120}SITE_SETTINGS_KEY[\s\S]{0,100}return/,
	);
	assert.ok(
		scheduler.indexOf('storedSettingsRequireBackgroundReconciliation(') <
			scheduler.indexOf('siteProcessManager.getSiteStatus(site)'),
		'passive reconciliation must reject pristine settings before reading service lifecycle or paths',
	);
	assertInOrder(
		scheduler,
		[
			'siteStatus = siteProcessManager.getSiteStatus(site)',
			'shouldSkipHaltedDisabledReconciliation(site, siteStatus, pending.options)',
			'detectSiteServer(site)',
		],
		'passive reconciliation must skip stopped disabled profiles before resolving server paths',
	);
	assert.equal(
		(scheduler.match(/pending\.revision !== reconcileRevision/g) ?? []).length,
		2,
		'both resolved and rejected reconciliation work must preserve one newer lifecycle revision',
	);
	assertInOrder(
		scheduler,
		[
			'forceRuntimeRefresh: false',
			'forceRuntimeRefresh: pending.forceRuntimeRefresh',
			'pending.forceRuntimeRefresh = false',
			'const reconcileRevision = pending.revision',
			'void reconcileSite(siteId, reconcileOptions)',
		],
		'a recovery refresh must be consumed once before the guarded reconciliation begins',
	);
	assert.equal(
		(scheduler.match(/pending\.forceRuntimeRefresh =/g) ?? []).length,
		3,
		'the one-shot flag may only be consumed or armed by a newer lifecycle revision',
	);
	assert.match(
		scheduler,
		/pending\.revision !== reconcileRevision[\s\S]{0,100}pending\.forceRuntimeRefresh = !converged[\s\S]{0,80}scheduleNextPoll\(\)[\s\S]{0,80}else \{[\s\S]{0,80}cancelDeferredReconciliation\(siteId\)/,
	);
	assert.match(
		scheduler,
		/pending\.revision !== reconcileRevision[\s\S]{0,100}pending\.forceRuntimeRefresh = true[\s\S]{0,80}scheduleNextPoll\(\)[\s\S]{0,80}else \{[\s\S]{0,80}cancelDeferredReconciliation\(siteId\)/,
	);
	assert.doesNotMatch(
		scheduler,
		/if \(!converged\)[\s\S]{0,120}scheduleNextPoll\(\)/,
		'a failed reconciliation without a newer lifecycle event must not retry autonomously',
	);
	const externalSchedulingCalls = [...mainSource.matchAll(/\bscheduleDeferredReconciliation\(/g)].map(
		(match) => mainSource.slice(match.index, mainSource.indexOf(');', match.index) + 2),
	);
	assert.ok(externalSchedulingCalls.length > 0);
	for (const schedulingCall of externalSchedulingCalls) {
		assert.doesNotMatch(
			schedulingCall,
			/forceRuntimeRefresh/,
			'lifecycle hooks must not expose the internal recovery refresh as a scheduling option',
		);
	}
	const siteStartedHook = sourceSection(
		"HooksMain.addAction('siteStarted'",
		"HooksMain.addAction('siteAdded'",
	);
	assert.doesNotMatch(siteStartedHook, /skipHaltedDisabledProfile/);
	const globalEnable = sourceSection(
		'const restoreAfterGlobalEnable',
		'const listenerRegistry',
	);
	assert.match(globalEnable, /skipHaltedDisabledProfile: true/);
	assert.match(reconcile, /const managedFilesMatch = await serverManagedFilesMatch\(/);
	assert.match(reconcile, /compiledConfigMatches = await serverCompiledConfigMatches\(/);
	assert.match(
		reconcile,
		/if \(!settings\.enabled\) \{[\s\S]{0,320}allManagedArtifactsExist\([\s\S]{0,420}serverCompiledConfigMatches\([\s\S]{0,320}!managedArtifactsPresent &&[\s\S]{0,80}compiledConfigMatches &&[\s\S]{0,80}!options\.forceRuntimeRefresh[\s\S]{0,180}persistReconciledEnvelope\(\)/,
	);
	assert.match(
		reconcile,
		/if \(compiledConfigMatches && !options\.forceRuntimeRefresh\) \{[\s\S]{0,120}return persistReconciledEnvelope\(\)/,
	);
	assert.match(
		mainSource,
		/for \(const site of Object\.values\(siteData\.getSites\(\)\)[\s\S]{0,220}scheduleDeferredReconciliation\(site\.id, \{[\s\S]{0,100}configuredOnly: true/,
	);
});

test('server reconciliation carries Site URL inside the site lock and commits it transactionally', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.equal(
		(mainSource.match(/carrySiteUrlToPristineServerProfile\(/g) ?? []).length,
		3,
		'Site URL handoff must be projected by passive state and enabled-only toggles, then persisted transactionally',
	);
	assert.equal(
		(mainSource.match(/preserveStoredBlankCurrentProfile\(/g) ?? []).length,
		3,
		'legacy blank intent must be honored by passive state, enabled-only toggles, and reconciliation',
	);
	assertInOrder(
		reconcile,
		[
			'await withSiteLock(siteId, async () => {',
			'previousEnvelope = readStoredSettingsEnvelope(site, server.kind)',
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
		/if \(managedFilesMatch\) \{[\s\S]{0,320}serverCompiledConfigMatches\([\s\S]{0,320}if \(compiledConfigMatches && !options\.forceRuntimeRefresh\) \{[\s\S]{0,160}persistReconciledEnvelope\(\)/,
		'a complete carried profile may be persisted without mutation only after exact compiled convergence',
	);
	assert.match(
		reconcile,
		/changed \|\|[\s\S]{0,80}!compiledConfigMatches \|\|[\s\S]{0,100}Boolean\(options\.forceRuntimeRefresh\)[\s\S]{0,320}compileAndReload\([\s\S]{0,220}persistReconciledEnvelope\(\)/,
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
	const passiveState = mainSource.slice(
		mainSource.indexOf('const getSiteState = async'),
		mainSource.indexOf('const applySettingsLocked'),
	);
	assert.match(passiveState, /carrySiteUrlToPristineServerProfile\(intentPreservedEnvelope, server\.kind\)/);
	assert.doesNotMatch(
		passiveState,
		/persistSettings|applyServerManagedFiles|removeAllManagedFiles|compileAndReload/,
		'passive cross-profile projection must not mutate settings, files, or runtime',
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

test('server transactions use primitive runtime identity without traversing Local service metadata', () => {
	const fingerprint = sourceSection(
		'const serverTransactionFingerprint',
		'const currentServerTransactionFingerprint',
	);
	assert.match(fingerprint, /configPath: server\.service\?\.configPath \?\? null/);
	assert.match(fingerprint, /serviceName: server\.serviceName/);
	assert.match(fingerprint, /siteStatus: siteProcessManager\.getSiteStatus\(site\)/);
	assert.doesNotMatch(mainSource, /fingerprintRuntimeInputs|runtimeInputsFingerprint|serviceInputsDigest|stableRuntimeInput|createHash|inspect\(/);
});

test('router orphan recovery restarts only Local\'s settled tracked process', () => {
	const recoverySignal = sourceSection(
		'const recoverExactLocalResource',
		'const knownSiteWebServerExecutables',
	);
	const routerRecovery = sourceSection(
		'const routerProcessHasRunningChild',
		'const ensureServerRuntimeReady',
	);

	assert.match(
		routerRecovery,
		/routerProcessHasRunningChild\(currentRouterProcess\)[\s\S]{0,120}currentRouterProcess\?\.restarts === 0[\s\S]{0,100}routerProcessWasVerified\(currentRouterProcess\)[\s\S]{0,60}return/,
		'normal healthy router checks must avoid lsof',
	);
	assert.match(
		routerRecovery,
		/rememberVerifiedRouterProcess\(routerProcess\)[\s\S]{0,80}router\.clearRouterBanner\(\)/,
		'a recovered child must regain the immediate healthy fast path',
	);
	assert.ok(
		routerRecovery.indexOf('assertAllLocalSitesSettledForRouterRecovery()') >
		routerRecovery.indexOf('routerProcessWasVerified(currentRouterProcess)'),
		'healthy router checks must return before reading global site statuses',
	);
	assert.match(
		routerRecovery,
		/assertRecoveryAllowed\(\)[\s\S]{0,120}inspectExactResourceOwners\(/,
		'each abnormal router listener inspection must recheck global site lifecycles',
	);
	assert.match(
		routerRecovery,
		/ownership\.state !== 'active'[\s\S]{0,100}processOwnersBelongToCapturedTree\(owners, capturedRouterPid\)/,
		'active listeners must belong to the exact captured router child PID tree',
	);
	assert.match(
		routerRecovery,
		/const listenersMatch = await routerHasExpectedListeners\([\s\S]{0,220}assertCurrent\(\)[\s\S]{0,180}_process !== routerProcess[\s\S]{0,260}routerProcess\.childProcess\?\.pid === pid[\s\S]{0,80}listenersMatch[\s\S]{0,80}return 'healthy'/,
		'listener verification must recheck the captured object and child PID after async inspection',
	);
	assert.match(
		recoverySignal,
		/signalProcess:[\s\S]{0,100}beforeSignal\?\.\(\)[\s\S]{0,80}process\.kill\(/,
		'router recovery must recheck global site lifecycles immediately before signaling',
	);
	assert.match(routerRecovery, /for \(const port of \[80, 443\]\)/);
	assert.match(
		routerRecovery,
		/listenerChecks < LOCAL_ROUTER_LISTENER_CHECK_ATTEMPTS[\s\S]{0,80}listenerChecks \+= 1[\s\S]{0,140}routerHasExpectedListeners\(/,
		'listener verification must have a small fixed retry bound',
	);
	assertInOrder(
		routerRecovery,
		[
			"typeof routerProcess.binPath !== 'string'",
			"typeof routerProcess.restart !== 'function'",
			'assertAllLocalSitesSettledForRouterRecovery()',
			'await waitForRouterProcessSettlement(',
			'for (const port of [80, 443])',
			'assertAllLocalSitesSettledForRouterRecovery()',
			'await recoverExactLocalResource(',
			'assertAllLocalSitesSettledForRouterRecovery,',
			'assertAllLocalSitesSettledForRouterRecovery()',
			'await restartCapturedLocalProcess(',
			'await waitForRouterProcessSettlement(',
			'router.clearRouterBanner()',
		],
		'router recovery must settle, recover exact listeners, and restart only the captured process',
	);
	assert.doesNotMatch(
		routerRecovery,
		/router\.restart\(|router\.refresh\(|compileConfigTemplates|generateSiteCert|hostsFile/,
		'router recovery must not rebuild global routes or certificates',
	);
});

test('interactive apply, save-disable, and toggle commit settings only after files and runtime are current', () => {
	const preflight = sourceSection(
		'const beginInteractiveServerTransaction',
		'const managedFileOptions',
	);
	const apply = mainSource.slice(
		mainSource.indexOf('const applySettingsLocked'),
		mainSource.indexOf('const applySettings = async'),
	);
	const toggle = mainSource.slice(
		mainSource.indexOf('const setEnabled = async'),
		mainSource.indexOf('const discoverOrigin = async'),
	);

	assert.match(
		preflight,
		/const serviceTracked = siteProcessManager\.hasRunningProcess\(site, processName\)/,
	);
	assert.match(
		preflight,
		/exactRestartableSiteProcess\(\s*site,\s*processName,\s*executablePath,\s*\)/,
	);
	assert.match(preflight, /matching\[0\]\.binPath === expectedExecutablePath/);
	assert.match(preflight, /stableLiveSamples >= 2/);
	assert.match(preflight, /waitForSiteProcessDisposition\(/);
	assert.match(preflight, /recoverExactLocalResource/);
	assert.match(preflight, /restartCapturedLocalProcess\(/);
	assert.doesNotMatch(preflight, /restartSiteService\(site, processName\)/);
	assertInOrder(
		preflight,
		[
			'const restartableProcess = exactRestartableSiteProcess(',
			'const disposition = await waitForSiteProcessDisposition(',
			'const recovery = await recoverExactLocalResource(',
			'await restartCapturedLocalProcess(',
		],
		'exact site process settlement must precede listener recovery and process-only restart',
	);
	assert.match(preflight, /routerProcessHasRunningChild/);
	assert.match(preflight, /Media Proxy made no settings or configuration changes/);
	assert.doesNotMatch(preflight, /siteProcessManager\.restart\(site/);
	assert.match(apply, /const transaction = beginInteractiveServerTransaction\(site, server\)/);
	assertInOrder(
		apply,
		[
			'const transaction = beginInteractiveServerTransaction(site, server)',
			'await ensureServerRuntimeReady(site, server, transaction)',
			'captureAllManagedFiles(',
		],
		'runtime recovery must finish before apply captures or changes managed files',
	);
	assert.match(
		apply,
		/captureAllManagedFiles\([\s\S]{0,80}site,[\s\S]{0,120}assertServerTransactionCurrent\(siteId, transaction\)/,
	);
	const enableBranch = apply.slice(
		apply.indexOf('if (normalizedInput.enabled)'),
		apply.indexOf('let disabled = sanitizeDisabledSettings'),
	);
	const saveDisableBranch = apply.slice(
		apply.indexOf('let disabled = sanitizeDisabledSettings'),
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
	assert.ok(
		toggle.indexOf('await ensureServerRuntimeReady(site, server, transaction)') <
			toggle.indexOf('snapshots = await captureAllManagedFiles('),
		'runtime recovery must finish before toggle captures or changes managed files',
	);
	assertInOrder(
		toggle,
		[
			'previousEnvelope = readStoredSettingsEnvelope(site, expectedServerKind)',
			'preserveStoredBlankCurrentProfile(',
			'carrySiteUrlToPristineServerProfile(',
			'const settings = storedSettingsForServer(envelope, expectedServerKind)',
		],
		'enabled-only toggles must use the same in-lock server-switch projection as passive state',
	);
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
	const lifecycleUnavailableState = mainSource.slice(
		mainSource.indexOf('const lifecycleUnavailableSiteState'),
		mainSource.indexOf('const getSiteState = async'),
	);
	assert.match(lifecycleUnavailableState, /lifecycleReady: false/);
	assert.match(
		lifecycleUnavailableState,
		/try \{[\s\S]{0,320}readStoredSettingsEnvelope[\s\S]{0,520}catch \(settingsError\)[\s\S]{0,220}failClosedSettingsForInvalidEnvelope/,
	);

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
		reason: 'The nginx profile is enabled, but its managed proxy configuration is not applied.',
		siteUrl: 'http://media.example.com',
		siteStatus: 'running',
	});
	assert.deepEqual(passive.updates, []);

	const projectedSwitch = runScenario('passive-switch-projection');
	assert.deepEqual(projectedSwitch.calls, []);
	assert.deepEqual(projectedSwitch.state, {
		applied: false,
		needsAttention: false,
		siteUrl: 'https://carried.example.com',
		siteStatus: 'running',
	});
	assert.deepEqual(projectedSwitch.updates, []);

	const immediateSwitchEnable = runScenario('immediate-apache-switch-enable');
	assert.equal(immediateSwitchEnable.projectedSiteUrl, 'https://carried.example.com');
	assert.deepEqual(immediateSwitchEnable.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileApache:managed',
		'updateSite',
	]);
	assert.equal(immediateSwitchEnable.operationError, undefined);
	assert.equal(immediateSwitchEnable.finalStoredSettings.enabled, true);
	assert.equal(
		immediateSwitchEnable.finalStoredSettings.profiles.apache.siteUrl,
		'https://carried.example.com',
	);
	assert.equal(immediateSwitchEnable.state?.applied, true);

	const unresolvedDisabled = runScenario('supported-service-unavailable-disabled');
	assert.deepEqual(unresolvedDisabled.calls, []);
	assert.equal(unresolvedDisabled.state.applied, false);
	assert.equal(unresolvedDisabled.state.needsAttention, true);
	assert.equal(unresolvedDisabled.state.siteUrl, 'http://media.example.com');
	assert.equal(unresolvedDisabled.state.siteStatus, 'running');
	assert.match(unresolvedDisabled.state.reason, /runtime cleanup cannot be verified/i);
	assert.deepEqual(unresolvedDisabled.updates, []);

	const startupNoop = runScenario('startup-noop');
	assert.deepEqual(startupNoop.calls, []);
	assert.equal(startupNoop.refreshCalls, 0);
	assert.equal(startupNoop.restartCalls, 0);

	for (const scenario of [
		'startup-pristine-disabled-nginx',
		'site-added-pristine-disabled-nginx',
		'site-start-pristine-disabled-nginx',
		'global-enable-pristine-disabled-nginx',
	]) {
		const pristineDisabledNginx = runScenario(scenario);
		assert.equal(pristineDisabledNginx.compiledMatches, false);
		assert.equal(pristineDisabledNginx.compiledMatchChecks, 0);
		assert.equal(pristineDisabledNginx.filesystemReadyChecks, 0);
		assert.equal(pristineDisabledNginx.managedArtifactChecks, 0);
		assert.equal(pristineDisabledNginx.serviceLookupCalls, 0);
		assert.equal(pristineDisabledNginx.siteStatusCalls, 0);
		assert.equal(pristineDisabledNginx.pendingTimers, 0);
		assert.deepEqual(pristineDisabledNginx.calls, []);
		assert.deepEqual(pristineDisabledNginx.updates, []);
		assert.equal(pristineDisabledNginx.restartCalls, 0);
		assert.deepEqual(
			pristineDisabledNginx.finalStoredSettings,
			pristineDisabledNginx.storedSettingsBeforeReconciliation,
		);
	}

	const pristineDisabledApache = runScenario('startup-pristine-disabled-apache');
	assert.deepEqual(pristineDisabledApache.calls, ['updateSite']);
	assert.equal(pristineDisabledApache.compiledMatchChecks, 1);
	assert.equal(pristineDisabledApache.managedArtifactChecks, 1);
	assert.equal(pristineDisabledApache.pendingTimers, 0);
	assert.equal(pristineDisabledApache.restartCalls, 0);
	assert.equal(pristineDisabledApache.updates.length, 1);
	assert.equal(pristineDisabledApache.finalStoredSettings.enabled, false);
	assert.equal(pristineDisabledApache.finalStoredSettings.lastServerKind, 'apache');
	assert.equal(pristineDisabledApache.finalStoredSettings.profiles.apache.originSource, 'manual');
	assert.deepEqual(pristineDisabledApache.finalStoredSettings.profiles.nginx, {
		originIp: '',
		productionUrl: '',
		siteUrl: '',
	});

	const configuredDisabledNginx = runScenario('startup-configured-disabled-nginx');
	assert.deepEqual(configuredDisabledNginx.calls, [
		'captureAllManagedFiles',
		'removeAllManagedFiles',
		'compileNginx:clean',
		'reloadNginx',
	]);
	assert.equal(configuredDisabledNginx.compiledMatchChecks, 1);
	assert.equal(configuredDisabledNginx.pendingTimers, 0);
	assert.deepEqual(configuredDisabledNginx.updates, []);
	assert.equal(configuredDisabledNginx.refreshCalls, 1);

	const configuredDisabledCleanNginx = runScenario('startup-configured-disabled-clean-nginx');
	assert.deepEqual(configuredDisabledCleanNginx.calls, []);
	assert.equal(configuredDisabledCleanNginx.compiledMatchChecks, 1);
	assert.equal(configuredDisabledCleanNginx.pendingTimers, 0);
	assert.deepEqual(configuredDisabledCleanNginx.updates, []);
	assert.equal(configuredDisabledCleanNginx.refreshCalls, 0);

	for (const scenario of [
		'startup-configured-disabled-halted',
		'global-enable-configured-disabled-halted',
	]) {
		const passiveHaltedDisabled = runScenario(scenario);
		assert.deepEqual(passiveHaltedDisabled.calls, []);
		assert.equal(passiveHaltedDisabled.compiledMatchChecks, 0);
		assert.equal(passiveHaltedDisabled.filesystemReadyChecks, 0);
		assert.equal(passiveHaltedDisabled.managedArtifactChecks, 0);
		assert.equal(passiveHaltedDisabled.serviceLookupCalls, 0);
		assert.equal(passiveHaltedDisabled.pendingTimers, 0);
		assert.equal(passiveHaltedDisabled.restartCalls, 0);
		assert.deepEqual(passiveHaltedDisabled.updates, []);
		assert.deepEqual(
			passiveHaltedDisabled.finalStoredSettings,
			passiveHaltedDisabled.storedSettingsBeforeReconciliation,
		);
	}

	const globalEnableRunningDisabled = runScenario('global-enable-configured-disabled-running');
	assert.deepEqual(globalEnableRunningDisabled.calls, [
		'captureAllManagedFiles',
		'removeAllManagedFiles',
		'compileNginx:clean',
		'reloadNginx',
	]);
	assert.equal(globalEnableRunningDisabled.pendingTimers, 0);
	assert.equal(globalEnableRunningDisabled.refreshCalls, 1);
	assert.equal(globalEnableRunningDisabled.restartCalls, 0);

	const siteStartedHaltedDisabled = runScenario('site-start-configured-disabled-halted');
	assert.deepEqual(siteStartedHaltedDisabled.calls, [
		'captureAllManagedFiles',
		'removeAllManagedFiles',
		'compileNginx:clean',
	]);
	assert.equal(siteStartedHaltedDisabled.pendingTimers, 0);
	assert.equal(siteStartedHaltedDisabled.restartCalls, 0);

	const startupEnabledHalted = runScenario('startup-enabled-halted-drift');
	assert.deepEqual(startupEnabledHalted.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
	]);
	assert.equal(startupEnabledHalted.pendingTimers, 0);
	assert.equal(startupEnabledHalted.restartCalls, 0);

	const startupRepair = runScenario('startup-compiled-drift');
	assert.deepEqual(startupRepair.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
	]);
	assert.equal(startupRepair.refreshCalls, 1);
	assert.equal(startupRepair.restartCalls, 0);

	for (const scenario of ['preflight-status-retry', 'preflight-service-retry']) {
		const retriedPreflight = runScenario(scenario);
		assert.ok(retriedPreflight.preflightTimersAfterFailure > 0);
		assert.ok(retriedPreflight.preflightTimersAfterOneRecoverySample > 0);
		assert.equal(retriedPreflight.preflightCallsAfterOneRecoverySample, 0);
		assert.equal(retriedPreflight.pendingTimers, 0);
		assert.deepEqual(retriedPreflight.calls, [
			'captureAllManagedFiles',
			'applyServerManagedFiles',
			'compileNginx:managed',
			'reloadNginx',
		]);
		assert.equal(retriedPreflight.refreshCalls, 1);
		assert.equal(retriedPreflight.restartCalls, 0);
	}

	const interruptedReconciliation = runScenario('reconciliation-service-path-change-recovery');
	assert.equal(interruptedReconciliation.retryTimersAfterFailure, 1);
	assert.equal(interruptedReconciliation.retryTimersAfterOneRecoverySample, 1);
	assert.equal(interruptedReconciliation.retryCallsAfterOneRecoverySample, 3);
	assert.equal(interruptedReconciliation.pendingTimers, 0);
	assert.equal(interruptedReconciliation.publishedSiteStartedEvents, 1);
	assert.deepEqual(interruptedReconciliation.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
	]);
	assert.equal(interruptedReconciliation.compiledMatchChecks, 2);
	assert.equal(interruptedReconciliation.refreshCalls, 1);
	assert.equal(interruptedReconciliation.restartCalls, 0);

	for (const scenario of ['site-start-matching', 'global-enable-matching']) {
		const matchingRuntime = runScenario(scenario);
		assert.deepEqual(matchingRuntime.calls, []);
		assert.equal(
			matchingRuntime.refreshCalls,
			0,
			`${scenario} must leave an already matching active runtime alone`,
		);
		assert.equal(matchingRuntime.restartCalls, 0);
	}

	for (const scenario of ['corrupt-schema-version', 'corrupt-profile-envelope']) {
		const corrupt = runScenario(scenario);
		assert.deepEqual(corrupt.calls, [
			'removeAllManagedFiles',
			'compileNginx:clean',
			'reloadNginx',
		]);
		assert.equal(corrupt.refreshCalls, 1);
		assert.equal(corrupt.restartCalls, 0);
		assert.deepEqual(corrupt.updates, []);
		assert.deepEqual(
			corrupt.finalStoredSettings,
			corrupt.storedSettingsBeforeReconciliation,
			`${scenario} cleanup must retain the unsupported stored value`,
		);
	}

	const failedCorruptCleanup = runScenario('corrupt-cleanup-failure-cancels');
	assert.deepEqual(failedCorruptCleanup.calls, [
		'removeAllManagedFiles',
		'compileNginx:clean',
	]);
	assert.equal(failedCorruptCleanup.retryTimersAfterFailure, 0);
	assert.equal(failedCorruptCleanup.pendingTimers, 0);
	assert.equal(failedCorruptCleanup.publishedSiteStartedEvents, 0);
	assert.equal(failedCorruptCleanup.refreshCalls, 0);
	assert.equal(failedCorruptCleanup.restartCalls, 0);
	assert.deepEqual(failedCorruptCleanup.updates, []);
	assert.deepEqual(
		failedCorruptCleanup.finalStoredSettings,
		failedCorruptCleanup.storedSettingsBeforeReconciliation,
		'a failed corrupt cleanup must retain the unsupported stored value without retrying',
	);

	const newerEventCleanup = runScenario('corrupt-cleanup-failure-newer-event');
	assert.equal(newerEventCleanup.retryTimersAfterFailure, 1);
	assert.equal(newerEventCleanup.retryTimersAfterOneRecoverySample, 1);
	assert.equal(newerEventCleanup.retryCallsAfterOneRecoverySample, 2);
	assert.equal(newerEventCleanup.pendingTimers, 0);
	assert.equal(newerEventCleanup.publishedSiteStartedEvents, 1);
	assert.deepEqual(newerEventCleanup.calls, [
		'removeAllManagedFiles',
		'compileNginx:clean',
		'removeAllManagedFiles',
		'compileNginx:clean',
		'reloadNginx',
	]);
	assert.equal(newerEventCleanup.refreshCalls, 1);
	assert.deepEqual(newerEventCleanup.updates, []);

	const passiveCorruptState = runScenario('corrupt-passive-state');
	assert.deepEqual(passiveCorruptState.calls, []);
	assert.equal(passiveCorruptState.state?.applied, false);
	assert.equal(passiveCorruptState.state?.needsAttention, true);
	assert.equal(passiveCorruptState.stateCanEnable, false);
	assert.equal(passiveCorruptState.stateCleanupSupported, true);
	assert.equal(passiveCorruptState.stateEnabledIntent, true);
	assert.equal(passiveCorruptState.stateSettingsReadOnly, true);
	assert.match(passiveCorruptState.state?.reason, /unsupported schema version/i);
	assert.match(passiveCorruptState.state?.reason, /cleanup is pending/i);
	assert.deepEqual(passiveCorruptState.updates, []);

	const transitioningCorruptState = runScenario('corrupt-passive-transitioning');
	assert.deepEqual(transitioningCorruptState.calls, []);
	assert.equal(transitioningCorruptState.stateCanEnable, false);
	assert.equal(transitioningCorruptState.stateEnabledIntent, true);
	assert.equal(transitioningCorruptState.stateLifecycleReady, false);
	assert.equal(transitioningCorruptState.stateSettingsReadOnly, true);
	assert.match(transitioningCorruptState.state?.reason, /starting|changing|available/i);
	assert.match(transitioningCorruptState.state?.reason, /unsupported schema version/i);
	assert.deepEqual(transitioningCorruptState.updates, []);
	assert.deepEqual(
		transitioningCorruptState.finalStoredSettings,
		transitioningCorruptState.storedSettingsBeforeReconciliation,
	);

	const deferredCorruptCleanup = runScenario('corrupt-service-unavailable');
	assert.deepEqual(deferredCorruptCleanup.calls, []);
	assert.equal(deferredCorruptCleanup.restartCalls, 0);
	assert.equal(deferredCorruptCleanup.updates.length, 0);
	assert.ok(deferredCorruptCleanup.pendingTimers > 0);
	assert.deepEqual(
		deferredCorruptCleanup.finalStoredSettings,
		deferredCorruptCleanup.storedSettingsBeforeReconciliation,
	);

	const haltedRepair = runScenario('same-value-halted-repair');
	assert.deepEqual(haltedRepair.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'updateSite',
	]);
	assert.equal(haltedRepair.restartCalls, 0);
	assert.deepEqual(haltedRepair.state, {
		applied: true,
		needsAttention: false,
		siteUrl: 'http://media.example.com',
		siteStatus: 'halted',
	});
	assert.equal(
		haltedRepair.finalStoredSettings.profiles.nginx.lastVerifiedAt,
		'2026-08-04T12:00:00.000Z',
	);

	const sameValueSave = runScenario('same-value-save-apply-fast-path');
	assert.deepEqual(sameValueSave.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(sameValueSave.operationError, undefined);
	assert.equal(sameValueSave.refreshCalls, 1);
	assert.equal(
		sameValueSave.finalStoredSettings.profiles.nginx.lastVerifiedAt,
		'2026-08-04T12:00:00.000Z',
	);

	const sameValueWpEngine = runScenario('same-value-wpengine-fast-path');
	assert.deepEqual(sameValueWpEngine.calls, [
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(sameValueWpEngine.operationError, undefined);
	assert.equal(
		sameValueWpEngine.finalStoredSettings.profiles.nginx.originWpEngineSiteId,
		'wp-site',
	);

	const mismatchedWpEngine = runScenario('same-value-wpengine-provenance-mismatch');
	assert.match(mismatchedWpEngine.operationError, /no longer matches this Local site connection/);
	assert.deepEqual(mismatchedWpEngine.calls, []);
	assert.deepEqual(mismatchedWpEngine.updates, []);

	const changedSave = runScenario('changed-save-apply-reprobes');
	assert.deepEqual(changedSave.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(changedSave.operationError, undefined);
	assert.equal(changedSave.finalStoredSettings.profiles.nginx.originIp, '192.0.2.11');

	const explicitTest = runScenario('explicit-test-reprobes');
	assert.deepEqual(explicitTest.calls, ['probeOrigin']);
	assert.deepEqual(explicitTest.updates, []);

	const staleMasterRecovery = runScenario('versioned-nginx-stale-master-recovery');
	assert.deepEqual(staleMasterRecovery.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'restart:nginx',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(staleMasterRecovery.operationError, undefined);
	assert.equal(staleMasterRecovery.restartCalls, 1);
	assert.equal(staleMasterRecovery.updates.length, 1);

	const trackedStaleOrphanRecovery = runScenario(
		'versioned-nginx-stale-master-orphan-recovery',
	);
	assert.deepEqual(trackedStaleOrphanRecovery.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'recoverPortOrphan',
		'restart:nginx',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(trackedStaleOrphanRecovery.operationError, undefined);
	assert.equal(trackedStaleOrphanRecovery.restartCalls, 1);
	assert.equal(trackedStaleOrphanRecovery.updates.length, 1);

	const trackedStaleApacheOrphanRecovery = runScenario(
		'versioned-apache-stale-master-orphan-recovery',
	);
	assert.deepEqual(trackedStaleApacheOrphanRecovery.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileApache:managed',
		'recoverPortOrphan',
		'restart:httpd',
		'updateSite',
	]);
	assert.equal(trackedStaleApacheOrphanRecovery.operationError, undefined);
	assert.equal(trackedStaleApacheOrphanRecovery.restartCalls, 1);
	assert.equal(trackedStaleApacheOrphanRecovery.updates.length, 1);

	const guardedRouterRecovery = runScenario('router-recovery-blocked-by-transitional-site');
	assert.match(guardedRouterRecovery.operationError, /changing one or more sites/);
	assert.deepEqual(guardedRouterRecovery.calls, ['getSiteStatuses']);
	assert.deepEqual(guardedRouterRecovery.updates, []);

	const unrelatedRouterOwner = runScenario('router-listener-unrelated-owner-rejected');
	assert.match(unrelatedRouterOwner.operationError, /bounded recovery deadline/);
	assert.deepEqual(unrelatedRouterOwner.calls, [
		'getSiteStatuses',
		'getSiteStatuses',
		'inspectRouterListener:80',
		'getSiteStatuses',
		'inspectRouterListener:80',
	]);
	assert.equal(unrelatedRouterOwner.restartCalls, 0);
	assert.deepEqual(unrelatedRouterOwner.updates, []);

	const failedStaleMasterRecovery = runScenario('versioned-nginx-stale-master-recovery-failure');
	assert.equal(failedStaleMasterRecovery.operationError, 'replacement did not accept a reload');
	assert.deepEqual(failedStaleMasterRecovery.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'restart:nginx',
		'reloadNginx',
		'restoreManagedFiles',
		'removeAllManagedFiles',
		'compileNginx:clean',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(failedStaleMasterRecovery.restartCalls, 1);
	assert.equal(failedStaleMasterRecovery.refreshCalls, 2);
	assert.equal(failedStaleMasterRecovery.updates.length, 1);
	assert.equal(failedStaleMasterRecovery.updates[0].enabled, false);
	assert.equal(failedStaleMasterRecovery.finalEnabled, false);
	assert.deepEqual(
		failedStaleMasterRecovery.finalStoredSettings.profiles.nginx.siteUrl,
		failedStaleMasterRecovery.storedSettingsBeforeReconciliation.profiles.nginx.siteUrl,
	);

	const timedOutStaleMasterRecovery = runScenario(
		'versioned-nginx-stale-master-restart-timeout',
	);
	assert.match(
		timedOutStaleMasterRecovery.operationError,
		/could not restart this site's Nginx service/,
	);
	assert.deepEqual(timedOutStaleMasterRecovery.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
		'reloadNginx',
		'restart:nginx',
		'restoreManagedFiles',
		'removeAllManagedFiles',
		'compileNginx:clean',
		'reloadNginx',
		'updateSite',
	]);
	assert.equal(timedOutStaleMasterRecovery.restartCalls, 1);
	assert.equal(timedOutStaleMasterRecovery.updates.length, 1);

	for (const [scenario, restoredCompile, restoredEnabled, failClosedCleanup] of [
		['rollback-valid-managed', 'compileNginx:managed', true, false],
		['rollback-snapshot-enabled', 'compileNginx:clean', false, true],
		['rollback-snapshot-disabled', 'compileNginx:clean', true, true],
		['rollback-malformed-snapshot', 'compileNginx:clean', true, true],
	]) {
		const rollback = runScenario(scenario);
		assert.equal(rollback.operationError, 'targeted reload failed');
		assert.equal(rollback.refreshCalls, 2);
		assert.equal(rollback.restartCalls, 0);
		assert.deepEqual(rollback.calls, [
			'probeOrigin',
			'captureAllManagedFiles',
			'applyServerManagedFiles',
			'compileNginx:managed',
			'reloadNginx',
			'restoreManagedFiles',
			...(failClosedCleanup ? ['removeAllManagedFiles'] : []),
			restoredCompile,
			'reloadNginx',
			'updateSite',
		]);
		assert.equal(rollback.finalEnabled, restoredEnabled);
		assert.equal(rollback.updates.length, 1);
		assert.equal(rollback.updates[0].enabled, restoredEnabled);
	}

	const timedOutMissingTarget = runScenario('target-service-missing-restart-timeout');
	assert.match(
		timedOutMissingTarget.operationError,
		/could not restart this site's Nginx service after its port was cleared/,
	);
	assert.deepEqual(timedOutMissingTarget.calls, ['restart:nginx']);
	assert.equal(timedOutMissingTarget.restartCalls, 1);
	assert.deepEqual(timedOutMissingTarget.updates, []);
	assert.deepEqual(
		timedOutMissingTarget.finalStoredSettings,
		timedOutMissingTarget.storedSettingsBeforeReconciliation,
	);

	const missingTarget = runScenario('target-service-missing');
	assert.match(missingTarget.operationError, /could not restart this site's Nginx service/);
	assert.match(missingTarget.operationError, /made no settings or configuration changes/);
	assert.deepEqual(missingTarget.calls, ['restart:nginx']);
	assert.equal(missingTarget.refreshCalls, 0);
	assert.equal(missingTarget.restartCalls, 1);
	assert.deepEqual(missingTarget.runningProcessChecks, ['nginx']);
	assert.equal(missingTarget.updates.length, 0);
	assert.deepEqual(
		missingTarget.finalStoredSettings,
		missingTarget.storedSettingsBeforeReconciliation,
	);

	const missingApacheTarget = runScenario('target-apache-service-missing');
	assert.match(missingApacheTarget.operationError, /could not restart this site's Apache service/);
	assert.match(missingApacheTarget.operationError, /made no settings or configuration changes/);
	assert.deepEqual(missingApacheTarget.calls, ['restart:httpd']);
	assert.equal(missingApacheTarget.refreshCalls, 0);
	assert.equal(missingApacheTarget.restartCalls, 1);
	assert.deepEqual(missingApacheTarget.runningProcessChecks, ['httpd']);
	assert.equal(missingApacheTarget.updates.length, 0);
	assert.deepEqual(
		missingApacheTarget.finalStoredSettings,
		missingApacheTarget.storedSettingsBeforeReconciliation,
	);

	const missingDisableTarget = runScenario('target-service-missing-disable');
	assert.match(missingDisableTarget.operationError, /could not restart this site's Nginx service/);
	assert.match(missingDisableTarget.operationError, /made no settings or configuration changes/);
	assert.deepEqual(missingDisableTarget.calls, ['restart:nginx']);
	assert.equal(missingDisableTarget.refreshCalls, 0);
	assert.equal(missingDisableTarget.restartCalls, 1);
	assert.deepEqual(missingDisableTarget.runningProcessChecks, ['nginx']);
	assert.equal(missingDisableTarget.updates.length, 0);
	assert.deepEqual(
		missingDisableTarget.finalStoredSettings,
		missingDisableTarget.storedSettingsBeforeReconciliation,
	);

	const missingSaveDisableTarget = runScenario('target-service-missing-save-disable');
	assert.match(missingSaveDisableTarget.operationError, /could not restart this site's Nginx service/);
	assert.deepEqual(missingSaveDisableTarget.calls, ['restart:nginx']);
	assert.equal(missingSaveDisableTarget.refreshCalls, 0);
	assert.equal(missingSaveDisableTarget.restartCalls, 1);
	assert.deepEqual(missingSaveDisableTarget.runningProcessChecks, ['nginx']);
	assert.equal(missingSaveDisableTarget.updates.length, 0);
	assert.deepEqual(
		missingSaveDisableTarget.finalStoredSettings,
		missingSaveDisableTarget.storedSettingsBeforeReconciliation,
	);

	const cleanMissingDisableTarget = runScenario('target-service-missing-clean-disable');
	assert.equal(cleanMissingDisableTarget.operationError, undefined);
	assert.deepEqual(cleanMissingDisableTarget.runningProcessChecks, []);
	assert.equal(cleanMissingDisableTarget.refreshCalls, 0);
	assert.equal(cleanMissingDisableTarget.restartCalls, 0);
	assert.equal(cleanMissingDisableTarget.updates.length, 1);
	assert.equal(cleanMissingDisableTarget.finalEnabled, false);

	const changedPath = runScenario('service-path-change');
	assert.match(changedPath.operationError, /web-server identity or lifecycle status/);
	assert.deepEqual(changedPath.calls, [
		'probeOrigin',
		'captureAllManagedFiles',
		'applyServerManagedFiles',
		'compileNginx:managed',
	]);
	assert.equal(changedPath.refreshCalls, 0);
	assert.equal(changedPath.restartCalls, 0);
	assert.equal(changedPath.updates.length, 0);
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
	assert.match(toggle, /rollbackTransaction\([\s\S]{0,160}previousEnvelope,[\s\S]{0,100}snapshots/);
	assert.doesNotMatch(toggle, /replaceStoredSettingsForServer/);
});

test('global cleanup polls readiness but cancels an operational failure after one attempt', () => {
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
	assert.match(
		scheduler,
		/catch \(error\) \{[\s\S]{0,180}isExpectedLifecycleInterruption\(siteId, error\)[\s\S]{0,260}cancelDeferredGlobalCleanup\(siteId\)[\s\S]{0,180}Unable to complete deferred Media Proxy global/,
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
			globalAsyncCleanups: 5,
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

	const disableGuardEnd = mainSource.indexOf('let disabled = sanitizeDisabledSettings');
	const disableStart = mainSource.lastIndexOf('\n\t\t\tif (', disableGuardEnd);
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
