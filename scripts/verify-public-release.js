/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(REPOSITORY_ROOT, 'public-release-policy.json');
const DEFAULT_ASSET_MANIFEST_PATH = path.join(REPOSITORY_ROOT, 'public-release-assets.json');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_ALLOWED_CHUNKS = new Set([
	'IHDR',
	'PLTE',
	'IDAT',
	'IEND',
	'cHRM',
	'gAMA',
	'sRGB',
	'pHYs',
	'tRNS',
	'bKGD',
	'sBIT',
]);
const HOSTNAME_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:agency|ai|app|ca|cloud|co|com|dev|digital|edu|example|gov|info|internal|io|marketing|media|me|net|org|studio|tech|uk|us|xyz)\b/gi;
const HOSTNAME_CANDIDATE_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})\b/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{},;]+/gi;
const IPV4_PATTERN = /(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?=$|[^0-9])/g;
const IPV6_CANDIDATE_PATTERN = /(?:^|[^0-9A-Za-z:])([0-9A-Fa-f]*:[0-9A-Fa-f:]+)(?=$|[^0-9A-Za-z:])/g;
const EMAIL_PATTERN = /(?:\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+|"(?:[^"\\\r\n]|\\.)+")@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi;
const PERSONAL_PATH_PATTERNS = [
	/(?:file:\/\/)?\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g,
	/(?:file:\/\/)?\/home\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g,
	/(?:file:\/\/)?\/Volumes\/[^/\s"'<>]+(?:\/[^\r\n"'<>`]*)?/g,
	/~\/[^/\r\n"'<>`\\]+\/[^\r\n"'<>`\\]+/g,
	/[A-Za-z]:\\Users\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)?/g,
	new RegExp('%USER' + 'PROFILE%\\\\[A-Za-z0-9 ._-]+(?:\\\\[^\\r\\n"\'<>]+)*', 'gi'),
];
const SECRET_PATTERNS = [
	{
		rule: 'SECRET_PRIVATE_KEY',
		message: 'Private-key material is not permitted.',
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
	},
	{
		rule: 'SECRET_AWS_ACCESS_KEY',
		message: 'A value resembling an AWS access key is not permitted.',
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	},
	{
		rule: 'SECRET_GITHUB_TOKEN',
		message: 'A value resembling a GitHub token is not permitted.',
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g,
	},
	{
		rule: 'SECRET_GITLAB_TOKEN',
		message: 'A value resembling a GitLab token is not permitted.',
		pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
	},
	{
		rule: 'SECRET_SLACK_TOKEN',
		message: 'A value resembling a Slack token is not permitted.',
		pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
	},
	{
		rule: 'SECRET_GOOGLE_API_KEY',
		message: 'A value resembling a Google API key is not permitted.',
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
	},
	{
		rule: 'SECRET_STRIPE_KEY',
		message: 'A value resembling a live Stripe key is not permitted.',
		pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,255}\b/g,
	},
	{
		rule: 'SECRET_NPM_TOKEN',
		message: 'A value resembling an npm token is not permitted.',
		pattern: /\bnpm_[A-Za-z0-9]{30,255}\b/g,
	},
	{
		rule: 'SECRET_JWT',
		message: 'A value resembling a JSON Web Token is not permitted.',
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
	{
		rule: 'SECRET_BEARER_TOKEN',
		message: 'A literal bearer token is not permitted.',
		pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/g,
	},
];
const GENERIC_SECRET_PATTERN = /\b(api[_-]?key|aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|private[_-]?key|secret)\b["']?\s*[:=]\s*(?:["']([^"'\r\n]{8,})["']|([A-Za-z0-9_./+=-]{12,}))/gi;
const PLACEHOLDER_SECRET_VALUES = new Set([
	'change-me',
	'change_me',
	'changeme',
	'example',
	'example-value',
	'example_value',
	'placeholder',
	'placeholder-value',
	'placeholder_value',
	'not-a-secret',
	'not_a_secret',
	'test-only',
	'test_only',
	'dummy',
	'dummy-value',
	'dummy_value',
]);
const PLACEHOLDER_SECRET_TEMPLATES = [
	/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
	/^\$\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}$/,
	/^\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}$/,
];
const MAGIC_KINDS = [
	{ kind: 'png', signature: PNG_SIGNATURE },
	{ kind: 'zip', signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
	{ kind: 'gzip', signature: Buffer.from([0x1f, 0x8b]) },
	{ kind: 'pdf', signature: Buffer.from('%PDF-') },
	{ kind: 'sqlite', signature: Buffer.from('SQLite format 3\0') },
	{ kind: 'ole-office', signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
	{ kind: 'elf', signature: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
];
const SENSITIVE_FILE_NAMES = new Set([
	'.env',
	'.htpasswd',
	'credentials',
	'credentials.json',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'id_rsa',
]);
const NON_HOSTNAME_SUFFIXES = new Set([
	'bak',
	'conf',
	'css',
	'csv',
	'der',
	'doc',
	'docx',
	'gif',
	'git',
	'hbs',
	'html',
	'ico',
	'jpeg',
	'jpg',
	'js',
	'json',
	'lock',
	'map',
	'md',
	'pem',
	'png',
	'sql',
	'sqlite',
	'svg',
	'tar',
	'tgz',
	'ts',
	'tsv',
	'txt',
	'webp',
	'xml',
	'yaml',
	'yml',
	'zip',
]);

function loadJson(filePath, label) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		throw new Error(`Unable to read ${label} ${filePath}: ${error.message}`);
	}
	return parsed;
}

function loadPolicy(filePath = DEFAULT_POLICY_PATH) {
	const policy = loadJson(filePath, 'public-release policy');
	validatePolicy(policy);
	return policy;
}

function loadAssetManifest(filePath = DEFAULT_ASSET_MANIFEST_PATH) {
	const manifest = loadJson(filePath, 'public-release asset manifest');
	validateAssetManifest(manifest);
	return manifest;
}

function validatePolicy(policy) {
	if (policy?.version !== 1) {
		throw new Error('Public-release policy must have version 1.');
	}
	for (const key of [
		'allowedEmailAddresses',
		'allowedHostnames',
		'allowedNoreplyEmailDomains',
		'allowedPublicIps',
		'allowedSyntheticEmailDomains',
		'exactFindingAllowlist',
		'manifestedExtensions',
		'dangerousExtensions',
	]) {
		if (!Array.isArray(policy[key])) {
			throw new Error(`Public-release policy ${key} must be an array.`);
		}
	}
	if (!Number.isSafeInteger(policy.maxFileSizeBytes) || policy.maxFileSizeBytes <= 0) {
		throw new Error('Public-release policy maxFileSizeBytes must be a positive integer.');
	}
	assertUniqueNormalized(policy.allowedEmailAddresses, 'allowed email address', normalizeEmail);
	assertUniqueNormalized(policy.allowedHostnames, 'allowed hostname', normalizeHostname);
	assertUniqueNormalized(policy.allowedNoreplyEmailDomains, 'allowed noreply email domain', normalizeHostname);
	assertUniqueNormalized(policy.allowedPublicIps, 'allowed public IP', (value) => String(value));
	assertUniqueNormalized(policy.allowedSyntheticEmailDomains, 'allowed synthetic email domain', normalizeHostname);
	assertUniqueNormalized(policy.manifestedExtensions, 'manifested extension', normalizeExtension);
	assertUniqueNormalized(policy.dangerousExtensions, 'dangerous extension', normalizeExtension);
	for (const exception of policy.exactFindingAllowlist) {
		if (
			typeof exception?.path !== 'string' ||
			!isSafeRelativePath(exception.path) ||
			typeof exception.rule !== 'string' ||
			!isSha256(exception.matchSha256) ||
			typeof exception.reason !== 'string' ||
			!exception.reason.trim()
		) {
			throw new Error('Each exact finding exception requires a safe path, rule, SHA-256, and reason.');
		}
	}
}

function validateAssetManifest(manifest) {
	if (manifest?.version !== 1 || !Array.isArray(manifest.assets)) {
		throw new Error('Public-release asset manifest must have version 1 and an assets array.');
	}
	const seen = new Set();
	for (const asset of manifest.assets) {
		if (
			typeof asset?.path !== 'string' ||
			!isSafeRelativePath(asset.path) ||
			!isSha256(asset.sha256) ||
			typeof asset.kind !== 'string' ||
			!asset.kind.trim() ||
			typeof asset.reviewedForPublicRelease !== 'string' ||
			!asset.reviewedForPublicRelease.trim()
		) {
			throw new Error('Each public asset requires a safe path, SHA-256, kind, and public-review reason.');
		}
		const normalizedPath = normalizeRelativePath(asset.path);
		if (seen.has(normalizedPath)) {
			throw new Error(`Duplicate public asset manifest path: ${normalizedPath}`);
		}
		seen.add(normalizedPath);
	}
}

function assertUniqueNormalized(values, label, normalize) {
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(`Every ${label} must be a non-empty string.`);
		}
		const normalized = normalize(value);
		if (seen.has(normalized)) {
			throw new Error(`Duplicate ${label}: ${normalized}`);
		}
		seen.add(normalized);
	}
}

