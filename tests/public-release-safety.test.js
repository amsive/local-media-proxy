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
const { execFileSync } = require('node:child_process');

const {
	crc32,
	loadPolicy,
	scanPublicRelease,
	sha256,
} = require('../scripts/verify-public-release');

const repositoryRoot = path.resolve(__dirname, '..');
const basePolicy = loadPolicy(path.join(repositoryRoot, 'public-release-policy.json'));

test('accepts reviewed assets and synthetic public-safe network data', (t) => {
	const fixture = createFixture(t);
	const png = createPng();
	writeFixture(fixture, 'README.md', [
		'https://example.com',
		'https://example-site.wpengine.com',
		'https://www.amsive.com/',
		'192.0.2.10',
		'127.0.0.1',
		'2001:db8::10',
	].join('\n'));
	writeFixture(fixture, 'art/screenshot.png', png);
	writeFixture(
		fixture,
		'art/icon.svg',
		'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
	);

	const result = scanFixture(fixture, [
		manifestAsset('art/screenshot.png', png, 'png'),
		manifestAsset('art/icon.svg', fs.readFileSync(path.join(fixture, 'art/icon.svg')), 'svg'),
	]);
	assert.deepEqual(result.findings, []);
});

test('permits only synthetic, GitHub noreply, and explicitly approved role addresses', (t) => {
	const fixture = createFixture(t);
	const syntheticAddress = ['fixture-contributor', 'example.com'].join('@');
	const noreplyAddress = ['12345+fixture-contributor', 'users.noreply.github.com'].join('@');
	const roleAddress = ['open-source', 'company.invalid'].join('@');
	const individualAddress = ['individual-contributor', 'company.invalid'].join('@');
	const quotedIndividualAddress = [
		`"${['individual', 'contributor'].join('.')}"`,
		'company.invalid',
	].join('@');
	const policy = {
		...basePolicy,
		allowedEmailAddresses: [...basePolicy.allowedEmailAddresses, roleAddress],
	};
	writeFixture(fixture, 'approved.txt', [
		syntheticAddress,
		noreplyAddress,
		roleAddress,
	].join('\n'));
	writeFixture(fixture, 'individual.txt', [
		individualAddress,
		quotedIndividualAddress,
	].join('\n'));

	const findings = scanFixture(fixture, [], policy).findings;
	assert.equal(
		findings.filter(({ path: findingPath, rule }) =>
			findingPath === 'approved.txt' && rule === 'INDIVIDUAL_EMAIL_NOT_ALLOWED').length,
		0,
	);
	assert.equal(
		findings.filter(({ path: findingPath, rule }) =>
			findingPath === 'individual.txt' && rule === 'INDIVIDUAL_EMAIL_NOT_ALLOWED').length,
		2,
	);
});

test('rejects common secret patterns, URL credentials, and personal paths', (t) => {
	const fixture = createFixture(t);
	const awsKey = 'AKIA' + 'A'.repeat(16);
	const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
	const personalPath = ['/', 'Users', 'project-owner', 'Client Work', 'notes.txt'].join('/');
	const genericSecret = ['client', 'secret'].join('_') + '="this-is-a-real-looking-value"';
	const jsonSecrets = JSON.stringify({
		[['client', 'secret'].join('_')]: ['actual', 'sensitive', 'value', '12345'].join('-'),
		[['pass', 'word'].join('')]: ['another', 'sensitive', 'value', '67890'].join('-'),
	});
	const databaseUrl = 'postgres://' + 'database-user:database-pass' + '@example.com/app';
	const homeShortcut = ['~', 'Local Sites', 'customer-name', 'app'].join('/');
	writeFixture(fixture, 'unsafe.txt', [
		awsKey,
		privateKey,
		'https://' + 'build-user:build-pass' + '@example.com',
		personalPath,
		genericSecret,
		jsonSecrets,
		databaseUrl,
		homeShortcut,
	].join('\n'));

	const rules = findingRules(scanFixture(fixture));
	assert(rules.has('SECRET_AWS_ACCESS_KEY'));
	assert(rules.has('SECRET_PRIVATE_KEY'));
	assert(rules.has('URL_CREDENTIALS'));
	assert.equal(scanFixture(fixture).findings.filter(({ rule }) => rule === 'PERSONAL_PATH').length, 2);
	assert.equal(scanFixture(fixture).findings.filter(({ rule }) => rule === 'SECRET_GENERIC_LITERAL').length, 3);
});

