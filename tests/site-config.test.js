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
	applyServerManagedFiles,
	allManagedArtifactsExist,
	apacheSnapshotHasCompleteManagedConfig,
	captureAllManagedFiles,
	captureManagedFiles,
	getApacheManagedPaths,
	getManagedPaths,
	managedArtifactsExist,
	managedFilesMatch,
	removeManagedFiles,
	removeAllManagedFiles,
	removeAllManagedFilesSync,
	removeManagedFilesSync,
	restoreManagedFiles,
	serverManagedFilesMatch,
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

async function makeDualServerSite() {
	const fixture = await makeSite();
	const apacheRoot = path.join(fixture.site.longPath, 'conf', 'apache');
	await fs.mkdir(path.join(apacheRoot, 'includes'), { recursive: true });
	const apacheMain = [
		'# human global',
		'<VirtualHost *:80>',
		'\t# human vhost',
		'</VirtualHost>',
		'',
	].join('\n');
	const apacheModules = '# human modules\nLoadModule rewrite_module "modules/mod_rewrite.so"\n';
	const serviceRoot = path.join(fixture.site.longPath, 'service', 'apache-2.4.43+11', 'bin', 'darwin-arm64');
	const httpd = path.join(serviceRoot, 'bin', 'httpd');
	await fs.mkdir(path.join(serviceRoot, 'bin'), { recursive: true });
	await fs.mkdir(path.join(serviceRoot, 'modules'), { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(apacheRoot, 'apache2.conf.hbs'), '# official global template\n'),
		fs.writeFile(path.join(apacheRoot, 'modules.conf.hbs'), apacheModules),
		fs.writeFile(path.join(apacheRoot, 'site.conf.hbs'), apacheMain),
		fs.writeFile(httpd, ''),
		...['mod_proxy_http.so', 'mod_headers.so', 'mod_ssl.so'].map((filename) => (
			fs.writeFile(path.join(serviceRoot, 'modules', filename), '')
		)),
	]);
	return {
		...fixture,
		apacheMain,
		apacheModules,
		httpd,
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
			/unsafe web-server configuration path/,
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

test('applies, matches, snapshots, restores, and removes only persistent Apache templates', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const options = {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		};

		assert.equal(await applyServerManagedFiles(fixture.site, origin, options, trustBundle), true);
		assert.equal(await allManagedArtifactsExist(fixture.site), true);
		assert.equal(await serverManagedFilesMatch(fixture.site, origin, options, trustBundle), true);
		assert.match(await fs.readFile(paths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
		assert.match(await fs.readFile(paths.modulesTemplate, 'utf8'), /mod_proxy_http\.so/);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /ProxyRequests Off/);
		assert.equal(paths.siteTemplate.startsWith(path.join(fixture.site.longPath, 'conf', 'apache')), true);
		assert.doesNotMatch(paths.siteTemplate, /Library\/Application Support\/Local\/run/);
		assert.equal(
			await fs.readFile(path.join(fixture.site.longPath, 'conf', 'apache', 'apache2.conf.hbs'), 'utf8'),
			'# official global template\n',
		);

		const snapshots = await captureAllManagedFiles(fixture.site);
		await fs.writeFile(paths.includeTemplate, '# drift\n');
		assert.equal(await serverManagedFilesMatch(fixture.site, origin, options, trustBundle), false);
		await restoreManagedFiles(snapshots);
		assert.equal(await serverManagedFilesMatch(fixture.site, origin, options, trustBundle), true);

		assert.equal(await removeAllManagedFiles(fixture.site), true);
		assert.equal(await allManagedArtifactsExist(fixture.site), false);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(paths.modulesTemplate, 'utf8'), fixture.apacheModules);
		await assert.rejects(fs.access(paths.includeTemplate));
		await assert.rejects(fs.access(paths.trustBundle));
	} finally {
		await fixture.cleanup();
	}
});

test('identical Nginx server reapply is byte-stable and reports no changes', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'https://media.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const options = { serverKind: 'nginx' };

		assert.equal(await applyServerManagedFiles(fixture.site, origin, options, trustBundle), true);
		const before = await Promise.all(Object.values(paths).map((filePath) => fs.readFile(filePath)));

		assert.equal(await applyServerManagedFiles(fixture.site, origin, options, trustBundle), false);
		const after = await Promise.all(Object.values(paths).map((filePath) => fs.readFile(filePath)));
		assert.deepEqual(after, before);
	} finally {
		await fixture.cleanup();
	}
});

test('identical Apache server reapply is byte-stable and reports no changes', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const options = {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		};

		assert.equal(await applyServerManagedFiles(fixture.site, origin, options, trustBundle), true);
		const before = await Promise.all(Object.values(paths).map((filePath) => fs.readFile(filePath)));

		assert.equal(await applyServerManagedFiles(fixture.site, origin, options, trustBundle), false);
		const after = await Promise.all(Object.values(paths).map((filePath) => fs.readFile(filePath)));
		assert.deepEqual(after, before);
	} finally {
		await fixture.cleanup();
	}
});

