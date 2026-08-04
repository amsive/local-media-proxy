/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	BLOCKED_BROWSER_FETCH_DESTINATION_PATTERN,
	BLOCKED_UPLOAD_ASSET_PATH_PATTERN,
	UPLOAD_ASSET_ROUTE_REVISION,
	UPLOAD_ASSET_URI_PATTERN,
	uploadAssetFetchDestinationIsProxyEligible,
	uploadAssetPathIsProxyEligible,
} = require('../lib/asset-policy');

test('allows current media, documents, data, and unknown future upload formats', () => {
	const allowedPaths = [
		'/wp-content/uploads/photo.jpg',
		'/wp-content/uploads/2026/08/photo.avif',
		'/wp-content/uploads/photo.webp',
		'/wp-content/uploads/photo.gif',
		'/wp-content/uploads/photo.jpeg',
		'/wp-content/uploads/photo.jpe',
		'/wp-content/uploads/photo.png',
		'/wp-content/uploads/photo.bmp',
		'/wp-content/uploads/photo.tiff',
		'/wp-content/uploads/photo.tif',
		'/wp-content/uploads/favicon.ico',
		'/wp-content/uploads/photo.heic',
		'/wp-content/uploads/photo.heif',
		'/wp-content/uploads/photo.heics',
		'/wp-content/uploads/photo.heifs',
		'/wp-content/uploads/vector.svg',
		'/wp-content/uploads/vector.SVGZ',
		'/wp-content/uploads/photo.jxl',
		'/wp-content/uploads/movie.mp4',
		'/wp-content/uploads/movie.webm',
		'/wp-content/uploads/movie.mov',
		'/wp-content/uploads/movie.m4v',
		'/wp-content/uploads/movie.ogv',
		'/wp-content/uploads/movie.avi',
		'/wp-content/uploads/movie.divx',
		'/wp-content/uploads/movie.flv',
		'/wp-content/uploads/movie.mpeg',
		'/wp-content/uploads/movie.mkv',
		'/wp-content/uploads/movie.3gp',
		'/wp-content/uploads/movie.asf',
		'/wp-content/uploads/movie.asx',
		'/wp-content/uploads/movie.wmv',
		'/wp-content/uploads/movie.wmx',
		'/wp-content/uploads/movie.wm',
		'/wp-content/uploads/movie.qt',
		'/wp-content/uploads/movie.mpg',
		'/wp-content/uploads/movie.mpe',
		'/wp-content/uploads/movie.3gpp',
		'/wp-content/uploads/movie.3g2',
		'/wp-content/uploads/movie.3gp2',
		'/wp-content/uploads/audio.mp3',
		'/wp-content/uploads/audio.wav',
		'/wp-content/uploads/audio.m4a',
		'/wp-content/uploads/audio.aac',
		'/wp-content/uploads/audio.ogg',
		'/wp-content/uploads/audio.flac',
		'/wp-content/uploads/audio.m4b',
		'/wp-content/uploads/audio.oga',
		'/wp-content/uploads/audio.midi',
		'/wp-content/uploads/audio.wma',
		'/wp-content/uploads/audio.mka',
		'/wp-content/uploads/audio.ra',
		'/wp-content/uploads/audio.ram',
		'/wp-content/uploads/audio.x-wav',
		'/wp-content/uploads/audio.mid',
		'/wp-content/uploads/audio.wax',
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
		'/wp-content/uploads/data.tsv',
		'/wp-content/uploads/calendar.ics',
		'/wp-content/uploads/readme.txt',
		'/wp-content/uploads/stream.m3u8',
		'/wp-content/uploads/stream.mpd',
		'/wp-content/uploads/new-format.futuremedia',
		'/wp-content/uploads/design.xcf',
		'/wp-content/uploads/document.odt',
		'/wp-content/uploads/workbook.ods',
		'/wp-content/uploads/slides.odp',
		'/wp-content/uploads/document.pages',
		'/wp-content/uploads/workbook.numbers',
		'/wp-content/uploads/photo%41.webp',
		'/wp-content/uploads/report%2Dfinal.pdf',
		'/wp-content/uploads/html-guide.pdf',
		'/wp-content/uploads/node-js-handbook.pdf',
		'/wp-content/uploads/wasm-talk.mp4',
		'/wp-content/uploads/app/image.jpg',
		'/wp-content/uploads/config/image.jpg',
		'/wp-content/uploads/js/image.jpg',
	];

	for (const requestPath of allowedPaths) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), true, requestPath);
	}
	assert.equal(UPLOAD_ASSET_ROUTE_REVISION, 'upload-assets-v3');
});

