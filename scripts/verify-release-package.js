/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const {
	formatFinding,
	scanPublicRelease,
} = require('./verify-public-release');

const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_SIZE = 25 * 1024 * 1024;
const MAX_UNPACKED_SIZE = 50 * 1024 * 1024;
const PACKAGE_ROOT = 'package/';

// This is intentionally an exact allowlist. Adding a distributable file requires
// a deliberate verifier update so package configuration changes cannot silently
// expand the contents of a GitHub release asset.
const EXPECTED_SOURCE_FILES = Object.freeze([
	'LICENSE',
	'NOTICE',
	'README.md',
	'icon.svg',
	'lib/apache.js',
	'lib/constants.js',
	'lib/dns.js',
	'lib/hosting.js',
	'lib/lifecycle.js',
	'lib/main.js',
	'lib/marketplace.js',
	'lib/nginx.js',
	'lib/origin.js',
	'lib/renderer.js',
	'lib/settings.js',
	'lib/server.js',
	'lib/site-config.js',
	'lib/validation.js',
	'package.json',
	'resources/amsive-avatar.svg',
	'resources/boris-hegedis-avatar.svg',
	'resources/cloudflare-origin-ca.pem',
	'resources/detail-hero.svg',
	'resources/mark-davoli-avatar.svg',
	'style.css',
]);
const EXPECTED_ARCHIVE_ENTRIES = Object.freeze(
	EXPECTED_SOURCE_FILES.map((name) => `${PACKAGE_ROOT}${name}`),
);