function scanPublicRelease(options = {}) {
	const root = path.resolve(options.root ?? REPOSITORY_ROOT);
	const policy = options.policy ?? loadPolicy(options.policyPath);
	const assetManifest = options.assetManifest ?? loadAssetManifest(options.assetManifestPath);
	validatePolicy(policy);
	validateAssetManifest(assetManifest);

	const useGitTrackedFiles = options.useGitTrackedFiles ?? root === REPOSITORY_ROOT;
	const requireManifestCompleteness = options.requireManifestCompleteness ?? useGitTrackedFiles;
	const files = useGitTrackedFiles
		? listGitTrackedFiles(root)
		: listDirectoryFiles(root);
	const findings = [];
	const scannedPaths = new Set();
	const assetByPath = new Map(
		assetManifest.assets.map((asset) => [normalizeRelativePath(asset.path), asset]),
	);

	for (const file of files) {
		const relativePath = normalizeRelativePath(file.relativePath);
		scannedPaths.add(canonicalAssetPath(relativePath));

		if (file.problem) {
			addFinding(findings, policy, {
				path: relativePath,
				rule: file.rule,
				message: file.problem,
			});
			continue;
		}

		const buffer = file.buffer ?? fs.readFileSync(file.absolutePath);
		if (buffer.length > policy.maxFileSizeBytes) {
			addFinding(findings, policy, {
				path: relativePath,
				rule: 'FILE_TOO_LARGE',
				message: `File exceeds the ${policy.maxFileSizeBytes}-byte public-review limit.`,
			});
			continue;
		}

		const extension = path.extname(relativePath).toLowerCase();
		const magicKind = identifyMagic(buffer);
		const isManifestedType = policy.manifestedExtensions
			.map(normalizeExtension)
			.includes(extension) || Boolean(magicKind) || appearsBinary(buffer) || isSensitivePath(relativePath);
		const assetPath = canonicalAssetPath(relativePath);
		const manifestEntry = assetByPath.get(assetPath);

		if (isManifestedType) {
			verifyManifestedAsset({
				assetPath,
				buffer,
				extension,
				findings,
				magicKind,
				manifestEntry,
				policy,
				relativePath,
			});
		}

		if (magicKind === 'png' || extension === '.png') {
			for (const pngFinding of inspectPng(buffer)) {
				addFinding(findings, policy, { path: relativePath, ...pngFinding });
			}
		}

		if (extension === '.svg') {
			const svgText = decodeText(buffer);
			if (svgText === null) {
				addFinding(findings, policy, {
					path: relativePath,
					rule: 'INVALID_UTF8',
					message: 'SVG is not valid UTF-8 text.',
				});
			} else {
				for (const svgFinding of inspectSvg(svgText)) {
					addFinding(findings, policy, { path: relativePath, ...svgFinding });
				}
				scanText(relativePath, svgText, findings, policy);
			}
		} else if (!appearsBinary(buffer)) {
			const text = decodeText(buffer);
			if (text === null) {
				addFinding(findings, policy, {
					path: relativePath,
					rule: 'INVALID_UTF8',
					message: 'Text file is not valid UTF-8.',
				});
			} else {
				scanText(relativePath, text, findings, policy);
			}
		}
	}

	if (requireManifestCompleteness) {
		for (const asset of assetManifest.assets) {
			const assetPath = normalizeRelativePath(asset.path);
			if (!scannedPaths.has(assetPath)) {
				addFinding(findings, policy, {
					path: assetPath,
					rule: 'ASSET_MISSING',
					message: 'Reviewed asset manifest entry does not exist in the scanned tree.',
				});
			}
		}
	}

	return {
		filesScanned: files.length,
		findings: deduplicateFindings(findings),
		root,
	};
}

