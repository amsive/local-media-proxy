/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
	emailsInText,
	isAllowedEmail,
	loadPolicy,
} = require('./verify-public-release');

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
		return `${commit.hash} is missing a Signed-off-by trailer matching its author identity.`;
	}
	return `${commit.hash} has Signed-off-by trailer(s), but none match author identity.`;
}

function validateCommitIdentity(commit, policy) {
	const problems = [];
	if (!isAllowedEmail(commit.authorEmail, policy)) {
		problems.push(`${commit.hash} uses an author address that is not an approved GitHub noreply or role address.`);
	}
	if (!isAllowedEmail(commit.committerEmail, policy)) {
		problems.push(`${commit.hash} uses a committer address that is not an approved GitHub noreply or role address.`);
	}
	if (emailsInText(commit.message).some((email) => !isAllowedEmail(email, policy))) {
		problems.push(`${commit.hash} contains an individual address in its commit message or trailers.`);
	}
	return problems;
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
	return commitsFromOutput(root, output);
}

function allReachableCommits(root) {
	const refs = git(root, [
		'for-each-ref',
		'--format=%(refname)',
		'refs/heads',
		'refs/remotes/origin',
		'refs/tags',
	]).split('\n').filter(Boolean);
	if (refs.length === 0) {
		return [];
	}
	return commitsFromOutput(root, git(root, ['rev-list', '--reverse', ...refs]));
}

function commitsFromOutput(root, output) {
	if (!output) {
		return [];
	}
	return output.split('\n').map((hash) => {
		const authorEmail = git(root, ['show', '-s', '--format=%ae', hash]);
		const committerEmail = git(root, ['show', '-s', '--format=%ce', hash]);
		const message = git(root, ['show', '-s', '--format=%B', hash]);
		return { authorEmail, committerEmail, hash, message };
	});
}

function annotatedTags(root) {
	const refs = git(root, ['for-each-ref', '--format=%(refname)', 'refs/tags']);
	if (!refs) {
		return [];
	}
	return refs.split('\n').flatMap((ref) => {
		if (git(root, ['cat-file', '-t', ref]) !== 'tag') {
			return [];
		}
		const object = git(root, ['cat-file', '-p', ref]);
		const separator = object.indexOf('\n\n');
		const headers = separator === -1 ? object : object.slice(0, separator);
		const message = separator === -1 ? '' : object.slice(separator + 2);
		const tagger = headers.split('\n').find((line) => line.startsWith('tagger ')) ?? '';
		const emailMatch = /<([^<>\r\n]+)>/.exec(tagger);
		return [{
			email: emailMatch?.[1] ?? '',
			message,
			ref,
		}];
	});
}

function validateTagIdentity(tag, policy) {
	const problems = [];
	if (!tag.email || !isAllowedEmail(tag.email, policy)) {
		problems.push(`${tag.ref} uses a tagger address that is not an approved GitHub noreply or role address.`);
	}
	if (emailsInText(tag.message).some((email) => !isAllowedEmail(email, policy))) {
		problems.push(`${tag.ref} contains an individual address in its annotated tag message.`);
	}
	return problems;
}

function verifyDco(options = {}) {
	const root = path.resolve(options.root ?? REPOSITORY_ROOT);
	const head = options.head ?? 'HEAD';
	const base = options.base ?? defaultBase(root, head);
	const policy = options.policy ?? loadPolicy(options.policyPath);
	const commits = commitsInRange(root, base, head);
	return {
		base,
		commitsChecked: commits.length,
		head,
		problems: commits.flatMap((commit) => [
			...validateCommitIdentity(commit, policy),
			validateCommitSignoff(commit),
		].filter(Boolean)),
	};
}

function verifyAllGitIdentities(options = {}) {
	const root = path.resolve(options.root ?? REPOSITORY_ROOT);
	const policy = options.policy ?? loadPolicy(options.policyPath);
	const commits = allReachableCommits(root);
	const tags = annotatedTags(root);
	return {
		commitsChecked: commits.length,
		problems: [
			...commits.flatMap((commit) => [
				...validateCommitIdentity(commit, policy),
				validateCommitSignoff(commit),
			].filter(Boolean)),
			...tags.flatMap((tag) => validateTagIdentity(tag, policy)),
		],
		tagsChecked: tags.length,
	};
}

function runCli(argv = process.argv.slice(2)) {
	try {
		if (argv[0] === '--all-reachable') {
			const result = verifyAllGitIdentities();
			if (result.problems.length > 0) {
				for (const problem of result.problems) {
					console.error(problem);
				}
				console.error(
					`Git identity check failed with ${result.problems.length} problem(s) across `
					+ `${result.commitsChecked} commit(s) and ${result.tagsChecked} annotated tag(s).`,
				);
				return 1;
			}
			console.log(
				`Git identity check passed for ${result.commitsChecked} commit(s) `
				+ `and ${result.tagsChecked} annotated tag(s).`,
			);
			return 0;
		}
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
	allReachableCommits,
	annotatedTags,
	commitsInRange,
	runCli,
	signoffEmails,
	validateCommitIdentity,
	validateCommitSignoff,
	validateTagIdentity,
	verifyDco,
	verifyAllGitIdentities,
};