test('derives rollback marker expectations from snapshots instead of enabled intent', async () => {
	const fixture = await makeDualServerSite();
	try {
		const driftedEnabledSnapshot = await captureAllManagedFiles(fixture.site);
		assert.equal(
			apacheSnapshotHasCompleteManagedConfig(fixture.site, driftedEnabledSnapshot),
			false,
			'enabled intent with no applied markers must restore as unmanaged',
		);

		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await applyServerManagedFiles(fixture.site, origin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		});
		const cleanupPendingSnapshot = await captureAllManagedFiles(fixture.site);
		assert.equal(
			apacheSnapshotHasCompleteManagedConfig(fixture.site, cleanupPendingSnapshot),
			true,
			'disabled intent with applied markers must restore as managed',
		);
	} finally {
		await fixture.cleanup();
	}
});

test('cross-server switches remove inactive artifacts in both directions', async () => {
	const fixture = await makeDualServerSite();
	try {
		const apachePaths = getApacheManagedPaths(fixture.site);
		const nginxPaths = getManagedPaths(fixture.site);
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		await applyServerManagedFiles(fixture.site, apacheOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}, trustBundle);

		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'https://media.example.com',
		});
		await applyServerManagedFiles(fixture.site, nginxOrigin, {
			serverKind: 'nginx',
		}, trustBundle);
		await assert.rejects(fs.access(apachePaths.includeTemplate));
		await assert.rejects(fs.access(apachePaths.trustBundle));
		assert.equal(await fs.readFile(apachePaths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(apachePaths.modulesTemplate, 'utf8'), fixture.apacheModules);
		assert.match(await fs.readFile(nginxPaths.includeTemplate, 'utf8'), /proxy_pass/);

		await applyServerManagedFiles(fixture.site, apacheOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}, trustBundle);
		await assert.rejects(fs.access(nginxPaths.includeTemplate));
		await assert.rejects(fs.access(nginxPaths.trustBundle));
		assert.equal(await fs.readFile(nginxPaths.siteTemplate, 'utf8'), fixture.original);
		assert.match(await fs.readFile(apachePaths.includeTemplate, 'utf8'), /ProxyRequests Off/);

		assert.equal(removeAllManagedFilesSync(fixture.site), true);
		assert.equal(await allManagedArtifactsExist(fixture.site), false);
	} finally {
		await fixture.cleanup();
	}
});

test('restores the prior server after a switched-server apply fails following inactive cleanup', async () => {
	const fixture = await makeDualServerSite();
	try {
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		const apacheOptions = {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		};
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		await applyServerManagedFiles(fixture.site, apacheOrigin, apacheOptions, trustBundle);
		const snapshots = await captureAllManagedFiles(fixture.site);

		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'https://media.example.com',
		});
		await assert.rejects(
			applyServerManagedFiles(fixture.site, nginxOrigin, { serverKind: 'nginx' }),
			/HTTPS certificate authority bundle is unavailable/,
		);
		assert.equal(await allManagedArtifactsExist(fixture.site), false);

		await restoreManagedFiles(snapshots);
		assert.deepEqual(await captureAllManagedFiles(fixture.site), snapshots);
		assert.equal(
			await serverManagedFilesMatch(fixture.site, apacheOrigin, apacheOptions, trustBundle),
			true,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('refuses Apache managed paths whose parent symlink escapes the site root', async () => {
	const fixture = await makeDualServerSite();
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-apache-outside-'));
	try {
		const paths = getApacheManagedPaths(fixture.site);
		await fs.rm(path.dirname(paths.includeTemplate), { recursive: true });
		await fs.symlink(outsideRoot, path.dirname(paths.includeTemplate), 'dir');
		assert.throws(() => getApacheManagedPaths(fixture.site), /symbolic link/);
	} finally {
		await fixture.cleanup();
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('fails before writing templates when the platform Apache bundle lacks a required module', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		await fs.rm(path.join(path.dirname(path.dirname(fixture.httpd)), 'modules', 'mod_headers.so'));
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await assert.rejects(applyServerManagedFiles(fixture.site, origin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}), /required mod_headers\.so module/);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(paths.modulesTemplate, 'utf8'), fixture.apacheModules);
		await assert.rejects(fs.access(paths.includeTemplate));
	} finally {
		await fixture.cleanup();
	}
});

test('keeps Apache HTTP usable but rejects HTTPS before writes when the Local bundle lacks mod_ssl', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		await fs.rm(path.join(path.dirname(path.dirname(fixture.httpd)), 'modules', 'mod_ssl.so'));
		const httpsOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		await assert.rejects(applyServerManagedFiles(fixture.site, httpsOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}), /Apache HTTP origins remain supported.*Apache HTTPS origins are unavailable/);
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(paths.modulesTemplate, 'utf8'), fixture.apacheModules);
		await assert.rejects(fs.access(paths.includeTemplate));

		const httpOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		assert.equal(await applyServerManagedFiles(fixture.site, httpOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}), true);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /http:\/\/media\.example\.com/);
	} finally {
		await fixture.cleanup();
	}
});