function verifyManifestedAsset({
	assetPath,
	buffer,
	extension,
	findings,
	magicKind,
	manifestEntry,
	policy,
	relativePath,
}) {
	if (!manifestEntry) {
		addFinding(findings, policy, {
			path: relativePath,
			rule: appearsBinary(buffer) || magicKind ? 'BINARY_UNMANIFESTED' : 'ASSET_NOT_MANIFESTED',
			message: 'Asset is not present in the reviewed public-release manifest.',
		});
	} else {
		const actualSha256 = sha256(buffer);
		if (actualSha256 !== manifestEntry.sha256.toLowerCase()) {
			addFinding(findings, policy, {
				path: relativePath,
				rule: 'ASSET_HASH_MISMATCH',
				message: `Asset bytes do not match the reviewed SHA-256 for ${assetPath}.`,
			});
		}
	}

	const isDangerous = policy.dangerousExtensions
		.map(normalizeExtension)
		.includes(extension) || isDangerousMagic(magicKind) || isSensitivePath(relativePath);
	if (isDangerous && manifestEntry?.allowDangerous !== true) {
		addFinding(findings, policy, {
			path: relativePath,
			rule: 'DANGEROUS_ASSET',
			message: 'Archive, office, database, executable, key, or disk-image asset requires an exact allowDangerous manifest approval.',
		});
	}
}

