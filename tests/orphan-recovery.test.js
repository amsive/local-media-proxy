/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	classifyResourceOwners,
	inspectExactResourceOwners,
	inspectExactResourceRecords,
	isExactOrphanOwner,
	isExactOrphanOwnerTree,
	parseLsofProcessRecords,
	parseLsofTextExecutable,
	recoverExactResourceOrphans,
} = require('../lib/orphan-recovery');

const EXPECTED_BINARY = '/Applications/Local Services/nginx/sbin/nginx';
const SIBLING_BINARY = '/Applications/Local Services/apache/bin/httpd';
const OTHER_BINARY = '/usr/local/bin/other-server';
const CURRENT_UID = 501;
const CURRENT_PID = 9000;

function processOutput(records) {
	return records.map(({ parentPid, pid, uid }) => [
		`p${pid}`,
		`R${parentPid}`,
		`u${uid}`,
	].join('\n')).join('\n');
}

function textOutput(pid, executable = EXPECTED_BINARY) {
	return [
		`p${pid}`,
		'ftxt',
		`n${executable}`,
		'ftxt',
		'n/usr/lib/dyld',
	].join('\n');
}

function makeDependencies(execFilePromise, overrides = {}) {
	return {
		currentPid: CURRENT_PID,
		currentUid: CURRENT_UID,
		execFilePromise,
		platform: 'darwin',
		realpath: async (filePath) => filePath,
		signalProcess: async () => undefined,
		wait: async () => undefined,
		...overrides,
	};
}

test('parses complete lsof process records and sorts them by PID', () => {
	assert.deepEqual(parseLsofProcessRecords([
		'p42',
		'R1',
		'u501',
		'f8',
		'p12',
		'R1',
		'u501',
		'f9',
	].join('\n')), [
		{ parentPid: 1, pid: 12, uid: 501 },
		{ parentPid: 1, pid: 42, uid: 501 },
	]);
	assert.deepEqual(parseLsofProcessRecords(''), []);
});

test('rejects incomplete, duplicate, and unexpected lsof process fields', () => {
	assert.throws(
		() => parseLsofProcessRecords('p42\nR1'),
		/incomplete process ownership/,
	);
	assert.throws(
		() => parseLsofProcessRecords('p42\nR1\nu501\np42\nR1\nu501'),
		/duplicate process ownership/,
	);
	assert.throws(
		() => parseLsofProcessRecords('p42\nR1\nu501\nnfile'),
		/ambiguous process ownership/,
	);
});

test('uses the first txt record as the executable and rejects a different PID', () => {
	assert.equal(parseLsofTextExecutable(textOutput(42), 42), EXPECTED_BINARY);
	assert.equal(parseLsofTextExecutable(textOutput(42), 43), null);
	assert.equal(parseLsofTextExecutable('', 42), null);
});

