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

test('uses exact release filenames as their visible GitHub asset labels', () => {
	const releaseWorkflow = readWorkflow('release.yml');
	const promotionWorkflow = readWorkflow('promote-release.yml');

	assert.ok(releaseWorkflow.includes('archive_name="$(basename "${RELEASE_ARCHIVE}")"'));
	assert.ok(releaseWorkflow.includes('checksum_name="$(basename "${RELEASE_CHECKSUM}")"'));
	assert.ok(releaseWorkflow.includes('"${RELEASE_ARCHIVE}#${archive_name}"'));
	assert.ok(releaseWorkflow.includes('"${RELEASE_CHECKSUM}#${checksum_name}"'));
	assert.doesNotMatch(releaseWorkflow, /#Local Media Proxy .* installable add-on/);
	assert.doesNotMatch(releaseWorkflow, /#SHA-256 checksum/);
	assert.match(releaseWorkflow, /--json assets,isDraft,isPrerelease,tagName/);
	assert.match(releaseWorkflow, /\[\.assets\[\] \| \{name, label\}\] \| sort_by\(\.name\)/);
	assert.match(releaseWorkflow, /\{name: \$archive, label: \$archive\}/);
	assert.match(releaseWorkflow, /\{name: \$checksum, label: \$checksum\}/);
	assert.match(releaseWorkflow, /"\$\{asset_pairs_json\}" != "\$\{expected_asset_pairs_json\}"/);
	assert.equal((promotionWorkflow.match(/^\s*asset_pairs_json=/gm) ?? []).length, 2);
	assert.equal((promotionWorkflow.match(/^\s*expected_asset_pairs_json=/gm) ?? []).length, 2);
	assert.equal(
		(promotionWorkflow.match(/"\$\{asset_pairs_json\}" != "\$\{expected_asset_pairs_json\}"/g) ?? []).length,
		2,
	);
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
	assert.equal((workflow.match(/^\s*asset_pairs_json=/gm) ?? []).length, 2);
	assert.equal((workflow.match(/^\s*expected_asset_pairs_json=/gm) ?? []).length, 2);
	assert.match(workflow, /The prerelease asset labels and download names must be exactly/);
	assert.match(workflow, /Release asset labels or download names changed after verification; refusing promotion/);
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