function scanText(relativePath, text, findings, policy) {
	for (const match of text.matchAll(cloneGlobalRegularExpression(EMAIL_PATTERN))) {
		if (!isAllowedEmail(match[0], policy)) {
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index,
				match[0],
				'INDIVIDUAL_EMAIL_NOT_ALLOWED',
				'Individual email addresses are not permitted; use a GitHub noreply identity, synthetic fixture, or explicitly approved role address.',
			);
		}
	}

	for (const secret of SECRET_PATTERNS) {
		for (const match of text.matchAll(cloneGlobalRegularExpression(secret.pattern))) {
			addTextFinding(findings, policy, relativePath, text, match.index, match[0], secret.rule, secret.message);
		}
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(GENERIC_SECRET_PATTERN))) {
		const value = match[2] ?? match[3] ?? '';
		if (!isPlaceholderSecret(value)) {
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index,
				match[0],
				'SECRET_GENERIC_LITERAL',
				'A literal assigned to a credential-like field is not permitted.',
			);
		}
	}

	for (const pathPattern of PERSONAL_PATH_PATTERNS) {
		for (const match of text.matchAll(cloneGlobalRegularExpression(pathPattern))) {
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index,
				match[0],
				'PERSONAL_PATH',
				'Personal workstation path is not permitted.',
			);
		}
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(URL_PATTERN))) {
		const nextCharacter = text[match.index + match[0].length];
		if (match[0].endsWith('$') && nextCharacter === '{') {
			continue;
		}
		let parsed;
		try {
			parsed = new URL(match[0]);
		} catch {
			continue;
		}
		if (parsed.username || parsed.password) {
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index,
				match[0],
				'URL_CREDENTIALS',
				'URL contains embedded credentials.',
			);
		}
		const urlHostname = normalizeHostname(parsed.hostname);
		if (
			urlHostname &&
			net.isIP(urlHostname) === 0 &&
			!isAllowedHostname(urlHostname, policy)
		) {
			const hostnameOffset = match[0].toLowerCase().indexOf(parsed.hostname.toLowerCase());
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index + Math.max(0, hostnameOffset),
				urlHostname,
				'HOST_NOT_ALLOWED',
				`External hostname is not on the public-release allowlist: ${urlHostname}`,
			);
		}
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(HOSTNAME_PATTERN))) {
		const hostname = normalizeHostname(match[0]);
		if (!isAllowedHostname(hostname, policy)) {
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				match.index,
				hostname,
				'HOST_NOT_ALLOWED',
				`External hostname is not on the public-release allowlist: ${hostname}`,
			);
		}
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(HOSTNAME_CANDIDATE_PATTERN))) {
		const hostname = normalizeHostname(match[0]);
		const suffix = hostname.split('.').at(-1) ?? '';
		if (
			NON_HOSTNAME_SUFFIXES.has(suffix) ||
			isAllowedHostname(hostname, policy) ||
			!isHighConfidenceBareHostname(relativePath, text, match.index, match[0])
		) {
			continue;
		}
		addTextFinding(
			findings,
			policy,
			relativePath,
			text,
			match.index,
			hostname,
			'HOST_NOT_ALLOWED',
			`External hostname is not on the public-release allowlist: ${hostname}`,
		);
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(IPV4_PATTERN))) {
		const address = match[1];
		if (net.isIP(address) === 4 && !isAllowedIp(address, policy)) {
			const matchIndex = match.index + match[0].indexOf(address);
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				matchIndex,
				address,
				'PUBLIC_IP_NOT_ALLOWED',
				`Public IP address is not on the public-release allowlist: ${address}`,
			);
		}
	}

	for (const match of text.matchAll(cloneGlobalRegularExpression(IPV6_CANDIDATE_PATTERN))) {
		const address = match[1];
		if (net.isIP(address) === 6 && !isAllowedIp(address, policy)) {
			const matchIndex = match.index + match[0].indexOf(address);
			addTextFinding(
				findings,
				policy,
				relativePath,
				text,
				matchIndex,
				address,
				'PUBLIC_IP_NOT_ALLOWED',
				`Public IP address is not on the public-release allowlist: ${address}`,
			);
		}
	}
}

