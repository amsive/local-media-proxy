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
const { gzipSync } = require('node:zlib');

const {
	createReleaseZip,
} = require('../scripts/create-release-zip');
const { crc32 } = require('../scripts/verify-public-release');
const {
	EXPECTED_ARCHIVE_ENTRIES,
	PACKAGE_ROOT,
	parseZip,
	verifyArchiveContentSafety,
	verifyReleasePackage,
} = require('../scripts/verify-release-package');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const tag = `v${packageJson.version}`;
const archiveName = `${packageJson.name}-${packageJson.version}.zip`;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY = (3 << 8) | ZIP_VERSION;
const ZIP_UTF8_FLAG = 1 << 11;
const ZIP_DOS_DATE = 0x0021;
const ZIP_REGULAR_FILE_MODE = 0o100644;

test('accepts only the complete 45-file ZIP release manifest', (t) => {
	assert.equal(EXPECTED_ARCHIVE_ENTRIES.length, 45);
	const archivePath = writeZip(
		t,
		EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
			name,
			data: fs.readFileSync(path.join(repositoryRoot, name.slice(PACKAGE_ROOT.length))),
		})),
	);

	const entries = verifyReleasePackage(tag, archivePath);
	assert.deepEqual(
		entries.map((entry) => entry.name),
		[...EXPECTED_ARCHIVE_ENTRIES].sort(),
	);
});

test('builds a deterministic ZIP from npm pack output with an unversioned root', (t) => {
	const temporaryDirectory = makeTemporaryDirectory(t);
	const inputPath = path.join(temporaryDirectory, 'npm-package.tgz');
	const outputPath = path.join(temporaryDirectory, archiveName);
	const tarEntries = EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
		name: `package/${name.slice(PACKAGE_ROOT.length)}`,
		data: fs.readFileSync(path.join(repositoryRoot, name.slice(PACKAGE_ROOT.length))),
	}));
	fs.writeFileSync(inputPath, gzipSync(createTar(tarEntries)));

	createReleaseZip(inputPath, outputPath);
	const firstBuild = fs.readFileSync(outputPath);
	createReleaseZip(inputPath, outputPath);
	const secondBuild = fs.readFileSync(outputPath);

	assert(firstBuild.equals(secondBuild));
	assert.deepEqual(
		parseZip(firstBuild).map((entry) => entry.name),
		[...EXPECTED_ARCHIVE_ENTRIES].sort(),
	);
	assert(parseZip(firstBuild).every((entry) => entry.name.startsWith('local-media-proxy/')));
	assert(parseZip(firstBuild).every((entry) => !entry.name.startsWith(`local-media-proxy-${packageJson.version}/`)));
});

test('rejects a suffixed package version tag', () => {
	assert.throws(
		() => verifyReleasePackage(`v${packageJson.version}-release`, '/tmp/not-used.zip'),
		/must exactly match package version/,
	);
});

test('rejects duplicate archive entries', (t) => {
	const packageData = fs.readFileSync(path.join(repositoryRoot, 'package.json'));
	const archivePath = writeZip(t, [
		{ name: `${PACKAGE_ROOT}package.json`, data: packageData },
		{ name: `${PACKAGE_ROOT}package.json`, data: packageData },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains duplicate entry: local-media-proxy\/package\.json/,
	);
});

test('rejects traversal paths', (t) => {
	const archivePath = writeZip(t, [
		{ name: `${PACKAGE_ROOT}../outside.txt`, data: Buffer.from('not distributable') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry contains traversal or an empty segment/,
	);
});

test('rejects files outside the exact release manifest', (t) => {
	const archivePath = writeZip(t, [
		{ name: `${PACKAGE_ROOT}unexpected.txt`, data: Buffer.from('not distributable') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains unexpected entry: local-media-proxy\/unexpected\.txt/,
	);
});

test('rejects non-regular ZIP entries', (t) => {
	const archivePath = writeZip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.alloc(0),
		externalAttributes: (0o120777 * 0x10000) >>> 0,
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/ZIP entry must be a portable regular file with mode 0644/,
	);
});

test('rejects unsupported ZIP encryption and optional flags', (t) => {
	const archivePath = writeZip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.alloc(0),
		flags: ZIP_UTF8_FLAG | 1,
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/ZIP encryption, data descriptors, or optional flags are unsupported/,
	);
});

test('rejects unsupported ZIP compression methods', (t) => {
	const archivePath = writeZip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.alloc(0),
		method: 8,
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/ZIP compression methods are unsupported/,
	);
});

test('rejects unsupported ZIP extra fields', (t) => {
	const archivePath = writeZip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.alloc(0),
		extra: Buffer.from([1, 0, 0, 0]),
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/ZIP extra fields are not supported/,
	);
});

test('rejects trailing bytes after the ZIP end record', (t) => {
	const archivePath = writeZip(
		t,
		[{ name: `${PACKAGE_ROOT}package.json`, data: Buffer.alloc(0) }],
		{ trailingData: Buffer.from('trailing') },
	);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains trailing bytes after its ZIP end record/,
	);
});

