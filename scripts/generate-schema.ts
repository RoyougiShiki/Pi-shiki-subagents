#!/usr/bin/env bun

/**
 * Generates a JSON Schema from the Zod PluginConfigSchema.
 * Run as part of the build step so the schema stays in sync with the source.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePluginConfigSchemaJson } from './schema-helper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outputPath = join(rootDir, 'oh-my-opencode-slim.schema.json');

writeFileSync(outputPath, generatePluginConfigSchemaJson());

console.log(`✅ Schema written to ${outputPath}`);
