/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const UPLOAD_ASSET_ROUTE_REVISION = 'upload-assets-v2';
export const UPLOAD_ASSET_PATH_PREFIX = '/wp-content/uploads/';

const PATH_CHARACTER_CLASS = "A-Za-z0-9._~!$&'()*+,;=:@-";
const NON_HIDDEN_PATH_CHARACTER_CLASS = "A-Za-z0-9_~!$&'()*+,;=:@-";
const EXTENSION_CHARACTER_CLASS = 'A-Za-z0-9_-';

export const UPLOAD_ASSET_SEGMENT_PATTERN =
	`[${NON_HIDDEN_PATH_CHARACTER_CLASS}][${PATH_CHARACTER_CLASS}]*`;
export const UPLOAD_ASSET_FILENAME_PATTERN =
	`[${NON_HIDDEN_PATH_CHARACTER_CLASS}][${PATH_CHARACTER_CLASS}]*\\.[A-Za-z0-9][${EXTENSION_CHARACTER_CLASS}]*`;
export const UPLOAD_ASSET_RELATIVE_PATH_PATTERN =
	`(?:${UPLOAD_ASSET_SEGMENT_PATTERN}/)*${UPLOAD_ASSET_FILENAME_PATTERN}`;
export const UPLOAD_ASSET_URI_PATTERN =
	`^/wp-content/uploads/${UPLOAD_ASSET_RELATIVE_PATH_PATTERN}$`;
export const APACHE_UPLOAD_ASSET_ROUTE_PATTERN =
	`^/(wp-content/uploads/${UPLOAD_ASSET_RELATIVE_PATH_PATTERN})$`;

/**
 * Unsafe path octets which must never be recovered through repeated decoding.
 * A literal percent-25 is rejected because it can conceal any of the other
 * blocked octets from the first URI decoding pass.
 */
export const UNSAFE_RAW_PERCENT_ENCODING_PATTERN =
	'%(?:25|2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)';

const SERVER_INTERPRETER_TOKEN_PATTERN = [
	'php[0-9]{0,2}',
	'pht',
	'phtm',
	'phtml',
	'phar',
	'phps',
	'cgi',
	'fcgi',
	'scgi',
	'pl',
	'pm',
	'py[co]?',
	'pyw',
	'rb',
	'erb',
	'lua',
	'tcl',
	'sh',
	'bash',
	'zsh',
	'csh',
	'ksh',
	'fish',
	'command',
	'bat',
	'cmd',
	'ps1',
	'psd1',
	'psm1',
	'vb',
	'vbe',
	'vbs',
	'wsf',
	'wsh',
	'asp',
	'aspx',
	'asa',
	'asax',
	'ascx',
	'ashx',
	'asmx',
	'cshtml',
	'vbhtml',
	'jsp',
	'jspx',
	'jspf',
	'cfm',
	'cfml',
	'cfc',
].join('|');

const BROWSER_ACTIVE_TOKEN_PATTERN = [
	'htm',
	'html',
	'hta',
	'htc',
	'mht',
	'mhtml',
	'xht',
	'xhtml',
	'shtml',
	'js',
	'mjs',
	'cjs',
	'jsx',
	'wasm',
	'swf',
].join('|');

const BLOCKED_FINAL_EXTENSION_PATTERN = [
	// Browser-executable documents. SVG/SVGZ are intentionally not blocked.
	BROWSER_ACTIVE_TOKEN_PATTERN,
	// Native packages, binaries, and runtime artifacts.
	'exe',
	'dll',
	'so',
	'dylib',
	'bin',
	'com',
	'msi',
	'app',
	'dmg',
	'pkg',
	'deb',
	'rpm',
	'apk',
	'elf',
	'class',
	'dex',
	'jar',
	'war',
	'ear',
	'ipa',
	'node',
	'appimage',
	'run',
	'scr',
	'cpl',
	'ocx',
	'sys',
	'drv',
	'lnk',
	'scf',
	'gadget',
	'desktop',
	'reg',
	// Obvious secret, configuration, database, and backup material.
	'env',
	'ini',
	'conf',
	'config',
	'cfg',
	'cnf',
	'properties',
	'yml',
	'yaml',
	'toml',
	'key',
	'pem',
	'p12',
	'pfx',
	'jks',
	'keystore',
	'crt',
	'cer',
	'der',
	'sql',
	'sqlite',
	'sqlite3',
	'db',
	'db3',
	'mdb',
	'accdb',
	'bak',
	'backup',
	'old',
	'orig',
	'save',
	'swp',
	'swo',
	'tmp',
	'temp',
	'dump',
].join('|');

