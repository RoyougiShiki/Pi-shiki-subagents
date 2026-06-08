#!/usr/bin/env bun

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });
