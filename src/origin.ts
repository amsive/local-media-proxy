/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import path from 'node:path';
import * as tls from 'node:tls';
import {
	MANUAL_WPENGINE_TLS_HOSTNAME,
	ORIGIN_REQUEST_USER_AGENT,
} from './constants';
import type {
	CertificateSummary,
	NormalizedOrigin,
	OriginProbeResult,
} from './types';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_TRUSTED_CERTIFICATE_AUTHORITY_ENTRIES = 512;
const MAX_TRUSTED_CERTIFICATE_AUTHORITY_INPUT_BYTES = 1024 * 1024;
const MAX_TRUSTED_CERTIFICATE_AUTHORITIES = 256;
const MAX_TRUST_BUNDLE_BYTES = 512 * 1024;
const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const TLS_TRUST_ERROR_CODES = new Set([
	'CERT_REVOKED',
	'CERT_UNTRUSTED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'INVALID_CA',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const TLS_HANDSHAKE_ERROR_CODES = new Set([
	'EPROTO',
	'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
	'ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME',
	'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
]);
const CLOUDFLARE_ORIGIN_CA_PATH = path.resolve(
	__dirname,
	'../resources/cloudflare-origin-ca.pem',
);
const CLOUDFLARE_ORIGIN_CA_FINGERPRINTS = new Set([
	'AA:63:69:7A:22:76:4B:67:B2:13:4C:E1:4C:B5:69:0E:A3:36:94:0B:93:98:61:13:F4:95:45:91:78:32:D8:0D',
	'D3:C7:E8:5C:91:70:7F:C0:A1:2A:BC:5D:88:26:67:47:AA:4F:A8:E7:B1:62:F6:33:FF:B3:C9:D9:89:94:76:20',
]);

function readBundledCertificateAuthorities(): string[] {
	const bundle = readFileSync(CLOUDFLARE_ORIGIN_CA_PATH, 'utf8');
	const certificates = bundle.match(PEM_CERTIFICATE_PATTERN) ?? [];
	if (certificates.length !== 2) {
		throw new Error('The bundled Cloudflare Origin CA trust file is invalid.');
	}

	const fingerprints = new Set(
		certificates.map((certificate) => new X509Certificate(certificate).fingerprint256),
	);
	if (
		fingerprints.size !== CLOUDFLARE_ORIGIN_CA_FINGERPRINTS.size ||
		![...CLOUDFLARE_ORIGIN_CA_FINGERPRINTS].every((fingerprint) => fingerprints.has(fingerprint))
	) {
		throw new Error('The bundled Cloudflare Origin CA roots do not match the published fingerprints.');
	}

	return certificates;
}

interface CertificateAuthorityBundle {
	certificates: string[];
	pem: string;
}

function buildCertificateAuthorityBundle(
	authorities: readonly string[],
): CertificateAuthorityBundle {
	const certificatesByFingerprint = new Map<string, string>();
	let inputBytes = 0;
	let processedEntries = 0;
	let trustedBundleBytes = 0;

	for (const authority of authorities) {
		inputBytes += Buffer.byteLength(authority, 'utf8');
		if (inputBytes > MAX_TRUSTED_CERTIFICATE_AUTHORITY_INPUT_BYTES) {
			throw new Error('The trusted certificate authority bundle exceeds safe limits.');
		}

		const certificates = authority.matchAll(PEM_CERTIFICATE_PATTERN);
		let matchedCertificate = false;
		for (const match of certificates) {
			matchedCertificate = true;
			processedEntries += 1;
			if (processedEntries > MAX_TRUSTED_CERTIFICATE_AUTHORITY_ENTRIES) {
				throw new Error('The trusted certificate authority bundle exceeds safe limits.');
			}

			let parsedCertificate: X509Certificate;
			try {
				parsedCertificate = new X509Certificate(match[0]);
			} catch {
				throw new Error('A trusted certificate authority entry is invalid.');
			}

			const fingerprint = parsedCertificate.fingerprint256;
			if (certificatesByFingerprint.has(fingerprint)) {
				continue;
			}
			if (certificatesByFingerprint.size >= MAX_TRUSTED_CERTIFICATE_AUTHORITIES) {
				throw new Error('The trusted certificate authority bundle exceeds safe limits.');
			}

			const canonicalCertificate = `${parsedCertificate.toString().trimEnd()}\n`;
			trustedBundleBytes += Buffer.byteLength(canonicalCertificate, 'utf8');
			if (trustedBundleBytes > MAX_TRUST_BUNDLE_BYTES) {
				throw new Error('The trusted certificate authority bundle exceeds safe limits.');
			}
			certificatesByFingerprint.set(fingerprint, canonicalCertificate);
		}

		if (!matchedCertificate) {
			throw new Error('A trusted certificate authority entry is invalid.');
		}
	}

	const certificates = [...certificatesByFingerprint.values()];
	if (certificates.length === 0) {
		throw new Error('A trusted certificate authority entry is invalid.');
	}

	return { certificates, pem: certificates.join('') };
}

