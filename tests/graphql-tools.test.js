/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mergeIncrementalResult } = require('@graphql-tools/utils');

test('locks every GraphQL Tools utils installation to the reviewed security fix', () => {
	const packageJson = require('../package.json');
	const lock = JSON.parse(
		fs.readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8'),
	);
	const installations = Object.entries(lock.packages).filter(([name]) =>
		name.endsWith('node_modules/@graphql-tools/utils'),
	);

	assert.equal(packageJson.overrides['@getflywheel/local']['@graphql-tools/utils'], '12.0.2');
	assert.ok(installations.length > 0);
	for (const [name, { version, dev: developmentOnly }] of installations) {
		assert.equal(version, '12.0.2', name);
		assert.equal(developmentOnly, true, name);
	}
});

test('rejects prototype-polluting incremental paths without mutating results', () => {
	const prototypeKeys = Object.getOwnPropertyNames(Object.prototype);
	const pollutionKey = 'localMediaProxyPolluted';
	assert.equal(Object.hasOwn(Object.prototype, pollutionKey), false);

	try {
		for (const forbidden of ['__proto__', 'constructor', 'prototype']) {
			for (const segment of [
				forbidden,
				[forbidden],
				{ toString: () => forbidden },
			]) {
				for (const keyPath of [[segment, pollutionKey], ['nested', segment]]) {
					for (const patch of [
						{ path: keyPath, data: { [pollutionKey]: true } },
						{ path: keyPath, items: [{ [pollutionKey]: true }, 'second'] },
						{ incremental: [{ path: keyPath, data: { [pollutionKey]: true } }] },
					]) {
						const executionResult = { data: {} };
						mergeIncrementalResult({ executionResult, incrementalResult: patch });
						assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototypeKeys);
						assert.equal(({}).localMediaProxyPolluted, undefined);
						assert.deepEqual(executionResult, { data: {} });
					}
				}
			}
		}
	} finally {
		delete Object.prototype[pollutionKey];
	}
});

test('preserves valid deferred and streamed incremental results', () => {
	const executionResult = { data: {} };
	mergeIncrementalResult({
		executionResult,
		incrementalResult: {
			incremental: [
				{ path: ['site'], data: { name: 'Example' } },
				{ path: ['site'], data: { enabled: true } },
				{ path: ['assets', 0], items: ['first', 'second'] },
			],
		},
	});

	assert.deepEqual(executionResult, {
		data: {
			site: { name: 'Example', enabled: true },
			assets: ['first', 'second'],
		},
	});
});
