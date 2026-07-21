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
	assert.equal(packageJson.version, '0.1.0');
	assert.equal(packageJson.license, 'Apache-2.0');
	assert.equal(
		packageJson.description,
		'Load missing WordPress upload images from a remote site while keeping existing media local.',
	);
	assert.equal(packageJson.bgColor, '#6E187A');
	assert.equal(packageJson.icon, 'icon.svg');
	assert.equal(ADDON_VERSION, packageJson.version);
	assert.equal(packageJson.scripts['package:addon'], 'node scripts/package-addon.js');
	assert.equal(packageJson.scripts['package:check'], 'npm run package:addon');
	assert.deepEqual(packageJson.files, [
		'lib/constants.js',
		'lib/dns.js',
		'lib/hosting.js',
		'lib/main.js',
		'lib/marketplace.js',
		'lib/nginx.js',
		'lib/origin.js',
		'lib/renderer.js',
		'lib/settings.js',
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
		'resources/mark-davoli-avatar.svg',
		'style.css',
	]);
	for (const asset of [
		'amsive-avatar.svg',
		'boris-hegedis-avatar.svg',
		'detail-hero.svg',
		'mark-davoli-avatar.svg',
	]) {
		assert.equal(
			fs.existsSync(path.resolve(__dirname, '../resources', asset)),
			true,
			`${asset} must be packaged for the native detail page.`,
		);
	}
});
