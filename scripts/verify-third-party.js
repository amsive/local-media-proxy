/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const MAX_REVIEW_AGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPECTED_MATERIAL_IDS = Object.freeze([
	'cloudflare-origin-ca-roots',
	'local-components-loading-indicator',
]);
const REQUIRED_NOTICE_TEXT = Object.freeze([
	'Cloudflare, Inc.',
	'https://creativecommons.org/licenses/by/4.0/',
	'https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem',
	'https://developers.cloudflare.com/ssl/static/origin_ca_ecc_root.pem',
	'certificate bytes are otherwise unchanged',
	'Cloudflare is not affiliated with this project',
	'@getflywheel/local-components 17.8.1',
	'Copyright (c) 2018-present, Fancy Chap, Inc.',
]);
const REPOSITORY_ONLY_PATHS = Object.freeze([
	'third-party-materials.json',
	'docs/third-party-provenance.md',
]);

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

function uniqueBy(items, key, label) {
	const values = items.map((item) => item[key]);
	assert.equal(new Set(values).size, values.length, `${label} contains a duplicate ${key}.`);
	return new Map(items.map((item) => [item[key], item]));
}

function assertSameValues(actual, expected, label) {
	assert.deepEqual(
		[...actual].sort(),
		[...expected].sort(),
		`${label} does not match the required values.`,
	);
}

function declaredDependencies(packageJson) {
	const declarations = new Map();
	for (const [scope, dependencies] of [
		['dev', packageJson.devDependencies ?? {}],
		['peer', packageJson.peerDependencies ?? {}],
	]) {
		for (const [name, version] of Object.entries(dependencies)) {
			const declared = declarations.get(name) ?? {};
			declared[scope] = version;
			declarations.set(name, declared);
		}
	}
	return declarations;
}

function verifyReviewDate(reviewedOn, now) {
	assert(
		/^\d{4}-\d{2}-\d{2}$/.test(reviewedOn),
		'third-party-materials.json reviewedOn must use YYYY-MM-DD.',
	);
	const reviewedAt = new Date(`${reviewedOn}T00:00:00.000Z`);
	assert(!Number.isNaN(reviewedAt.valueOf()), 'third-party-materials.json reviewedOn is invalid.');
	const ageMs = now.valueOf() - reviewedAt.valueOf();
	assert(ageMs >= -DAY_MS, 'third-party-materials.json reviewedOn cannot be in the future.');
	assert(
		ageMs <= MAX_REVIEW_AGE_DAYS * DAY_MS,
		`Third-party provenance is older than ${MAX_REVIEW_AGE_DAYS} days and must be reviewed.`,
	);
}

function verifyCloudflareMaterial(root, material, packageJson, notice, now) {
	assert.equal(material.kind, 'certificate-bundle');
	assert.equal(material.publisher, 'Cloudflare, Inc.');
	assert.equal(material.distributed, true);
	assert.equal(material.noticeRequired, true);
	assert.equal(material.licenseBasis?.name, 'Creative Commons Attribution 4.0 International');
	assert.equal(material.licenseBasis?.url, 'https://creativecommons.org/licenses/by/4.0/');
	assert.equal(
		material.licenseBasis?.publisherStatementUrl,
		'https://github.com/cloudflare/cloudflare-docs#license-and-legal-notices',
	);
	assertSameValues(material.repositoryPaths, ['resources/cloudflare-origin-ca.pem'], 'Cloudflare repository paths');
	assertSameValues(material.packagePaths, ['resources/cloudflare-origin-ca.pem'], 'Cloudflare package paths');
	assertSameValues(material.sourceUrls, [
		'https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem',
		'https://developers.cloudflare.com/ssl/static/origin_ca_ecc_root.pem',
	], 'Cloudflare source URLs');

	const bundlePath = path.join(root, material.repositoryPaths[0]);
	const bundle = fs.readFileSync(bundlePath);
	assert.equal(sha256(bundle), material.sha256, 'Cloudflare Origin CA bundle SHA-256 has changed.');
	const certificates = bundle.toString('utf8').match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
	) ?? [];
	assert.equal(certificates.length, 2, 'Cloudflare Origin CA bundle must contain exactly two certificates.');
	const parsedCertificates = certificates.map((certificate) => new X509Certificate(certificate));
	assertSameValues(
		parsedCertificates.map((certificate) => certificate.fingerprint256),
		material.certificateFingerprintsSha256,
		'Cloudflare certificate fingerprints',
	);
	for (const certificate of parsedCertificates) {
		assert(
			new Date(certificate.validTo).valueOf() > now.valueOf(),
			`Cloudflare Origin CA certificate ${certificate.fingerprint256} has expired.`,
		);
	}

	assert(packageJson.files.includes(material.packagePaths[0]), 'Cloudflare Origin CA bundle must remain packaged.');
	assert.match(
		material.modifications,
		/concatenated[\s\S]*otherwise unchanged/i,
		'Cloudflare material must document its exact modification.',
	);
	assert.match(material.purpose, /Cloudflare Origin Certificates/);
	for (const sourceUrl of material.sourceUrls) {
		assert(notice.includes(sourceUrl), `NOTICE is missing Cloudflare source ${sourceUrl}.`);
	}
}