test('rejects an allowed file whose bytes differ from tagged source', (t) => {
	const archivePath = writeZip(
		t,
		EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
			name,
			data: name === `${PACKAGE_ROOT}lib/main.js`
				? Buffer.from('altered release code')
				: fs.readFileSync(path.join(repositoryRoot, name.slice(PACKAGE_ROOT.length))),
		})),
	);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry differs from tagged source: local-media-proxy\/lib\/main\.js/,
	);
});

test('rejects sensitive content inside an otherwise allowed release entry', () => {
	const unapprovedHostname = ['customer-site', 'invalid-host', 'com'].join('.');
	assert.throws(
		() => verifyArchiveContentSafety([{
			name: `${PACKAGE_ROOT}README.md`,
			data: Buffer.from(`https://${unapprovedHostname}`),
		}]),
		/HOST_NOT_ALLOWED/,
	);
});

function writeZip(t, entries, options = {}) {
	const temporaryDirectory = makeTemporaryDirectory(t);
	const archivePath = path.join(temporaryDirectory, archiveName);
	fs.writeFileSync(archivePath, createTestZip(entries, options));
	return archivePath;
}

function makeTemporaryDirectory(t) {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-proxy-package-test-'));
	t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
	return temporaryDirectory;
}

function createTestZip(entries, options = {}) {
	const sortedEntries = options.preserveOrder
		? [...entries]
		: [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
	const localChunks = [];
	const centralChunks = [];
	let localOffset = 0;

	for (const entry of sortedEntries) {
		const name = Buffer.from(entry.name, 'utf8');
		const data = Buffer.from(entry.data ?? '');
		const extra = Buffer.from(entry.extra ?? '');
		const flags = entry.flags ?? ZIP_UTF8_FLAG;
		const method = entry.method ?? 0;
		const checksum = entry.checksum ?? crc32(data);

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(ZIP_VERSION, 4);
		localHeader.writeUInt16LE(flags, 6);
		localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(extra.length, 28);
		localChunks.push(localHeader, name, extra, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(ZIP_VERSION_MADE_BY, 4);
		centralHeader.writeUInt16LE(ZIP_VERSION, 6);
		centralHeader.writeUInt16LE(flags, 8);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(extra.length, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(
			entry.externalAttributes ?? (ZIP_REGULAR_FILE_MODE * 0x10000) >>> 0,
			38,
		);
		centralHeader.writeUInt32LE(localOffset, 42);
		centralChunks.push(centralHeader, name, extra);
		localOffset += localHeader.length + name.length + extra.length + data.length;
	}

	const centralDirectory = Buffer.concat(centralChunks);
	const endRecord = Buffer.alloc(22);
	endRecord.writeUInt32LE(0x06054b50, 0);
	endRecord.writeUInt16LE(0, 4);
	endRecord.writeUInt16LE(0, 6);
	endRecord.writeUInt16LE(sortedEntries.length, 8);
	endRecord.writeUInt16LE(sortedEntries.length, 10);
	endRecord.writeUInt32LE(centralDirectory.length, 12);
	endRecord.writeUInt32LE(localOffset, 16);
	endRecord.writeUInt16LE(0, 20);
	return Buffer.concat([
		...localChunks,
		centralDirectory,
		endRecord,
		options.trailingData ?? Buffer.alloc(0),
	]);
}

function createTar(entries) {
	const chunks = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? '');
		const header = Buffer.alloc(512);
		writeString(header, 0, 100, entry.name);
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, data.length);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = '0'.charCodeAt(0);
		writeString(header, 257, 6, 'ustar');
		writeString(header, 263, 2, '00');
		writeString(header, 265, 32, 'root');
		writeString(header, 297, 32, 'root');

		let checksum = 0;
		for (const byte of header) {
			checksum += byte;
		}
		header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
		chunks.push(header, data);
		const paddingLength = (512 - (data.length % 512)) % 512;
		if (paddingLength > 0) {
			chunks.push(Buffer.alloc(paddingLength));
		}
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

function writeString(buffer, offset, length, value) {
	assert(Buffer.byteLength(value) <= length, `Test tar value is too long: ${value}`);
	buffer.write(value, offset, length, 'utf8');
}

function writeOctal(buffer, offset, length, value) {
	const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
	assert.equal(encoded.length, length);
	buffer.write(encoded, offset, length, 'ascii');
}
