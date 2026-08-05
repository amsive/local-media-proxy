/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	cleanupRequiresRefresh,
	completeUnresolvedServiceCleanup,
	isServerTransactionChangedError,
	lifecycleUnavailableReason,
	processOwnersBelongToCapturedTree,
	runServerTransactionMutation,
	ServerTransactionChangedError,
	serverTransactionFingerprintsMatch,
	shouldCancelDeferredReconciliation,
	shouldReconcileManagedFiles,
	shouldRefreshRuntime,
	siteLifecycleAccess,
	synchronousCleanupRequiresRefresh,
} = require('../lib/lifecycle');

function serverTransaction(overrides = {}) {
	return {
		configPath: '/example/site/conf/nginx',
		executablePath: '/example/services/nginx',
		runPath: '/example/site/run/nginx',
		serverKind: 'nginx',
		serviceName: 'nginx-1.26.1',
		siteConfigTemplatePath: '/example/site/conf/nginx/site.conf.hbs',
		sitePath: '/example/site',
		siteStatus: 'running',
		templatesPath: '/example/site/conf',
		...overrides,
	};
}

test('captured process trees accept the master and descendants but reject unrelated owners', () => {
	const master = { parentPid: 4000, pid: 5000 };
	const worker = { parentPid: master.pid, pid: 5001 };
	const nestedWorker = { parentPid: worker.pid, pid: 5002 };

	assert.equal(
		processOwnersBelongToCapturedTree([master, worker, nestedWorker], master.pid),
		true,
	);
	assert.equal(
		processOwnersBelongToCapturedTree([worker], master.pid),
		true,
		'a direct worker remains provable when the captured master does not own the listener',
	);
	assert.equal(
		processOwnersBelongToCapturedTree([
			master,
			worker,
			{ parentPid: 7000, pid: 7001 },
		], master.pid),
		false,
		'an unrelated same-binary owner must not be accepted as part of the captured router',
	);
});

test('server transactions close when server identity, paths, or lifecycle status changes', () => {
	const original = serverTransaction();
	assert.equal(serverTransactionFingerprintsMatch(original, serverTransaction()), true);

	for (const [field, value] of [
		['configPath', '/example/site/conf/apache'],
		['executablePath', '/example/services/httpd'],
		['runPath', '/example/site/run/apache'],
		['serverKind', 'apache'],
		['serviceName', 'apache-2.4.63+1'],
		['siteConfigTemplatePath', '/example/site/conf/apache/site.conf.hbs'],
		['sitePath', '/example/other-site'],
		['siteStatus', 'restarting'],
		['templatesPath', '/example/site/alternate-conf'],
	]) {
		assert.equal(
			serverTransactionFingerprintsMatch(original, serverTransaction({ [field]: value })),
			false,
			`${field} changes must invalidate the transaction`,
		);
	}
});

test('server transaction failures give actionable rollback guidance', () => {
	const error = new ServerTransactionChangedError();
	assert.equal(error.name, 'LocalMediaProxyServerTransactionChangedError');
	assert.match(error.message, /stopped further work/i);
	assert.match(error.message, /wait for Local.*review the current state.*retry/i);
});

test('server transaction failures remain identifiable across duplicate module copies', () => {
	const equivalentError = new Error('transaction changed');
	equivalentError.name = 'LocalMediaProxyServerTransactionChangedError';

	assert.equal(isServerTransactionChangedError(new ServerTransactionChangedError()), true);
	assert.equal(isServerTransactionChangedError(equivalentError), true);
	assert.equal(isServerTransactionChangedError({
		name: 'LocalMediaProxyServerTransactionChangedError',
	}), false);
	assert.equal(isServerTransactionChangedError(new Error('ordinary failure')), false);
	assert.equal(isServerTransactionChangedError(null), false);
});

test('guarded interactive mutations reject server transitions before writes and after deferred writes', async () => {
	const original = serverTransaction();
	let current = serverTransaction({ serverKind: 'apache', serviceName: 'apache-2.4.63+1' });
	let applied = false;
	const assertCurrent = () => {
		if (!serverTransactionFingerprintsMatch(original, current)) {
			throw new ServerTransactionChangedError();
		}
	};

	await assert.rejects(
		runServerTransactionMutation(assertCurrent, async () => {
			applied = true;
		}),
		ServerTransactionChangedError,
	);
	assert.equal(applied, false, 'a Nginx-to-Apache transition before mutation must prevent the write');

	current = serverTransaction();
	await assert.rejects(
		runServerTransactionMutation(assertCurrent, async () => {
			applied = true;
			current = serverTransaction({
				executablePath: '/example/services/httpd',
				serverKind: 'apache',
				serviceName: 'apache-2.4.63+1',
			});
		}),
		ServerTransactionChangedError,
	);
	assert.equal(applied, true, 'the post-mutation guard must detect a transition during the write');
});

