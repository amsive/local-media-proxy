/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	signoffEmails,
	validateCommitSignoff,
} = require('../scripts/verify-dco');

test('accepts a DCO trailer matching the commit author email', () => {
	const message = [
		'feat: add a safe example',
		'',
		'Signed-off-by: Example Contributor <contributor@example.com>',
	].join('\n');

	assert.deepEqual(signoffEmails(message), ['contributor@example.com']);
	assert.equal(validateCommitSignoff({
		authorEmail: 'Contributor@Example.com',
		hash: 'abc1234',
		message,
	}), null);
});

test('rejects missing or mismatched DCO trailers', () => {
	assert.match(validateCommitSignoff({
		authorEmail: 'contributor@example.com',
		hash: 'abc1234',
		message: 'fix: missing trailer',
	}), /missing a Signed-off-by/);
	assert.match(validateCommitSignoff({
		authorEmail: 'contributor@example.com',
		hash: 'def5678',
		message: 'fix: wrong signer\n\nSigned-off-by: Someone Else <else@example.com>',
	}), /none match author/);
});
