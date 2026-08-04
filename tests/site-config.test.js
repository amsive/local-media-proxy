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
	captureAllManagedFiles,
	captureManagedFiles,
	getApacheManagedPaths,
	getManagedPaths,
	getSafeServerConfigPath,
	managedArtifactsExist,
	managedFilesMatch,
	removeManagedFiles,
	removeAllManagedFiles,
	removeAllManagedFilesSync,
	removeManagedFilesSync,
	readServerManagedIncludeTemplate,
	restoreManagedFiles,
	serverManagedFilesystemReady,
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
		...['mod_proxy_http.so', 'mod_headers.so', 'mod_setenvif.so', 'mod_ssl.so'].map((filename) => (
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

async function temporaryManagedFiles(filePath) {
	const entries = await fs.readdir(path.dirname(filePath));
	const prefix = `${path.basename(filePath)}.`;
	return entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'));
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

test('detects and replaces pre-revision image-only routes on both supported servers', async () => {
	const fixture = await makeDualServerSite();
	try {
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://media.example.com',
		});
		const nginxOptions = { serverKind: 'nginx' };
		const nginxPaths = getManagedPaths(fixture.site);
		await applyServerManagedFiles(fixture.site, nginxOrigin, nginxOptions, trustBundle);
		await fs.writeFile(nginxPaths.includeTemplate, [
			'# Generated by Local Media Proxy. Changes will be overwritten.',
			'location ~* ^/wp-content/uploads/.*\\.(?:avif|jpe?g|png|webp)$ {',
			'\ttry_files $uri @local_media_proxy;',
			'}',
			'',
		].join('\n'));

		assert.equal(
			await serverManagedFilesMatch(fixture.site, nginxOrigin, nginxOptions, trustBundle),
			false,
		);
		assert.equal(
			await applyServerManagedFiles(fixture.site, nginxOrigin, nginxOptions, trustBundle),
			true,
		);
		assert.match(
			await fs.readFile(nginxPaths.includeTemplate, 'utf8'),
			/Managed route revision: upload-assets-v3/,
		);

		await removeAllManagedFiles(fixture.site);
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		const apacheOptions = {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		};
		const apachePaths = getApacheManagedPaths(fixture.site);
		await applyServerManagedFiles(fixture.site, apacheOrigin, apacheOptions, trustBundle);
		await fs.writeFile(apachePaths.includeTemplate, [
			'# BEGIN Local Media Proxy (managed)',
			'# Generated by Local Media Proxy. Changes will be overwritten.',
			'<LocationMatch "(?i)^/wp-content/uploads/.*\\.(?:avif|jpe?g|png|webp)$">',
			'</LocationMatch>',
			'# END Local Media Proxy (managed)',
			'',
		].join('\n'));

		assert.equal(
			await serverManagedFilesMatch(fixture.site, apacheOrigin, apacheOptions, trustBundle),
			false,
		);
		assert.equal(
			await applyServerManagedFiles(fixture.site, apacheOrigin, apacheOptions, trustBundle),
			true,
		);
		assert.match(
			await fs.readFile(apachePaths.includeTemplate, 'utf8'),
			/Managed route revision: upload-assets-v3/,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('refuses configuration paths outside the Local site root', async () => {
	const fixture = await makeSite();
	try {
		const unsafeSite = {
			...fixture.site,
			paths: { confTemplates: path.join(os.tmpdir(), 'outside-site') },
		};
		assert.throws(
			() => getManagedPaths(unsafeSite),
			/unsafe web-server configuration path/,
		);
		assert.throws(
			() => serverManagedFilesystemReady(unsafeSite, 'nginx'),
			/unsafe web-server configuration path/,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('requires the site root and Local core templates before managed-file access', async () => {
	const fixture = await makeDualServerSite();
	try {
		const nginxPaths = getManagedPaths(fixture.site);
		const apachePaths = getApacheManagedPaths(fixture.site);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'nginx'), true);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'apache'), true);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'unsupported'), false);

		await fs.rm(nginxPaths.siteTemplate);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'nginx'), false);
		await fs.writeFile(nginxPaths.siteTemplate, fixture.original);

		await fs.rm(apachePaths.modulesTemplate);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'apache'), false);
		await fs.writeFile(apachePaths.modulesTemplate, fixture.apacheModules);

		const nonDirectoryTemplates = path.join(fixture.site.longPath, 'conf-file');
		await fs.writeFile(nonDirectoryTemplates, '');
		assert.equal(serverManagedFilesystemReady({
			...fixture.site,
			paths: { confTemplates: nonDirectoryTemplates },
		}, 'nginx'), false);

		await fs.rm(fixture.site.longPath, { recursive: true });
		assert.equal(serverManagedFilesystemReady(fixture.site, 'nginx'), false);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'apache'), false);
	} finally {
		await fixture.cleanup();
	}
});