test('classifies exact current-user process trees rooted at PPID 1 as recoverable', () => {
	const orphan = {
		executablePath: EXPECTED_BINARY,
		parentPid: 1,
		pid: 42,
		uid: CURRENT_UID,
	};
	assert.equal(
		isExactOrphanOwner(orphan, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		true,
	);
	assert.equal(
		isExactOrphanOwner({ ...orphan, parentPid: 41 }, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		false,
	);
	assert.equal(
		isExactOrphanOwner({ ...orphan, executablePath: OTHER_BINARY }, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		false,
	);
	assert.equal(
		classifyResourceOwners([orphan], [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID).state,
		'recoverable',
	);
	assert.equal(
		classifyResourceOwners(
			[{ ...orphan, parentPid: 41 }],
			[EXPECTED_BINARY],
			CURRENT_UID,
			CURRENT_PID,
		).state,
		'active',
	);
	assert.equal(
		classifyResourceOwners(
			[orphan, { ...orphan, executablePath: OTHER_BINARY, pid: 43 }],
			[EXPECTED_BINARY],
			CURRENT_UID,
			CURRENT_PID,
		).state,
		'ambiguous',
	);
	assert.equal(
		classifyResourceOwners(
			[orphan, { ...orphan, parentPid: 42, pid: 43, uid: CURRENT_UID + 1 }],
			[EXPECTED_BINARY],
			CURRENT_UID,
			CURRENT_PID,
		).state,
		'ambiguous',
	);
	assert.equal(
		classifyResourceOwners(
			[orphan, { ...orphan, parentPid: 42, pid: 43 }],
			[EXPECTED_BINARY],
			CURRENT_UID,
			CURRENT_PID,
		).state,
		'recoverable',
	);
	const nestedTree = [
		orphan,
		{ ...orphan, parentPid: 42, pid: 43 },
		{ ...orphan, parentPid: 43, pid: 44 },
	];
	assert.equal(
		isExactOrphanOwnerTree(nestedTree, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		true,
	);
	assert.equal(
		classifyResourceOwners(nestedTree, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID).state,
		'recoverable',
	);
	const missingRoot = [{ ...orphan, parentPid: 41, pid: 42 }];
	assert.equal(
		isExactOrphanOwnerTree(missingRoot, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		false,
	);
	const cycle = [
		{ ...orphan, parentPid: 43, pid: 42 },
		{ ...orphan, parentPid: 42, pid: 43 },
	];
	assert.equal(
		isExactOrphanOwnerTree(cycle, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID),
		false,
	);
	assert.equal(
		classifyResourceOwners(cycle, [EXPECTED_BINARY], CURRENT_UID, CURRENT_PID).state,
		'ambiguous',
	);
});

test('inspects one exact TCP listener and fetches each owner executable separately', async () => {
	const calls = [];
	const resource = { kind: 'tcp-listener', port: 10409 };
	const execFilePromise = async (command, args) => {
		calls.push({ args, command });
		return args.includes('-d')
			? textOutput(42)
			: processOutput([{ parentPid: 1, pid: 42, uid: CURRENT_UID }]);
	};
	assert.deepEqual(await inspectExactResourceRecords(resource, execFilePromise), [{
		parentPid: 1,
		pid: 42,
		uid: CURRENT_UID,
	}]);
	const owners = await inspectExactResourceOwners(
		resource,
		makeDependencies(execFilePromise),
	);

	assert.deepEqual(owners, [{
		executablePath: EXPECTED_BINARY,
		parentPid: 1,
		pid: 42,
		uid: CURRENT_UID,
	}]);
	assert.deepEqual(calls[0], {
		args: [
			'-nP',
			'-a',
			'-iTCP:10409',
			'-sTCP:LISTEN',
			'-F',
			'pRu',
		],
		command: '/usr/sbin/lsof',
	});
	assert.deepEqual(calls[2], {
		args: ['-nP', '-a', '-p', '42', '-d', 'txt', '-F', 'pfn'],
		command: '/usr/sbin/lsof',
	});
});

test('inspects independent owner executables in parallel while preserving PID order', async () => {
	const started = [];
	const resolvers = new Map();
	const inspection = inspectExactResourceOwners(
		{ kind: 'tcp-listener', port: 10409 },
		makeDependencies(async (_command, args) => {
			if (!args.includes('-d')) {
				return processOutput([
					{ parentPid: 1, pid: 43, uid: CURRENT_UID },
					{ parentPid: 1, pid: 42, uid: CURRENT_UID },
				]);
			}
			const pid = Number(args[args.indexOf('-p') + 1]);
			started.push(pid);
			return new Promise((resolve) => {
				resolvers.set(pid, resolve);
			});
		}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, [42, 43]);
	resolvers.get(43)(textOutput(43));
	resolvers.get(42)(textOutput(42));
	assert.deepEqual((await inspection).map(({ pid }) => pid), [42, 43]);
});

test('treats lsof exit 1 as an unowned resource without signaling', async () => {
	let signalCount = 0;
	let realpathCount = 0;
	const result = await recoverExactResourceOrphans(
		{ kind: 'tcp-listener', port: 10409 },
		[EXPECTED_BINARY],
		makeDependencies(async () => {
			throw Object.assign(new Error('no matches'), { code: 1 });
		}, {
			realpath: async (filePath) => {
				realpathCount += 1;
				return filePath;
			},
			signalProcess: async () => {
				signalCount += 1;
			},
		}),
	);

	assert.deepEqual(result, { pids: [], status: 'unowned' });
	assert.equal(realpathCount, 0);
	assert.equal(signalCount, 0);
});

test('leaves healthy expected owners and unrelated-only owners unchanged', async () => {
	for (const fixture of [
		{ executable: EXPECTED_BINARY, parentPid: 41, status: 'active' },
		{ executable: OTHER_BINARY, parentPid: 1, status: 'occupied' },
	]) {
		let signalCount = 0;
		const result = await recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args) => (
				args.includes('-d')
					? textOutput(42, fixture.executable)
					: processOutput([{ parentPid: fixture.parentPid, pid: 42, uid: CURRENT_UID }])
			), {
				signalProcess: async () => {
					signalCount += 1;
				},
			}),
		);
		assert.deepEqual(result, { pids: [], status: fixture.status });
		assert.equal(signalCount, 0);
	}
});

test('recovers exact sibling-server orphans with one executable inspection and SIGTERM only', async () => {
	const records = [
		{ parentPid: 1, pid: 42, uid: CURRENT_UID },
		{ parentPid: 42, pid: 43, uid: CURRENT_UID },
	];
	const resourceResults = [processOutput(records), processOutput(records), ''];
	const calls = [];
	const signals = [];
	let realpathCalls = 0;
	const result = await recoverExactResourceOrphans(
		{ kind: 'tcp-listener', port: 10409 },
		[EXPECTED_BINARY, SIBLING_BINARY],
		makeDependencies(async (command, args) => {
			calls.push({ args, command });
			if (args.includes('-d')) {
				const pid = Number(args[args.indexOf('-p') + 1]);
				return textOutput(pid, pid === 42 ? EXPECTED_BINARY : SIBLING_BINARY);
			}
			return resourceResults.shift();
		}, {
			realpath: async (filePath) => {
				realpathCalls += 1;
				return filePath;
			},
			signalProcess: async (pid, signal) => {
				signals.push({ pid, signal });
				if (pid === 42) {
					throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
				}
			},
		}),
	);

	assert.deepEqual(result, { pids: [42, 43], status: 'recovered' });
	assert.deepEqual(signals, [
		{ pid: 42, signal: 'SIGTERM' },
		{ pid: 43, signal: 'SIGTERM' },
	]);
	assert.equal(realpathCalls, 4);
	assert.equal(calls.filter(({ args }) => args.includes('-d')).length, 2);
	assert.equal(calls.filter(({ args }) => !args.includes('-d')).length, 3);
	assert.ok(calls.every(({ command }) => command === '/usr/sbin/lsof'));
	const resourceCall = calls.find(({ args }) => !args.includes('-d'));
	assert.deepEqual(resourceCall.args, [
		'-nP',
		'-a',
		'-iTCP:10409',
		'-sTCP:LISTEN',
		'-F',
		'pRu',
	]);
});

test('refuses a mixed orphan and exact active owner before signaling', async () => {
	const records = [
		{ parentPid: 1, pid: 42, uid: CURRENT_UID },
		{ parentPid: 99, pid: 43, uid: CURRENT_UID },
	];
	let signalCount = 0;
	await assert.rejects(
		recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args) => {
				if (args.includes('-d')) {
					const pid = Number(args[args.indexOf('-p') + 1]);
					return textOutput(pid);
				}
				return processOutput(records);
			}, {
				signalProcess: async () => {
					signalCount += 1;
				},
			}),
		),
		/mixed process ownership/,
	);
	assert.equal(signalCount, 0);
});

test('refuses when owner identities change between the two inspections', async () => {
	const resourceResults = [
		processOutput([{ parentPid: 1, pid: 42, uid: CURRENT_UID }]),
		processOutput([{ parentPid: 1, pid: 43, uid: CURRENT_UID }]),
	];
	let signalCount = 0;
	await assert.rejects(
		recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args) => (
				args.includes('-d')
					? textOutput(Number(args[args.indexOf('-p') + 1]))
					: resourceResults.shift()
			), {
				signalProcess: async () => {
					signalCount += 1;
				},
			}),
		),
		/ownership changed before recovery/,
	);
	assert.equal(signalCount, 0);
});

