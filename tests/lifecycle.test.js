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
	synchronousCleanupRequiresRefresh,
} = require('../lib/lifecycle');

test('enabled reconciliation intent forces cleanup refresh when persistent files are already absent', () => {
	assert.equal(cleanupRequiresRefresh(false, true), true);
	assert.equal(cleanupRequiresRefresh(true, false), true);
	assert.equal(cleanupRequiresRefresh(false, false), false);
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