function normalizeEmail(value) {
	return String(value).trim().toLowerCase();
}

function emailDomain(value) {
	const normalized = normalizeEmail(value);
	return normalized.slice(normalized.lastIndexOf('@') + 1);
}

function isAllowedEmail(value, policy) {
	const normalized = normalizeEmail(value);
	const domain = emailDomain(normalized);
	return policy.allowedEmailAddresses.map(normalizeEmail).includes(normalized)
		|| policy.allowedNoreplyEmailDomains.map(normalizeHostname).includes(domain)
		|| policy.allowedSyntheticEmailDomains.map(normalizeHostname).includes(domain);
}

function emailsInText(text) {
	return [...String(text).matchAll(cloneGlobalRegularExpression(EMAIL_PATTERN))]
		.map((match) => match[0]);
}

function inspectPng(buffer) {
	const findings = [];
	if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		return [{ rule: 'PNG_INVALID', message: 'PNG signature is missing or invalid.' }];
	}

	let offset = PNG_SIGNATURE.length;
	let chunkIndex = 0;
	let foundIend = false;
	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const chunkEnd = offset + 12 + length;
		if (chunkEnd > buffer.length) {
			findings.push({ rule: 'PNG_INVALID', message: 'PNG contains a truncated chunk.' });
			return findings;
		}
		const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
		const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
		if (expectedCrc !== actualCrc) {
			findings.push({ rule: 'PNG_INVALID', message: `PNG chunk ${type} has an invalid CRC.` });
		}
		if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) {
			findings.push({ rule: 'PNG_INVALID', message: 'PNG must begin with a 13-byte IHDR chunk.' });
		}
		if (!PNG_ALLOWED_CHUNKS.has(type)) {
			findings.push({
				rule: 'PNG_UNSAFE_METADATA',
				message: `PNG contains unapproved ancillary or metadata chunk: ${type}`,
			});
		}
		if (type === 'IEND') {
			if (length !== 0) {
				findings.push({ rule: 'PNG_INVALID', message: 'PNG IEND chunk must be empty.' });
			}
			foundIend = true;
			offset = chunkEnd;
			break;
		}
		offset = chunkEnd;
		chunkIndex += 1;
	}

	if (!foundIend) {
		findings.push({ rule: 'PNG_INVALID', message: 'PNG is missing its IEND chunk.' });
	} else if (offset !== buffer.length) {
		findings.push({ rule: 'PNG_TRAILING_DATA', message: 'PNG contains data after its IEND chunk.' });
	}
	return findings;
}

