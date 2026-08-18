/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
);
const { ADDON_VERSION } = require('../lib/constants');

test('declares the installed add-on card metadata expected by Local', () => {
	assert.equal(packageJson.productName, 'Local Media Proxy');
	assert.equal(packageJson.author?.name, 'Amsive');
	assert.equal(
		packageJson.author?.url,
		'https://www.amsive.com/?utm_source=localwp&utm_medium=referral&utm_campaign=local_media_proxy&utm_content=package_author',
	);
	assert.equal(packageJson.version, '0.4.2');
	assert.equal(packageJson.license, 'Apache-2.0');
	assert.equal(
		packageJson.description,
		'Load safe missing WordPress upload assets from a remote site while keeping existing files local.',
	);
	assert.equal(packageJson.bgColor, '#6E187A');
	assert.equal(packageJson.icon, 'icon.svg');
	assert.equal(ADDON_VERSION, packageJson.version);
	assert.equal(packageJson.scripts['package:addon'], 'node scripts/package-addon.js');
	assert.equal(packageJson.scripts['package:check'], 'npm run package:addon');
	assert.equal(packageJson.scripts.test, 'npm run test:all');
	assert.equal(
		packageJson.scripts['test:all'],
		'npm run build && node --test --test-reporter=dot',
	);
	assert.equal(
		packageJson.scripts['test:focused'],
		'npm run build && node --test --test-reporter=dot',
	);
	assert.equal(
		packageJson.scripts['test:verbose'],
		'npm run build && node --test --test-reporter=spec',
	);
	assert.doesNotMatch(packageJson.scripts.validate, /npm run typecheck/);
	assert.equal(packageJson.scripts['verify:third-party'], 'node scripts/verify-third-party.js');
	assert.deepEqual(packageJson.files, [
		'lib/apache.js',
		'lib/asset-policy.js',
		'lib/compiled-config.js',
		'lib/constants.js',
		'lib/dns.js',
		'lib/hosting.js',
		'lib/lifecycle.js',
		'lib/main.js',
		'lib/marketplace.js',
		'lib/nginx.js',
		'lib/orphan-recovery.js',
		'lib/origin.js',
		'lib/renderer.js',
		'lib/settings.js',
		'lib/server.js',
		'lib/site-config.js',
		'lib/validation.js',
		'LICENSE',
		'NOTICE',
		'README.md',
		'icon.svg',
		'resources/amsive-avatar.svg',
		'resources/boris-hegedis-avatar.svg',
		'resources/cloudflare-origin-ca.pem',
		'resources/detail-hero.svg',
		'resources/detail-icon.svg',
		'resources/mark-davoli-avatar.svg',
		'style.css',
	]);
	// npm adds package.json to these 28 explicit files, producing the
	// release verifier's exact 29-entry archive.
	assert.equal(packageJson.files.length, 28);
	for (const asset of [
		'amsive-avatar.svg',
		'boris-hegedis-avatar.svg',
		'detail-hero.svg',
		'detail-icon.svg',
		'mark-davoli-avatar.svg',
	]) {
		assert.equal(
			fs.existsSync(path.resolve(__dirname, '../resources', asset)),
			true,
			`${asset} must be packaged for the native detail page.`,
		);
	}
});

test('keeps README artwork public, package-compatible, and off removed commit history', () => {
	const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

	assert.match(
		readme,
		/\[Amsive\]\(https:\/\/www\.amsive\.com\/\?utm_source=github&utm_medium=referral&utm_campaign=local_media_proxy&utm_content=readme\)/,
	);
	assert.match(
		readme,
		/https:\/\/github\.com\/amsive\/local-media-proxy\/raw\/main\/docs\/screenshots\/origin-discovery-light\.png/,
	);
	assert.doesNotMatch(
		readme,
		/https:\/\/github\.com\/amsive\/local-media-proxy\/raw\/[0-9a-f]{40}\//,
	);
	assert.equal(
		fs.existsSync(path.resolve(__dirname, '../docs/screenshots/origin-discovery-light.png')),
		true,
	);
});

test('keeps the README package count synchronized with the exact release manifest', () => {
	const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
	const expectedArchiveEntries = packageJson.files.length + 1;

	assert.match(
		readme,
		new RegExp(
			`contains exactly ${expectedArchiveEntries} reviewed runtime files\\.`,
		),
	);
});

test('keeps the lifecycle release contract durable and public-safe', () => {
	const releasing = fs.readFileSync(
		path.resolve(__dirname, '../RELEASING.md'),
		'utf8',
	);
	const contributing = fs.readFileSync(
		path.resolve(__dirname, '../CONTRIBUTING.md'),
		'utf8',
	);
	const technicalDetails = fs.readFileSync(
		path.resolve(__dirname, '../docs/technical-details.md'),
		'utf8',
	);

	for (const expected of [
		/Local Media Proxy Test Site N/,
		/automated initial-pull transition regressions/,
		/Do not start a live pull or push to satisfy this step/,
		/predesignated non-production transfer-test site/,
		/database-only/,
		/File synchronization must remain disabled, including `wp-content\/uploads\/\*\*`/,
		/zero file or media paths were transferred/,
		/Approval does not carry across operations or test runs/,
		/Delete at least one running numbered fixture and one halted numbered fixture/,
		/starting byte offset.*starting line count/,
		/no renderer IPC, managed-file reads or writes, or settings writes/,
		/raw Local and.*WP Engine logs.*local and untracked/,
		/Pull-request evidence must be a sanitized summary/,
	]) {
		assert.match(releasing, expected);
	}

	assert.match(
		technicalDetails,
		/immediately before each write, atomic rename, or unlink/,
	);
	assert.match(
		technicalDetails,
		/re-enable cancels the deferred global cleanup before normal configured-site reconciliation/,
	);
	assert.match(
		technicalDetails,
		/Rollback is similarly qualified.*only while the current site remains lifecycle-ready/,
	);

	assert.match(
		contributing,
		/Keep raw Local and WP Engine logs.*local and untracked/,
	);
	assert.match(
		contributing,
		/Revalidate lifecycle readiness immediately before every managed write, atomic rename, unlink, and rollback restoration/,
	);
});