test('uses the active service template root, deduplicates conventional roots, and safely accepts an external compiled root', async () => {
	const fixture = await makeSite();
	const runtimeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-runtime-root-')));
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		await applyManagedFiles(fixture.site, origin);
		const conventional = getManagedPaths(fixture.site);
		assert.match(await fs.readFile(conventional.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);

		const activeRoot = path.join(fixture.site.longPath, 'active-service', 'nginx');
		await fs.mkdir(path.join(activeRoot, 'includes'), { recursive: true });
		await fs.writeFile(path.join(activeRoot, 'site.conf.hbs'), fixture.original);
		const options = {
			configPath: runtimeRoot,
			runPath: path.join(fixture.site.longPath, 'run', 'nginx'),
			serverKind: 'nginx',
			siteConfigTemplatePath: activeRoot,
		};
		assert.equal(getSafeServerConfigPath(fixture.site, options), runtimeRoot);
		assert.equal(serverManagedFilesystemReady(fixture.site, 'nginx', options), true);
		assert.equal(await applyServerManagedFiles(fixture.site, origin, options), true);

		const active = getManagedPaths(fixture.site, options);
		assert.equal(active.siteTemplate, path.join(activeRoot, 'site.conf.hbs'));
		assert.match(await fs.readFile(active.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
		assert.equal(await fs.readFile(conventional.siteTemplate, 'utf8'), fixture.original);
		assert.match(
			await readServerManagedIncludeTemplate(fixture.site, options),
			/Generated by Local Media Proxy/,
		);

		const conventionalOptions = {
			...options,
			siteConfigTemplatePath: path.join(fixture.site.longPath, 'conf', 'nginx'),
		};
		const snapshots = await captureAllManagedFiles(fixture.site, undefined, conventionalOptions);
		assert.equal(
			new Set(snapshots.map((snapshot) => snapshot.filePath)).size,
			snapshots.length,
			'active and conventional aliases must be captured once',
		);

		const configLink = path.join(fixture.site.longPath, 'compiled-link');
		await fs.symlink(runtimeRoot, configLink);
		assert.throws(
			() => getSafeServerConfigPath(fixture.site, { ...options, configPath: configLink }),
			/unsafe nginx compiled configuration root/,
		);

		const configParentLink = path.join(fixture.site.longPath, 'compiled-parent-link');
		await fs.symlink(path.dirname(runtimeRoot), configParentLink);
		assert.throws(
			() => getSafeServerConfigPath(fixture.site, {
				...options,
				configPath: path.join(configParentLink, path.basename(runtimeRoot)),
			}),
			/unsafe nginx compiled configuration root/,
			'symlinked ancestors must be rejected even when the compiled root itself is a real directory',
		);

		const templateLink = path.join(fixture.site.longPath, 'template-link');
		await fs.symlink(activeRoot, templateLink);
		assert.throws(
			() => getManagedPaths(fixture.site, { ...options, siteConfigTemplatePath: templateLink }),
			/symbolic link/,
		);
	} finally {
		await fixture.cleanup();
		await fs.rm(runtimeRoot, { force: true, recursive: true });
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
		assert.throws(
			() => serverManagedFilesystemReady(fixture.site, 'nginx'),
			/symbolic link/,
		);
	} finally {
		await fixture.cleanup();
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('waits for every Local-owned managed-file parent and never recreates one', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		await fs.rm(path.dirname(paths.includeTemplate), { recursive: true });
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});

		assert.equal(serverManagedFilesystemReady(fixture.site, 'nginx'), false);
		await assert.rejects(
			applyManagedFiles(fixture.site, origin),
			/has not finished creating this site web-server configuration/,
		);
		await assert.rejects(fs.access(path.dirname(paths.includeTemplate)));
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
	} finally {
		await fixture.cleanup();
	}
});

test('creates the add-on-owned Apache includes directory after Local core templates are ready', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const includesRoot = path.dirname(paths.includeTemplate);
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await fs.rm(includesRoot, { recursive: true });

		assert.equal(serverManagedFilesystemReady(fixture.site, 'apache'), true);
		assert.equal(await applyServerManagedFiles(fixture.site, origin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}), true);

		const metadata = await fs.lstat(includesRoot);
		assert.equal(metadata.isDirectory(), true);
		assert.equal(metadata.isSymbolicLink(), false);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /ProxyRequests Off/);
		assert.match(await fs.readFile(paths.modulesTemplate, 'utf8'), /mod_proxy_http\.so/);
		assert.match(await fs.readFile(paths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
	} finally {
		await fixture.cleanup();
	}
});

