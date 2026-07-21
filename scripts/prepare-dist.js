/*
 * Copyright 2026 Amsive LLC
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
