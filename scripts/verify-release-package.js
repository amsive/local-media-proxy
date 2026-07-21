/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { gunzipSync } = require('node:zlib');
const {
	crc32,
	formatFinding,
	scanPublicRelease,
} = require('./verify-public-release');

const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_SIZE = 25 * 1024 * 1024;
const MAX_UNPACKED_SIZE = 50 * 1024 * 1024;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY = (3 << 8) | ZIP_VERSION;
const ZIP_UTF8_FLAG = 1 << 11;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021;
const ZIP_REGULAR_FILE_MODE = 0o100644;
const PACKAGE_ROOT = 'local-media-proxy/';

// This is intentionally an exact allowlist. Adding a distributable file requires
// a deliberate verifier update so package configuration changes cannot silently
// expand the contents of a GitHub release asset.
const EXPECTED_SOURCE_FILES = Object.freeze([
	'AGENTS.md',
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'DCO',
	'LICENSE',
	'NOTICE',
	'PUBLIC_RELEASE_SAFETY.md',
	'README.md',
	'RELEASING.md',
	'SECURITY.md',
	'SUPPORT.md',
	'TRADEMARKS.md',
	'icon.svg',
	'lib/constants.js',
	'lib/constants.js.map',
	'lib/dns.js',
	'lib/dns.js.map',
	'lib/hosting.js',
	'lib/hosting.js.map',
	'lib/main.js',
	'lib/main.js.map',
	'lib/marketplace.js',
	'lib/marketplace.js.map',
	'lib/nginx.js',
	'lib/nginx.js.map',
	'lib/origin.js',
	'lib/origin.js.map',
	'lib/renderer.js',
	'lib/renderer.js.map',
	'lib/settings.js',
	'lib/settings.js.map',
	'lib/site-config.js',
	'lib/site-config.js.map',
	'lib/types.js',
	'lib/types.js.map',
	'lib/validation.js',
	'lib/validation.js.map',
	'package.json',
	'resources/README.md',
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
	assert(tag, 'Usage: node scripts/verify-release-package.js <vX.Y.Z> <archive.zip>');
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
	const expectedArchiveName = `${packageJson.name}-${packageJson.version}.zip`;

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

	const entries = parseZip(fs.readFileSync(archivePath));
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
			// Preserve the package/ scan namespace used by the byte-pinned safety
			// exceptions while the published ZIP itself uses local-media-proxy/.
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

function parseZip(archive) {
	assert(Buffer.isBuffer(archive), 'ZIP archive must be provided as a Buffer.');
	assert(archive.length >= 22, 'Archive is too short to be a ZIP file.');
	assert(
		archive.length <= MAX_ARCHIVE_SIZE,
		`Archive exceeds the ${MAX_ARCHIVE_SIZE}-byte size limit.`,
	);

	const endOffset = findEndOfCentralDirectory(archive);
	const diskNumber = archive.readUInt16LE(endOffset + 4);
	const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
	const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
	const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
	const commentLength = archive.readUInt16LE(endOffset + 20);

	assert.equal(commentLength, 0, 'ZIP archive comments are not supported.');
	assert.equal(
		endOffset + 22,
		archive.length,
		'Archive contains trailing bytes after its ZIP end record.',
	);
	assert.equal(diskNumber, 0, 'Multi-disk ZIP archives are not supported.');
	assert.equal(centralDirectoryDisk, 0, 'Multi-disk ZIP archives are not supported.');
	assert.equal(entriesOnDisk, entryCount, 'Multi-disk ZIP archives are not supported.');
	assert(
		entryCount !== 0xffff &&
			centralDirectorySize !== 0xffffffff &&
			centralDirectoryOffset !== 0xffffffff,
		'ZIP64 archives are not supported.',
	);
	assert.equal(
		centralDirectoryOffset + centralDirectorySize,
		endOffset,
		'ZIP central directory has an invalid boundary.',
	);

	const centralEntries = [];
	let centralOffset = centralDirectoryOffset;
	let unpackedSize = 0;
	for (let index = 0; index < entryCount; index += 1) {
		assertRange(archive, centralOffset, 46, `central directory entry ${index + 1}`);
		assert.equal(
			archive.readUInt32LE(centralOffset),
			CENTRAL_DIRECTORY_HEADER_SIGNATURE,
			`ZIP central directory entry ${index + 1} has an invalid signature.`,
		);

		const versionMadeBy = archive.readUInt16LE(centralOffset + 4);
		const versionNeeded = archive.readUInt16LE(centralOffset + 6);
		const flags = archive.readUInt16LE(centralOffset + 8);
		const method = archive.readUInt16LE(centralOffset + 10);
		const modifiedTime = archive.readUInt16LE(centralOffset + 12);
		const modifiedDate = archive.readUInt16LE(centralOffset + 14);
		const checksum = archive.readUInt32LE(centralOffset + 16);
		const compressedSize = archive.readUInt32LE(centralOffset + 20);
		const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
		const nameLength = archive.readUInt16LE(centralOffset + 28);
		const extraLength = archive.readUInt16LE(centralOffset + 30);
		const entryCommentLength = archive.readUInt16LE(centralOffset + 32);
		const diskStart = archive.readUInt16LE(centralOffset + 34);
		const internalAttributes = archive.readUInt16LE(centralOffset + 36);
		const externalAttributes = archive.readUInt32LE(centralOffset + 38);
		const localHeaderOffset = archive.readUInt32LE(centralOffset + 42);
		const variableLength = nameLength + extraLength + entryCommentLength;
		assertRange(archive, centralOffset + 46, variableLength, `central directory entry ${index + 1}`);

		assert.equal(versionMadeBy, ZIP_VERSION_MADE_BY, 'ZIP creator platform or version is unsupported.');
		assert.equal(versionNeeded, ZIP_VERSION, 'ZIP extraction version is unsupported.');
		assert.equal(flags, ZIP_UTF8_FLAG, 'ZIP encryption, data descriptors, or optional flags are unsupported.');
		assert.equal(method, ZIP_STORE_METHOD, 'ZIP compression methods are unsupported.');
		assert.equal(modifiedTime, ZIP_DOS_TIME, 'ZIP entry timestamp is not deterministic.');
		assert.equal(modifiedDate, ZIP_DOS_DATE, 'ZIP entry timestamp is not deterministic.');
		assert.equal(compressedSize, uncompressedSize, 'Stored ZIP entry sizes must match.');
		assert(compressedSize !== 0xffffffff, 'ZIP64 entries are not supported.');
		assert(nameLength > 0, `ZIP central directory entry ${index + 1} has an empty path.`);
		assert.equal(extraLength, 0, 'ZIP extra fields are not supported.');
		assert.equal(entryCommentLength, 0, 'ZIP entry comments are not supported.');
		assert.equal(diskStart, 0, 'Multi-disk ZIP archives are not supported.');
		assert.equal(internalAttributes, 0, 'ZIP internal attributes are unsupported.');
		assert.equal(
			externalAttributes,
			(ZIP_REGULAR_FILE_MODE * 0x10000) >>> 0,
			'ZIP entry must be a portable regular file with mode 0644.',
		);

		const nameBytes = archive.subarray(
			centralOffset + 46,
			centralOffset + 46 + nameLength,
		);
		const name = decodeZipName(nameBytes, index);
		validateArchivePath(name);
		unpackedSize += uncompressedSize;
		assert(
			unpackedSize <= MAX_UNPACKED_SIZE,
			`Archive exceeds the ${MAX_UNPACKED_SIZE}-byte uncompressed-size limit.`,
		);

		centralEntries.push({
			checksum,
			compressedSize,
			flags,
			localHeaderOffset,
			method,
			modifiedDate,
			modifiedTime,
			name,
			nameBytes: Buffer.from(nameBytes),
			uncompressedSize,
			versionNeeded,
		});
		centralOffset += 46 + variableLength;
	}
	assert.equal(
		centralOffset,
		endOffset,
		'ZIP central directory entry count or size is invalid.',
	);

	const names = centralEntries.map((entry) => entry.name);
	assert.equal(
		new Set(names).size,
		names.length,
		`Archive contains duplicate entry: ${findDuplicate(names)}`,
	);
	const sortedNames = [...names].sort();
	assert.deepEqual(names, sortedNames, 'ZIP entries must be sorted by path.');

	const entries = [];
	let expectedLocalOffset = 0;
	for (const [index, centralEntry] of centralEntries.entries()) {
		assert.equal(
			centralEntry.localHeaderOffset,
			expectedLocalOffset,
			'ZIP local entries are overlapping, reordered, or separated by unsupported data.',
		);
		assertRange(archive, expectedLocalOffset, 30, `local entry ${index + 1}`);
		assert.equal(
			archive.readUInt32LE(expectedLocalOffset),
			LOCAL_FILE_HEADER_SIGNATURE,
			`ZIP local entry ${index + 1} has an invalid signature.`,
		);

		const localVersion = archive.readUInt16LE(expectedLocalOffset + 4);
		const localFlags = archive.readUInt16LE(expectedLocalOffset + 6);
		const localMethod = archive.readUInt16LE(expectedLocalOffset + 8);
		const localTime = archive.readUInt16LE(expectedLocalOffset + 10);
		const localDate = archive.readUInt16LE(expectedLocalOffset + 12);
		const localChecksum = archive.readUInt32LE(expectedLocalOffset + 14);
		const localCompressedSize = archive.readUInt32LE(expectedLocalOffset + 18);
		const localUncompressedSize = archive.readUInt32LE(expectedLocalOffset + 22);
		const localNameLength = archive.readUInt16LE(expectedLocalOffset + 26);
		const localExtraLength = archive.readUInt16LE(expectedLocalOffset + 28);

		assert.equal(localVersion, centralEntry.versionNeeded, 'ZIP local and central versions differ.');
		assert.equal(localFlags, centralEntry.flags, 'ZIP local and central flags differ.');
		assert.equal(localMethod, centralEntry.method, 'ZIP local and central methods differ.');
		assert.equal(localTime, centralEntry.modifiedTime, 'ZIP local and central timestamps differ.');
		assert.equal(localDate, centralEntry.modifiedDate, 'ZIP local and central timestamps differ.');
		assert.equal(localChecksum, centralEntry.checksum, 'ZIP local and central CRC-32 values differ.');
		assert.equal(localCompressedSize, centralEntry.compressedSize, 'ZIP local and central sizes differ.');
		assert.equal(localUncompressedSize, centralEntry.uncompressedSize, 'ZIP local and central sizes differ.');
		assert.equal(localNameLength, centralEntry.nameBytes.length, 'ZIP local and central path lengths differ.');
		assert.equal(localExtraLength, 0, 'ZIP local extra fields are not supported.');

		const localNameStart = expectedLocalOffset + 30;
		assertRange(archive, localNameStart, localNameLength, `local entry ${index + 1} path`);
		assert(
			archive.subarray(localNameStart, localNameStart + localNameLength).equals(centralEntry.nameBytes),
			'ZIP local and central paths differ.',
		);
		const dataStart = localNameStart + localNameLength;
		assertRange(archive, dataStart, centralEntry.compressedSize, `data for ${centralEntry.name}`);
		const data = Buffer.from(
			archive.subarray(dataStart, dataStart + centralEntry.compressedSize),
		);
		assert.equal(data.length, centralEntry.uncompressedSize, `ZIP entry size is invalid: ${centralEntry.name}`);
		assert.equal(crc32(data), centralEntry.checksum, `ZIP entry has an invalid CRC-32: ${centralEntry.name}`);
		entries.push({ name: centralEntry.name, data });
		expectedLocalOffset = dataStart + centralEntry.compressedSize;
	}
	assert.equal(
		expectedLocalOffset,
		centralDirectoryOffset,
		'ZIP contains unsupported data before its central directory.',
	);

	return entries;
}

function findEndOfCentralDirectory(archive) {
	const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
	for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
		if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
			return offset;
		}
	}
	assert.fail('Archive is missing its ZIP end record.');
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

function decodeZipName(nameBytes, entryIndex) {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
	} catch {
		assert.fail(`ZIP central directory entry ${entryIndex + 1} has an invalid UTF-8 path.`);
	}
}

