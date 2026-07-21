/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readWorkflow = (name) => fs.readFileSync(
	path.resolve(__dirname, '../.github/workflows', name),
	'utf8',
);

test('creates ordinary SemVer tags as draft prerelease candidates', () => {
	const workflow = readWorkflow('release.yml');

	assert.match(workflow, /- "v\*\.\*\.\*"/);
	assert.doesNotMatch(workflow, /\n\s+- "v[^"]*-release"/);
	assert.match(workflow, /\n\s+--draft\n/);
	assert.match(workflow, /\n\s+--prerelease\n/);
	assert.match(workflow, /\n\s+--latest=false\n/);
	assert.doesNotMatch(workflow, /--prerelease="?\$\{/);
	assert.match(workflow, /\.isDraft[^\n]+!= "true"/);
	assert.match(workflow, /\.isPrerelease[^\n]+!= "true"/);
	assert.match(workflow, /git merge-base --is-ancestor "\$\{GITHUB_SHA\}\^\{commit\}" origin\/main/);
	assert.match(workflow, /archive="dist\/local-media-proxy-v\$\{version\}\.tgz"/);
	assert.match(workflow, /RELEASE_ARCHIVE: dist\/local-media-proxy-v\$\{\{ needs\.build\.outputs\.version \}\}\.tgz/);
	assert.match(workflow, /RELEASE_CHECKSUM: dist\/local-media-proxy-v\$\{\{ needs\.build\.outputs\.version \}\}\.tgz\.sha256/);
});

test('requires an explicit human promotion with candidate identity binding', () => {
	const workflow = readWorkflow('promote-release.yml');

	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /confirmation:/);
	assert.equal(
		(workflow.match(/"\$\{CONFIRMATION\}" != "PROMOTE \$\{TAG\}"/g) ?? []).length,
		2,
	);
	assert.match(workflow, /name: release-approval/);
	assert.match(workflow, /EXPECTED_ARCHIVE_ASSET_ID/);
	assert.match(workflow, /EXPECTED_ARCHIVE_SHA256/);
	assert.match(workflow, /EXPECTED_CHECKSUM_ASSET_ID/);
	assert.match(workflow, /EXPECTED_CHECKSUM_SHA256/);
	assert.match(workflow, /EXPECTED_RELEASE_ID/);
	assert.match(workflow, /EXPECTED_TAG_OBJECT_SHA/);
	assert.match(workflow, /EXPECTED_TAG_COMMIT_SHA/);
	assert.equal(
		(workflow.match(/\[\[ ! "\$\{TAG\}" =~ \^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$ \]\]/g) ?? []).length,
		2,
	);
	assert.equal((workflow.match(/version="\$\{TAG#v\}"/g) ?? []).length, 2);
	assert.equal(
		(workflow.match(/archive="local-media-proxy-v\$\{version\}\.tgz"/g) ?? []).length,
		2,
	);
	assert.equal((workflow.match(/checksum="\$\{archive\}\.sha256"/g) ?? []).length, 2);
	assert.equal((workflow.match(/^\s*asset_names_json=/gm) ?? []).length, 2);
	assert.equal((workflow.match(/^\s*expected_asset_names_json=/gm) ?? []).length, 2);
	assert.match(workflow, /The prerelease assets must be exactly/);
	assert.match(workflow, /Release assets changed after verification; refusing promotion/);
	assert.match(workflow, /node scripts\/verify-release-package\.js "\$\{TAG\}" "\$\{assets_dir\}\/\$\{archive\}"/);
	assert.doesNotMatch(workflow, /version="\$\{version%-release\}"/);
	assert.match(workflow, /git merge-base --is-ancestor "\$\{TAG\}\^\{commit\}" origin\/main/);
	assert.match(workflow, /npm run build/);
	assert.match(workflow, /git rev-parse "\$\{TAG\}\^\{tag\}"/);
	assert.match(workflow, /git rev-parse "\$\{TAG\}\^\{commit\}"/);
	assert.match(workflow, /git rev-parse HEAD/);
	assert.match(workflow, /git\/tags\/\$\{tag_object_sha\}/);
	assert.doesNotMatch(workflow, /releases\/tags\/\$\{TAG\}/);
	assert.match(workflow, /--draft=false --prerelease=false --latest/);
	assert.match(workflow, /releases\/latest/);
});
