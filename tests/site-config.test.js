/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	applyManagedFiles,
	captureManagedFiles,
	getManagedPaths,
	managedArtifactsExist,
	managedFilesMatch,
	removeManagedFiles,
	removeManagedFilesSync,
	restoreManagedFiles,
} = require('../lib/site-config');
const { validateAndNormalizeOrigin } = require('../lib/validation');

async function makeSite() {
	const siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-'));
	const nginxRoot = path.join(siteRoot, 'conf', 'nginx');
	await fs.mkdir(path.join(nginxRoot, 'includes'), { recursive: true });
	const original = 'server {\n    #\n    # WordPress Rules\n    #\n    location / {}\n}\n';
	await fs.writeFile(path.join(nginxRoot, 'site.conf.hbs'), original);

	return {
		cleanup: () => fs.rm(siteRoot, { force: true, recursive: true }),
		original,
		site: {
			id: 'test-site',
			longPath: siteRoot,
			path: siteRoot,
			paths: { confTemplates: path.join(siteRoot, 'conf') },
			services: { nginx: { name: 'nginx' } },
		},
	};
}

test('applies and fully removes managed site files', async () => {
	const fixture = await makeSite();
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const changed = await applyManagedFiles(
			fixture.site,
			origin,
			trustBundle,
		);
		const paths = getManagedPaths(fixture.site);

		assert.equal(changed, true);
		assert.equal(await managedArtifactsExist(fixture.site), true);
		assert.equal(await managedFilesMatch(fixture.site, origin, trustBundle), true);
		assert.match(await fs.readFile(paths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /proxy_ssl_verify on/);
		assert.match(await fs.readFile(paths.trustBundle, 'utf8'), /BEGIN CERTIFICATE/);

		assert.equal(await removeManagedFiles(fixture.site), true);
		assert.equal(await managedArtifactsExist(fixture.site), false);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
		await assert.rejects(fs.access(paths.includeTemplate));
		await assert.rejects(fs.access(paths.trustBundle));
	} finally {
		await fixture.cleanup();
	}
});

test('replaces the HTTPS trust bundle without accumulating certificates', async () => {
	const fixture = await makeSite();
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const firstBundle = '-----BEGIN CERTIFICATE-----\nZmlyc3Q=\n-----END CERTIFICATE-----\n';
		const replacementBundle = '-----BEGIN CERTIFICATE-----\nc2Vjb25k\n-----END CERTIFICATE-----\n';
		const paths = getManagedPaths(fixture.site);

		assert.equal(await applyManagedFiles(fixture.site, origin, firstBundle), true);
		const firstBytes = await fs.readFile(paths.trustBundle);
		assert.equal(await applyManagedFiles(fixture.site, origin, firstBundle), false);
		assert.deepEqual(await fs.readFile(paths.trustBundle), firstBytes);

		assert.equal(await removeManagedFiles(fixture.site), true);
		await assert.rejects(fs.access(paths.trustBundle));
		assert.equal(await applyManagedFiles(fixture.site, origin, firstBundle), true);
		assert.deepEqual(await fs.readFile(paths.trustBundle), firstBytes);

		assert.equal(await applyManagedFiles(fixture.site, origin, replacementBundle), true);
		assert.equal(await fs.readFile(paths.trustBundle, 'utf8'), replacementBundle);
	} finally {
		await fixture.cleanup();
	}
});

test('supports legacy Local sites whose raw path uses a home-directory shortcut', async () => {
	const fixture = await makeSite();
	try {
		const customized = `${fixture.original}# custom legacy rule\n`;
		await fs.writeFile(
			path.join(fixture.site.longPath, 'conf', 'nginx', 'site.conf.hbs'),
			customized,
		);
		const legacySite = {
			...fixture.site,
			path: ['~', 'Local Sites', 'example-site'].join('/'),
		};
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';

		await applyManagedFiles(legacySite, origin, trustBundle);
		assert.equal(await managedArtifactsExist(legacySite), true);
		await removeManagedFiles(legacySite);
		assert.equal(
			await fs.readFile(getManagedPaths(legacySite).siteTemplate, 'utf8'),
			customized,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('detects drift and supports synchronous lifecycle cleanup', async () => {
	const fixture = await makeSite();
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		await applyManagedFiles(fixture.site, origin, trustBundle);
		const paths = getManagedPaths(fixture.site);
		const splitTlsOrigin = validateAndNormalizeOrigin({
			originEnvironment: 'production',
			originIp: '192.0.2.20',
			originSource: 'wpengine',
			originTlsHostname: 'origin.wpengine.com',
			siteUrl: 'https://origin.example.com',
		});
		assert.equal(await managedFilesMatch(fixture.site, splitTlsOrigin, trustBundle), false);

		await fs.writeFile(paths.includeTemplate, '# manually changed\n');
		assert.equal(await managedFilesMatch(fixture.site, origin, trustBundle), false);
		assert.equal(removeManagedFilesSync(fixture.site), true);
		assert.equal(await managedArtifactsExist(fixture.site), false);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
	} finally {
		await fixture.cleanup();
	}
});

test('refuses configuration paths outside the Local site root', async () => {
	const fixture = await makeSite();
	try {
		assert.throws(
			() => getManagedPaths({
				...fixture.site,
				paths: { confTemplates: path.join(os.tmpdir(), 'outside-site') },
			}),
			/unsafe Nginx configuration path/,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('refuses managed paths whose existing parent symlink escapes the site root', async () => {
	const fixture = await makeSite();
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-outside-'));
	try {
		const paths = getManagedPaths(fixture.site);
		await fs.rm(path.dirname(paths.includeTemplate), { recursive: true });
		await fs.symlink(outsideRoot, path.dirname(paths.includeTemplate), 'dir');

		assert.throws(
			() => getManagedPaths(fixture.site),
			/symbolic link/,
		);
	} finally {
		await fixture.cleanup();
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('continues restoring later snapshots after one file fails', async () => {
	const fixture = await makeSite();
	try {
		const snapshots = await captureManagedFiles(fixture.site);
		const paths = getManagedPaths(fixture.site);
		await fs.writeFile(paths.siteTemplate, 'changed\n');
		const blockedPath = path.join(fixture.site.path, 'blocked-directory');
		await fs.mkdir(blockedPath);

		await assert.rejects(
			restoreManagedFiles([
				{ content: Buffer.from('cannot replace directory'), filePath: blockedPath },
				...snapshots,
			]),
			AggregateError,
		);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
	} finally {
		await fixture.cleanup();
	}
});

test('removes orphaned managed artifacts when the Nginx site template is absent', async () => {
	const fixture = await makeSite();
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		await applyManagedFiles(
			fixture.site,
			origin,
			'-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
		);
		const paths = getManagedPaths(fixture.site);
		await fs.rm(paths.siteTemplate);

		assert.equal(await removeManagedFiles(fixture.site), true);
		await assert.rejects(fs.access(paths.includeTemplate));
		await assert.rejects(fs.access(paths.trustBundle));
	} finally {
		await fixture.cleanup();
	}
});
