/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectSiteServer } = require('../lib/server');

test('selects the explicit HTTP-role service instead of unrelated service names', () => {
	assert.deepEqual(detectSiteServer({
		services: {
			'apache-helper': { name: 'apache-helper', role: 'other' },
			web: { name: 'nginx', role: 'http' },
		},
		webServer: 'nginx',
	}), {
		kind: 'nginx',
		requiresOriginIp: true,
		serviceName: 'web',
	});
});

test('detects an explicit Apache HTTP service', () => {
	assert.deepEqual(detectSiteServer({
		services: { web: { name: 'apache', role: 'http' } },
		webServer: 'apache',
	}), {
		kind: 'apache',
		requiresOriginIp: false,
		serviceName: 'web',
	});
});

test('fails closed for multiple HTTP-role services', () => {
	const result = detectSiteServer({
		services: {
			apache: { name: 'apache', role: 'http' },
			nginx: { name: 'nginx', role: 'http' },
		},
	});
	assert.equal(result.kind, 'unsupported');
	assert.match(result.reason, /multiple HTTP services/);
});

test('fails closed for an ambiguous or mismatched HTTP service identity', () => {
	assert.equal(detectSiteServer({
		services: { web: { name: 'apache-nginx', role: 'http' } },
	}).kind, 'unsupported');
	assert.equal(detectSiteServer({
		services: { web: { name: 'apache', role: 'http' } },
		webServer: 'nginx',
	}).kind, 'unsupported');
	for (const webServer of ['caddy', 'apache-nginx', 'notapache']) {
		assert.equal(detectSiteServer({
			services: { web: { name: 'apache', role: 'http' } },
			webServer,
		}).kind, 'unsupported');
	}
});

test('accepts only exact explicit names and narrowly versioned official service identities', () => {
	for (const name of ['notapache', 'mynginxhelper', 'nginx-helper']) {
		assert.equal(detectSiteServer({
			services: { web: { name, role: 'http' } },
		}).kind, 'unsupported', name);
	}
	assert.deepEqual(detectSiteServer({
		services: {
			'apache-2.4.43+11': { name: 'apache-2.4.43+11', role: 'http' },
		},
		webServer: 'apache',
	}), {
		kind: 'apache',
		requiresOriginIp: false,
		serviceName: 'apache-2.4.43+11',
	});
	assert.deepEqual(detectSiteServer({
		services: {
			'nginx-1.26.1+1': { name: 'nginx-1.26.1+1', role: 'http' },
		},
		webServer: 'nginx',
	}), {
		kind: 'nginx',
		requiresOriginIp: true,
		serviceName: 'nginx-1.26.1+1',
	});
});

test('uses one unambiguous legacy service only when role metadata is absent', () => {
	assert.equal(detectSiteServer({
		services: { nginx: { name: 'nginx' }, php: { name: 'php' } },
	}).kind, 'nginx');
	assert.equal(detectSiteServer({
		services: {
			apache: { name: 'apache' },
			nginx: { name: 'nginx' },
		},
	}).kind, 'unsupported');
});