function verifyLoadingIndicatorMaterial(root, material, packageJson, notice) {
	assert.equal(material.kind, 'adapted-source');
	assert.equal(material.publisher, 'Fancy Chap, Inc.');
	assert.equal(material.distributed, true);
	assert.equal(material.sourcePackage, '@getflywheel/local-components');
	assert.equal(material.sourceVersion, '17.8.1');
	assert.equal(material.licenseBasis?.name, 'MIT');
	assert.equal(material.noticeRequired, true);
	assertSameValues(material.repositoryPaths, ['src/renderer.ts', 'style.css'], 'LoadingIndicator repository paths');
	assertSameValues(material.packagePaths, ['lib/renderer.js', 'style.css'], 'LoadingIndicator package paths');
	for (const repositoryPath of material.repositoryPaths) {
		assert(fs.statSync(path.join(root, repositoryPath)).isFile(), `Missing adapted source path: ${repositoryPath}`);
	}
	for (const packagePath of material.packagePaths) {
		assert(packageJson.files.includes(packagePath), `Adapted LoadingIndicator path must remain packaged: ${packagePath}`);
	}
	const stylesheet = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
	assert.match(stylesheet, /Scoped adaptation of the Gray LoadingIndicator/);
	assert.match(stylesheet, /@getflywheel\/local-components 17\.8\.1/);
	assert.match(notice, /MIT License[\s\S]*Fancy Chap, Inc\./);
}

function verifyDependencies(manifest, packageJson, packageLock) {
	assert.deepEqual(packageJson.dependencies ?? {}, {}, 'The installer must not declare runtime dependencies.');
	const actualDeclarations = declaredDependencies(packageJson);
	const manifestDependencies = uniqueBy(manifest.dependencies, 'name', 'third-party dependencies');
	assertSameValues(manifestDependencies.keys(), actualDeclarations.keys(), 'Direct dependency inventory');

	for (const [name, declared] of actualDeclarations) {
		const dependency = manifestDependencies.get(name);
		assert.deepEqual(dependency.declared, declared, `Declared versions have changed for ${name}.`);
		assert.equal(dependency.distributed, false, `${name} must remain non-distributed.`);
		const locked = packageLock.packages?.[`node_modules/${name}`];
		assert(locked, `package-lock.json is missing direct dependency ${name}.`);
		assert.equal(dependency.resolvedVersion, locked.version, `Resolved version has changed for ${name}.`);
		if (locked.license) {
			assert.equal(dependency.license, locked.license, `License metadata has changed for ${name}.`);
			assert.equal(dependency.licenseStatus, 'declared', `${name} must record declared license metadata.`);
		} else {
			assert.equal(dependency.license, null, `${name} must not invent unavailable license metadata.`);
			assert.equal(
				dependency.licenseStatus,
				'metadata-unavailable',
				`${name} must record unavailable license metadata explicitly.`,
			);
		}
		assert.match(dependency.relationship, /\S/, `${name} must document its relationship to the project.`);
	}
}