test('waits no more than two seconds and never force-kills a lingering owner', async () => {
	const record = [{ parentPid: 1, pid: 42, uid: CURRENT_UID }];
	let currentTime = 0;
	let waited = 0;
	let executableInspections = 0;
	const signals = [];
	await assert.rejects(
		recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args) => {
				if (args.includes('-d')) {
					executableInspections += 1;
					return textOutput(42);
				}
				return processOutput(record);
			}, {
				now: () => currentTime,
				signalProcess: async (pid, signal) => {
					signals.push({ pid, signal });
				},
				wait: async (milliseconds) => {
					currentTime += milliseconds;
					waited += milliseconds;
				},
			}),
		),
		/did not release its resource/,
	);
	assert.equal(waited, 2_000);
	assert.equal(executableInspections, 1);
	assert.deepEqual(signals, [{ pid: 42, signal: 'SIGTERM' }]);
});

test('shares one wall-clock deadline across slow ownership and executable probes', async () => {
	const record = [{ parentPid: 1, pid: 42, uid: CURRENT_UID }];
	let currentTime = 0;
	let signalCount = 0;
	const timeouts = [];

	await assert.rejects(
		recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args, options) => {
				timeouts.push(options.timeout);
				currentTime += 700;
				return args.includes('-d')
					? textOutput(42)
					: processOutput(record);
			}, {
				now: () => currentTime,
				signalProcess: async () => {
					signalCount += 1;
				},
			}),
		),
		/bounded recovery deadline/,
	);

	assert.deepEqual(timeouts, [2_000, 1_300, 600]);
	assert.equal(signalCount, 0);
});

test('propagates signal failures other than ESRCH', async () => {
	const record = processOutput([{ parentPid: 1, pid: 42, uid: CURRENT_UID }]);
	await assert.rejects(
		recoverExactResourceOrphans(
			{ kind: 'tcp-listener', port: 10409 },
			[EXPECTED_BINARY],
			makeDependencies(async (_command, args) => (
				args.includes('-d') ? textOutput(42) : record
			), {
				signalProcess: async () => {
					throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
				},
			}),
		),
		/not permitted/,
	);
});