function verifyReleasePackage(tag, archiveArgument) {
	assert(tag, 'Usage: node scripts/verify-release-package.js <vX.Y.Z> <archive.tgz>');
	assert(archiveArgument, 'The installable archive path is required.');

	const repositoryRoot = path.join(__dirname, '..');
	const packageJson = JSON.parse(
		fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
	);
	const packageLock = JSON.parse(
		fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
	);
	const changelog = fs.readFileSync(
		path.join(repositoryRoot, 'CHANGELOG.md'),
		'utf8',
	);
	const archivePath = path.resolve(repositoryRoot, archiveArgument);
	const expectedTag = `v${packageJson.version}`;
	const expectedArchiveName = `${packageJson.name}-v${packageJson.version}.tgz`;

	assert.equal(tag, expectedTag, `Tag ${tag} must exactly match package version ${expectedTag}.`);
	assert.equal(
		packageLock.version,
		packageJson.version,
		'package-lock.json version must match package.json.',
	);
	assert.equal(
		packageLock.packages?.['']?.version,
		packageJson.version,
		'package-lock.json root package version must match package.json.',
	);
	assert.equal(
		path.basename(archivePath),
		expectedArchiveName,
		`Archive must be named ${expectedArchiveName}.`,
	);
	assert(fs.existsSync(archivePath), `Archive does not exist: ${archivePath}`);
	assert(
		new RegExp(`^## \\[${escapeRegularExpression(packageJson.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog),
		`CHANGELOG.md must contain a dated ${packageJson.version} release heading.`,
	);

	const archiveStat = fs.statSync(archivePath);
	assert(archiveStat.isFile(), `Archive path must be a regular file: ${archivePath}`);
	assert(
		archiveStat.size <= MAX_ARCHIVE_SIZE,
		`Archive exceeds the ${MAX_ARCHIVE_SIZE}-byte size limit.`,
	);

	const entries = parseTarGzip(fs.readFileSync(archivePath));
	assert(entries.length > 0, 'Archive is empty.');

	const actualNames = entries.map((entry) => entry.name);
	const actualNameSet = new Set(actualNames);
	assert.equal(
		actualNameSet.size,
		actualNames.length,
		`Archive contains duplicate entry: ${findDuplicate(actualNames)}`,
	);

	const expectedNameSet = new Set(EXPECTED_ARCHIVE_ENTRIES);
	for (const name of actualNames) {
		assert(expectedNameSet.has(name), `Archive contains unexpected entry: ${name}`);
	}
	for (const name of EXPECTED_ARCHIVE_ENTRIES) {
		assert(actualNameSet.has(name), `Archive is missing expected entry: ${name}`);
	}
	assert.equal(
		actualNames.length,
		EXPECTED_ARCHIVE_ENTRIES.length,
		'Archive entry count does not match the release manifest.',
	);

	for (const entry of entries) {
		const sourcePath = path.join(
			repositoryRoot,
			entry.name.slice(PACKAGE_ROOT.length),
		);
		assert(
			fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile(),
			`Tagged source is missing packaged file: ${entry.name}`,
		);
		assert(
			entry.data.equals(fs.readFileSync(sourcePath)),
			`Archive entry differs from tagged source: ${entry.name}`,
		);
	}

	verifyArchiveContentSafety(entries);

	const packedPackageEntry = entries.find(
		(entry) => entry.name === `${PACKAGE_ROOT}package.json`,
	);
	assert(packedPackageEntry, `Archive is missing expected entry: ${PACKAGE_ROOT}package.json`);
	const packedPackageJson = JSON.parse(packedPackageEntry.data.toString('utf8'));

	assert.equal(packedPackageJson.name, packageJson.name, 'Packed package name does not match.');
	assert.equal(packedPackageJson.version, packageJson.version, 'Packed package version does not match.');
	assert.equal(packedPackageJson.main, 'lib/main.js', 'Packed main entry point is incorrect.');
	assert.equal(packedPackageJson.renderer, 'lib/renderer.js', 'Packed renderer entry point is incorrect.');
	assert.equal(packedPackageJson.author?.name, 'Amsive', 'Packed author must render as by Amsive.');
	assert.equal(packedPackageJson.license, 'Apache-2.0', 'Packed license must be Apache-2.0.');
	assert.deepEqual(
		packedPackageJson.dependencies ?? {},
		{},
		'Packed add-on must not contain undeclared runtime dependency requirements.',
	);

	console.log(`Verified ${path.relative(repositoryRoot, archivePath)} for ${tag} (${entries.length} entries).`);
	return entries;
}

function verifyArchiveContentSafety(entries) {
	const temporaryDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), 'local-media-proxy-public-release-'),
	);
	try {
		for (const entry of entries) {
			validateArchivePath(entry.name);
			const relativePath = entry.name.slice(PACKAGE_ROOT.length);
			const destination = path.join(temporaryDirectory, 'package', relativePath);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.writeFileSync(destination, entry.data, { flag: 'wx' });
		}

		const result = scanPublicRelease({
			requireManifestCompleteness: false,
			root: temporaryDirectory,
			useGitTrackedFiles: false,
		});
		assert.equal(
			result.findings.length,
			0,
			`Archive failed the public-release safety check:\n${result.findings.map(formatFinding).join('\n')}`,
		);
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function validateArchivePath(name) {
	assert(name.startsWith(PACKAGE_ROOT), `Archive entry is outside ${PACKAGE_ROOT}: ${name}`);
	assert(!name.includes('\\'), `Archive entry uses a backslash path separator: ${name}`);
	assert(!name.includes('\0'), `Archive entry contains a NUL byte: ${name}`);
	assert(!name.endsWith('/'), `Archive entry must be a regular file: ${name}`);
	const segments = name.split('/');
	assert(
		segments.every((segment) => segment && segment !== '.' && segment !== '..'),
		`Archive entry contains traversal or an empty segment: ${name}`,
	);
}

function parseTarGzip(compressedArchive) {
	assert(Buffer.isBuffer(compressedArchive), 'TGZ archive must be provided as a Buffer.');
	assert(
		compressedArchive.length <= MAX_ARCHIVE_SIZE,
		`Archive exceeds the ${MAX_ARCHIVE_SIZE}-byte compressed-size limit.`,
	);
	let archive;
	try {
		archive = gunzipSync(compressedArchive, { maxOutputLength: MAX_UNPACKED_SIZE });
	} catch (error) {
		assert.fail(`Archive must be a readable gzip-compressed tar file: ${error.message}`);
	}

	assert(
		archive.length <= MAX_UNPACKED_SIZE,
		`Archive exceeds the ${MAX_UNPACKED_SIZE}-byte uncompressed-size limit.`,
	);

	const entries = [];
	let offset = 0;
	let reachedEndMarker = false;
	while (offset + TAR_BLOCK_SIZE <= archive.length) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (isZeroBlock(header)) {
			reachedEndMarker = true;
			offset += TAR_BLOCK_SIZE;
			break;
		}

		validateTarChecksum(header, entries.length);
		const name = readTarPath(header);
		assert(name, `Archive entry ${entries.length + 1} has an empty path.`);
		validateArchivePath(name);
		const typeFlag = header[156];
		assert(
			typeFlag === 0 || typeFlag === 48,
			`Archive entry must be a regular file: ${name} (type ${describeTarType(typeFlag)}).`,
		);

		const size = readTarOctal(header.subarray(124, 136), `size for ${name}`);
		const dataStart = offset + TAR_BLOCK_SIZE;
		const dataEnd = dataStart + size;
		assert(dataEnd <= archive.length, `Archive entry data is truncated: ${name}`);
		entries.push({ name, data: Buffer.from(archive.subarray(dataStart, dataEnd)) });
		offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}

	assert(reachedEndMarker, 'Archive is missing its tar end marker.');
	assert(isAllZero(archive.subarray(offset)), 'Archive contains data after its tar end marker.');
	return entries;
}

function validateTarChecksum(header, entryIndex) {
	const storedChecksum = readTarOctal(
		header.subarray(148, 156),
		`checksum for archive entry ${entryIndex + 1}`,
	);
	let calculatedChecksum = 0;
	for (let index = 0; index < header.length; index += 1) {
		calculatedChecksum += index >= 148 && index < 156 ? 32 : header[index];
	}
	assert.equal(
		storedChecksum,
		calculatedChecksum,
		`Archive entry ${entryIndex + 1} has an invalid tar checksum.`,
	);
}

function readTarPath(header) {
	const name = readTarString(header.subarray(0, 100));
	const prefix = readTarString(header.subarray(345, 500));
	return prefix ? `${prefix}/${name}` : name;
}

function readTarString(field) {
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function readTarOctal(field, label) {
	assert.equal(field[0] & 0x80, 0, `Archive uses unsupported binary ${label}.`);
	const value = field.toString('ascii').replace(/\0.*$/s, '').trim();
	assert(/^[0-7]+$/.test(value), `Archive contains invalid ${label}.`);
	const result = Number.parseInt(value, 8);
	assert(Number.isSafeInteger(result), `Archive contains unsafe ${label}.`);
	return result;
}

function isZeroBlock(block) {
	return block.length === TAR_BLOCK_SIZE && isAllZero(block);
}

function isAllZero(buffer) {
	for (const byte of buffer) {
		if (byte !== 0) {
			return false;
		}
	}
	return true;
}

function describeTarType(typeFlag) {
	const descriptions = {
		49: 'hard link',
		50: 'symbolic link',
		51: 'character device',
		52: 'block device',
		53: 'directory',
		54: 'FIFO',
		55: 'contiguous file',
		103: 'global PAX header',
		120: 'PAX header',
	};
	return descriptions[typeFlag] ?? `flag ${JSON.stringify(String.fromCharCode(typeFlag))}`;
}

function findDuplicate(values) {
	const seen = new Set();
	for (const value of values) {
		if (seen.has(value)) {
			return value;
		}
		seen.add(value);
	}
	return 'unknown';
}

function escapeRegularExpression(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) {
	verifyReleasePackage(...process.argv.slice(2));
}

module.exports = {
	EXPECTED_ARCHIVE_ENTRIES,
	PACKAGE_ROOT,
	parseTarGzip,
	verifyArchiveContentSafety,
	verifyReleasePackage,
};
