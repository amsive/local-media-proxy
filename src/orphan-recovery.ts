/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecFileOptions } from 'node:child_process';

const LSOF_BINARY = '/usr/sbin/lsof';
const LSOF_TIMEOUT_MS = 2_000;
const RECOVERY_WAIT_INTERVAL_MS = 100;
const RECOVERY_WAIT_LIMIT_MS = 2_000;

export type ExactLocalResource = { kind: 'tcp-listener'; port: number };

export interface LsofProcessRecord {
	parentPid: number;
	pid: number;
	uid: number;
}

export interface ExactResourceOwner extends LsofProcessRecord {
	executablePath: string | null;
}

export type ResourceOwnershipState =
	| 'active'
	| 'ambiguous'
	| 'occupied'
	| 'recoverable'
	| 'unowned';

export interface ResourceOwnership {
	owners: ExactResourceOwner[];
	state: ResourceOwnershipState;
}

export interface OrphanRecoveryResult {
	pids: number[];
	status: 'active' | 'occupied' | 'recovered' | 'unowned';
}

export type ExecFilePromise = (
	command: string,
	args: string[],
	options?: ExecFileOptions,
) => Promise<string>;

export interface OrphanRecoveryDependencies {
	currentPid?: number;
	currentUid?: number;
	execFilePromise: ExecFilePromise;
	now?: () => number;
	platform?: NodeJS.Platform;
	realpath: (filePath: string) => Promise<string>;
	signalProcess: (pid: number, signal: 'SIGTERM') => void | Promise<void>;
	wait: (milliseconds: number) => Promise<void>;
}

class RecoveryDeadlineError extends Error {}

function createRecoveryDeadline(
	now: () => number,
	message: () => string,
): {
	run: <T>(operation: (remainingMs: number) => Promise<T>) => Promise<T>;
} {
	const deadline = now() + RECOVERY_WAIT_LIMIT_MS;
	const deadlineError = (): RecoveryDeadlineError => new RecoveryDeadlineError(message());
	const remainingMs = (): number => {
		const remaining = Math.ceil(deadline - now());
		if (remaining <= 0) {
			throw deadlineError();
		}
		return Math.min(LSOF_TIMEOUT_MS, remaining);
	};

	return {
		run: async <T>(operation: (remainingMs: number) => Promise<T>): Promise<T> => {
			const remaining = remainingMs();
			let timer: ReturnType<typeof setTimeout>;
			try {
				const result = await Promise.race([
					operation(remaining),
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(deadlineError()), remaining);
					}),
				]);
				if (now() > deadline) {
					throw deadlineError();
				}
				return result;
			} finally {
				clearTimeout(timer!);
			}
		},
	};
}

