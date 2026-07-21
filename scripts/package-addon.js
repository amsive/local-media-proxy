/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createReleaseZip } = require('./create-release-zip');

const repositoryRoot = path.join(__dirname, '..');
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const temporaryDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), 'local-media-proxy-package-'),
);

try {
	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = spawnSync(
		npmCommand,
		[
			'pack',
			'--cache',
			path.join(repositoryRoot, '.npm-cache'),
			'--pack-destination',
			temporaryDirectory,
		],
		{
			cwd: repositoryRoot,
			stdio: 'inherit',
		},
	);
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, `npm pack exited with status ${result.status}.`);

	const expectedTarballName = `${packageJson.name}-${packageJson.version}.tgz`;
	const generatedFiles = fs.readdirSync(temporaryDirectory);
	assert.deepEqual(
		generatedFiles,
		[expectedTarballName],
		'npm pack must produce exactly the expected intermediate tarball.',
	);

	createReleaseZip(
		path.join(temporaryDirectory, expectedTarballName),
		path.join(repositoryRoot, 'dist', `${packageJson.name}-${packageJson.version}.zip`),
	);
} finally {
	fs.rmSync(temporaryDirectory, { force: true, recursive: true });
}
