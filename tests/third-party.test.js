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

const {
	MAX_REVIEW_AGE_DAYS,
	verifyThirdParty,
} = require('../scripts/verify-third-party');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const REVIEW_DATE = new Date('2026-08-03T12:00:00.000Z');
const FIXTURE_PATHS = [
	'NOTICE',
	'package-lock.json',
	'package.json',
	'resources/cloudflare-origin-ca.pem',
	'src/renderer.ts',
	'style.css',
	'third-party-materials.json',
];

function createFixture(context) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-proxy-third-party-'));
	context.after(() => fs.rmSync(root, { force: true, recursive: true }));
	for (const relativePath of FIXTURE_PATHS) {
		const source = path.join(REPOSITORY_ROOT, relativePath);
		const destination = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(source, destination);
	}
	return root;
}

function readJson(root, relativePath) {
	return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(root, relativePath, value) {
	fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

test('verifies the complete third-party provenance contract offline', () => {
	const result = verifyThirdParty({ now: REVIEW_DATE });

	assert.deepEqual(result, {
		dependenciesChecked: 6,
		materialsChecked: 2,
		reviewedOn: '2026-08-03',
	});
	assert.equal(MAX_REVIEW_AGE_DAYS, 366);
});

test('rejects a changed Cloudflare Origin CA bundle', (context) => {
	const root = createFixture(context);
	fs.appendFileSync(path.join(root, 'resources/cloudflare-origin-ca.pem'), '\n');

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, root }),
		/Cloudflare Origin CA bundle SHA-256 has changed/,
	);
});

test('rejects stale provenance', (context) => {
	const root = createFixture(context);

	assert.throws(
		() => verifyThirdParty({
			now: new Date('2027-08-05T12:00:00.000Z'),
			root,
		}),
		/Third-party provenance is older than 366 days/,
	);
});

test('rejects future-dated provenance', (context) => {
	const root = createFixture(context);
	const provenance = readJson(root, 'third-party-materials.json');
	provenance.reviewedOn = '2026-08-04';
	writeJson(root, 'third-party-materials.json', provenance);

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, root }),
		/third-party-materials\.json reviewedOn cannot be in the future/,
	);
});

test('rejects an undeclared direct dependency', (context) => {
	const root = createFixture(context);
	const packageJson = readJson(root, 'package.json');
	packageJson.devDependencies['example-dev-tool'] = '1.0.0';
	writeJson(root, 'package.json', packageJson);

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, root }),
		/Direct dependency inventory does not match/,
	);
});

test('allows an unresolved optional peer supplied by the host', (context) => {
	const root = createFixture(context);
	const packageLock = readJson(root, 'package-lock.json');
	delete packageLock.packages['node_modules/react'];
	writeJson(root, 'package-lock.json', packageLock);
	const provenance = readJson(root, 'third-party-materials.json');
	const react = provenance.dependencies.find(({ name }) => name === 'react');
	react.resolvedVersion = null;
	react.license = null;
	react.licenseStatus = 'host-provided-unresolved';
	writeJson(root, 'third-party-materials.json', provenance);

	assert.doesNotThrow(() => verifyThirdParty({ now: REVIEW_DATE, root }));
});

test('rejects a missing locked development dependency', (context) => {
	const root = createFixture(context);
	const packageLock = readJson(root, 'package-lock.json');
	delete packageLock.packages['node_modules/typescript'];
	writeJson(root, 'package-lock.json', packageLock);

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, root }),
		/package-lock\.json is missing direct dependency typescript/,
	);
});

test('rejects missing required attribution', (context) => {
	const root = createFixture(context);
	const noticePath = path.join(root, 'NOTICE');
	const notice = fs.readFileSync(noticePath, 'utf8')
		.replace('Cloudflare is not affiliated with this project', 'Third-party publisher notice');
	fs.writeFileSync(noticePath, notice);

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, root }),
		/NOTICE is missing required attribution: Cloudflare is not affiliated with this project/,
	);
});

test('rejects repository-only provenance files in the installer', (context) => {
	const root = createFixture(context);
	const packageJson = readJson(root, 'package.json');
	const packagedFiles = [...packageJson.files, 'third-party-materials.json'];

	assert.throws(
		() => verifyThirdParty({ now: REVIEW_DATE, packagedFiles, root }),
		/Repository-only provenance file must not be packaged/,
	);
});
