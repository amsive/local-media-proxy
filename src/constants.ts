/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const ADDON_ID = 'local-media-proxy';
export const ADDON_NAME = 'Local Media Proxy';
export const ADDON_VERSION = '0.4.2';
export const ORIGIN_REQUEST_USER_AGENT = `${ADDON_NAME}/${ADDON_VERSION}`;
export const PROXIED_CONTENT_SECURITY_POLICY =
	"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";
export const PROXIED_RESPONSE_HEADERS_TO_STRIP = [
	'Accept-CH',
	'Alt-Svc',
	'Authentication-Info',
	'Clear-Site-Data',
	'Content-Location',
	'Content-Security-Policy',
	'Content-Security-Policy-Report-Only',
	'Critical-CH',
	'Location',
	'NEL',
	'Origin-Trial',
	'Proxy-Authenticate',
	'Proxy-Authentication-Info',
	'Refresh',
	'Report-To',
	'Reporting-Endpoints',
	'Service-Worker-Allowed',
	'Set-Cookie',
	'Set-Cookie2',
	'Strict-Transport-Security',
	'X-Content-Type-Options',
	'X-Accel-Buffering',
	'X-Accel-Charset',
	'X-Accel-Expires',
	'X-Accel-Limit-Rate',
	'X-Accel-Redirect',
	'X-Local-Media-Proxy',
	'WWW-Authenticate',
] as const;

export const MANUAL_WPENGINE_TLS_HOSTNAME = 'origin.wpengine.com';

export const IPC_CHANNELS = {
	applySettings: `${ADDON_ID}:apply-settings`,
	cancelOriginTest: `${ADDON_ID}:cancel-origin-test`,
	discoverOrigin: `${ADDON_ID}:discover-origin`,
	getOriginDiscoveryOptions: `${ADDON_ID}:get-origin-discovery-options`,
	getSiteState: `${ADDON_ID}:get-site-state`,
	setEnabled: `${ADDON_ID}:set-enabled`,
	testOrigin: `${ADDON_ID}:test-origin`,
} as const;

export const SITE_SETTINGS_KEY = 'localMediaProxy';
export const MANAGED_INCLUDE_FILENAME = 'local-media-proxy.conf.hbs';
export const COMPILED_INCLUDE_FILENAME = 'local-media-proxy.conf';
export const TRUST_BUNDLE_FILENAME = 'local-media-proxy-origin-ca.pem';
export const MANAGED_MARKER_START = '# BEGIN Local Media Proxy (managed)';
export const MANAGED_MARKER_END = '# END Local Media Proxy (managed)';

export const DEFAULT_SETTINGS = {
	enabled: false,
	originIp: '',
	siteUrl: '',
} as const;