function parsePositiveInteger(value: string, description: string): number {
	if (!/^[0-9]+$/.test(value)) {
		throw new Error(`Local returned an invalid ${description} while process ownership was inspected.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`Local returned an invalid ${description} while process ownership was inspected.`);
	}
	return parsed;
}

export function parseLsofProcessRecords(output: string): LsofProcessRecord[] {
	if (!output.trim()) {
		return [];
	}

	const records: LsofProcessRecord[] = [];
	let current: Partial<LsofProcessRecord> | null = null;
	const finishRecord = (): void => {
		if (!current) {
			return;
		}
		if (
			current.pid === undefined ||
			current.parentPid === undefined ||
			current.uid === undefined
		) {
			throw new Error('Local returned incomplete process ownership information.');
		}
		records.push(current as LsofProcessRecord);
	};

	for (const line of output.split(/\r?\n/).filter(Boolean)) {
		const field = line[0];
		const value = line.slice(1);
		if (field === 'p') {
			finishRecord();
			current = {
				pid: parsePositiveInteger(value, 'process ID'),
			};
			continue;
		}
		if (
			field === 'f' &&
			current?.pid !== undefined &&
			current.parentPid !== undefined &&
			current.uid !== undefined
		) {
			continue;
		}
		if (!current || (field !== 'R' && field !== 'u')) {
			throw new Error('Local returned ambiguous process ownership information.');
		}
		if (field === 'R') {
			if (current.parentPid !== undefined) {
				throw new Error('Local returned ambiguous process ownership information.');
			}
			current.parentPid = parsePositiveInteger(value, 'parent process ID');
		} else {
			if (current.uid !== undefined) {
				throw new Error('Local returned ambiguous process ownership information.');
			}
			current.uid = parsePositiveInteger(value, 'user ID');
		}
	}
	finishRecord();

	const seen = new Set<number>();
	for (const record of records) {
		if (seen.has(record.pid)) {
			throw new Error('Local returned duplicate process ownership information.');
		}
		seen.add(record.pid);
	}
	return records.sort((left, right) => left.pid - right.pid);
}

export function parseLsofTextExecutable(output: string, expectedPid: number): string | null {
	if (!output.trim()) {
		return null;
	}

	let reportedPid: number | null = null;
	let descriptor: string | null = null;
	let executablePath: string | null = null;
	for (const line of output.split(/\r?\n/).filter(Boolean)) {
		const field = line[0];
		const value = line.slice(1);
		if (field === 'p') {
			if (reportedPid !== null) {
				throw new Error('Local returned ambiguous executable ownership information.');
			}
			reportedPid = parsePositiveInteger(value, 'executable process ID');
			descriptor = null;
			continue;
		}
		if (reportedPid === null) {
			throw new Error('Local returned ambiguous executable ownership information.');
		}
		if (field === 'f') {
			descriptor = value;
			continue;
		}
		if (field !== 'n' || descriptor === null) {
			throw new Error('Local returned ambiguous executable ownership information.');
		}
		if (descriptor === 'txt' && executablePath === null) {
			executablePath = value;
		}
	}

	if (reportedPid !== expectedPid || !executablePath || !executablePath.startsWith('/')) {
		return null;
	}
	return executablePath;
}

export function isExactOrphanOwner(
	owner: ExactResourceOwner,
	allowedExecutablePaths: readonly string[],
	currentUid: number,
	currentPid: number,
): boolean {
	return (
		owner.pid > 1 &&
		owner.pid !== currentPid &&
		owner.parentPid === 1 &&
		owner.uid === currentUid &&
		owner.executablePath !== null &&
		allowedExecutablePaths.includes(owner.executablePath)
	);
}

function isExactOwnerIdentity(
	owner: ExactResourceOwner,
	allowedExecutablePaths: readonly string[],
	currentUid: number,
	currentPid: number,
): boolean {
	return (
		owner.pid > 1 &&
		owner.pid !== currentPid &&
		owner.uid === currentUid &&
		owner.executablePath !== null &&
		allowedExecutablePaths.includes(owner.executablePath)
	);
}

export function isExactOrphanOwnerTree(
	owners: ExactResourceOwner[],
	allowedExecutablePaths: readonly string[],
	currentUid: number,
	currentPid: number,
): boolean {
	if (
		owners.length === 0 ||
		!owners.every((owner) => isExactOwnerIdentity(
			owner,
			allowedExecutablePaths,
			currentUid,
			currentPid,
		))
	) {
		return false;
	}

	const ownersByPid = new Map(owners.map((owner) => [owner.pid, owner]));
	return owners.every((owner) => {
		const visited = new Set<number>();
		let current = owner;
		while (current.parentPid !== 1) {
			if (visited.has(current.pid)) {
				return false;
			}
			visited.add(current.pid);
			const parent = ownersByPid.get(current.parentPid);
			if (!parent) {
				return false;
			}
			current = parent;
		}
		return true;
	});
}

function hasOwnerCycle(owners: ExactResourceOwner[]): boolean {
	const ownersByPid = new Map(owners.map((owner) => [owner.pid, owner]));
	return owners.some((owner) => {
		const visited = new Set<number>();
		let current: ExactResourceOwner | undefined = owner;
		while (current) {
			if (visited.has(current.pid)) {
				return true;
			}
			visited.add(current.pid);
			current = ownersByPid.get(current.parentPid);
		}
		return false;
	});
}

function isExpectedActiveOwner(
	owner: ExactResourceOwner,
	allowedExecutablePaths: readonly string[],
	currentUid: number,
	currentPid: number,
): boolean {
	return (
		owner.pid > 1 &&
		owner.pid !== currentPid &&
		owner.parentPid !== 1 &&
		owner.uid === currentUid &&
		owner.executablePath !== null &&
		allowedExecutablePaths.includes(owner.executablePath)
	);
}

export function classifyResourceOwners(
	owners: ExactResourceOwner[],
	allowedExecutablePaths: readonly string[],
	currentUid: number,
	currentPid: number,
): ResourceOwnership {
	if (owners.length === 0) {
		return { owners, state: 'unowned' };
	}

	const activeCount = owners.filter((owner) => isExpectedActiveOwner(
		owner,
		allowedExecutablePaths,
		currentUid,
		currentPid,
	)).length;

	if (isExactOrphanOwnerTree(
		owners,
		allowedExecutablePaths,
		currentUid,
		currentPid,
	)) {
		return { owners, state: 'recoverable' };
	}
	const hasOrphanRoot = owners.some((owner) => isExactOrphanOwner(
		owner,
		allowedExecutablePaths,
		currentUid,
		currentPid,
	));
	if (hasOrphanRoot || hasOwnerCycle(owners)) {
		return { owners, state: 'ambiguous' };
	}
	if (activeCount === owners.length) {
		return { owners, state: 'active' };
	}
	return { owners, state: 'occupied' };
}

function isLsofNoMatch(error: unknown): boolean {
	const candidate = error as {
		code?: number | string;
		exitCode?: number | string;
		status?: number | string;
	};
	return [candidate.code, candidate.exitCode, candidate.status].some((value) => (
		value === 1 || value === '1'
	));
}

async function runLsof(
	args: string[],
	execFilePromise: ExecFilePromise,
): Promise<string> {
	try {
		return await execFilePromise(LSOF_BINARY, args, {
			timeout: LSOF_TIMEOUT_MS,
		});
	} catch (error) {
		if (error instanceof RecoveryDeadlineError) {
			throw error;
		}
		if (isLsofNoMatch(error)) {
			return '';
		}
		throw new Error('Local process ownership could not be inspected.', { cause: error });
	}
}

function resourceLsofArgs(resource: ExactLocalResource): string[] {
	if (!Number.isInteger(resource.port) || resource.port < 1 || resource.port > 65_535) {
		throw new Error('Local returned an invalid TCP port for process recovery.');
	}
	return [
		'-nP',
		'-a',
		`-iTCP:${resource.port}`,
		'-sTCP:LISTEN',
		'-F',
		'pRu',
	];
}

export async function inspectExactResourceRecords(
	resource: ExactLocalResource,
	execFilePromise: ExecFilePromise,
): Promise<LsofProcessRecord[]> {
	return parseLsofProcessRecords(await runLsof(
		resourceLsofArgs(resource),
		execFilePromise,
	));
}

export async function inspectExactResourceOwners(
	resource: ExactLocalResource,
	dependencies: Pick<OrphanRecoveryDependencies, 'execFilePromise' | 'realpath'>,
): Promise<ExactResourceOwner[]> {
	const processRecords = await inspectExactResourceRecords(
		resource,
		dependencies.execFilePromise,
	);
	return inspectExecutablesForRecords(processRecords, dependencies);
}

async function inspectExecutablesForRecords(
	processRecords: LsofProcessRecord[],
	dependencies: Pick<OrphanRecoveryDependencies, 'execFilePromise' | 'realpath'>,
): Promise<ExactResourceOwner[]> {
	return Promise.all(processRecords.map(async (record): Promise<ExactResourceOwner> => {
		const executable = parseLsofTextExecutable(await runLsof([
			'-nP',
			'-a',
			'-p',
			String(record.pid),
			'-d',
			'txt',
			'-F',
			'pfn',
		], dependencies.execFilePromise), record.pid);
		let executablePath: string | null = null;
		if (executable) {
			try {
				executablePath = await dependencies.realpath(executable);
			} catch {
				executablePath = null;
			}
		}
		return { ...record, executablePath };
	}));
}

function ownerIdentity(owner: LsofProcessRecord): string {
	return [
		owner.pid,
		owner.parentPid,
		owner.uid,
	].join(':');
}

function sameOwnerRecords(left: LsofProcessRecord[], right: LsofProcessRecord[]): boolean {
	return (
		left.length === right.length &&
		left.every((owner, index) => ownerIdentity(owner) === ownerIdentity(right[index]))
	);
}

export async function recoverExactResourceOrphans(
	resource: ExactLocalResource,
	allowedExecutablePaths: readonly string[],
	dependencies: OrphanRecoveryDependencies,
): Promise<OrphanRecoveryResult> {
	if ((dependencies.platform ?? process.platform) !== 'darwin') {
		throw new Error('Automatic Local process recovery is only available on macOS.');
	}
	const currentUid = dependencies.currentUid ?? process.getuid?.();
	if (currentUid === undefined || !Number.isSafeInteger(currentUid) || currentUid < 0) {
		throw new Error('The current user could not be verified for Local process recovery.');
	}
	const currentPid = dependencies.currentPid ?? process.pid;
	let stopRequested = false;
	const deadline = createRecoveryDeadline(
		dependencies.now ?? Date.now,
		() => stopRequested
			? 'The orphaned Local process did not release its resource after a bounded stop request.'
			: 'Local process ownership could not be verified before the bounded recovery deadline.',
	);
	const recoveryDependencies: OrphanRecoveryDependencies = {
		...dependencies,
		execFilePromise: (command, args, options) => deadline.run((remainingMs) => (
			dependencies.execFilePromise(command, args, {
				...options,
				timeout: remainingMs,
			})
		)),
		realpath: (filePath) => deadline.run(() => dependencies.realpath(filePath)),
	};
	const firstRecords = await inspectExactResourceRecords(
		resource,
		recoveryDependencies.execFilePromise,
	);
	if (firstRecords.length === 0) {
		return { pids: [], status: 'unowned' };
	}
	const uniqueAllowedPaths = [...new Set(allowedExecutablePaths)];
	if (uniqueAllowedPaths.length === 0 || uniqueAllowedPaths.length > 4) {
		throw new Error('Local returned an invalid executable list for process recovery.');
	}
	const allowedRealpaths = await Promise.all(uniqueAllowedPaths.map((filePath) => (
		recoveryDependencies.realpath(filePath)
	)));
	const firstOwners = await inspectExecutablesForRecords(firstRecords, recoveryDependencies);
	const first = classifyResourceOwners(
		firstOwners,
		allowedRealpaths,
		currentUid,
		currentPid,
	);
	if (first.state === 'active') {
		return { pids: [], status: 'active' };
	}
	if (first.state === 'occupied') {
		return { pids: [], status: 'occupied' };
	}
	if (first.state === 'ambiguous') {
		throw new Error('An orphaned Local resource has mixed process ownership and was left unchanged.');
	}

	const secondRecords = await inspectExactResourceRecords(
		resource,
		recoveryDependencies.execFilePromise,
	);
	if (!sameOwnerRecords(firstRecords, secondRecords)) {
		throw new Error('Local process ownership changed before recovery and was left unchanged.');
	}

	const pids = secondRecords.map(({ pid }) => pid);
	stopRequested = true;
	for (const pid of pids) {
		try {
			await deadline.run(() => Promise.resolve(dependencies.signalProcess(pid, 'SIGTERM')));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
				throw error;
			}
		}
	}

	while (true) {
		const remainingRecords = await inspectExactResourceRecords(
			resource,
			recoveryDependencies.execFilePromise,
		);
		if (remainingRecords.length === 0) {
			return { pids, status: 'recovered' };
		}
		await deadline.run((remainingMs) => dependencies.wait(
			Math.min(RECOVERY_WAIT_INTERVAL_MS, remainingMs),
		));
	}
}