test('accepts only constrained whole-value placeholders for credential fields', (t) => {
	const fixture = createFixture(t);
	const credentialField = ['pass', 'word'].join('');
	const embeddedPlaceholderValues = [
		'change-me',
		'example',
		'placeholder',
		'not-a-secret',
		'test-only',
		'dummy',
	].map((word) => ['prod', word, 'A7k9Q2m4Z8x6'].join('_'));
	const wholePlaceholderValues = [
		'change-me',
		'example-value',
		'placeholder-value',
		'not-a-secret',
		'test-only',
		'dummy-value',
		'$' + '{LOCAL_MEDIA_PROXY_PASSWORD}',
		'{' + '{ local_media_proxy.password }}',
		'$' + '{{ secrets.LOCAL_MEDIA_PROXY_PASSWORD }}',
	];
	writeFixture(
		fixture,
		'embedded-placeholder-values.txt',
		embeddedPlaceholderValues.map((value) => `${credentialField}=${value}`).join('\n'),
	);
	writeFixture(
		fixture,
		'whole-placeholder-values.txt',
		wholePlaceholderValues.map((value) => `${credentialField}=${JSON.stringify(value)}`).join('\n'),
	);

	const findings = scanFixture(fixture).findings;
	assert.equal(
		findings.filter(({ path: findingPath, rule }) =>
			findingPath === 'embedded-placeholder-values.txt' && rule === 'SECRET_GENERIC_LITERAL').length,
		embeddedPlaceholderValues.length,
	);
	assert.equal(
		findings.filter(({ path: findingPath }) => findingPath === 'whole-placeholder-values.txt').length,
		0,
	);
});

test('rejects external hostnames and public IP addresses unless exactly approved', (t) => {
	const fixture = createFixture(t);
	const clientHostname = ['client-project', 'invalid-public-host', 'com'].join('.');
	const uncommonTldUrl = 'https://' + ['client-project', 'public-leak', 'xyz'].join('.');
	const invalidInternalUrl = 'https://' + ['client_project', 'internal'].join('.');
	const agencyHostname = ['client-project', 'agency'].join('.');
	const photographyHostname = ['client-project', 'photography'].join('.');
	const solutionsHostname = ['customer', 'solutions'].join('.');
	const publicIpv4 = [8, 8, 4, 4].join('.');
	const publicIpv6 = ['2606', '4700', '4700', '0', '0', '0', '0', '1111'].join(':');
	writeFixture(fixture, 'network.txt', [
		clientHostname,
		uncommonTldUrl,
		invalidInternalUrl,
		agencyHostname,
		photographyHostname,
		`server_name ${solutionsHostname};`,
		publicIpv4,
		publicIpv6,
	].join('\n'));

	const findings = scanFixture(fixture).findings;
	assert.equal(findings.filter(({ rule }) => rule === 'HOST_NOT_ALLOWED').length, 6);
	assert.equal(findings.filter(({ rule }) => rule === 'PUBLIC_IP_NOT_ALLOWED').length, 2);
});

test('does not confuse dotted code properties and filenames with hostnames', (t) => {
	const fixture = createFixture(t);
	writeFixture(fixture, 'source.txt', [
		'const currentSite = fixture.site;',
		'const installName = install.name;',
		'const joined = path.join(root, child);',
		"const template = 'site.conf.hbs';",
		"const manifest = 'package.json';",
	].join('\n'));

	assert.deepEqual(scanFixture(fixture).findings, []);
});

