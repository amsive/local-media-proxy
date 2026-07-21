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
const { verifyReleasePackage } = require('./verify-release-package');

const repositoryRoot = path.join(__dirname, '..');
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const temporaryDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), 'local-media-proxy-package-'),
);

try {
	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const buildResult = spawnSync(
		npmCommand,
		['run', 'build'],
		{
			cwd: repositoryRoot,
			stdio: 'inherit',
		},
	);
	assert.equal(buildResult.error, undefined, buildResult.error?.message);
	assert.equal(buildResult.status, 0, `npm run build exited with status ${buildResult.status}.`);

	const stagingDirectory = path.join(temporaryDirectory, 'source');
	const packedDirectory = path.join(temporaryDirectory, 'packed');
	fs.mkdirSync(stagingDirectory, { recursive: true });
	fs.mkdirSync(packedDirectory, { recursive: true });
	assert(Array.isArray(packageJson.files), 'package.json files must be an exact allowlist.');
	assert.equal(
		new Set(packageJson.files).size,
		packageJson.files.length,
		'package.json files must not contain duplicates.',
	);
	copyPackageFile('package.json', stagingDirectory);
	for (const relativePath of packageJson.files) {
		copyPackageFile(relativePath, stagingDirectory);
	}

	const packResult = spawnSync(
		npmCommand,
		[
			'pack',
			'--ignore-scripts',
			'--cache',
			path.join(repositoryRoot, '.npm-cache'),
			'--pack-destination',
			packedDirectory,
		],
		{
			cwd: stagingDirectory,
			stdio: 'inherit',
		},
	);
	assert.equal(packResult.error, undefined, packResult.error?.message);
	assert.equal(packResult.status, 0, `npm pack exited with status ${packResult.status}.`);

	const expectedTarballName = `${packageJson.name}-${packageJson.version}.tgz`;
	const releaseTarballName = `${packageJson.name}-v${packageJson.version}.tgz`;
	const generatedFiles = fs.readdirSync(packedDirectory);
	assert.deepEqual(
		generatedFiles,
		[expectedTarballName],
		'npm pack must produce exactly the expected intermediate tarball.',
	);

	const candidatePath = path.join(temporaryDirectory, releaseTarballName);
	fs.copyFileSync(
		path.join(packedDirectory, expectedTarballName),
		candidatePath,
	);
	verifyReleasePackage(`v${packageJson.version}`, candidatePath);

	const outputPath = path.join(repositoryRoot, 'dist', releaseTarballName);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.copyFileSync(candidatePath, outputPath);
	console.log(`Created ${path.relative(repositoryRoot, outputPath)}`);
} finally {
	fs.rmSync(temporaryDirectory, { force: true, recursive: true });
}

function copyPackageFile(relativePath, stagingDirectory) {
	assert(
		typeof relativePath === 'string' &&
			relativePath.length > 0 &&
			!relativePath.includes('*') &&
			!relativePath.includes('?') &&
			!relativePath.includes('\\') &&
			!path.isAbsolute(relativePath) &&
			relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
		`Package file must be an exact repository-relative path: ${relativePath}`,
	);
	const sourcePath = path.join(repositoryRoot, relativePath);
	assert(
		fs.existsSync(sourcePath) && fs.lstatSync(sourcePath).isFile(),
		`Package file does not exist or is not a regular file: ${relativePath}`,
	);
	const destinationPath = path.join(stagingDirectory, relativePath);
	fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
	fs.copyFileSync(sourcePath, destinationPath);
}
