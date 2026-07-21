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

export function originProbeErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = error && typeof error === 'object' && 'code' in error
		? String((error as { code?: unknown }).code ?? '')
		: '';
	if (code === 'ETIMEDOUT' || /\bETIMEDOUT\b/i.test(message)) {
		return 'Connection timed out.';
	}

	return message;
}

function probeTimeoutMessage(timeoutMs: number): string {
	const seconds = timeoutMs / 1_000;
	const formatted = Number.isInteger(seconds)
		? String(seconds)
		: seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	return `Connection timed out after ${formatted} second${seconds === 1 ? '' : 's'}.`;
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
		const reason = abortReason === 'timeout'
			? probeTimeoutMessage(timeoutMs)
			: abortReason === 'cancelled'
				? 'Connection test stopped.'
				: originProbeErrorReason(error);
		const identity = origin.tlsHostname === origin.hostname
			? origin.hostname
			: `${origin.hostname} using TLS identity ${origin.tlsHostname}`;
		throw new Error(
			`Could not connect to ${origin.originIp}:${origin.port} for ${identity}. ${reason}`,
		);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', cancel);
	}
}
