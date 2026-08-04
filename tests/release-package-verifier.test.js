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
	PACKAGE_ROOT,
	parseTarGzip,
	verifyArchiveContentSafety,
	verifyReleasePackage,
} = require('../scripts/verify-release-package');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
	fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const tag = `v${packageJson.version}`;
const archiveName = `${packageJson.name}-v${packageJson.version}.tgz`;

test('accepts only the complete 28-file npm-style TGZ release manifest', (t) => {
	assert.equal(EXPECTED_ARCHIVE_ENTRIES.length, 28);
	const archivePath = writeTarGzip(t, releaseEntries());

	const entries = verifyReleasePackage(tag, archivePath);
	assert.deepEqual(
		entries.map((entry) => entry.name),
		EXPECTED_ARCHIVE_ENTRIES,
	);
	assert(entries.every((entry) => entry.name.startsWith(PACKAGE_ROOT)));
	assert(entries.every((entry) => !entry.name.endsWith('.map')));
	assert(!entries.some((entry) => entry.name === `${PACKAGE_ROOT}lib/types.js`));
});

test('parses the npm package root without a versioned directory', (t) => {
	const archivePath = writeTarGzip(t, releaseEntries());
	const entries = parseTarGzip(fs.readFileSync(archivePath));

	assert(entries.every((entry) => entry.name.startsWith('package/')));
	assert(entries.every((entry) => !entry.name.startsWith(`package-${packageJson.version}/`)));
});

test('requires the exact v-prefixed installer filename', (t) => {
	const archivePath = writeTarGzip(
		t,
		releaseEntries(),
		`${packageJson.name}-${packageJson.version}.tgz`,
	);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		new RegExp(`Archive must be named ${packageJson.name}-v${packageJson.version}\\.tgz`),
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
	const archivePath = writeTarGzip(t, [
		{ name: `${PACKAGE_ROOT}package.json`, data: packageData },
		{ name: `${PACKAGE_ROOT}package.json`, data: packageData },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains duplicate entry: package\/package\.json/,
	);
});

test('rejects traversal paths', (t) => {
	const archivePath = writeTarGzip(t, [
		{ name: `${PACKAGE_ROOT}../outside.txt`, data: Buffer.from('not distributable') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry contains traversal or an empty segment/,
	);
});

test('rejects files outside the npm package root', (t) => {
	const archivePath = writeTarGzip(t, [
		{ name: 'outside/package.json', data: Buffer.from('{}') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry is outside package\//,
	);
});

test('rejects files outside the exact release manifest', (t) => {
	const archivePath = writeTarGzip(t, [
		{ name: `${PACKAGE_ROOT}unexpected.txt`, data: Buffer.from('not distributable') },
	]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains unexpected entry: package\/unexpected\.txt/,
	);
});

test('rejects a missing release file', (t) => {
	const missingName = EXPECTED_ARCHIVE_ENTRIES.at(-1);
	const archivePath = writeTarGzip(
		t,
		releaseEntries().filter((entry) => entry.name !== missingName),
	);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		new RegExp(`Archive is missing expected entry: ${escapeRegularExpression(missingName)}`),
	);
});

test('rejects non-regular tar entries', (t) => {
	const archivePath = writeTarGzip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.alloc(0),
		typeFlag: '2'.charCodeAt(0),
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry must be a regular file: package\/package\.json \(type symbolic link\)/,
	);
});

test('rejects an invalid tar header checksum', (t) => {
	const archivePath = writeTarGzip(t, [{
		name: `${PACKAGE_ROOT}package.json`,
		data: Buffer.from('{}'),
		invalidChecksum: true,
	}]);

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive entry 1 has an invalid tar checksum/,
	);
});

test('rejects data after the tar end marker', (t) => {
	const archivePath = writeTarGzip(t, releaseEntries(), archiveName, {
		trailingData: Buffer.from('trailing'),
	});

	assert.throws(
		() => verifyReleasePackage(tag, archivePath),
		/Archive contains data after its tar end marker/,
	);
});

test('rejects an allowed file whose bytes differ from tagged source', (t) => {
	const archivePath = writeTarGzip(
		t,
		releaseEntries().map((entry) => entry.name === `${PACKAGE_ROOT}lib/main.js`
			? { ...entry, data: Buffer.from('altered release code') }
			: entry),
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
			name: `${PACKAGE_ROOT}README.md`,
			data: Buffer.from(`https://${unapprovedHostname}`),
		}]),
		/HOST_NOT_ALLOWED/,
	);
});

test('package content safety rejects embedded placeholder words and accepts whole placeholders', () => {
	const credentialField = ['pass', 'word'].join('');
	const embeddedValue = ['prod', 'example', 'A7k9Q2m4Z8x6'].join('_');
	assert.throws(
		() => verifyArchiveContentSafety([{
			name: `${PACKAGE_ROOT}README.md`,
			data: Buffer.from(`${credentialField}=${embeddedValue}`),
		}]),
		/SECRET_GENERIC_LITERAL/,
	);

	assert.doesNotThrow(() => verifyArchiveContentSafety([{
		name: `${PACKAGE_ROOT}README.md`,
		data: Buffer.from(`${credentialField}="placeholder-value"`),
	}]));
});

function releaseEntries() {
	return EXPECTED_ARCHIVE_ENTRIES.map((name) => ({
		name,
		data: fs.readFileSync(path.join(repositoryRoot, name.slice(PACKAGE_ROOT.length))),
	}));
}

function writeTarGzip(t, entries, filename = archiveName, options = {}) {
	const temporaryDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), 'local-media-proxy-package-test-'),
	);
	t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
	const archivePath = path.join(temporaryDirectory, filename);
	fs.writeFileSync(archivePath, gzipSync(createTar(entries, options)));
	return archivePath;
}

function createTar(entries, options = {}) {
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
		header[156] = entry.typeFlag ?? '0'.charCodeAt(0);
		writeString(header, 257, 6, 'ustar');
		writeString(header, 263, 2, '00');
		writeString(header, 265, 32, 'root');
		writeString(header, 297, 32, 'root');

		let checksum = 0;
		for (const byte of header) {
			checksum += byte;
		}
		header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
		if (entry.invalidChecksum) {
			header.write('000000\0 ', 148, 8, 'ascii');
		}
		chunks.push(header, data);
		const paddingLength = (512 - (data.length % 512)) % 512;
		if (paddingLength > 0) {
			chunks.push(Buffer.alloc(paddingLength));
		}
	}
	chunks.push(Buffer.alloc(1024), options.trailingData ?? Buffer.alloc(0));
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

function escapeRegularExpression(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
