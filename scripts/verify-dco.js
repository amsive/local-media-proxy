/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SIGNOFF_PATTERN = /^Signed-off-by:\s+.+?\s+<([^<>\r\n]+)>\s*$/gmi;

function signoffEmails(message) {
	return [...message.matchAll(new RegExp(SIGNOFF_PATTERN.source, SIGNOFF_PATTERN.flags))]
		.map((match) => match[1].trim().toLowerCase());
}

function validateCommitSignoff(commit) {
	const authorEmail = commit.authorEmail.trim().toLowerCase();
	const emails = signoffEmails(commit.message);
	if (emails.includes(authorEmail)) {
		return null;
	}
	if (emails.length === 0) {
		return `${commit.hash} is missing a Signed-off-by trailer for ${commit.authorEmail}.`;
	}
	return `${commit.hash} has Signed-off-by trailer(s), but none match author ${commit.authorEmail}.`;
}

function git(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function defaultBase(root, head) {
	for (const candidate of ['main', 'origin/main']) {
		try {
			return git(root, ['merge-base', head, candidate]);
		} catch {
			// Try the next local baseline.
		}
	}
	throw new Error('Unable to determine the DCO base. Pass explicit base and head commit SHAs.');
}

function commitsInRange(root, base, head) {
	const output = git(root, ['rev-list', '--reverse', `${base}..${head}`]);
	if (!output) {
		return [];
	}
	return output.split('\n').map((hash) => {
		const authorEmail = git(root, ['show', '-s', '--format=%ae', hash]);
		const message = git(root, ['show', '-s', '--format=%B', hash]);
		return { authorEmail, hash, message };
	});
}

function verifyDco(options = {}) {
	const root = path.resolve(options.root ?? REPOSITORY_ROOT);
	const head = options.head ?? 'HEAD';
	const base = options.base ?? defaultBase(root, head);
	const commits = commitsInRange(root, base, head);
	return {
		base,
		commitsChecked: commits.length,
		head,
		problems: commits.map(validateCommitSignoff).filter(Boolean),
	};
}

function runCli(argv = process.argv.slice(2)) {
	try {
		const result = verifyDco({
			base: argv[0] || process.env.DCO_BASE_SHA || undefined,
			head: argv[1] || process.env.DCO_HEAD_SHA || undefined,
		});
		if (result.problems.length > 0) {
			for (const problem of result.problems) {
				console.error(problem);
			}
			console.error(`DCO check failed for ${result.problems.length} of ${result.commitsChecked} commit(s).`);
			return 1;
		}
		console.log(`DCO check passed for ${result.commitsChecked} commit(s).`);
		return 0;
	} catch (error) {
		console.error(`DCO check could not run: ${error.message}`);
		return 1;
	}
}

if (require.main === module) {
	process.exitCode = runCli();
}

module.exports = {
	commitsInRange,
	runCli,
	signoffEmails,
	validateCommitSignoff,
	verifyDco,
};