test('rejects an unsafe Apache includes path instead of replacing it', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const includesRoot = path.dirname(paths.includeTemplate);
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await fs.rm(includesRoot, { recursive: true });
		await fs.writeFile(includesRoot, 'not a directory');

		assert.equal(serverManagedFilesystemReady(fixture.site, 'apache'), false);
		await assert.rejects(
			applyServerManagedFiles(fixture.site, origin, {
				apacheHttpdBinary: fixture.httpd,
				serverKind: 'apache',
			}),
			/has not finished creating this site web-server configuration/,
		);
		assert.equal(await fs.readFile(includesRoot, 'utf8'), 'not a directory');
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(paths.modulesTemplate, 'utf8'), fixture.apacheModules);
	} finally {
		await fixture.cleanup();
	}
});

test('never recreates an Apache template root removed before managed-directory creation', async () => {
	const fixture = await makeDualServerSite();
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const apacheRoot = path.dirname(paths.siteTemplate);
		const includesRoot = path.dirname(paths.includeTemplate);
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await fs.rm(includesRoot, { recursive: true });
		let guardCalls = 0;

		await assert.rejects(
			applyServerManagedFiles(
				fixture.site,
				origin,
				{
					apacheHttpdBinary: fixture.httpd,
					serverKind: 'apache',
				},
				undefined,
				async () => {
					guardCalls += 1;
					if (guardCalls === 2) {
						await fs.rm(apacheRoot, { recursive: true });
					}
				},
			),
			/has not finished creating this site web-server configuration/,
		);

		assert.equal(guardCalls, 2);
		await assert.rejects(fs.access(apacheRoot));
		await assert.rejects(fs.access(includesRoot));
	} finally {
		await fixture.cleanup();
	}
});

