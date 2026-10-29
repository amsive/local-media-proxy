/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const sdkRequire = createRequire(require.resolve('@getflywheel/local/package.json'));
const utilsPath = sdkRequire.resolve('@graphql-tools/utils');

test('locks the Local SDK to the patched GraphQL Tools dependency', () => {
	const packageJson = require('../package.json');
	const packageLock = require('../package-lock.json');
	const lockedUtils = Object.entries(packageLock.packages)
		.filter(([name]) => name.endsWith('/@graphql-tools/utils'));

	assert.equal(packageJson.overrides['@getflywheel/local']['@graphql-tools/utils'], '12.0.2');
	assert.ok(lockedUtils.length > 0);
	for (const [, { version, dev }] of lockedUtils) {
		assert.equal(version, '12.0.2');
		assert.equal(dev, true);
	}
});

test('GraphQL mergeDeep merges safe data without traversing prototype keys', () => {
	const result = spawnSync(process.execPath, ['-e', `
		const assert = require('node:assert/strict');
		const { mergeDeep } = require(${JSON.stringify(utilsPath)});
		const prototypes = [Object.prototype, Function.prototype];
		const descriptors = prototypes.map(Object.getOwnPropertyDescriptors);
		const unsafe = JSON.parse('{"constructor":{"prototype":{"graphqlPolluted":true},"__proto__":{"graphqlPolluted":true}},"__proto__":{"graphqlPolluted":true},"prototype":{"graphqlPolluted":true}}');

		assert.deepEqual(
			mergeDeep([{ shared: { fieldA: 'local' } }, { shared: { fieldB: 'origin' } }]),
			{ shared: { fieldA: 'local', fieldB: 'origin' } },
		);
		const merged = mergeDeep([{ shared: unsafe }, { shared: unsafe }]);
		assert.deepEqual(merged, { shared: {} });
		assert.equal(Object.getPrototypeOf(merged.shared), Object.prototype);
		prototypes.forEach((prototype, index) => {
			assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), descriptors[index]);
		});
	`], {
		cwd: path.resolve(__dirname, '..'),
		encoding: 'utf8',
		timeout: 10000,
	});

	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});
