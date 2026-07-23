/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
	allReachableCommits,
	historicalTrackedTextProblems,
	isGitHubDependabotCommit,
	signoffEmails,
	validateCommitIdentity,
	validateCommitSignoff,
	validateTagIdentity,
} = require('../scripts/verify-dco');

test('accepts a DCO trailer matching the commit author email', () => {
	const address = ['12345+contributor', 'users.noreply.github.com'].join('@');
	const message = [
		'feat: add a safe example',
		'',
		`Signed-off-by: Example Contributor <${address}>`,
	].join('\n');

	assert.deepEqual(signoffEmails(message), [address]);
	assert.equal(validateCommitSignoff({
		authorEmail: address.toUpperCase(),
		hash: 'abc1234',
		message,
	}), null);
});

test('rejects missing or mismatched DCO trailers', () => {
	const authorAddress = ['12345+contributor', 'users.noreply.github.com'].join('@');
	const otherAddress = ['67890+someone-else', 'users.noreply.github.com'].join('@');
	assert.match(validateCommitSignoff({
		authorEmail: authorAddress,
		hash: 'abc1234',
		message: 'fix: missing trailer',
	}), /missing a Signed-off-by/);
	assert.match(validateCommitSignoff({
		authorEmail: authorAddress,
		hash: 'def5678',
		message: `fix: wrong signer\n\nSigned-off-by: Someone Else <${otherAddress}>`,
	}), /none match author/);
});

test('accepts only the exact GitHub Dependabot role-identity pattern', () => {
	const dependabotAddress = ['49699333+dependabot[bot]', 'users.noreply.github.com'].join('@');
	const githubCommitterAddress = ['noreply', 'github.com'].join('@');
	const githubSupportAddress = ['support', 'github.com'].join('@');
	const commit = {
		authorEmail: dependabotAddress,
		authorName: 'dependabot[bot]',
		committerEmail: githubCommitterAddress,
		committerName: 'GitHub',
		hash: 'abc1234',
		message: `chore: update dependencies\n\nSigned-off-by: dependabot[bot] <${githubSupportAddress}>`,
	};

	assert.equal(isGitHubDependabotCommit(commit), true);
	assert.equal(validateCommitSignoff(commit), null);
	assert.equal(isGitHubDependabotCommit({
		...commit,
		authorName: 'dependabot',
	}), false);
	assert.match(validateCommitSignoff({
		...commit,
		committerEmail: dependabotAddress,
	}), /none match author/);
	assert.match(validateCommitSignoff({
		...commit,
		message: `chore: update dependencies\n\nSigned-off-by: GitHub <${githubCommitterAddress}>`,
	}), /none match author/);
});

test('rejects individual addresses in commit identities, messages, and annotated tags', () => {
	const allowedAddress = ['12345+contributor', 'users.noreply.github.com'].join('@');
	const individualAddress = ['named-person', 'company.invalid'].join('@');
	const policy = {
		allowedEmailAddresses: [],
		allowedNoreplyEmailDomains: ['users.noreply.github.com'],
		allowedSyntheticEmailDomains: ['example.com'],
	};
	const commitProblems = validateCommitIdentity({
		authorEmail: individualAddress,
		committerEmail: allowedAddress,
		hash: 'abc1234',
		message: `Co-authored-by: Named Person <${individualAddress}>`,
	}, policy);
	assert.equal(commitProblems.length, 2);
	assert(commitProblems.every((problem) => !problem.includes(individualAddress)));

	const tagProblems = validateTagIdentity({
		email: individualAddress,
		message: `Contact: ${individualAddress}`,
		ref: 'refs/tags/v1.0.0',
	}, policy);
	assert.equal(tagProblems.length, 2);
	assert(tagProblems.every((problem) => !problem.includes(individualAddress)));
});

test('allows an exact role address without allowing its entire domain', () => {
	const roleAddress = ['open-source', 'company.invalid'].join('@');
	const individualAddress = ['named-person', 'company.invalid'].join('@');
	const policy = {
		allowedEmailAddresses: [roleAddress],
		allowedNoreplyEmailDomains: [],
		allowedSyntheticEmailDomains: ['example.com'],
	};
	assert.deepEqual(validateCommitIdentity({
		authorEmail: roleAddress,
		committerEmail: roleAddress,
		hash: 'abc1234',
		message: `Signed-off-by: Open Source Team <${roleAddress}>`,
	}, policy), []);
	assert.equal(validateCommitIdentity({
		authorEmail: individualAddress,
		committerEmail: roleAddress,
		hash: 'def5678',
		message: `Signed-off-by: Named Person <${individualAddress}>`,
	}, policy).length, 2);
});

test('excludes GitHub synthetic pull-request merge refs from advertised history', (t) => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dco-merge-ref-'));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	const address = ['12345+contributor', 'users.noreply.github.com'].join('@');
	const runGit = (args) => execFileSync('git', args, {
		cwd: fixture,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
	runGit(['init', '--quiet', '--initial-branch=main']);
	runGit(['config', 'user.name', 'Example Contributor']);
	runGit(['config', 'user.email', address]);
	fs.writeFileSync(path.join(fixture, 'fixture.txt'), 'advertised\n');
	runGit(['add', 'fixture.txt']);
	runGit(['commit', '--quiet', '--signoff', '-m', 'test: add advertised commit']);
	const advertisedCommit = runGit(['rev-parse', 'HEAD']);
	runGit(['commit', '--quiet', '--allow-empty', '-m', 'Merge pull request']);
	const syntheticMergeCommit = runGit(['rev-parse', 'HEAD']);
	runGit(['update-ref', 'refs/remotes/pull/19/merge', syntheticMergeCommit]);
	runGit(['update-ref', 'refs/heads/main', advertisedCommit, syntheticMergeCommit]);

	assert.deepEqual(
		allReachableCommits(fixture).map(({ hash }) => hash),
		[advertisedCommit],
	);
});

test('detects individual addresses in historical tracked text after removal from HEAD', (t) => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dco-historical-text-'));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	const address = ['12345+contributor', 'users.noreply.github.com'].join('@');
	const individualAddress = ['named-person', 'company.invalid'].join('@');
	const runGit = (args) => execFileSync('git', args, {
		cwd: fixture,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
	runGit(['init', '--quiet', '--initial-branch=main']);
	runGit(['config', 'user.name', 'Example Contributor']);
	runGit(['config', 'user.email', address]);
	fs.writeFileSync(path.join(fixture, 'fixture.txt'), `${individualAddress}\n`);
	runGit(['add', 'fixture.txt']);
	runGit(['commit', '--quiet', '--signoff', '-m', 'test: add historical fixture']);
	fs.writeFileSync(path.join(fixture, 'fixture.txt'), 'removed\n');
	runGit(['add', 'fixture.txt']);
	runGit(['commit', '--quiet', '--signoff', '-m', 'test: remove historical fixture']);

	const problems = historicalTrackedTextProblems(
		fixture,
		allReachableCommits(fixture),
		{
			allowedEmailAddresses: [],
			allowedNoreplyEmailDomains: ['users.noreply.github.com'],
			allowedSyntheticEmailDomains: ['example.com'],
		},
	).problems;
	assert.equal(problems.length, 1);
	assert.match(problems[0], /historical fixture|fixture\.txt/);
	assert(!problems[0].includes(individualAddress));
});
