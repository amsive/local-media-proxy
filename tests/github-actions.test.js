/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflows = ['ci.yml', 'promote-release.yml', 'release.yml']
	.map((name) => fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8'))
	.join('\n');

test('pins the consolidated GitHub Actions upgrades to immutable revisions', () => {
	for (const [action, revision, version, expectedUses] of [
		['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1', '7.0.1', 3],
		['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020', '7.0.0', 3],
		['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', '7.0.1', 2],
		['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', '8.0.1', 2],
	]) {
		const expected = `uses: ${action}@${revision} # v${version}`;
		assert.equal(
			workflows.split(expected).length - 1,
			expectedUses,
			`${action} must use the reviewed full-length revision everywhere.`,
		);
	}
});

test('validates an upload and download artifact round trip on pull requests', () => {
	const workflow = fs.readFileSync(
		path.resolve(__dirname, '../.github/workflows/ci.yml'),
		'utf8',
	);

	assert.match(workflow, /artifact-round-trip:/);
	assert.match(workflow, /needs: validate/);
	assert.equal((workflow.match(/github\.run_attempt/g) ?? []).length, 2);
	assert.match(workflow, /find dist -maxdepth 1 -type f \| wc -l/);
	assert.match(workflow, /find dist -maxdepth 1 -type f -name '\*\.tgz'/);
	assert.match(workflow, /find dist -maxdepth 1 -type f -name '\*\.tgz\.sha256'/);
	assert.match(workflow, /sha256sum --check \.\/\*\.tgz\.sha256/);
	assert.match(workflow, /dist\/local-media-proxy-v\*\.tgz/);
});

test('enforces public-source and third-party checks in validation, release, and promotion workflows', () => {
	for (const name of ['ci.yml', 'release.yml', 'promote-release.yml']) {
		const workflow = fs.readFileSync(
			path.resolve(__dirname, '../.github/workflows', name),
			'utf8',
		);
		assert.match(workflow, /node scripts\/verify-public-release\.js/);
		assert.match(workflow, /git archive --format=tar HEAD/);
		assert.match(workflow, /--require-manifest-completeness/);
		assert.match(workflow, /npm run verify:third-party/);
	}

	const releaseWorkflow = fs.readFileSync(
		path.resolve(__dirname, '../.github/workflows/release.yml'),
		'utf8',
	);
	assert.match(releaseWorkflow, /git archive --format=zip/);
	assert.match(releaseWorkflow, /unzip -q/);
	assert.match(releaseWorkflow, /dist\/local-media-proxy-v\$\{version\}\.tgz/);
});

test('enforces DCO sign-offs across the exact pull-request commit range', () => {
	const workflow = fs.readFileSync(
		path.resolve(__dirname, '../.github/workflows/ci.yml'),
		'utf8',
	);

	assert.match(workflow, /if: github\.event_name == 'pull_request'/);
	assert.match(workflow, /DCO_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
	assert.match(workflow, /DCO_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
	assert.match(workflow, /node scripts\/verify-dco\.js "\$\{DCO_BASE_SHA\}" "\$\{DCO_HEAD_SHA\}"/);
});

test('groups future GitHub Actions updates into one Dependabot pull request', () => {
	const config = fs.readFileSync(
		path.resolve(__dirname, '../.github/dependabot.yml'),
		'utf8',
	);

	assert.match(config, /groups:\n\s+github-actions:\n\s+patterns:\n\s+- "\*"/);
});

test('groups future npm updates into one monthly Dependabot pull request', () => {
	const config = fs.readFileSync(
		path.resolve(__dirname, '../.github/dependabot.yml'),
		'utf8',
	);

	assert.match(config, /package-ecosystem: npm/);
	assert.match(config, /schedule:\n\s+interval: monthly/);
	assert.match(config, /groups:\n\s+npm:\n\s+patterns:\n\s+- "\*"/);
});

test('documents commit-pinned absolute screenshot URLs for pull requests', () => {
	const guidance = [
		'.github/pull_request_template.md',
		'AGENTS.md',
		'CONTRIBUTING.md',
	].map((name) => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
	const absoluteScreenshotUrl = /https:\/\/github\.com\/amsive\/local-media-proxy\/raw\/<head-commit-sha>\/docs\/screenshots\/<file>\.png/;

	for (const document of guidance) {
		assert.match(document, absoluteScreenshotUrl);
		assert.doesNotMatch(document, /\.\.\/blob\/<head-commit-sha>/);
	}
});
