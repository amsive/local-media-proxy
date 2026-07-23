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
const DEPENDABOT_AUTHOR_EMAIL = '49699333+dependabot[bot]@users.noreply.github.com';
const GITHUB_COMMITTER_EMAIL = 'noreply@github.com';
const GITHUB_SUPPORT_EMAIL = 'support@github.com';

function identityTrailers(message, label) {
	const pattern = new RegExp(
		`^${label}:\\s+(.+?)\\s+<([^<>\\r\\n]+)>\\s*$`,
		'gmi',
	);
	return [...message.matchAll(pattern)].map((match) => ({
		email: match[2].trim().toLowerCase(),
		name: match[1].trim(),
	}));
}

function signoffEmails(message) {
	return identityTrailers(message, 'Signed-off-by').map(({ email }) => email);
}

function identityKey({ email, name }) {
	return `${name}\0${email}`;
}

function isGitHubDependabotCommit(commit) {
	const hasPlatformIdentity = commit.authorName === 'dependabot[bot]'
		&& commit.authorEmail.trim().toLowerCase() === DEPENDABOT_AUTHOR_EMAIL
		&& commit.committerName === 'GitHub'
		&& commit.committerEmail.trim().toLowerCase() === GITHUB_COMMITTER_EMAIL;
	if (!hasPlatformIdentity) {
		return false;
	}

	const signoffs = identityTrailers(commit.message, 'Signed-off-by');
	const coauthors = identityTrailers(commit.message, 'Co-authored-by');
	const hasDependabotRoleSignoff = signoffs.some(({ email, name }) =>
		name === 'dependabot[bot]' && email === GITHUB_SUPPORT_EMAIL);
	if (!hasDependabotRoleSignoff) {
		return false;
	}

	const coauthorKeys = new Set(coauthors.map(identityKey));
	const signoffKeys = new Set(signoffs.map(identityKey));
	const signoffsAreExpected = signoffs.every((signoff) =>
		(signoff.name === 'dependabot[bot]' && signoff.email === GITHUB_SUPPORT_EMAIL)
		|| coauthorKeys.has(identityKey(signoff)));
	const coauthorsAreSigned = coauthors.every((coauthor) =>
		(
			coauthor.name === 'dependabot[bot]'
			&& coauthor.email === DEPENDABOT_AUTHOR_EMAIL
		)
		|| signoffKeys.has(identityKey(coauthor)));
	return signoffsAreExpected && coauthorsAreSigned;
}

function validateCommitSignoff(commit) {
	const authorEmail = commit.authorEmail.trim().toLowerCase();
	const emails = signoffEmails(commit.message);
	if (emails.includes(authorEmail)) {
		return null;
	}
	if (isGitHubDependabotCommit(commit)) {
		return null;
	}
	if (emails.length === 0) {
		return `${commit.hash} is missing a Signed-off-by trailer matching its author identity.`;
	}
	return `${commit.hash} has Signed-off-by trailer(s), but none match author identity.`;
}

function validateCommitIdentity(commit, policy) {
	const problems = [];
	const parsedTrailerEmails = [
		...identityTrailers(commit.message, 'Signed-off-by'),
		...identityTrailers(commit.message, 'Co-authored-by'),
	].map(({ email }) => email);
	if (!isAllowedEmail(commit.authorEmail, policy)) {
		problems.push(`${commit.hash} uses an author address that is not an approved GitHub noreply or role address.`);
	}
	if (!isAllowedEmail(commit.committerEmail, policy)) {
		problems.push(`${commit.hash} uses a committer address that is not an approved GitHub noreply or role address.`);
	}
	if (
		[...emailsInText(commit.message), ...parsedTrailerEmails]
			.some((email) => !isAllowedEmail(email, policy))
	) {
		problems.push(`${commit.hash} contains an individual address in its commit message or trailers.`);
	}
	return problems;
}

function git(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function gitBuffer(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'buffer',
		maxBuffer: 16 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
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
		const authorName = git(root, ['show', '-s', '--format=%an', hash]);
		const authorEmail = git(root, ['show', '-s', '--format=%ae', hash]);
		const committerName = git(root, ['show', '-s', '--format=%cn', hash]);
		const committerEmail = git(root, ['show', '-s', '--format=%ce', hash]);
		const message = git(root, ['show', '-s', '--format=%B', hash]);
		return {
			authorEmail,
			authorName,
			committerEmail,
			committerName,
			hash,
			message,
		};
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

function historicalTrackedTextProblems(root, commits, policy) {
	const problems = [];
	const seenBlobs = new Set();
	for (const commit of commits) {
		const records = gitBuffer(root, ['ls-tree', '-r', '-z', commit.hash])
			.toString('utf8')
			.split('\0')
			.filter(Boolean);
		for (const record of records) {
			const separator = record.indexOf('\t');
			const metadata = separator === -1 ? record : record.slice(0, separator);
			const relativePath = separator === -1 ? '' : record.slice(separator + 1);
			const [, type, objectId] = metadata.split(' ');
			if (type !== 'blob' || !objectId || seenBlobs.has(objectId)) {
				continue;
			}
			seenBlobs.add(objectId);
			const buffer = gitBuffer(root, ['cat-file', '-p', objectId]);
			if (buffer.includes(0)) {
				continue;
			}
			if (emailsInText(buffer.toString('utf8')).some((email) => !isAllowedEmail(email, policy))) {
				problems.push(
					`${commit.hash} tracks text containing an individual address at ${relativePath}.`,
				);
			}
		}
	}
	return {
		blobsChecked: seenBlobs.size,
		problems,
	};
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
	const trackedText = historicalTrackedTextProblems(root, commits, policy);
	return {
		blobsChecked: trackedText.blobsChecked,
		commitsChecked: commits.length,
		problems: [
			...commits.flatMap((commit) => [
				...validateCommitIdentity(commit, policy),
				validateCommitSignoff(commit),
			].filter(Boolean)),
			...tags.flatMap((tag) => validateTagIdentity(tag, policy)),
			...trackedText.problems,
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
					+ `${result.commitsChecked} commit(s), ${result.tagsChecked} annotated tag(s), `
					+ `and ${result.blobsChecked} historical blob(s).`,
				);
				return 1;
			}
			console.log(
				`Git identity check passed for ${result.commitsChecked} commit(s) `
				+ `${result.tagsChecked} annotated tag(s), and ${result.blobsChecked} historical blob(s).`,
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
	historicalTrackedTextProblems,
	isGitHubDependabotCommit,
	runCli,
	signoffEmails,
	validateCommitIdentity,
	validateCommitSignoff,
	validateTagIdentity,
	verifyDco,
	verifyAllGitIdentities,
};