test('never cleans up through a replaced Apache root after managed-directory creation', async () => {
	const fixture = await makeDualServerSite();
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-outside-apache-'));
	try {
		const paths = getApacheManagedPaths(fixture.site);
		const apacheRoot = path.dirname(paths.siteTemplate);
		const movedApacheRoot = `${apacheRoot}-original`;
		const includesRoot = path.dirname(paths.includeTemplate);
		const outsideIncludesRoot = path.join(outsideRoot, 'includes');
		const origin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await fs.rm(includesRoot, { recursive: true });
		await fs.mkdir(outsideIncludesRoot);
		let swapped = false;

		await assert.rejects(
			applyServerManagedFiles(
				fixture.site,
				origin,
				{
					apacheHttpdBinary: fixture.httpd,
					serverKind: 'apache',
				},
				undefined,
				async () => {
					if (swapped) {
						return;
					}
					try {
						await fs.lstat(includesRoot);
					} catch (error) {
						if (error.code === 'ENOENT') {
							return;
						}
						throw error;
					}
					await fs.rename(apacheRoot, movedApacheRoot);
					await fs.symlink(outsideRoot, apacheRoot, 'dir');
					swapped = true;
				},
			),
			/unsafe web-server configuration path through a symbolic link/,
		);

		assert.equal(swapped, true);
		assert.equal((await fs.lstat(outsideIncludesRoot)).isDirectory(), true);
		assert.equal((await fs.lstat(path.join(movedApacheRoot, 'includes'))).isDirectory(), true);
		assert.deepEqual(await fs.readdir(outsideIncludesRoot), []);
	} finally {
		await fixture.cleanup();
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('rejects a symbolic-link site root before reading or writing lookalike templates', async () => {
	const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-link-parent-'));
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-link-target-'));
	const siteRoot = path.join(linkParent, 'site-root');
	const nginxRoot = path.join(outsideRoot, 'conf', 'nginx');
	const original = 'server {\n}\n';
	try {
		await fs.mkdir(path.join(nginxRoot, 'includes'), { recursive: true });
		await fs.writeFile(path.join(nginxRoot, 'site.conf.hbs'), original);
		await fs.symlink(outsideRoot, siteRoot, 'dir');
		const site = {
			id: 'symlink-root',
			longPath: siteRoot,
			path: siteRoot,
			paths: { confTemplates: path.join(siteRoot, 'conf') },
			services: { nginx: { name: 'nginx' } },
		};
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});

		assert.throws(() => getManagedPaths(site), /unsafe site root.*symbolic link/i);
		assert.throws(
			() => serverManagedFilesystemReady(site, 'nginx'),
			/unsafe site root.*symbolic link/i,
		);
		await assert.rejects(
			managedArtifactsExist(site),
			/unsafe site root.*symbolic link/i,
		);
		await assert.rejects(
			applyManagedFiles(site, origin),
			/unsafe site root.*symbolic link/i,
		);
		assert.equal(await fs.readFile(path.join(nginxRoot, 'site.conf.hbs'), 'utf8'), original);
		await assert.rejects(
			fs.access(path.join(nginxRoot, 'includes', 'local-media-proxy.conf.hbs')),
		);
	} finally {
		await fs.rm(linkParent, { force: true, recursive: true });
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('an apply guard can stop before a temporary write without changing any target', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';

		await assert.rejects(
			applyManagedFiles(fixture.site, origin, trustBundle, () => {
				throw new Error('site lifecycle changed before write');
			}),
			/site lifecycle changed before write/,
		);

		await assert.rejects(fs.access(paths.trustBundle));
		await assert.rejects(fs.access(paths.includeTemplate));
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
		assert.deepEqual(await temporaryManagedFiles(paths.trustBundle), []);
	} finally {
		await fixture.cleanup();
	}
});

test('exclusive unpredictable temporary files cannot follow a pre-created legacy symlink', async () => {
	const fixture = await makeSite();
	const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-temp-target-'));
	const originalNow = Date.now;
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		const outsideFile = path.join(outsideRoot, 'outside.txt');
		const sentinel = 'outside sentinel\n';
		const fixedTime = 1_234_567_890_000;
		const legacyTemporaryPath = `${paths.includeTemplate}.${process.pid}.${fixedTime}.tmp`;
		await fs.writeFile(outsideFile, sentinel);
		await fs.symlink(outsideFile, legacyTemporaryPath);
		Date.now = () => fixedTime;

		assert.equal(await applyManagedFiles(fixture.site, origin), true);

		assert.equal(await fs.readFile(outsideFile, 'utf8'), sentinel);
		const managedMetadata = await fs.lstat(paths.includeTemplate);
		assert.equal(managedMetadata.isFile(), true);
		assert.equal(managedMetadata.isSymbolicLink(), false);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /proxy_pass/);
	} finally {
		Date.now = originalNow;
		await fixture.cleanup();
		await fs.rm(outsideRoot, { force: true, recursive: true });
	}
});

test('an apply guard can stop the rename and the temporary file is always cleaned', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		let guardCalls = 0;
		const assertCurrent = async () => {
			guardCalls += 1;
			if ((await temporaryManagedFiles(paths.trustBundle)).length > 0) {
				throw new Error('site lifecycle changed before rename');
			}
		};

		await assert.rejects(
			applyManagedFiles(fixture.site, origin, trustBundle, assertCurrent),
			/site lifecycle changed before rename/,
		);

		assert.equal(guardCalls, 4);
		await assert.rejects(fs.access(paths.trustBundle));
		await assert.rejects(fs.access(paths.includeTemplate));
		assert.equal(await fs.readFile(paths.siteTemplate, 'utf8'), fixture.original);
		assert.deepEqual(await temporaryManagedFiles(paths.trustBundle), []);
	} finally {
		await fixture.cleanup();
	}
});

test('a site deleted between temporary write and rename is never recreated', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'https://origin.example.com',
		});
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		let guardCalls = 0;
		const assertCurrent = async () => {
			guardCalls += 1;
			if ((await temporaryManagedFiles(paths.trustBundle)).length > 0) {
				await fs.rm(fixture.site.longPath, { recursive: true });
				throw new Error('site was deleted before rename');
			}
		};

		await assert.rejects(
			applyManagedFiles(fixture.site, origin, trustBundle, assertCurrent),
			/site was deleted before rename/,
		);

		assert.equal(guardCalls, 4);
		await assert.rejects(fs.access(fixture.site.longPath));
	} finally {
		await fixture.cleanup();
	}
});