function assertRange(buffer, offset, length, label) {
	assert(
		Number.isSafeInteger(offset) &&
			Number.isSafeInteger(length) &&
			offset >= 0 &&
			length >= 0 &&
			offset + length <= buffer.length,
		`Archive contains truncated ${label}.`,
	);
}

// The builder consumes npm pack's tarball, so this deliberately small parser
// remains strict even though the published installer is a ZIP archive.
function parseTarGzip(compressedArchive) {
	let archive;
	try {
		archive = gunzipSync(compressedArchive, { maxOutputLength: MAX_UNPACKED_SIZE });
	} catch (error) {
		assert.fail(`Input must be a readable gzip-compressed tar file: ${error.message}`);
	}

	assert(
		archive.length <= MAX_UNPACKED_SIZE,
		`Input exceeds the ${MAX_UNPACKED_SIZE}-byte uncompressed-size limit.`,
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
		assert(name, `Input entry ${entries.length + 1} has an empty path.`);
		assert(name.startsWith('package/'), `Input entry is outside package/: ${name}`);
		assert(!name.split('/').includes('..'), `Input entry contains traversal: ${name}`);
		const typeFlag = header[156];
		assert(
			typeFlag === 0 || typeFlag === 48,
			`Input entry must be a regular file: ${name} (type ${describeTarType(typeFlag)}).`,
		);

		const size = readTarOctal(header.subarray(124, 136), `size for ${name}`);
		const dataStart = offset + TAR_BLOCK_SIZE;
		const dataEnd = dataStart + size;
		assert(dataEnd <= archive.length, `Input entry data is truncated: ${name}`);
		entries.push({ name, data: Buffer.from(archive.subarray(dataStart, dataEnd)) });
		offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}

	assert(reachedEndMarker, 'Input archive is missing its tar end marker.');
	assert(isAllZero(archive.subarray(offset)), 'Input archive contains data after its tar end marker.');
	return entries;
}

function validateTarChecksum(header, entryIndex) {
	const storedChecksum = readTarOctal(
		header.subarray(148, 156),
		`checksum for input entry ${entryIndex + 1}`,
	);
	let calculatedChecksum = 0;
	for (let index = 0; index < header.length; index += 1) {
		calculatedChecksum += index >= 148 && index < 156 ? 32 : header[index];
	}
	assert.equal(
		storedChecksum,
		calculatedChecksum,
		`Input entry ${entryIndex + 1} has an invalid tar checksum.`,
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
	assert.equal(field[0] & 0x80, 0, `Input uses unsupported binary ${label}.`);
	const value = field.toString('ascii').replace(/\0.*$/s, '').trim();
	assert(/^[0-7]+$/.test(value), `Input contains invalid ${label}.`);
	const result = Number.parseInt(value, 8);
	assert(Number.isSafeInteger(result), `Input contains unsafe ${label}.`);
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
	parseZip,
	verifyArchiveContentSafety,
	verifyReleasePackage,
};
