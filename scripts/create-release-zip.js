/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { crc32 } = require('./verify-public-release');
const {
	EXPECTED_ARCHIVE_ENTRIES,
	PACKAGE_ROOT,
	parseTarGzip,
} = require('./verify-release-package');

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
const MAX_ARCHIVE_SIZE = 25 * 1024 * 1024;

function createReleaseZip(inputArgument, outputArgument) {
	assert(
		inputArgument,
		'Usage: node scripts/create-release-zip.js <npm-package.tgz> [output.zip]',
	);

	const repositoryRoot = path.join(__dirname, '..');
	const packageJson = JSON.parse(
		fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
	);
	const inputPath = path.resolve(repositoryRoot, inputArgument);
	const expectedOutputName = `${packageJson.name}-${packageJson.version}.zip`;
	const outputPath = outputArgument
		? path.resolve(repositoryRoot, outputArgument)
		: path.join(repositoryRoot, 'dist', expectedOutputName);

	assert(fs.existsSync(inputPath), `Input archive does not exist: ${inputPath}`);
	assert(
		fs.statSync(inputPath).isFile(),
		`Input archive path must be a regular file: ${inputPath}`,
	);
	assert(
		fs.statSync(inputPath).size <= MAX_ARCHIVE_SIZE,
		`Input archive exceeds the ${MAX_ARCHIVE_SIZE}-byte size limit.`,
	);
	assert.equal(
		path.basename(outputPath),
		expectedOutputName,
		`Output archive must be named ${expectedOutputName}.`,
	);

	const sourceEntries = parseTarGzip(fs.readFileSync(inputPath));
	const actualSourceNames = sourceEntries.map((entry) => entry.name);
	assert.equal(
		new Set(actualSourceNames).size,
		actualSourceNames.length,
		'Input archive contains duplicate entries.',
	);

	const expectedSourceNames = EXPECTED_ARCHIVE_ENTRIES.map(
		(name) => `package/${name.slice(PACKAGE_ROOT.length)}`,
	);
	assert.deepEqual(
		[...actualSourceNames].sort(),
		[...expectedSourceNames].sort(),
		'Input archive does not match the exact release manifest.',
	);

	const zipEntries = sourceEntries.map((entry) => ({
		data: entry.data,
		name: `${PACKAGE_ROOT}${entry.name.slice('package/'.length)}`,
	}));
	const archive = createDeterministicZip(zipEntries);
	assert(
		archive.length <= MAX_ARCHIVE_SIZE,
		`ZIP archive exceeds the ${MAX_ARCHIVE_SIZE}-byte size limit.`,
	);

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, archive);
	console.log(
		`Created ${path.relative(repositoryRoot, outputPath)} with ${zipEntries.length} files under ${PACKAGE_ROOT}`,
	);
	return outputPath;
}

function createDeterministicZip(entries) {
	const sortedEntries = [...entries].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	const names = sortedEntries.map((entry) => entry.name);
	assert.equal(new Set(names).size, names.length, 'ZIP entries must have unique paths.');

	const localChunks = [];
	const centralChunks = [];
	let localOffset = 0;

	for (const entry of sortedEntries) {
		assert(
			EXPECTED_ARCHIVE_ENTRIES.includes(entry.name),
			`ZIP entry is outside the release manifest: ${entry.name}`,
		);
		const name = Buffer.from(entry.name, 'utf8');
		const data = Buffer.from(entry.data);
		assert(name.length <= 0xffff, `ZIP entry name is too long: ${entry.name}`);
		assert(data.length <= 0xffffffff, `ZIP entry is too large: ${entry.name}`);
		const checksum = crc32(data);

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
		localHeader.writeUInt16LE(ZIP_VERSION, 4);
		localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
		localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8);
		localHeader.writeUInt16LE(ZIP_DOS_TIME, 10);
		localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(0, 28);
		localChunks.push(localHeader, name, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
		centralHeader.writeUInt16LE(ZIP_VERSION_MADE_BY, 4);
		centralHeader.writeUInt16LE(ZIP_VERSION, 6);
		centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
		centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10);
		centralHeader.writeUInt16LE(ZIP_DOS_TIME, 12);
		centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE((ZIP_REGULAR_FILE_MODE * 0x10000) >>> 0, 38);
		centralHeader.writeUInt32LE(localOffset, 42);
		centralChunks.push(centralHeader, name);

		localOffset += localHeader.length + name.length + data.length;
	}

	assert(sortedEntries.length <= 0xffff, 'ZIP contains too many entries.');
	const centralDirectory = Buffer.concat(centralChunks);
	const endRecord = Buffer.alloc(22);
	endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
	endRecord.writeUInt16LE(0, 4);
	endRecord.writeUInt16LE(0, 6);
	endRecord.writeUInt16LE(sortedEntries.length, 8);
	endRecord.writeUInt16LE(sortedEntries.length, 10);
	endRecord.writeUInt32LE(centralDirectory.length, 12);
	endRecord.writeUInt32LE(localOffset, 16);
	endRecord.writeUInt16LE(0, 20);

	return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}

if (require.main === module) {
	createReleaseZip(...process.argv.slice(2));
}

module.exports = {
	createDeterministicZip,
	createReleaseZip,
};