test('guarded reconciliation stops between managed-file mutation and refresh on status or Apache-to-Nginx changes', async () => {
	const apacheTransaction = serverTransaction({
		configPath: '/example/site/conf/apache',
		executablePath: '/example/services/httpd',
		runPath: '/example/site/run/apache',
		serverKind: 'apache',
		serviceName: 'apache-2.4.63+1',
		siteConfigTemplatePath: '/example/site/conf/apache/site.conf.hbs',
	});
	for (const currentAfterMutation of [
		{ ...apacheTransaction, siteStatus: 'restarting' },
		serverTransaction({
			configPath: '/example/site/conf/nginx',
			executablePath: '/example/services/nginx',
			runPath: '/example/site/run/nginx',
			serverKind: 'nginx',
			serviceName: 'nginx-1.26.1',
			siteConfigTemplatePath: '/example/site/conf/nginx/site.conf.hbs',
		}),
	]) {
		const expected = apacheTransaction;
		let current = expected;
		let refreshed = false;
		const assertCurrent = () => {
			if (!serverTransactionFingerprintsMatch(expected, current)) {
				throw new ServerTransactionChangedError();
			}
		};

		await assert.rejects(async () => {
			await runServerTransactionMutation(assertCurrent, async () => {
				current = currentAfterMutation;
			});
			refreshed = true;
		}, ServerTransactionChangedError);
		assert.equal(refreshed, false, 'the stale service must not refresh after a transaction-closing change');
	}
});

test('enabled reconciliation intent forces cleanup refresh when persistent files are already absent', () => {
	assert.equal(cleanupRequiresRefresh(false, true), true);
	assert.equal(cleanupRequiresRefresh(true, false), true);
	assert.equal(cleanupRequiresRefresh(false, false), false);
});

test('Apache runtime refresh requires both a running site and its targeted service', () => {
	assert.equal(shouldRefreshRuntime('running', false), false);
	assert.equal(shouldRefreshRuntime('running', true), true);
	assert.equal(shouldRefreshRuntime('provisioning', true), false);
	assert.equal(shouldRefreshRuntime('starting', true), false);
	assert.equal(shouldRefreshRuntime('restarting', true), false);
	assert.equal(shouldRefreshRuntime('provisioning', false), false);
	assert.equal(shouldRefreshRuntime('halted', true), false);
	assert.equal(shouldRefreshRuntime('stopping', true), false);
	assert.equal(shouldRefreshRuntime('deleting', true), false);
	assert.equal(shouldRefreshRuntime('deleting_backup', true), false);
});

test('managed-file access defaults closed across every current Local lifecycle status', () => {
	const currentStatuses = [
		'adding',
		'backing_up',
		'cloning',
		'container_missing',
		'copying',
		'creating',
		'deleting',
		'deleting_backup',
		'downloading_backup',
		'exporting',
		'exporting_db',
		'halted',
		'importing_backup',
		'processing',
		'provisioning',
		'provisioning_error',
		'pulling',
		'pulling_finalizing',
		'pulling_provisioning',
		'pulling_request_backup',
		'pushing',
		'pushing_creating',
		'pushing_preparing',
		'pushing_processing',
		'pushing_v2',
		'restarting',
		'restoring_backup',
		'running',
		'saving',
		'stalled',
		'starting',
		'stopping',
		'updating_wp',
		'wordpress_install_error',
	];
	for (const status of currentStatuses) {
		assert.equal(
			shouldReconcileManagedFiles(status),
			status === 'running' || status === 'halted',
			`${status} must have an explicit managed-file access decision`,
		);
	}
	assert.equal(shouldReconcileManagedFiles('future_local_status'), false);
	assert.equal(siteLifecycleAccess('running'), 'ready');
	assert.equal(siteLifecycleAccess('halted'), 'ready');
	assert.equal(siteLifecycleAccess('deleting'), 'destroying');
	assert.equal(siteLifecycleAccess('provisioning_error'), 'failed');
	assert.equal(siteLifecycleAccess('future_local_status'), 'transitioning');
	assert.equal(shouldCancelDeferredReconciliation('deleting'), true);
	assert.equal(shouldCancelDeferredReconciliation('stalled'), true);
	assert.equal(shouldCancelDeferredReconciliation('pulling'), false);
	assert.equal(shouldCancelDeferredReconciliation('future_local_status'), false);
	assert.match(lifecycleUnavailableReason('pulling_finalizing'), /still pulling/i);
	assert.match(lifecycleUnavailableReason('creating'), /still creating/i);
	assert.match(lifecycleUnavailableReason('deleting'), /will not access its files/i);
});