test('rejects private, carrier-grade, link-local, and unique-local infrastructure addresses', (t) => {
	const fixture = createFixture(t);
	writeFixture(fixture, 'private-network.txt', [
		[10, 42, 17, 3].join('.'),
		[100, 64, 20, 1].join('.'),
		[169, 254, 18, 4].join('.'),
		[172, 20, 4, 8].join('.'),
		[192, 168, 17, 99].join('.'),
		['fd12', '3456', '789a', '', '42'].join(':'),
	].join('\n'));

	const findings = scanFixture(fixture).findings;
	assert.equal(findings.filter(({ rule }) => rule === 'PUBLIC_IP_NOT_ALLOWED').length, 6);
});

test('requires an exact reviewed hash for binary assets', (t) => {
	const fixture = createFixture(t);
	const png = createPng();
	writeFixture(fixture, 'unreviewed.png', png);

	let result = scanFixture(fixture);
	assert(findingRules(result).has('BINARY_UNMANIFESTED'));

	result = scanFixture(fixture, [{
		...manifestAsset('unreviewed.png', png, 'png'),
		sha256: '0'.repeat(64),
	}]);
	assert(findingRules(result).has('ASSET_HASH_MISMATCH'));
});

test('rejects archive, office, and database assets without explicit dangerous approval', (t) => {
	const fixture = createFixture(t);
	const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
	const environment = Buffer.from('PUBLIC_FIXTURE=true\n');
	writeFixture(fixture, 'bundle.zip', zip);
	writeFixture(fixture, '.env.production', environment);
	writeFixture(fixture, 'records.sqlite', Buffer.from('SQLite format 3\0fixture'));

	const assets = [
		manifestAsset('bundle.zip', zip, 'archive'),
		manifestAsset('.env.production', environment, 'environment'),
		manifestAsset('records.sqlite', fs.readFileSync(path.join(fixture, 'records.sqlite')), 'database'),
	];
	let result = scanFixture(fixture, assets);
	assert.equal(result.findings.filter(({ rule }) => rule === 'DANGEROUS_ASSET').length, 3);

	result = scanFixture(fixture, assets.map((asset) => ({ ...asset, allowDangerous: true })));
	assert.deepEqual(result.findings, []);
});

test('rejects PNG metadata chunks and bytes after IEND', (t) => {
	const fixture = createFixture(t);
	const withMetadata = createPng([{ type: 'tEXt', data: Buffer.from('Comment\0internal') }]);
	const withTrailingData = Buffer.concat([createPng(), Buffer.from('trailing')]);
	writeFixture(fixture, 'metadata.png', withMetadata);
	writeFixture(fixture, 'trailing.png', withTrailingData);

	const result = scanFixture(fixture, [
		manifestAsset('metadata.png', withMetadata, 'png'),
		manifestAsset('trailing.png', withTrailingData, 'png'),
	]);
	const rules = findingRules(result);
	assert(rules.has('PNG_UNSAFE_METADATA'));
	assert(rules.has('PNG_TRAILING_DATA'));
});

test('rejects SVG scripts, event handlers, and external references', (t) => {
	const fixture = createFixture(t);
	const svg = [
		'<svg xmlns="http://www.w3.org/2000/svg">',
		'<script>void 0</script>',
		'<image href="https://example.com/image.png" onload="void 0"/>',
		'</svg>',
	].join('');
	writeFixture(fixture, 'active.svg', svg);

	const result = scanFixture(fixture, [
		manifestAsset('active.svg', Buffer.from(svg), 'svg'),
	]);
	const rules = findingRules(result);
	assert(rules.has('SVG_ACTIVE_CONTENT'));
	assert(rules.has('SVG_EXTERNAL_REFERENCE'));
});

