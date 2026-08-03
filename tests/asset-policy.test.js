/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	BLOCKED_UPLOAD_ASSET_PATH_PATTERN,
	UPLOAD_ASSET_ROUTE_REVISION,
	UPLOAD_ASSET_URI_PATTERN,
	uploadAssetPathIsProxyEligible,
} = require('../lib/asset-policy');

test('allows current media, documents, data, and unknown future upload formats', () => {
	const allowedPaths = [
		'/wp-content/uploads/2026/08/photo.avif',
		'/wp-content/uploads/photo.webp',
		'/wp-content/uploads/photo.gif',
		'/wp-content/uploads/photo.jpeg',
		'/wp-content/uploads/photo.png',
		'/wp-content/uploads/photo.tiff',
		'/wp-content/uploads/photo.heic',
		'/wp-content/uploads/vector.svg',
		'/wp-content/uploads/vector.SVGZ',
		'/wp-content/uploads/photo.jxl',
		'/wp-content/uploads/movie.mp4',
		'/wp-content/uploads/movie.webm',
		'/wp-content/uploads/movie.mov',
		'/wp-content/uploads/movie.m4v',
		'/wp-content/uploads/movie.ogv',
		'/wp-content/uploads/audio.mp3',
		'/wp-content/uploads/audio.wav',
		'/wp-content/uploads/audio.m4a',
		'/wp-content/uploads/audio.aac',
		'/wp-content/uploads/audio.ogg',
		'/wp-content/uploads/audio.flac',
		'/wp-content/uploads/captions.vtt',
		'/wp-content/uploads/captions.srt',
		'/wp-content/uploads/captions.dfxp',
		'/wp-content/uploads/download.pdf',
		'/wp-content/uploads/document.rtf',
		'/wp-content/uploads/document.docx',
		'/wp-content/uploads/workbook.xlsx',
		'/wp-content/uploads/slides.pptx',
		'/wp-content/uploads/archive.zip',
		'/wp-content/uploads/archive.tar',
		'/wp-content/uploads/archive.gz',
		'/wp-content/uploads/archive.7z',
		'/wp-content/uploads/archive.tar.gz',
		'/wp-content/uploads/design.psd',
		'/wp-content/uploads/generated.css',
		'/wp-content/uploads/font.woff2',
		'/wp-content/uploads/data.json',
		'/wp-content/uploads/data.xml',
		'/wp-content/uploads/data.csv',
		'/wp-content/uploads/calendar.ics',
		'/wp-content/uploads/stream.m3u8',
		'/wp-content/uploads/stream.mpd',
		'/wp-content/uploads/new-format.futuremedia',
		'/wp-content/uploads/photo%41.webp',
		'/wp-content/uploads/report%2Dfinal.pdf',
	];

	for (const requestPath of allowedPaths) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), true, requestPath);
	}
	assert.equal(UPLOAD_ASSET_ROUTE_REVISION, 'upload-assets-v2');
});

test('blocks interpreter tokens even when a safe-looking extension follows them', () => {
	for (const requestPath of [
		'/wp-content/uploads/shell.php.jpg',
		'/wp-content/uploads/shell.PHP82.webp',
		'/wp-content/uploads/shell.php;.jpg',
		'/wp-content/uploads/shell.php%3B.jpg',
		'/wp-content/uploads/payload.phtml.pdf',
		'/wp-content/uploads/payload.pht.pdf',
		'/wp-content/uploads/archive.phar.zip',
		'/wp-content/uploads/task.cgi.png',
		'/wp-content/uploads/script.py.svg',
		'/wp-content/uploads/run-bash.mp4',
		'/wp-content/uploads/handler.aspx.avif',
		'/wp-content/uploads/template.cfm.jxl',
	]) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
});

test('blocks browser-active, executable, secret, configuration, database, and backup files', () => {
	for (const requestPath of [
		'/wp-content/uploads/index.html',
		'/wp-content/uploads/app.js',
		'/wp-content/uploads/module.mjs',
		'/wp-content/uploads/program.wasm',
		'/wp-content/uploads/legacy.swf',
		'/wp-content/uploads/program.exe',
		'/wp-content/uploads/program.class',
		'/wp-content/uploads/library.dll',
		'/wp-content/uploads/plugin.so',
		'/wp-content/uploads/package.jar',
		'/wp-content/uploads/secrets.env',
		'/wp-content/uploads/server.ini',
		'/wp-content/uploads/web.config',
		'/wp-content/uploads/database.sqlite3',
		'/wp-content/uploads/database.sql',
		'/wp-content/uploads/site.backup',
		'/wp-content/uploads/site.bak',
	]) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
});

test('rejects hidden, extensionless, malformed, encoded traversal, and ambiguous paths', () => {
	for (const requestPath of [
		'wp-content/uploads/photo.jpg',
		'/other/uploads/photo.jpg',
		'/wp-content/uploads/',
		'/wp-content/uploads/no-extension',
		'/wp-content/uploads/trailing.',
		'/wp-content/uploads/.env',
		'/wp-content/uploads/.hidden/photo.jpg',
		'/wp-content/uploads/../secret.jpg',
		'/wp-content/uploads/%2e%2e/secret.jpg',
		'/wp-content/uploads/%252e%252e/secret.jpg',
		'/wp-content/uploads/a%2fb.jpg',
		'/wp-content/uploads/a%5cb.jpg',
		'/wp-content/uploads/a%20photo.webp',
		'/wp-content/uploads/photo%2541.jpg',
		'/wp-content/uploads/photo%00.jpg',
		'/wp-content/uploads/photo%1f.jpg',
		'/wp-content/uploads/photo%zz.jpg',
		'/wp-content/uploads//photo.jpg',
		'/wp-content/uploads/photo.jpg?cache=1',
		'/wp-content/uploads/photo.jpg#preview',
		'/wp-content/uploads/photo\\name.jpg',
	]) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
});

test('exports compatible route and block patterns for both server generators', () => {
	const route = new RegExp(UPLOAD_ASSET_URI_PATTERN, 'i');
	const blocked = new RegExp(BLOCKED_UPLOAD_ASSET_PATH_PATTERN, 'i');

	assert.equal(route.test('/wp-content/uploads/new.futuremedia'), true);
	assert.equal(route.test('/wp-content/uploads/download.pdf'), true);
	assert.equal(route.test('/wp-content/uploads/no-extension'), false);
	assert.equal(route.test('/wp-content/uploads/.hidden.pdf'), false);
	assert.equal(blocked.test('/wp-content/uploads/shell.php.jpg'), true);
	assert.equal(blocked.test('/wp-content/uploads/shell.php;.jpg'), true);
	assert.equal(blocked.test('/wp-content/uploads/app.js'), true);
	assert.equal(blocked.test('/wp-content/uploads/document.pdf'), false);
	assert.equal(blocked.test('/wp-content/uploads/vector.svg'), false);
	for (const delimiter of ['.', '-', '_', '~', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '=', ':', '@']) {
		const requestPath = `/wp-content/uploads/shell${delimiter}php${delimiter}.jpg`;
		assert.equal(route.test(requestPath), true, requestPath);
		assert.equal(blocked.test(requestPath), true, requestPath);
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
	assert.equal(
		blocked.test(decodeURIComponent('/wp-content/uploads/shell.php%3B.jpg')),
		true,
	);
});
