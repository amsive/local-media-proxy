/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

test('Apache apply snapshots both servers and rolls settings and files back on refresh failure', () => {
	const applyBranch = mainSource.slice(
		mainSource.indexOf('if (normalizedInput.enabled)'),
		mainSource.indexOf('} else {', mainSource.indexOf('if (normalizedInput.enabled)')),
	);
	assert.match(applyBranch, /const snapshots = await captureAllManagedFiles\(site\)/);
	assert.match(applyBranch, /await applyServerManagedFiles\(/);
	assert.match(applyBranch, /await compileAndReload\(site, server, true\)/);
	assert.match(applyBranch, /return rollbackTransaction\([\s\S]{0,180}snapshots,[\s\S]{0,80}error/);
	assert.match(mainSource, /persistSettings\(site\.id, previousEnvelope\)[\s\S]{0,260}await restoreManagedFiles\(snapshots\)/);
	assert.match(mainSource, /apacheSnapshotHasCompleteManagedConfig\(site, snapshots\)/);
});

test('Apache refresh observes Local runtime process name httpd without using its non-settling hard restart', () => {
	const refreshBranch = mainSource.slice(
		mainSource.indexOf("if (server.kind === 'apache')"),
		mainSource.indexOf('await configTemplates.compileServiceConfigs', mainSource.indexOf("if (server.kind === 'apache')")),
	);
	assert.match(refreshBranch, /const processName = 'httpd'/);
	assert.match(refreshBranch, /hasRunningProcess\(site, processName\)/);
	assert.match(refreshBranch, /shouldRefreshRuntime\(/);
	assert.doesNotMatch(refreshBranch, /restartSiteService/);
});

test('global disable and uninstall remove both server artifacts before targeted refresh', () => {
	const cleanup = mainSource.slice(
		mainSource.indexOf('const cleanUpForGlobalChange'),
		mainSource.indexOf('const restoreAfterGlobalEnable'),
	);
	assert.match(cleanup, /removeAllManagedFilesSync\(site\)/);
	assert.match(cleanup, /await removeAllManagedFiles\(site\)/);
	assert.match(cleanup, /if \(uninstalling && envelopeBeforeCleanup\)[\s\S]{0,220}setStoredSettingsEnabled\(envelopeBeforeCleanup, false\)/);
	assert.match(cleanup, /await compileAndReload\(site, server, false\)/);
	assert.doesNotMatch(cleanup, /removeManagedFiles(?:Sync)?\(/);
});

test('startup and site-start reconciliation repair active-server drift and clean inactive artifacts', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.match(reconcile, /serverManagedFilesMatch\(/);
	assert.match(reconcile, /applyServerManagedFiles\(/);
	assert.match(reconcile, /removeAllManagedFiles\(site\)/);
	assert.match(reconcile, /compileAndReload\(site, server, settings\.enabled\)/);
	assert.match(reconcile, /const forcedAfterSiteStarted = options\.refreshMatchingEnabledRuntime === true;[\s\S]{0,220}shouldReconcileManagedFiles\(/);
	assert.ok(
		reconcile.indexOf('siteStatusAllowsReconciliation(site)') < reconcile.indexOf('const server = resolveServer(site)'),
		'background reconciliation must reject Local transition states before resolving or mutating server templates',
	);
	assert.match(reconcile, /normalizedOrigin = validateAndNormalizeOrigin[\s\S]{0,180}await assertApacheOriginCapability\(server, normalizedOrigin\.protocol\)/);
	assert.match(reconcile, /catch \(validationError\)[\s\S]{0,500}removeAllManagedFiles\(site\)[\s\S]{0,300}compileAndReload\(site, server, false\)/);
	assert.match(reconcile, /retaining global enabled intent for the current \$\{server\.kind\} profile/);
	assert.match(reconcile, /cleanupRequiresRefresh\(changed, settings\.enabled\)/);
	assert.match(reconcile, /nextEnvelope !== previousEnvelope \|\|[\s\S]{0,100}storedSettingsEnvelopeNeedsMigration\(rawStoredSettings\)/);
	assert.match(reconcile, /if \(shouldPersistReconciledEnvelope\) \{\s*persistSettings\(site\.id, nextEnvelope\)/);
	assert.match(mainSource, /HooksMain\.addAction\('siteStarted'/);
	assert.match(
		mainSource,
		/reconcileSite\(siteId, \{ refreshMatchingEnabledRuntime: true \}\)/,
	);
	assert.match(
		reconcile,
		/if \(options\.refreshMatchingEnabledRuntime\) \{[\s\S]{0,180}compileAndReload\(site, server, true\)/,
	);
	assert.match(mainSource, /Startup reconciliation failed/);
});

test('reconciliation rechecks current status and server identity immediately before mutation branches', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	assert.match(
		reconcile,
		/const reconciliationCanMutate = \(\): boolean => \{[\s\S]{0,180}siteData\.getSite\(siteId\)[\s\S]{0,180}siteStatusAllowsReconciliation\(latestSite\)/,
	);
	assert.match(
		reconcile,
		/const latestServer = resolveServer\(latestSite\);[\s\S]{0,260}latestSite\.longPath === site\.longPath[\s\S]{0,260}latestServer\.kind === server\.kind[\s\S]{0,260}latestServer\.serviceName === server\.serviceName[\s\S]{0,260}latestServer\.service\?\.bin\?\.\[binaryName\] === server\.service\?\.bin\?\.\[binaryName\][\s\S]{0,400}siteConfigTemplatePath === server\.service\?\.siteConfigTemplatePath/,
	);

	const invalidCleanup = reconcile.slice(
		reconcile.indexOf('catch (validationError)'),
		reconcile.indexOf('const trustBundle = normalizedOrigin.protocol'),
	);
	assert.ok(
		invalidCleanup.indexOf('if (!reconciliationCanMutate())') < invalidCleanup.indexOf('removeAllManagedFiles(site)'),
		'invalid-profile cleanup must recheck status after awaited validation',
	);
	assert.ok(
		invalidCleanup.lastIndexOf('reconciliationCanMutate()') < invalidCleanup.indexOf('compileAndReload(site, server, false)') &&
		invalidCleanup.lastIndexOf('reconciliationCanMutate()') >= 0,
		'runtime cleanup refresh must recheck status after file removal',
	);

	const driftRepair = reconcile.slice(
		reconcile.indexOf('const snapshots = await captureAllManagedFiles(site)'),
		reconcile.indexOf('const matchesThisAddon'),
	);
	assert.ok(
		driftRepair.indexOf('!persistReconciledEnvelope() || !reconciliationCanMutate()') < driftRepair.indexOf('applyServerManagedFiles('),
		'drift repair must recheck status and server identity after snapshot reads',
	);
	assert.ok(
		driftRepair.lastIndexOf('if (!reconciliationCanMutate())') < driftRepair.indexOf('compileAndReload(site, server, settings.enabled)') &&
		driftRepair.lastIndexOf('if (!reconciliationCanMutate())') >= 0,
		'runtime refresh must recheck status after drift repair',
	);
});

test('site-state IPC reconciles server metadata changes before returning readable state', () => {
	const handler = mainSource.slice(
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.getSiteState'),
		mainSource.indexOf('ipcMain.handle(IPC_CHANNELS.testOrigin'),
	);
	assert.ok(handler.indexOf('await reconcileSite(siteId)') >= 0);
	assert.ok(handler.indexOf('return await getSiteState(siteId)') > handler.indexOf('await reconcileSite(siteId)'));
	assert.match(handler, /catch \(error\)[\s\S]{0,240}returning the current persisted state/);
	assert.doesNotMatch(handler, /withSiteLock/);
	assert.match(mainSource, /Boolean\(!settings\.enabled && applied\)/);
	assert.match(mainSource, /profile is disabled, but managed proxy configuration remains and cleanup is required/);
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
	assert.match(toggle, /persistSettings\(siteId, disabledEnvelope\)[\s\S]{0,180}removeAllManagedFiles\(site\)/);
	assert.match(toggle, /rollbackTransaction\([\s\S]{0,160}envelope,[\s\S]{0,100}snapshots/);
	assert.doesNotMatch(toggle, /replaceStoredSettingsForServer/);
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
	assert.match(disableGuard, /previousSettings\.enabled \|\| await allManagedArtifactsExist\(site\)/);
	assert.match(disableGuard, /throw new Error\(runtimeCleanupUnavailableReason\(server\)\)/);
	assert.doesNotMatch(disableGuard, /persistSettings|removeAllManagedFiles|compileAndReload|restartSiteService/);

	const globalCleanup = mainSource.slice(
		mainSource.indexOf('const cleanUpForGlobalChange'),
		mainSource.indexOf('const restoreAfterGlobalEnable'),
	);
	assert.match(globalCleanup, /server\.kind === 'unsupported' \|\| !server\.service/);
	assert.match(globalCleanup, /completeUnresolvedServiceCleanup\(\{/);
	assert.match(globalCleanup, /compileAllConfigs: \(\) => configTemplates\.compileServiceConfigs\(site\)/);
	assert.doesNotMatch(globalCleanup, /siteProcessManager\.restart\(site\)/);
	assert.match(globalCleanup, /Global \$\{uninstalling \? 'uninstall' : 'disable'\} cleanup incomplete/);
	assert.match(globalCleanup, /server = resolveServer\(site\)[\s\S]{0,240}using fail-closed persistent cleanup/);
	assert.match(globalCleanup, /Initial uninstall intent update failed[\s\S]{0,400}removeAllManagedFilesSync\(site\)/);
	assert.match(globalCleanup, /synchronousCleanupRequiresRefresh\([\s\S]{0,180}removeAllManagedFilesSync\(site\)[\s\S]{0,260}force a runtime refresh/);
	assert.match(globalCleanup, /changedSynchronously \|\| enabledBeforeCleanup/);
	assert.match(globalCleanup, /changedSynchronously \|\| changedAfterPendingOperations \|\| enabledBeforeCleanup/);
	assert.match(globalCleanup, /preserving the unknown schema and forcing runtime cleanup/);
	assert.match(globalCleanup, /errors\.push\(`runtime cleanup:[\s\S]{0,400}errors\.push\(`disabled intent:/);
	assert.doesNotMatch(globalCleanup, /using whole-site cleanup[\s\S]{0,80}continue/);
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