function inspectSvg(text) {
	const findings = [];
	for (const [pattern, message] of [
		[/<\s*script\b/i, 'SVG contains a script element.'],
		[/\son[a-z]+\s*=/i, 'SVG contains an event-handler attribute.'],
		[/\bjavascript\s*:/i, 'SVG contains a JavaScript URL.'],
		[/<\s*foreignObject\b/i, 'SVG contains an active foreignObject element.'],
		[/<!\s*(?:DOCTYPE|ENTITY)\b/i, 'SVG contains a document type or entity declaration.'],
	]) {
		const match = pattern.exec(text);
		if (match) {
			findings.push({
				index: match.index,
				match: match[0],
				rule: 'SVG_ACTIVE_CONTENT',
				message,
			});
		}
	}

	for (const pattern of [
		/(?:href|xlink:href|src)\s*=\s*["']\s*(?!#)[^"']+["']/gi,
		/url\(\s*["']?\s*(?!#)[^)]+\)/gi,
		/@import\s+[^;]+/gi,
	]) {
		for (const match of text.matchAll(pattern)) {
			findings.push({
				index: match.index,
				match: match[0],
				rule: 'SVG_EXTERNAL_REFERENCE',
				message: 'SVG contains an external or embedded-data reference.',
			});
		}
	}
	return findings;
}

function addTextFinding(findings, policy, relativePath, text, index, match, rule, message) {
	addFinding(findings, policy, {
		column: columnNumber(text, index),
		index,
		line: lineNumber(text, index),
		match,
		message,
		path: relativePath,
		rule,
	});
}

function addFinding(findings, policy, finding) {
	if (isExactFindingAllowed(finding, policy)) {
		return;
	}
	findings.push(finding);
}

function isExactFindingAllowed(finding, policy) {
	if (typeof finding.match !== 'string') {
		return false;
	}
	const matchSha256 = sha256(Buffer.from(finding.match, 'utf8'));
	return policy.exactFindingAllowlist.some((exception) =>
		normalizeRelativePath(exception.path) === normalizeRelativePath(finding.path) &&
		exception.rule === finding.rule &&
		exception.matchSha256.toLowerCase() === matchSha256,
	);
}

function listGitTrackedFiles(root) {
	let stagedOutput;
	let untrackedOutput;
	try {
		stagedOutput = execFileSync('git', [
			'ls-files',
			'--stage',
			'--cached',
			'-z',
		], {
			cwd: root,
			encoding: 'buffer',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		untrackedOutput = execFileSync('git', [
			'ls-files',
			'--others',
			'--exclude-standard',
			'-z',
		], {
			cwd: root,
			encoding: 'buffer',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		throw new Error(`Unable to list Git release-candidate files below ${root}: ${error.message}`);
	}

	const stagedFiles = stagedOutput
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
		.map((record) => describeIndexPath(root, record));
	const worktreeFiles = stagedFiles.flatMap((staged) => {
		if (!fs.existsSync(path.join(root, staged.relativePath))) {
			return [];
		}
		const worktree = describePath(root, staged.relativePath);
		return worktree.problem || staged.problem || !worktree.buffer?.equals(staged.buffer)
			? [worktree]
			: [];
	});
	const untrackedFiles = untrackedOutput
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
		.map((relativePath) => describePath(root, relativePath));

	return [...stagedFiles, ...worktreeFiles, ...untrackedFiles];
}

function describeIndexPath(root, record) {
	const separator = record.indexOf('\t');
	const metadata = separator === -1 ? '' : record.slice(0, separator);
	const relativePath = separator === -1 ? record : record.slice(separator + 1);
	const [mode, objectId, stage] = metadata.split(' ');
	if (!isSafeRelativePath(relativePath) || !/^[0-9a-f]{40,64}$/i.test(objectId ?? '')) {
		return {
			absolutePath: path.join(root, relativePath),
			problem: 'Git index entry could not be parsed safely.',
			relativePath,
			rule: 'INDEX_ENTRY_INVALID',
		};
	}
	if (stage !== '0') {
		return {
			absolutePath: path.join(root, relativePath),
			problem: 'Unmerged Git index entries are not permitted in a public-release scan.',
			relativePath,
			rule: 'INDEX_UNMERGED',
		};
	}
	if (mode === '120000') {
		return {
			absolutePath: path.join(root, relativePath),
			problem: 'Symbolic links are not permitted in the public-release tree.',
			relativePath,
			rule: 'SYMLINK_NOT_ALLOWED',
		};
	}
	if (!['100644', '100755'].includes(mode)) {
		return {
			absolutePath: path.join(root, relativePath),
			problem: `Unsupported Git index mode ${mode}.`,
			relativePath,
			rule: 'INDEX_MODE_NOT_ALLOWED',
		};
	}

	try {
		return {
			absolutePath: path.join(root, relativePath),
			buffer: execFileSync('git', ['cat-file', 'blob', objectId], {
				cwd: root,
				encoding: 'buffer',
				maxBuffer: 32 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
			relativePath,
		};
	} catch (error) {
		return {
			absolutePath: path.join(root, relativePath),
			problem: `Git index blob cannot be read: ${error.message}`,
			relativePath,
			rule: 'INDEX_BLOB_MISSING',
		};
	}
}

function listDirectoryFiles(root) {
	const files = [];
	const visit = (absoluteDirectory) => {
		for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
			if (entry.name === '.git') {
				continue;
			}
			const absolutePath = path.join(absoluteDirectory, entry.name);
			const relativePath = path.relative(root, absolutePath);
			if (entry.isDirectory()) {
				visit(absolutePath);
			} else {
				files.push(describePath(root, relativePath));
			}
		}
	};
	visit(root);
	return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function describePath(root, relativePath) {
	const absolutePath = path.join(root, relativePath);
	let stat;
	try {
		stat = fs.lstatSync(absolutePath);
	} catch (error) {
		return {
			absolutePath,
			problem: `Tracked path cannot be read: ${error.message}`,
			relativePath,
			rule: 'TRACKED_FILE_MISSING',
		};
	}
	if (stat.isSymbolicLink()) {
		return {
			absolutePath,
			problem: 'Symbolic links are not permitted in the public-release tree.',
			relativePath,
			rule: 'SYMLINK_NOT_ALLOWED',
		};
	}
	if (!stat.isFile()) {
		return {
			absolutePath,
			problem: 'Tracked path is not a regular file.',
			relativePath,
			rule: 'NON_FILE_NOT_ALLOWED',
		};
	}
	return { absolutePath, buffer: fs.readFileSync(absolutePath), relativePath };
}

function identifyMagic(buffer) {
	return MAGIC_KINDS.find(({ signature }) =>
		buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature),
	)?.kind ?? null;
}

function isDangerousMagic(kind) {
	return kind !== null && kind !== 'png';
}

function isSensitivePath(relativePath) {
	const baseName = path.basename(relativePath).toLowerCase();
	return SENSITIVE_FILE_NAMES.has(baseName) ||
		(baseName.startsWith('.env.') && !baseName.endsWith('.example') && !baseName.endsWith('.sample'));
}

function appearsBinary(buffer) {
	const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
	return sample.includes(0);
}

function decodeText(buffer) {
	const text = buffer.toString('utf8');
	return text.includes('\ufffd') ? null : text;
}

function isAllowedHostname(hostname, policy) {
	if (
		hostname === 'localhost' ||
		hostname === 'example' ||
		hostname.endsWith('.example') ||
		hostname === 'example.com' ||
		hostname.endsWith('.example.com') ||
		hostname === 'example.net' ||
		hostname.endsWith('.example.net') ||
		hostname === 'example.org' ||
		hostname.endsWith('.example.org')
	) {
		return true;
	}
	return policy.allowedHostnames.some((allowed) => normalizeHostname(allowed) === hostname);
}

function isAllowedIp(address, policy) {
	if (policy.allowedPublicIps.includes(address)) {
		return true;
	}
	return net.isIP(address) === 4 ? isSafeExampleIpv4(address) : isSafeExampleIpv6(address);
}

function isSafeExampleIpv4(address) {
	const octets = address.split('.').map(Number);
	const value = (
		(octets[0] * 0x1000000) +
		(octets[1] * 0x10000) +
		(octets[2] * 0x100) +
		octets[3]
	) >>> 0;
	return [
		['0.0.0.0', 32],
		['127.0.0.0', 8],
		['192.0.2.0', 24],
		['198.51.100.0', 24],
		['203.0.113.0', 24],
	].some(([base, prefix]) => ipv4InCidr(value, base, prefix));
}

function ipv4InCidr(value, baseAddress, prefix) {
	const baseOctets = baseAddress.split('.').map(Number);
	const base = (
		(baseOctets[0] * 0x1000000) +
		(baseOctets[1] * 0x10000) +
		(baseOctets[2] * 0x100) +
		baseOctets[3]
	) >>> 0;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (value & mask) === (base & mask);
}

function isSafeExampleIpv6(address) {
	const normalized = address.toLowerCase();
	return normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('2001:db8:') ||
		normalized === '2001:db8::';
}

function isPlaceholderSecret(value) {
	const trimmed = value.trim();
	return PLACEHOLDER_SECRET_VALUES.has(trimmed.toLowerCase()) ||
		PLACEHOLDER_SECRET_TEMPLATES.some((pattern) => pattern.test(trimmed));
}

function isHighConfidenceBareHostname(relativePath, text, index, value) {
	const lineStart = text.lastIndexOf('\n', index - 1) + 1;
	const lineEndCandidate = text.indexOf('\n', index + value.length);
	const lineEnd = lineEndCandidate === -1 ? text.length : lineEndCandidate;
	const prefix = text.slice(lineStart, index);
	const suffix = text.slice(index + value.length, lineEnd);
	const previousCharacter = text[index - 1] ?? '';
	const nextCharacter = text[index + value.length] ?? '';

	if (previousCharacter === '/' || /[0-9A-Za-z_-]/.test(nextCharacter)) {
		return false;
	}
	if (value.includes('-')) {
		return true;
	}
	if (previousCharacter === '@') {
		return true;
	}
	if (/^\s*(?:[-*]\s*)?$/.test(prefix) && /^\s*\.?\s*$/.test(suffix)) {
		return true;
	}
	if (/(?:^|\b)(?:proxy_pass|server_name)\s+["'`]?\s*$/i.test(prefix)) {
		return true;
	}
	const configLikeExtensions = new Set(['.conf', '.env', '.hbs', '.ini', '.json', '.md', '.toml', '.txt', '.yaml', '.yml']);
	return configLikeExtensions.has(path.extname(relativePath).toLowerCase()) &&
		/(?:^|\b)(?:cname|domain|host|hostname|origin|site[_-]?url|url)\s*(?::|=|\s)\s*["'`]?\s*$/i.test(prefix);
}

function canonicalAssetPath(relativePath) {
	const normalized = normalizeRelativePath(relativePath);
	return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized;
}

function normalizeRelativePath(value) {
	return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeHostname(value) {
	return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function normalizeExtension(value) {
	const normalized = value.trim().toLowerCase();
	return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function isSafeRelativePath(value) {
	const normalized = normalizeRelativePath(value);
	return normalized.length > 0 &&
		!path.posix.isAbsolute(normalized) &&
		!normalized.split('/').includes('..');
}

function isSha256(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

function cloneGlobalRegularExpression(pattern) {
	return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

function lineNumber(text, index) {
	return text.slice(0, index).split('\n').length;
}

function columnNumber(text, index) {
	const lineStart = text.lastIndexOf('\n', index - 1);
	return index - lineStart;
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function deduplicateFindings(findings) {
	const seen = new Set();
	return findings.filter((finding) => {
		const key = [finding.path, finding.rule, finding.index ?? '', finding.message].join('\0');
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function formatFinding(finding) {
	const location = finding.line
		? `${finding.path}:${finding.line}:${finding.column ?? 1}`
		: finding.path;
	return `${location} [${finding.rule}] ${finding.message}`;
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--root') {
			options.root = argv[index + 1];
			options.useGitTrackedFiles = false;
			options.requireManifestCompleteness = false;
			index += 1;
		} else if (argument === '--policy') {
			options.policyPath = argv[index + 1];
			index += 1;
		} else if (argument === '--assets') {
			options.assetManifestPath = argv[index + 1];
			index += 1;
		} else if (argument === '--require-manifest-completeness') {
			options.requireManifestCompleteness = true;
		} else if (!argument.startsWith('-') && options.root === undefined) {
			options.root = argument;
			options.useGitTrackedFiles = false;
			options.requireManifestCompleteness = false;
		} else {
			throw new Error(`Unknown or incomplete argument: ${argument}`);
		}
	}
	return options;
}

function runCli(argv = process.argv.slice(2)) {
	try {
		const result = scanPublicRelease(parseArguments(argv));
		if (result.findings.length > 0) {
			for (const finding of result.findings) {
				console.error(formatFinding(finding));
			}
			console.error(`Public-release safety check failed with ${result.findings.length} finding(s) across ${result.filesScanned} file(s).`);
			return 1;
		}
		console.log(`Public-release safety check passed for ${result.filesScanned} file(s).`);
		return 0;
	} catch (error) {
		console.error(`Public-release safety check could not run: ${error.message}`);
		return 1;
	}
}

if (require.main === module) {
	process.exitCode = runCli();
}

module.exports = {
	crc32,
	emailsInText,
	formatFinding,
	inspectPng,
	inspectSvg,
	isAllowedEmail,
	loadAssetManifest,
	loadPolicy,
	runCli,
	scanPublicRelease,
	sha256,
};