function verifyPackagedFiles(packagedFiles, materials) {
	const packagedFileSet = new Set(packagedFiles);
	for (const material of materials) {
		if (!material.distributed) {
			continue;
		}
		for (const packagePath of material.packagePaths) {
			assert(packagedFileSet.has(packagePath), `Installer is missing third-party material: ${packagePath}`);
		}
	}
	for (const repositoryOnlyPath of REPOSITORY_ONLY_PATHS) {
		assert(
			!packagedFileSet.has(repositoryOnlyPath),
			`Repository-only provenance file must not be packaged: ${repositoryOnlyPath}`,
		);
	}
	assert(
		![...packagedFileSet].some((name) => name === 'node_modules' || name.startsWith('node_modules/')),
		'Installer must not contain dependencies or a node_modules tree.',
	);
	assert(packagedFileSet.has('NOTICE'), 'Installer must retain NOTICE attribution.');
}

function verifyThirdParty(options = {}) {
	const root = path.resolve(options.root ?? REPOSITORY_ROOT);
	const now = options.now ?? new Date();
	assert(now instanceof Date && !Number.isNaN(now.valueOf()), 'Verification time must be a valid Date.');

	const manifest = readJson(path.join(root, 'third-party-materials.json'));
	const packageJson = readJson(path.join(root, 'package.json'));
	const packageLock = readJson(path.join(root, 'package-lock.json'));
	const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');
	const normalizedNotice = notice.replace(/\s+/g, ' ');
	assert.equal(manifest.schemaVersion, 1, 'Unsupported third-party material schema version.');
	verifyReviewDate(manifest.reviewedOn, now);
	assert.equal(packageJson.private, true, 'package.json must remain private to prevent accidental npm publication.');
	assert.equal(packageJson.license, 'Apache-2.0');

	const materials = uniqueBy(manifest.materials, 'id', 'third-party materials');
	assertSameValues(materials.keys(), EXPECTED_MATERIAL_IDS, 'Third-party material inventory');
	for (const requiredText of REQUIRED_NOTICE_TEXT) {
		assert(
			normalizedNotice.includes(requiredText.replace(/\s+/g, ' ')),
			`NOTICE is missing required attribution: ${requiredText}`,
		);
	}
	verifyCloudflareMaterial(root, materials.get('cloudflare-origin-ca-roots'), packageJson, notice, now);
	verifyLoadingIndicatorMaterial(root, materials.get('local-components-loading-indicator'), packageJson, notice);
	verifyDependencies(manifest, packageJson, packageLock);

	for (const repositoryOnlyPath of REPOSITORY_ONLY_PATHS) {
		assert(
			!packageJson.files.includes(repositoryOnlyPath),
			`Repository-only provenance file must not be listed in package.json: ${repositoryOnlyPath}`,
		);
	}
	verifyPackagedFiles(options.packagedFiles ?? packageJson.files, manifest.materials);

	return {
		dependenciesChecked: manifest.dependencies.length,
		materialsChecked: manifest.materials.length,
		reviewedOn: manifest.reviewedOn,
	};
}

function runCli() {
	try {
		const result = verifyThirdParty();
		console.log(
			`Verified ${result.materialsChecked} third-party materials and `
			+ `${result.dependenciesChecked} direct dependencies (reviewed ${result.reviewedOn}).`,
		);
		return 0;
	} catch (error) {
		console.error(`Third-party material verification failed: ${error.message}`);
		return 1;
	}
}

if (require.main === module) {
	process.exitCode = runCli();
}

module.exports = {
	MAX_REVIEW_AGE_DAYS,
	REPOSITORY_ONLY_PATHS,
	runCli,
	verifyPackagedFiles,
	verifyThirdParty,
};