test('restore stops immediately when its lifecycle guard closes', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		await Promise.all([
			fs.writeFile(paths.includeTemplate, '# current include\n'),
			fs.writeFile(paths.trustBundle, '# current trust\n'),
		]);
		let guardCalls = 0;
		await assert.rejects(
			restoreManagedFiles([
				{
					content: Buffer.from('# restored include\n'),
					filePath: paths.includeTemplate,
				},
				{
					content: Buffer.from('# restored trust\n'),
					filePath: paths.trustBundle,
				},
			], () => {
				guardCalls += 1;
				throw new Error('rollback is no longer current');
			}),
			/rollback is no longer current/,
		);

		assert.equal(guardCalls, 1);
		assert.equal(await fs.readFile(paths.includeTemplate, 'utf8'), '# current include\n');
		assert.equal(await fs.readFile(paths.trustBundle, 'utf8'), '# current trust\n');
		assert.deepEqual(await temporaryManagedFiles(paths.includeTemplate), []);
		assert.deepEqual(await temporaryManagedFiles(paths.trustBundle), []);
	} finally {
		await fixture.cleanup();
	}
});

test('restore propagates a lifecycle guard failure discovered after a filesystem error', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const blockedPath = path.join(fixture.site.longPath, 'blocked-directory');
		await fs.mkdir(blockedPath);
		await fs.writeFile(paths.includeTemplate, '# untouched include\n');
		const lifecycleError = new Error('rollback target changed after restore failure');
		let guardCalls = 0;
		const assertCurrent = () => {
			guardCalls += 1;
			if (guardCalls >= 4) {
				throw lifecycleError;
			}
		};

		await assert.rejects(
			restoreManagedFiles([
				{
					content: Buffer.from('cannot replace a directory'),
					filePath: blockedPath,
				},
				{
					content: Buffer.from('# should not be restored\n'),
					filePath: paths.includeTemplate,
				},
			], assertCurrent),
			(error) => error === lifecycleError,
		);

		assert.equal(guardCalls, 4);
		assert.equal(await fs.readFile(paths.includeTemplate, 'utf8'), '# untouched include\n');
	} finally {
		await fixture.cleanup();
	}
});

test('captureAllManagedFiles fences path resolution before reading snapshots', async () => {
	const fixture = await makeDualServerSite();
	try {
		const lifecycleError = new Error('snapshot target changed before read');
		let guardCalls = 0;
		await assert.rejects(
			captureAllManagedFiles(fixture.site, () => {
				guardCalls += 1;
				if (guardCalls === 5) {
					throw lifecycleError;
				}
			}),
			(error) => error === lifecycleError,
		);
		assert.equal(guardCalls, 5);
	} finally {
		await fixture.cleanup();
	}
});

test('read-only artifact probes propagate a lifecycle change around an absent read', async () => {
	const fixture = await makeDualServerSite();
	try {
		const lifecycleError = new Error('artifact probe target changed during read');
		let guardCalls = 0;
		await assert.rejects(
			allManagedArtifactsExist(fixture.site, async () => {
				guardCalls += 1;
				if (guardCalls === 3) {
					await fs.rm(fixture.site.longPath, { recursive: true });
				}
				if (guardCalls === 4) {
					throw lifecycleError;
				}
			}),
			(error) => error === lifecycleError,
		);
		assert.equal(guardCalls, 4);
		await assert.rejects(fs.access(fixture.site.longPath));
	} finally {
		await fixture.cleanup();
	}
});

