/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const distPath = path.join(__dirname, '..', 'dist');

fs.rmSync(distPath, { force: true, recursive: true });
fs.mkdirSync(distPath, { recursive: true });
