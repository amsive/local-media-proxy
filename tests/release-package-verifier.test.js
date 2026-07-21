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
	EXPECTED_ARCHIVE_ENTRIES,
	verifyArchiveContentSafety,
	verifyReleasePackage,
} = require('../scripts/verify-release-package');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const tag = `v${packageJson.version}`;
const archiveName = `${packageJson.name}-${packageJson.version}.tgz`;

test('accepts only the complete 45-file release manifest', (t) => {
	assert.equal(EXPECTED_ARCHIVE_ENTRIES.length, 45);
	const archivePath = writeArchive(
		t,
		EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
			name,
			data: fs.readFileSync(path.join(repositoryRoot, name.slice('package/'.length))),
		})),
	);

	const entries = verifyReleasePackage(tag, archivePath);
	assert.deepEqual(
		entries.map((entry) => entry.name).sort(),
		[...EXPECTED_ARCHIVE_ENTRIES].sort(),
	);
});

test('rejects a suffixed package version tag', () => {
	assert.throws(
		() => verifyReleasePackage(`v${packageJson.version}-release`, '/tmp/not-used.tgz'),
		/must exactly match package version/,
	);
});

test('rejects duplicate archive entries', (t) => {
	const packageData = fs.readFileSync(path.join(repositoryRoot, 'package.json'));
	const archivePath = writeArchive(t, [
		{ name: 'package/package.json', data: packageData },
		{ name: 'package/package.json', data: packageData },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains duplicate entry: package\/package\.json/,
	);
});

test('rejects files outside the exact release manifest', (t) => {
	const archivePath = writeArchive(t, [
		{ name: 'package/unexpected.txt', data: Buffer.from('not distributable') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains unexpected entry: package\/unexpected\.txt/,
	);
});

test('rejects an allowed file whose bytes differ from tagged source', (t) => {
	const archivePath = writeArchive(
		t,
		EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
			name,
			data: name === 'package/lib/main.js'
				? Buffer.from('altered release code')
				: fs.readFileSync(path.join(repositoryRoot, name.slice('package/'.length))),
		})),
	);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry differs from tagged source: package\/lib\/main\.js/,
	);
});

test('rejects sensitive content inside an otherwise allowed release entry', () => {
	const unapprovedHostname = ['customer-site', 'invalid-host', 'com'].join('.');
	assert.throws(
		() => verifyArchiveContentSafety([{
			name: 'package/README.md',
			data: Buffer.from(`https://${unapprovedHostname}`),
		}]),
		/HOST_NOT_ALLOWED/,
	);
});

for (const [label, typeFlag, expectedMessage] of [
	['hard links', '1', 'hard link'],
	['symbolic links', '2', 'symbolic link'],
	['character devices', '3', 'character device'],
	['block devices', '4', 'block device'],
	['directories', '5', 'directory'],
	['FIFOs', '6', 'FIFO'],
]) {
	test(`rejects ${label}`, (t) => {
		const archivePath = writeArchive(t, [
		{
				name: 'package/package.json',
				typeFlag,
				linkName: typeFlag === '1' || typeFlag === '2' ? 'package/README.md' : '',
			},
		]);

		assert.throws(
			() => verifyReleasePackage(tag, archivePath),
			new RegExp(`Archive entry must be a regular file: package/package\\.json \\(type ${expectedMessage}\\)`),
		);
	});
}

function writeArchive(t, entries) {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-proxy-package-test-'));
	t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
	const archivePath = path.join(temporaryDirectory, archiveName);
	fs.writeFileSync(archivePath, gzipSync(createTar(entries)));
	return archivePath;
}

function createTar(entries) {
	const chunks = [];
	for (const entry of entries) {
		const typeFlag = entry.typeFlag ?? '0';
		const data = typeFlag === '0' || typeFlag === '\0'
			? Buffer.from(entry.data ?? '')
			: Buffer.alloc(0);
		const header = Buffer.alloc(512);

		writeString(header, 0, 100, entry.name);
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, data.length);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = typeFlag === '\0' ? 0 : typeFlag.charCodeAt(0);
		writeString(header, 157, 100, entry.linkName ?? '');
		writeString(header, 257, 6, 'ustar');
		writeString(header, 263, 2, '00');
		writeString(header, 265, 32, 'root');
		writeString(header, 297, 32, 'root');

		let checksum = 0;
		for (const byte of header) {
			checksum += byte;
		}
		const checksumField = `${checksum.toString(8).padStart(6, '0')}\0 `;
		header.write(checksumField, 148, 8, 'ascii');

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