test('serverManagedFilesMatch propagates its optional transaction guard', async () => {
	const fixture = await makeSite();
	try {
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		await applyManagedFiles(fixture.site, origin);
		const lifecycleError = new Error('matching target changed');

		await assert.rejects(
			serverManagedFilesMatch(
				fixture.site,
				origin,
				{ serverKind: 'nginx' },
				undefined,
				() => {
					throw lifecycleError;
				},
			),
			(error) => error === lifecycleError,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('apply and rollback never recreate a deleted Local site root', async () => {
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
		const snapshots = await captureManagedFiles(fixture.site);
		await fs.rm(fixture.site.longPath, { recursive: true });

		await assert.rejects(
			applyManagedFiles(fixture.site, origin),
			/has not finished creating this site web-server configuration/,
		);
		await assert.rejects(restoreManagedFiles(snapshots), AggregateError);
		await assert.rejects(fs.access(fixture.site.longPath));
	} finally {
		await fixture.cleanup();
	}
});

test('read-only wrappers and cleanup treat an already deleted site as absent', async () => {
	const fixture = await makeDualServerSite();
	const siteRoot = fixture.site.longPath;
	const nginxOrigin = validateAndNormalizeOrigin({
		originIp: '192.0.2.20',
		siteUrl: 'http://origin.example.com',
	});
	const apacheOrigin = validateAndNormalizeOrigin({
		originIp: '',
		siteUrl: 'http://origin.example.com',
	}, { requiresOriginIp: false });
	await fs.rm(siteRoot, { recursive: true });

	assert.equal(await managedArtifactsExist(fixture.site), false);
	assert.equal(await allManagedArtifactsExist(fixture.site), false);
	assert.equal(await managedFilesMatch(fixture.site, nginxOrigin), false);
	assert.equal(
		await serverManagedFilesMatch(fixture.site, nginxOrigin, { serverKind: 'nginx' }),
		false,
	);
	assert.equal(
		await serverManagedFilesMatch(fixture.site, apacheOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		}),
		false,
	);
		assert.equal(await removeAllManagedFiles(fixture.site), false);
	assert.equal(removeAllManagedFilesSync(fixture.site), false);
	await assert.rejects(fs.access(siteRoot));
});

test('removeAllManagedFiles serializes Nginx and Apache mutation guards', async () => {
	const fixture = await makeDualServerSite();
	try {
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		await applyServerManagedFiles(fixture.site, apacheOrigin, {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		});
		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'http://media.example.com',
		});
		await applyManagedFiles(fixture.site, nginxOrigin);
		const nginxPaths = getManagedPaths(fixture.site);

		let activeGuards = 0;
		let apachePhaseGuardCalls = 0;
		let maximumActiveGuards = 0;
		const assertCurrent = async () => {
			activeGuards += 1;
			maximumActiveGuards = Math.max(maximumActiveGuards, activeGuards);
			try {
				await fs.access(nginxPaths.includeTemplate);
			} catch {
				apachePhaseGuardCalls += 1;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeGuards -= 1;
		};

		assert.equal(await removeAllManagedFiles(fixture.site, assertCurrent), true);
		assert.equal(maximumActiveGuards, 1);
		assert.ok(apachePhaseGuardCalls > 0);
		assert.equal(await allManagedArtifactsExist(fixture.site), false);
	} finally {
		await fixture.cleanup();
	}
});

test('removeManagedFiles guards immediately before unlinking an artifact', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		await applyManagedFiles(fixture.site, origin);
		await fs.writeFile(paths.siteTemplate, fixture.original);

		await assert.rejects(
			removeManagedFiles(fixture.site, () => {
				throw new Error('site lifecycle changed before unlink');
			}),
			/site lifecycle changed before unlink/,
		);

		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /proxy_pass/);
	} finally {
		await fixture.cleanup();
	}
});

test('Apache apply and cross-server inactive cleanup both honor the mutation guard', async () => {
	const fixture = await makeDualServerSite();
	try {
		const apachePaths = getApacheManagedPaths(fixture.site);
		const nginxPaths = getManagedPaths(fixture.site);
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'http://media.example.com',
		}, { requiresOriginIp: false });
		const apacheOptions = {
			apacheHttpdBinary: fixture.httpd,
			serverKind: 'apache',
		};

		await assert.rejects(
			applyServerManagedFiles(
				fixture.site,
				apacheOrigin,
				apacheOptions,
				undefined,
				() => {
					throw new Error('Apache apply is no longer current');
				},
			),
			/Apache apply is no longer current/,
		);
		assert.equal(await fs.readFile(apachePaths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(apachePaths.modulesTemplate, 'utf8'), fixture.apacheModules);
		await assert.rejects(fs.access(apachePaths.includeTemplate));

		await applyServerManagedFiles(fixture.site, apacheOrigin, apacheOptions);
		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'http://media.example.com',
		});
		await assert.rejects(
			applyServerManagedFiles(
				fixture.site,
				nginxOrigin,
				{ serverKind: 'nginx' },
				undefined,
				() => {
					throw new Error('cross-server cleanup is no longer current');
				},
			),
			/cross-server cleanup is no longer current/,
		);

		assert.match(await fs.readFile(apachePaths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
		assert.match(await fs.readFile(apachePaths.includeTemplate, 'utf8'), /ProxyRequests Off/);
		await assert.rejects(fs.access(nginxPaths.includeTemplate));
		assert.equal(await fs.readFile(nginxPaths.siteTemplate, 'utf8'), fixture.original);
	} finally {
		await fixture.cleanup();
	}
});