test('allows passive/core Fetch Metadata destinations and rejects browser execution destinations', () => {
	for (const destination of [
		undefined,
		null,
		'',
		' ',
		'audio',
		'document',
		'empty',
		'embed',
		'fencedframe',
		'font',
		'frame',
		'iframe',
		'image',
		'json',
		'manifest',
		'object',
		'report',
		'style',
		'track',
		'video',
	]) {
		assert.equal(uploadAssetFetchDestinationIsProxyEligible(destination), true, destination);
	}

	for (const destination of [
		'audioworklet',
		'paintworklet',
		'script',
		'SCRIPT',
		'serviceworker',
		'sharedworker',
		'worker',
		'xslt',
		'image, script',
	]) {
		assert.equal(uploadAssetFetchDestinationIsProxyEligible(destination), false, destination);
	}

	const blockedDestination = new RegExp(BLOCKED_BROWSER_FETCH_DESTINATION_PATTERN, 'i');
	assert.equal(blockedDestination.test('image'), false);
	assert.equal(blockedDestination.test('image, script'), true);
	assert.equal(blockedDestination.test('scripted'), false);
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
		'/wp-content/uploads/task.fcgi.png',
		'/wp-content/uploads/task.scgi.png',
		'/wp-content/uploads/script.py.svg',
		'/wp-content/uploads/script.vbs.svg',
		'/wp-content/uploads/script.wsf.svg',
		'/wp-content/uploads/run-bash.mp4',
		'/wp-content/uploads/handler.aspx.avif',
		'/wp-content/uploads/template.cfm.jxl',
		'/wp-content/uploads/shell.php123.jpg',
		'/wp-content/uploads/shell.PHP12345/image.jpg',
		'/wp-content/uploads/shell.php/image.jpg',
	]) {
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
});

test('blocks browser-active, executable, secret, configuration, database, and backup files', () => {
	for (const requestPath of [
		'/wp-content/uploads/index.html',
		'/wp-content/uploads/index.dhtml',
		'/wp-content/uploads/index.shtm',
		'/wp-content/uploads/index.stm',
		'/wp-content/uploads/index.xhtm',
		'/wp-content/uploads/index.html.futuremedia',
		'/wp-content/uploads/app.js',
		'/wp-content/uploads/app.js.futuremedia',
		'/wp-content/uploads/module.mjs',
		'/wp-content/uploads/program.wasm',
		'/wp-content/uploads/program.wasm.futuremedia',
		'/wp-content/uploads/legacy.swf',
		'/wp-content/uploads/application.hta',
		'/wp-content/uploads/program.exe',
		'/wp-content/uploads/program.appimage',
		'/wp-content/uploads/program.run',
		'/wp-content/uploads/program.scr',
		'/wp-content/uploads/program.cpl',
		'/wp-content/uploads/program.ocx',
		'/wp-content/uploads/program.sys',
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
		'/wp-content/uploads/photo.jpg:preview.futuremedia',
		'/wp-content/uploads/photo.jpg%3Apreview.futuremedia',
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
	assert.equal(blocked.test('/wp-content/uploads/index.dhtml'), true);
	assert.equal(blocked.test('/wp-content/uploads/index.shtm'), true);
	assert.equal(blocked.test('/wp-content/uploads/index.stm'), true);
	assert.equal(blocked.test('/wp-content/uploads/index.xhtm'), true);
	assert.equal(blocked.test('/wp-content/uploads/app.js.futuremedia'), true);
	assert.equal(blocked.test('/wp-content/uploads/script.fcgi.jpg'), true);
	assert.equal(blocked.test('/wp-content/uploads/script.php/image.jpg'), true);
	assert.equal(blocked.test('/wp-content/uploads/script.php123/image.jpg'), true);
	assert.equal(blocked.test('/wp-content/uploads/program.appimage'), true);
	assert.equal(blocked.test('/wp-content/uploads/html-guide.pdf'), false);
	assert.equal(blocked.test('/wp-content/uploads/node-js-handbook.pdf'), false);
	assert.equal(blocked.test('/wp-content/uploads/wasm-talk.mp4'), false);
	for (const requestPath of [
		'/wp-content/uploads/app/image.jpg',
		'/wp-content/uploads/config/image.jpg',
		'/wp-content/uploads/js/image.jpg',
	]) {
		assert.equal(route.test(requestPath), true, requestPath);
		assert.equal(blocked.test(requestPath), false, requestPath);
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), true, requestPath);
	}
	assert.equal(blocked.test('/wp-content/uploads/document.pdf'), false);
	assert.equal(blocked.test('/wp-content/uploads/vector.svg'), false);
	for (const delimiter of ['.', '-', '_', '~', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '=', '@']) {
		const requestPath = `/wp-content/uploads/shell${delimiter}php${delimiter}.jpg`;
		assert.equal(route.test(requestPath), true, requestPath);
		assert.equal(blocked.test(requestPath), true, requestPath);
		assert.equal(uploadAssetPathIsProxyEligible(requestPath), false, requestPath);
	}
	assert.equal(route.test('/wp-content/uploads/shell:php:.jpg'), false);
	assert.equal(
		blocked.test(decodeURIComponent('/wp-content/uploads/shell.php%3B.jpg')),
		true,
	);
});