const TRUSTED_CERTIFICATE_AUTHORITY_BUNDLE = buildCertificateAuthorityBundle([
	...tls.rootCertificates,
	...readBundledCertificateAuthorities(),
]);

export interface OriginProbeOptions {
	allowWpEngineTlsFallback?: boolean;
	certificateAuthorities?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

type ProbeAbortReason = 'cancelled' | 'timeout';

interface TlsHostnameError extends Error {
	cert?: tls.PeerCertificate;
	code?: string;
}

export function originResponseOutcome(statusCode: number): 'success' | 'warning' {
	return statusCode >= 200 && statusCode < 300 ? 'success' : 'warning';
}

export function trustedCertificateAuthoritiesPem(): string {
	return TRUSTED_CERTIFICATE_AUTHORITY_BUNDLE.pem;
}

function summarizeCertificate(certificate: tls.DetailedPeerCertificate): CertificateSummary {
	const certificateName = (value: string | string[] | undefined, fallback: string): string => {
		if (Array.isArray(value)) {
			return value[0] || fallback;
		}

		return value || fallback;
	};
	const fingerprint256 = certificate.fingerprint256 || createHash('sha256')
		.update(certificate.raw)
		.digest('hex')
		.match(/.{2}/g)
		?.join(':')
		.toUpperCase() || '';

	return {
		fingerprint256,
		issuer: certificateName(
			certificate.issuer?.CN || certificate.issuer?.O,
			'Unknown issuer',
		),
		subject: certificateName(
			certificate.subject?.CN || certificate.subject?.O,
			'Unknown subject',
		),
		validTo: certificate.valid_to || 'Unknown',
	};
}

function probeHttpOrigin(
	origin: NormalizedOrigin,
	signal: AbortSignal,
): Promise<OriginProbeResult> {
	return new Promise((resolve, reject) => {
		const request = http.request({
			agent: false,
			headers: {
				Connection: 'close',
				Host: origin.hostHeader,
				'User-Agent': ORIGIN_REQUEST_USER_AGENT,
			},
			host: origin.originIp,
			method: 'HEAD',
			path: '/',
			port: origin.port,
			signal,
		}, (response) => {
			const statusCode = response.statusCode ?? 0;
			response.resume();
			response.once('end', () => resolve({ statusCode }));
		});

		request.once('error', reject);
		request.end();
	});
}

function probeHttpsOrigin(
	origin: NormalizedOrigin,
	certificateAuthorityBundle: CertificateAuthorityBundle,
	signal: AbortSignal,
): Promise<OriginProbeResult> {
	return new Promise((resolve, reject) => {
		let certificate: CertificateSummary | undefined;
		let certificateVerified = false;

		const request = https.request({
			agent: false,
			ca: certificateAuthorityBundle.certificates,
			checkServerIdentity: (_hostname, peerCertificate) => tls.checkServerIdentity(
				origin.tlsHostname,
				peerCertificate,
			),
			headers: {
				Connection: 'close',
				Host: origin.hostHeader,
				'User-Agent': ORIGIN_REQUEST_USER_AGENT,
			},
			host: origin.originIp,
			method: 'HEAD',
			path: '/',
			port: origin.port,
			rejectUnauthorized: true,
			servername: origin.tlsHostname,
			signal,
		}, (response) => {
			if (!certificateVerified) {
				response.destroy(new Error('The HTTPS origin certificate could not be verified.'));
				return;
			}

			const statusCode = response.statusCode ?? 0;
			response.resume();
			response.once('end', () => resolve({
				certificate,
				statusCode,
				trustedCertificateAuthoritiesPem: certificateAuthorityBundle.pem,
				verifiedTlsHostname: origin.tlsHostname,
			}));
		});

		request.once('socket', (socket) => {
			const tlsSocket = socket as tls.TLSSocket;
			tlsSocket.once('secureConnect', () => {
				try {
					if (!tlsSocket.authorized) {
						return;
					}

					const peerCertificate = tlsSocket.getPeerCertificate(true);
					if (!peerCertificate || !Buffer.isBuffer(peerCertificate.raw)) {
						throw new Error('The HTTPS origin did not provide a certificate.');
					}

					certificate = summarizeCertificate(peerCertificate);
					certificateVerified = true;
				} catch (error) {
					request.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});

		request.once('error', reject);
		request.end();
	});
}

function canRetryWithManualWpEngineIdentity(
	origin: NormalizedOrigin,
	error: unknown,
): boolean {
	if (
		origin.protocol !== 'https:' ||
		origin.tlsHostname !== origin.hostname ||
		!(error instanceof Error) ||
		(error as TlsHostnameError).code !== 'ERR_TLS_CERT_ALTNAME_INVALID'
	) {
		return false;
	}

	const certificate = (error as TlsHostnameError).cert;
	return Boolean(
		certificate &&
		tls.checkServerIdentity(MANUAL_WPENGINE_TLS_HOSTNAME, certificate) === undefined,
	);
}

function errorCode(error: unknown): string {
	return error && typeof error === 'object' && 'code' in error
		? String((error as { code?: unknown }).code ?? '').toUpperCase()
		: '';
}

function remoteEndpoint(origin: NormalizedOrigin): string {
	const address = origin.originIp.includes(':')
		? `[${origin.originIp}]`
		: origin.originIp;
	const defaultPort = origin.protocol === 'https:' ? 443 : 80;

	return origin.port === defaultPort ? address : `${address}:${origin.port}`;
}

function siteUrlAndRemoteAddress(origin: NormalizedOrigin): string {
	if (origin.originIp === origin.hostname) {
		return `Site URL ${origin.siteUrl}`;
	}
	return `Site URL ${origin.siteUrl} and Remote IP address ${remoteEndpoint(origin)}`;
}

export function originProbeErrorReason(
	error: unknown,
	origin?: NormalizedOrigin,
): string {
	const code = errorCode(error);
	const secureOrigin = origin?.protocol === 'https:';
	const context = origin ? siteUrlAndRemoteAddress(origin) : undefined;

	if (secureOrigin && TLS_HANDSHAKE_ERROR_CODES.has(code)) {
		return `The HTTPS handshake failed for ${context}. Check that the address serves this hostname over HTTPS.`;
	}
	if (secureOrigin && code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
		return `The HTTPS certificate for ${context} does not match the expected hostname. Check that both fields identify the same site.`;
	}
	if (secureOrigin && code === 'CERT_HAS_EXPIRED') {
		return `The HTTPS certificate for ${context} has expired. Renew the remote certificate before trying again.`;
	}
	if (secureOrigin && code === 'CERT_NOT_YET_VALID') {
		return `The HTTPS certificate for ${context} is not valid yet. Check the remote certificate dates and this computer's clock.`;
	}
	if (secureOrigin && TLS_TRUST_ERROR_CODES.has(code)) {
		return `The HTTPS certificate for ${context} is not trusted. Check the certificate chain on the remote server.`;
	}
	if (code === 'ECONNREFUSED') {
		return origin
			? origin.originIp === origin.hostname
				? `Site URL ${origin.siteUrl} refused the connection. Check that its hostname and port accept ${secureOrigin ? 'HTTPS' : 'HTTP'} connections.`
				: `Remote IP address ${remoteEndpoint(origin)} refused the connection for Site URL ${origin.siteUrl}. Check that the address and port accept ${secureOrigin ? 'HTTPS' : 'HTTP'} connections.`
			: 'The remote endpoint refused the connection.';
	}
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
		return origin
			? origin.originIp === origin.hostname
				? `Site URL ${origin.siteUrl} is unreachable. Check its hostname and network access.`
				: `Remote IP address ${remoteEndpoint(origin)} is unreachable for Site URL ${origin.siteUrl}. Check the address and network access.`
			: 'The remote endpoint is unreachable.';
	}
	if (code === 'ECONNRESET') {
		return origin
			? `The connection for ${context} was reset before the check completed. Try again or check the remote server.`
			: 'The connection was reset before the check completed.';
	}
	if (code === 'ETIMEDOUT') {
		return origin
			? `Connection timed out for ${context}. Check the address, port, and network access.`
			: 'Connection timed out.';
	}

	return origin
		? `Could not reach ${context}. Check both fields and try again.`
		: 'The remote endpoint could not be reached.';
}

function probeTimeoutMessage(timeoutMs: number, origin: NormalizedOrigin): string {
	const seconds = timeoutMs / 1_000;
	const formatted = Number.isInteger(seconds)
		? String(seconds)
		: seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	return `Connection timed out after ${formatted} second${seconds === 1 ? '' : 's'}. Check ${siteUrlAndRemoteAddress(origin)}.`;
}

export async function probeOrigin(
	origin: NormalizedOrigin,
	options: OriginProbeOptions = {},
): Promise<OriginProbeResult> {
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error('Origin probe timeout must be a positive number.');
	}

	const controller = new AbortController();
	let abortReason: ProbeAbortReason | undefined;
	const abort = (reason: ProbeAbortReason): void => {
		if (!controller.signal.aborted) {
			abortReason = reason;
			controller.abort();
		}
	};
	const cancel = (): void => abort('cancelled');
	if (options.signal?.aborted) {
		cancel();
	} else {
		options.signal?.addEventListener('abort', cancel, { once: true });
	}
	const timeout = setTimeout(() => abort('timeout'), timeoutMs);

	try {
		if (origin.protocol === 'http:') {
			return await probeHttpOrigin(origin, controller.signal);
		}

		const certificateAuthorityBundle = options.certificateAuthorities
			? buildCertificateAuthorityBundle(options.certificateAuthorities)
			: TRUSTED_CERTIFICATE_AUTHORITY_BUNDLE;
		try {
			return await probeHttpsOrigin(origin, certificateAuthorityBundle, controller.signal);
		} catch (error) {
			if (
				!controller.signal.aborted &&
				options.allowWpEngineTlsFallback !== false &&
				canRetryWithManualWpEngineIdentity(origin, error)
			) {
				return await probeHttpsOrigin(
					{ ...origin, tlsHostname: MANUAL_WPENGINE_TLS_HOSTNAME },
					certificateAuthorityBundle,
					controller.signal,
				);
			}
			throw error;
		}
	} catch (error) {
		const message = abortReason === 'timeout'
			? probeTimeoutMessage(timeoutMs, origin)
			: abortReason === 'cancelled'
				? 'Connection test stopped.'
				: originProbeErrorReason(error, origin);
		throw new Error(message, { cause: error });
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', cancel);
	}
}
