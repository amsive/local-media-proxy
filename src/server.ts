/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as Local from '@getflywheel/local';
import type { ServerKind } from './types';

export interface SiteServerAdapter {
	kind: ServerKind;
	reason?: string;
	requiresOriginIp: boolean;
	serviceName: string | null;
}

function classifyOfficialServiceName(value: unknown): 'apache' | 'nginx' | null {
	if (typeof value !== 'string') {
		return null;
	}
	const match = /^(apache|nginx)(?:-\d+(?:\.\d+)*(?:\+\d+)?)?$/.exec(value.trim().toLowerCase());
	return match ? match[1] as 'apache' | 'nginx' : null;
}

function classifyService(serviceName: string, service: Local.SiteService): 'apache' | 'nginx' | null {
	const candidates = [
		classifyOfficialServiceName(serviceName),
		classifyOfficialServiceName((service as { name?: unknown }).name),
	].filter((candidate): candidate is 'apache' | 'nginx' => candidate !== null);
	return candidates.length > 0 && candidates.every((candidate) => candidate === candidates[0])
		? candidates[0]
		: null;
}

function unsupported(reason: string): SiteServerAdapter {
	return {
		kind: 'unsupported',
		reason,
		requiresOriginIp: false,
		serviceName: null,
	};
}

function supported(
	kind: 'apache' | 'nginx',
	serviceName: string,
): SiteServerAdapter {
	return {
		kind,
		requiresOriginIp: kind === 'nginx',
		serviceName,
	};
}

export function detectSiteServer(site: Local.Site): SiteServerAdapter {
	const services = Object.entries(site.services ?? {});
	const httpServices = services.filter(([, service]) => (
		(service as { role?: unknown }).role === 'http'
	));
	if (httpServices.length > 1) {
		return unsupported('Local reported multiple HTTP services, so the web server could not be selected safely.');
	}

	const declaredServer = typeof (site as { webServer?: unknown }).webServer === 'string'
		? (site as { webServer: string }).webServer.trim().toLowerCase()
		: '';
	const declaredKind = declaredServer === 'apache' || declaredServer === 'nginx'
		? declaredServer
		: null;
	if (declaredServer && !declaredKind) {
		return unsupported('Local reported unsupported or ambiguous explicit web-server metadata.');
	}

	if (httpServices.length === 1) {
		const [serviceName, service] = httpServices[0];
		const kind = classifyService(serviceName, service);
		if (!kind) {
			return unsupported('Local reported an HTTP service with an unsupported or ambiguous server identity.');
		}
		if (declaredKind && declaredKind !== kind) {
			return unsupported('Local reported conflicting web-server identities for this site.');
		}
		return supported(kind, serviceName);
	}

	const legacyCandidates = services.flatMap(([serviceName, service]) => {
		const kind = classifyService(serviceName, service);
		return kind ? [{ kind, serviceName }] : [];
	});
	if (legacyCandidates.length !== 1) {
		return unsupported(
			legacyCandidates.length > 1
				? 'Local reported ambiguous legacy web-server services for this site.'
				: 'Local Media Proxy supports Local sites using Nginx or Apache.',
		);
	}

	const candidate = legacyCandidates[0];
	if (declaredKind && declaredKind !== candidate.kind) {
		return unsupported('Local reported conflicting web-server identities for this site.');
	}
	return supported(candidate.kind, candidate.serviceName);
}