test('an ordinary reconciliation guard closes when Local enters a transition after entry', () => {
	let currentStatus = 'running';
	const canMutate = () => shouldReconcileManagedFiles(currentStatus);

	assert.equal(canMutate(), true);
	currentStatus = 'provisioning';
	assert.equal(canMutate(), false);
	currentStatus = 'restarting';
	assert.equal(canMutate(), false);
});

function cleanupFixture({ running = true } = {}) {
	const calls = [];
	let artifacts = true;
	let siteRunning = running;
	return {
		calls,
		setArtifacts: (value) => { artifacts = value; },
		setRunning: (value) => { siteRunning = value; },
		operations: {
			compileAllConfigs: async () => { calls.push('compile-all'); },
			hasManagedArtifacts: async () => artifacts,
			isSiteRunning: () => siteRunning,
			removeAllManagedFiles: async () => {
				calls.push('remove-all');
				artifacts = false;
				return true;
			},
		},
	};
}

test('unresolved-service cleanup removes and compiles persistent files without hard-restarting a running site', async () => {
	const fixture = cleanupFixture();
	await assert.rejects(
		completeUnresolvedServiceCleanup(fixture.operations, true),
		/running site could not be refreshed safely[\s\S]*Stop the site in Local/,
	);
	assert.deepEqual(fixture.calls, ['remove-all', 'compile-all']);
});

test('unresolved-service cleanup completes for a stopped site without a runtime restart', async () => {
	const fixture = cleanupFixture({ running: false });
	assert.deepEqual(await completeUnresolvedServiceCleanup(fixture.operations, true), {
		changed: true,
	});
	assert.deepEqual(fixture.calls, ['remove-all', 'compile-all']);
});

test('unresolved-service cleanup fails closed when a stopped site starts during cleanup', async () => {
	const fixture = cleanupFixture({ running: false });
	fixture.operations.compileAllConfigs = async () => {
		fixture.calls.push('compile-all');
		fixture.setRunning(true);
	};
	await assert.rejects(
		completeUnresolvedServiceCleanup(fixture.operations, true),
		/running site could not be refreshed safely/,
	);
	assert.deepEqual(fixture.calls, ['remove-all', 'compile-all']);
});

test('unresolved-service cleanup propagates compile failure instead of reporting success', async () => {
	const compileFailure = cleanupFixture();
	compileFailure.operations.compileAllConfigs = async () => {
		compileFailure.calls.push('compile-all');
		throw new Error('compile failed');
	};
	await assert.rejects(completeUnresolvedServiceCleanup(compileFailure.operations, true), /compile failed/);
	assert.deepEqual(compileFailure.calls, ['remove-all', 'compile-all']);
});

test('unresolved-service cleanup skips an unnecessary refresh and rejects artifacts that reappear', async () => {
	const unchanged = cleanupFixture({ running: false });
	unchanged.operations.removeAllManagedFiles = async () => {
		unchanged.calls.push('remove-all');
		unchanged.setArtifacts(false);
		return false;
	};
	assert.deepEqual(await completeUnresolvedServiceCleanup(unchanged.operations, false), {
		changed: false,
	});
	assert.deepEqual(unchanged.calls, ['remove-all']);

	const unverifiableRunning = cleanupFixture({ running: true });
	unverifiableRunning.operations.removeAllManagedFiles = async () => {
		unverifiableRunning.calls.push('remove-all');
		unverifiableRunning.setArtifacts(false);
		return false;
	};
	await assert.rejects(
		completeUnresolvedServiceCleanup(unverifiableRunning.operations, false),
		/running site could not be refreshed safely/,
	);
	assert.deepEqual(unverifiableRunning.calls, ['remove-all']);

	const reappearing = cleanupFixture({ running: false });
	reappearing.operations.compileAllConfigs = async () => {
		reappearing.calls.push('compile-all');
		reappearing.setArtifacts(true);
	};
	await assert.rejects(
		completeUnresolvedServiceCleanup(reappearing.operations, true),
		/reappeared while compiling/,
	);
	assert.deepEqual(reappearing.calls, ['remove-all', 'compile-all']);
});

test('partial synchronous cleanup failure forces refresh when disabled async retry reports no changes', async () => {
	const synchronousErrors = [];
	const forceRefresh = synchronousCleanupRequiresRefresh(
		() => { throw new Error('partial synchronous removal'); },
		(error) => synchronousErrors.push(error),
	);
	assert.equal(forceRefresh, true);
	assert.equal(synchronousErrors.length, 1);

	const fixture = cleanupFixture({ running: true });
	fixture.operations.removeAllManagedFiles = async () => {
		fixture.calls.push('remove-all');
		fixture.setArtifacts(false);
		return false;
	};
	await assert.rejects(
		completeUnresolvedServiceCleanup(fixture.operations, forceRefresh),
		/running site could not be refreshed safely/,
	);
	assert.deepEqual(fixture.calls, ['remove-all', 'compile-all']);
});
