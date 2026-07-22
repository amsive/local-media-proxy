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
	assert.match(mainSource, /persistSettings\(site\.id, previousSettings\)[\s\S]{0,260}await restoreManagedFiles\(snapshots\)/);
	assert.match(mainSource, /apacheSnapshotHasCompleteManagedConfig\(site, snapshots\)/);
});

test('Apache refresh observes Local runtime process name httpd without using its non-settling hard restart', () => {
	const refreshBranch = mainSource.slice(
		mainSource.indexOf("if (server.kind === 'apache')"),
		mainSource.indexOf('await configTemplates.compileServiceConfigs', mainSource.indexOf("if (server.kind === 'apache')")),
	);
	assert.match(refreshBranch, /const processName = 'httpd'/);
	assert.match(refreshBranch, /hasRunningProcess\(site, processName\)/);
	assert.doesNotMatch(refreshBranch, /restartSiteService/);
});

test('global disable and uninstall remove both server artifacts before targeted refresh', () => {
	const cleanup = mainSource.slice(
		mainSource.indexOf('const cleanUpForGlobalChange'),
		mainSource.indexOf('const restoreAfterGlobalEnable'),
	);
	assert.match(cleanup, /removeAllManagedFilesSync\(site\)/);
	assert.match(cleanup, /await removeAllManagedFiles\(site\)/);
	assert.match(cleanup, /if \(uninstalling\)[\s\S]{0,180}enabled: false/);
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
	assert.match(reconcile, /normalizedOrigin = validateAndNormalizeOrigin[\s\S]{0,180}await assertApacheOriginCapability\(server, normalizedOrigin\.protocol\)/);
	assert.match(reconcile, /validationError instanceof ApacheCapabilityUnavailableError \|\|[\s\S]{0,180}shouldRetainWpEngineSettingsAfterVerificationError/);
	assert.match(reconcile, /retainEnabledIntent[\s\S]{0,700}removeAllManagedFiles\(site\)[\s\S]{0,400}compileAndReload\(site, server, false\)/);
	assert.match(reconcile, /cleanupRequiresRefresh\(changed, settings\.enabled\)[\s\S]{0,160}compileAndReload\(site, server, false\)/);
	assert.match(mainSource, /HooksMain\.addAction\('siteStarted'/);
	assert.match(mainSource, /Startup reconciliation failed/);
});

test('unsupported ambiguity and transient service lookup failure defer cleanup without mutations', () => {
	const reconcile = mainSource.slice(
		mainSource.indexOf('const reconcileSite'),
		mainSource.indexOf('const matchesThisAddon'),
	);
	const unavailableStart = reconcile.indexOf("if (server.kind === 'unsupported' || !server.service)");
	const unavailableEnd = reconcile.indexOf('if (!settings.enabled)', unavailableStart);
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
	assert.match(globalCleanup, /Initial uninstall intent update failed[\s\S]{0,300}removeAllManagedFilesSync\(site\)/);
	assert.match(globalCleanup, /synchronousCleanupRequiresRefresh\([\s\S]{0,180}removeAllManagedFilesSync\(site\)[\s\S]{0,260}force a runtime refresh/);
	assert.match(globalCleanup, /changedSynchronously \|\| settingsBeforeCleanup\.enabled/);
	assert.match(globalCleanup, /changedSynchronously \|\| changedAfterPendingOperations \|\| settingsBeforeCleanup\.enabled/);
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