test('applies a finding exception only to the exact path, rule, and match hash', (t) => {
	const fixture = createFixture(t);
	const credentialUrl = 'https://' + 'fixture-user:fixture-pass' + '@example.com';
	writeFixture(fixture, 'expected.txt', credentialUrl);
	writeFixture(fixture, 'other.txt', credentialUrl);

	const policy = {
		...basePolicy,
		exactFindingAllowlist: [{
			path: 'expected.txt',
			rule: 'URL_CREDENTIALS',
			matchSha256: sha256(Buffer.from(credentialUrl)),
			reason: 'Synthetic fixture proves the exception is exact.',
		}],
	};
	const result = scanFixture(fixture, [], policy);
	const credentialFindings = result.findings.filter(({ rule }) => rule === 'URL_CREDENTIALS');
	assert.equal(credentialFindings.length, 1);
	assert.equal(credentialFindings[0].path, 'other.txt');
});

test('includes untracked, non-ignored files in a repository safety scan', (t) => {
	const fixture = createFixture(t);
	execFileSync('git', ['init', '--quiet'], { cwd: fixture });
	writeFixture(fixture, 'tracked.txt', 'safe example.com');
	execFileSync('git', ['add', 'tracked.txt'], { cwd: fixture });
	const unapprovedHostname = ['untracked-client', 'invalid-host', 'com'].join('.');
	writeFixture(fixture, 'untracked.txt', `https://${unapprovedHostname}`);

	const result = scanPublicRelease({
		assetManifest: { version: 1, assets: [] },
		policy: basePolicy,
		requireManifestCompleteness: false,
		root: fixture,
		useGitTrackedFiles: true,
	});
	assert(result.findings.some(({ path: findingPath, rule }) =>
		findingPath === 'untracked.txt' && rule === 'HOST_NOT_ALLOWED',
	));
});

test('scans both staged index bytes and different working-tree bytes', (t) => {
	const fixture = createFixture(t);
	execFileSync('git', ['init', '--quiet'], { cwd: fixture });
	const unapprovedHostname = ['staged-client', 'invalid-host', 'com'].join('.');
	writeFixture(fixture, 'config.json', 'https://example.com');
	execFileSync('git', ['add', 'config.json'], { cwd: fixture });
	writeFixture(fixture, 'config.json', `https://${unapprovedHostname}`);

	let result = scanPublicRelease({
		assetManifest: { version: 1, assets: [] },
		policy: basePolicy,
		requireManifestCompleteness: false,
		root: fixture,
		useGitTrackedFiles: true,
	});
	assert(result.findings.some(({ path: findingPath, rule }) =>
		findingPath === 'config.json' && rule === 'HOST_NOT_ALLOWED',
	));

	writeFixture(fixture, 'config.json', `https://${unapprovedHostname}`);
	execFileSync('git', ['add', 'config.json'], { cwd: fixture });
	writeFixture(fixture, 'config.json', 'https://example.com');
	result = scanPublicRelease({
		assetManifest: { version: 1, assets: [] },
		policy: basePolicy,
		requireManifestCompleteness: false,
		root: fixture,
		useGitTrackedFiles: true,
	});
	assert(result.findings.some(({ path: findingPath, rule }) =>
		findingPath === 'config.json' && rule === 'HOST_NOT_ALLOWED',
	));
});

function createFixture(t) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'public-release-safety-'));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	return fixture;
}

function writeFixture(root, relativePath, content) {
	const filePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function scanFixture(root, assets = [], policy = basePolicy) {
	return scanPublicRelease({
		assetManifest: { version: 1, assets },
		policy,
		requireManifestCompleteness: true,
		root,
		useGitTrackedFiles: false,
	});
}

function manifestAsset(assetPath, content, kind) {
	return {
		path: assetPath,
		sha256: sha256(content),
		kind,
		reviewedForPublicRelease: 'Synthetic regression fixture reviewed for this test.',
	};
}

function findingRules(result) {
	return new Set(result.findings.map(({ rule }) => rule));
}

function createPng(extraChunks = []) {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const chunks = [
		pngChunk('IHDR', ihdr),
		...extraChunks.map(({ type, data }) => pngChunk(type, data)),
		pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x00, 0x01, 0x04, 0x01, 0x00])),
		pngChunk('IEND', Buffer.alloc(0)),
	];
	return Buffer.concat([signature, ...chunks]);
}

function pngChunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
	return chunk;
}
