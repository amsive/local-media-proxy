/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

for (const directory of ['lib']) {
	fs.rmSync(path.join(__dirname, '..', directory), {
		force: true,
		recursive: true,
	});
}