test('synchronous cleanup guards the rename and removes its temporary file', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		await applyManagedFiles(fixture.site, origin);
		let guardCalls = 0;

		assert.throws(
			() => removeManagedFilesSync(fixture.site, () => {
				guardCalls += 1;
				if (guardCalls === 2) {
					throw new Error('sync lifecycle changed before rename');
				}
			}),
			/sync lifecycle changed before rename/,
		);

		assert.equal(guardCalls, 2);
		assert.match(await fs.readFile(paths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
		assert.deepEqual(await temporaryManagedFiles(paths.siteTemplate), []);
	} finally {
		await fixture.cleanup();
	}
});

test('synchronous cleanup guards immediately before unlinking an artifact', async () => {
	const fixture = await makeSite();
	try {
		const paths = getManagedPaths(fixture.site);
		const origin = validateAndNormalizeOrigin({
			originIp: '192.0.2.20',
			siteUrl: 'http://origin.example.com',
		});
		await applyManagedFiles(fixture.site, origin);
		await fs.writeFile(paths.siteTemplate, fixture.original);

		assert.throws(
			() => removeManagedFilesSync(fixture.site, () => {
				throw new Error('sync lifecycle changed before unlink');
			}),
			/sync lifecycle changed before unlink/,
		);
		assert.match(await fs.readFile(paths.includeTemplate, 'utf8'), /proxy_pass/);
	} finally {
		await fixture.cleanup();
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

test('rollback preserves Local-owned templates created after an absent snapshot', async () => {
	const fixture = await makeDualServerSite();
	try {
		const nginx = getManagedPaths(fixture.site);
		const apache = getApacheManagedPaths(fixture.site);
		await Promise.all([
			fs.rm(nginx.siteTemplate),
			fs.rm(apache.modulesTemplate),
			fs.rm(apache.siteTemplate),
		]);
		const snapshots = await captureAllManagedFiles(fixture.site);
		const managedBlock = [
			'# BEGIN Local Media Proxy (managed)',
			'# add-on-owned directive',
			'# END Local Media Proxy (managed)',
			'',
		].join('\n');
		await Promise.all([
			fs.writeFile(nginx.siteTemplate, `# Local created Nginx template\n${managedBlock}`),
			fs.writeFile(apache.modulesTemplate, `# Local created Apache modules template\n${managedBlock}`),
			fs.writeFile(apache.siteTemplate, `# Local created Apache site template\n${managedBlock}`),
			fs.writeFile(nginx.includeTemplate, '# add-on Nginx include\n'),
			fs.writeFile(nginx.trustBundle, '# add-on Nginx trust\n'),
			fs.writeFile(apache.includeTemplate, '# add-on Apache include\n'),
			fs.writeFile(apache.trustBundle, '# add-on Apache trust\n'),
		]);

		await restoreManagedFiles(snapshots);

		assert.equal(await fs.readFile(nginx.siteTemplate, 'utf8'), '# Local created Nginx template\n');
		assert.equal(await fs.readFile(apache.modulesTemplate, 'utf8'), '# Local created Apache modules template\n');
		assert.equal(await fs.readFile(apache.siteTemplate, 'utf8'), '# Local created Apache site template\n');
		await Promise.all([
			assert.rejects(fs.access(nginx.includeTemplate)),
			assert.rejects(fs.access(nginx.trustBundle)),
			assert.rejects(fs.access(apache.includeTemplate)),
			assert.rejects(fs.access(apache.trustBundle)),
		]);
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

test('cross-server switches clean sibling authoritative service template roots', async () => {
	const fixture = await makeDualServerSite();
	const runtimeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-proxy-runtime-switch-')));
	try {
		const serviceTemplatesRoot = path.join(fixture.site.longPath, 'active-service');
		const nginxRoot = path.join(serviceTemplatesRoot, 'nginx');
		const apacheRoot = path.join(serviceTemplatesRoot, 'apache');
		const nginxConfigRoot = path.join(runtimeRoot, 'nginx');
		const apacheConfigRoot = path.join(runtimeRoot, 'apache');
		await Promise.all([
			fs.mkdir(path.join(nginxRoot, 'includes'), { recursive: true }),
			fs.mkdir(path.join(apacheRoot, 'includes'), { recursive: true }),
			fs.mkdir(nginxConfigRoot, { recursive: true }),
			fs.mkdir(apacheConfigRoot, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(nginxRoot, 'site.conf.hbs'), fixture.original),
			fs.writeFile(path.join(apacheRoot, 'site.conf.hbs'), fixture.apacheMain),
			fs.writeFile(path.join(apacheRoot, 'modules.conf.hbs'), fixture.apacheModules),
		]);

		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'https://media.example.com',
		});
		const nginxOptions = {
			configPath: nginxConfigRoot,
			serverKind: 'nginx',
			siteConfigTemplatePath: nginxRoot,
		};
		const nginxPaths = getManagedPaths(fixture.site, nginxOptions);
		await applyServerManagedFiles(fixture.site, nginxOrigin, nginxOptions, trustBundle);
		assert.match(await fs.readFile(nginxPaths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);

		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });
		const apacheOptions = {
			apacheHttpdBinary: fixture.httpd,
			configPath: apacheConfigRoot,
			serverKind: 'apache',
			siteConfigTemplatePath: apacheRoot,
		};
		const apachePaths = getApacheManagedPaths(fixture.site, apacheOptions);
		await applyServerManagedFiles(fixture.site, apacheOrigin, apacheOptions, trustBundle);
		assert.equal(await fs.readFile(nginxPaths.siteTemplate, 'utf8'), fixture.original);
		await assert.rejects(fs.access(nginxPaths.includeTemplate));
		await assert.rejects(fs.access(nginxPaths.trustBundle));
		assert.match(await fs.readFile(apachePaths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);

		await applyServerManagedFiles(fixture.site, nginxOrigin, nginxOptions, trustBundle);
		assert.equal(await fs.readFile(apachePaths.siteTemplate, 'utf8'), fixture.apacheMain);
		assert.equal(await fs.readFile(apachePaths.modulesTemplate, 'utf8'), fixture.apacheModules);
		await assert.rejects(fs.access(apachePaths.includeTemplate));
		await assert.rejects(fs.access(apachePaths.trustBundle));
		assert.match(await fs.readFile(nginxPaths.siteTemplate, 'utf8'), /BEGIN Local Media Proxy/);
	} finally {
		await fixture.cleanup();
		await fs.rm(runtimeRoot, { force: true, recursive: true });
	}
});

test('preflights Nginx HTTPS prerequisites before removing an active Apache configuration', async () => {
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
		assert.deepEqual(await captureAllManagedFiles(fixture.site), snapshots);
		assert.equal(
			await serverManagedFilesMatch(fixture.site, apacheOrigin, apacheOptions, trustBundle),
			true,
		);
	} finally {
		await fixture.cleanup();
	}
});

test('preflights Apache HTTPS prerequisites before removing an active Nginx configuration', async () => {
	const fixture = await makeDualServerSite();
	try {
		const nginxOrigin = validateAndNormalizeOrigin({
			originIp: '192.0.2.10',
			siteUrl: 'https://media.example.com',
		});
		const nginxOptions = { serverKind: 'nginx' };
		const trustBundle = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';
		await applyServerManagedFiles(
			fixture.site,
			nginxOrigin,
			nginxOptions,
			trustBundle,
		);
		const snapshots = await captureAllManagedFiles(fixture.site);
		const apacheOrigin = validateAndNormalizeOrigin({
			originIp: '',
			siteUrl: 'https://media.example.com',
		}, { requiresOriginIp: false });

		await assert.rejects(
			applyServerManagedFiles(fixture.site, apacheOrigin, {
				apacheHttpdBinary: fixture.httpd,
				serverKind: 'apache',
			}),
			/HTTPS certificate authority bundle is unavailable/,
		);

		assert.deepEqual(await captureAllManagedFiles(fixture.site), snapshots);
		assert.equal(
			await serverManagedFilesMatch(
				fixture.site,
				nginxOrigin,
				nginxOptions,
				trustBundle,
			),
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
		assert.throws(
			() => serverManagedFilesystemReady(fixture.site, 'apache'),
			/symbolic link/,
		);
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
		await assert.rejects(applyServerManagedFiles(
			fixture.site,
			httpsOrigin,
			{
				apacheHttpdBinary: fixture.httpd,
				serverKind: 'apache',
			},
			'-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
		), /Apache HTTP origins remain supported.*Apache HTTPS origins are unavailable/);
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