const SENSITIVE_EXACT_BASENAME_PATTERN = [
	'\\.env',
	'\\.htaccess',
	'\\.htpasswd',
	'\\.user\\.ini',
	'web\\.config',
].join('|');

/**
 * This expression is applied to the complete upload path. Interpreter tokens
 * are blocked at every non-alphanumeric boundary in the basename so a
 * harmless-looking final extension or delimiter cannot conceal an executable
 * suffix.
 */
export const BLOCKED_UPLOAD_ASSET_PATH_PATTERN =
	`(?:^|/)(?:(?:[^/]*[^A-Za-z0-9])?(?:${SERVER_INTERPRETER_TOKEN_PATTERN})(?=[^A-Za-z0-9]|$)[^/]*|` +
	`(?:[^/]*[^A-Za-z0-9])?(?:${BROWSER_ACTIVE_TOKEN_PATTERN})(?=[^A-Za-z0-9]|$)[^/]*|` +
	`[^/]*\\.(?:${BLOCKED_FINAL_EXTENSION_PATTERN})|` +
	`(?:${SENSITIVE_EXACT_BASENAME_PATTERN}))$`;

const SAFE_DECODED_SEGMENT = new RegExp(`^[${PATH_CHARACTER_CLASS}]+$`);
const SAFE_EXTENSION = new RegExp(`^[A-Za-z0-9][${EXTENSION_CHARACTER_CLASS}]*$`);
const SERVER_INTERPRETER_TOKEN = new RegExp(
	`^(?:${SERVER_INTERPRETER_TOKEN_PATTERN})$`,
	'i',
);
const BROWSER_ACTIVE_TOKEN = new RegExp(
	`^(?:${BROWSER_ACTIVE_TOKEN_PATTERN})$`,
	'i',
);
const BLOCKED_FINAL_EXTENSION = new RegExp(
	`^(?:${BLOCKED_FINAL_EXTENSION_PATTERN})$`,
	'i',
);
const SENSITIVE_EXACT_BASENAMES = new Set([
	'.env',
	'.htaccess',
	'.htpasswd',
	'.user.ini',
	'web.config',
]);
const UNSAFE_RAW_PERCENT_ENCODING = new RegExp(
	UNSAFE_RAW_PERCENT_ENCODING_PATTERN,
	'i',
);

function basenameIsBlocked(basename: string): boolean {
	const normalized = basename.toLowerCase();
	if (SENSITIVE_EXACT_BASENAMES.has(normalized)) {
		return true;
	}

	const extension = normalized.slice(normalized.lastIndexOf('.') + 1);
	if (BLOCKED_FINAL_EXTENSION.test(extension)) {
		return true;
	}

	return normalized
		.split(/[^a-z0-9]+/)
		.some((token) => (
			SERVER_INTERPRETER_TOKEN.test(token) || BROWSER_ACTIVE_TOKEN.test(token)
		));
}

/**
 * Validate a URL pathname only. Query strings are deliberately excluded from
 * this helper because the web-server routes validate the path and then retain
 * the original query string for cache-busting.
 */
export function uploadAssetPathIsProxyEligible(requestPath: string): boolean {
	if (
		/[?#\\\\\u0000-\u001f\u007f]/.test(requestPath) ||
		!requestPath.toLowerCase().startsWith(UPLOAD_ASSET_PATH_PREFIX) ||
		UNSAFE_RAW_PERCENT_ENCODING.test(requestPath)
	) {
		return false;
	}

	const relativePath = requestPath.slice(UPLOAD_ASSET_PATH_PREFIX.length);
	const rawSegments = relativePath.split('/');
	if (rawSegments.length === 0 || rawSegments.some((segment) => !segment)) {
		return false;
	}

	const decodedSegments: string[] = [];
	for (const rawSegment of rawSegments) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(rawSegment);
		} catch {
			return false;
		}
		if (
			decoded.startsWith('.') ||
			decoded.includes('%') ||
			!SAFE_DECODED_SEGMENT.test(decoded)
		) {
			return false;
		}
		decodedSegments.push(decoded);
	}

	const basename = decodedSegments[decodedSegments.length - 1];
	const extensionSeparator = basename.lastIndexOf('.');
	if (
		extensionSeparator <= 0 ||
		extensionSeparator === basename.length - 1 ||
		!SAFE_EXTENSION.test(basename.slice(extensionSeparator + 1))
	) {
		return false;
	}

	return !basenameIsBlocked(basename);
}
