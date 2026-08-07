#!/usr/bin/env bun

/**
 * Pi dev sync checker.
 *
 * Ensures local Pi settings point at this repository, keeps the generated
 * config schema in sync, and optionally runs verification commands.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePluginConfigSchemaJson } from './schema-helper';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const SETTINGS_PATH =
  process.env.PI_SETTINGS_PATH ??
  join(homedir(), '.pi', 'agent', 'settings.json');
const SCHEMA_PATH = join(REPO_ROOT, 'pi-shiki-subagents.schema.json');
const PACKAGE_NAME = 'pi-shiki-subagents';
const REQUIRED_EXTENSION_FILTERS = ['+src/pi/core/pi-shiki-subagents.ts'];

type JsonObject = Record<string, unknown>;

interface Options {
  write: boolean;
  check: boolean;
  schema: boolean;
  typecheck: boolean;
  test: boolean;
  build: boolean;
  restartHint: boolean;
  help: boolean;
}

interface CheckResult {
  ok: boolean;
  changed: boolean;
  messages: string[];
  settingsChanged: boolean;
}

function parseArgs(argv: string[]): Options {
  const has = (flag: string) => argv.includes(flag);
  const check = has('--check');
  return {
    write: has('--write'),
    check,
    schema: !has('--skip-schema'),
    typecheck: has('--typecheck'),
    test: has('--test'),
    build: has('--build'),
    restartHint: has('--restart-hint'),
    help: has('--help') || has('-h'),
  };
}

function printHelp(): void {
  console.log(
    `Usage: bun run pi:sync -- [options]\n\nOptions:\n  --check          Check only; do not write settings or schema\n  --write          Update ~/.pi/agent/settings.json if needed\n  --skip-schema    Skip schema generation/check\n  --typecheck      Run bun run typecheck\n  --test           Run bun test\n  --build          Run bun run build\n  --restart-hint   Always print restart guidance\n  -h, --help       Show this help\n`,
  );
}

function readJson(pathname: string): JsonObject {
  return JSON.parse(readFileSync(pathname, 'utf-8')) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSource(source: string): string {
  return resolve(dirname(SETTINGS_PATH), source);
}

function loadPackageJson(): JsonObject {
  if (!existsSync(PACKAGE_JSON)) {
    throw new Error(`package.json not found at ${PACKAGE_JSON}`);
  }
  const pkg = readJson(PACKAGE_JSON);
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected package name ${PACKAGE_NAME}, got ${String(pkg.name)}`,
    );
  }
  return pkg;
}

function generatedSchemaJson(): string {
  return generatePluginConfigSchemaJson();
}

function ensureSchema(options: Options): CheckResult {
  if (!options.schema) {
    return {
      ok: true,
      changed: false,
      settingsChanged: false,
      messages: ['[schema] skipped'],
    };
  }

  const expected = generatedSchemaJson();
  const current = existsSync(SCHEMA_PATH)
    ? readFileSync(SCHEMA_PATH, 'utf-8')
    : '';
  const fresh = current === expected;

  if (fresh) {
    return {
      ok: true,
      changed: false,
      settingsChanged: false,
      messages: ['[schema] up to date'],
    };
  }

  if (options.check) {
    return {
      ok: false,
      changed: false,
      settingsChanged: false,
      messages: [
        '[schema] stale; run bun run pi:sync to update pi-shiki-subagents.schema.json',
      ],
    };
  }

  writeFileSync(SCHEMA_PATH, expected, 'utf-8');
  return {
    ok: true,
    changed: true,
    settingsChanged: false,
    messages: ['[schema] updated pi-shiki-subagents.schema.json'],
  };
}

function ensureSettings(options: Options): CheckResult {
  if (!existsSync(SETTINGS_PATH)) {
    return {
      ok: false,
      changed: false,
      settingsChanged: false,
      messages: [`[settings] missing: ${SETTINGS_PATH}`],
    };
  }

  const settings = readJson(SETTINGS_PATH);
  const packages = Array.isArray(settings.packages)
    ? [...settings.packages]
    : [];
  let packageIndex = packages.findIndex((entry) => {
    if (!isObject(entry) || typeof entry.source !== 'string') return false;
    return normalizeSource(entry.source) === REPO_ROOT;
  });

  let changed = false;
  const messages: string[] = [];

  if (packageIndex < 0) {
    if (!options.write || options.check) {
      return {
        ok: false,
        changed: false,
        settingsChanged: false,
        messages: [
          `[settings] local package source missing: ${REPO_ROOT} (run bun run pi:sync:write)`,
        ],
      };
    }
    packages.push({
      source: REPO_ROOT,
      extensions: [...REQUIRED_EXTENSION_FILTERS],
    });
    packageIndex = packages.length - 1;
    changed = true;
    messages.push(`[settings] added local package source: ${REPO_ROOT}`);
  }

  const entry = packages[packageIndex];
  if (!isObject(entry)) {
    return {
      ok: false,
      changed,
      settingsChanged: changed,
      messages: ['[settings] local package entry is not an object'],
    };
  }

  const extensions = Array.isArray(entry.extensions)
    ? entry.extensions.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const missing = REQUIRED_EXTENSION_FILTERS.filter(
    (filter) => !extensions.includes(filter),
  );

  if (missing.length > 0) {
    if (!options.write || options.check) {
      return {
        ok: false,
        changed,
        settingsChanged: changed,
        messages: [
          `[settings] missing extension filters: ${missing.join(', ')} (run bun run pi:sync:write)`,
        ],
      };
    }
    entry.extensions = [...extensions, ...missing];
    changed = true;
    messages.push(`[settings] added extension filters: ${missing.join(', ')}`);
  } else {
    messages.push(
      '[settings] local package source and extension filters are present',
    );
  }

  if (changed) {
    settings.packages = packages;
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf-8',
    );
  }

  return { ok: true, changed, settingsChanged: changed, messages };
}

function runCommand(label: string, command: string, args: string[]): boolean {
  console.log(`[run] ${label}: ${command} ${args.join(' ')}`.trim());
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`[${label}] failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[${label}] exited with code ${result.status}`);
    return false;
  }
  return true;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  try {
    loadPackageJson();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`Pi dev sync: ${PACKAGE_NAME}`);
  console.log(`[repo] ${REPO_ROOT}`);
  console.log(`[settings] ${SETTINGS_PATH}`);

  const results = [ensureSettings(options), ensureSchema(options)];
  for (const result of results) {
    for (const message of result.messages) console.log(message);
  }

  let ok = results.every((result) => result.ok);
  if (ok && options.typecheck)
    ok = runCommand('typecheck', 'bun', ['run', 'typecheck']);
  if (ok && options.test) ok = runCommand('test', 'bun', ['test']);
  if (ok && options.build) ok = runCommand('build', 'bun', ['run', 'build']);

  console.log(
    '[info] managed agent files are runtime-generated by ensureAgentFiles().',
  );
  console.log(
    '[hint] Run /reload in the current Pi session to refresh runtime code.',
  );

  const settingsChanged = results.some((result) => result.settingsChanged);
  if (settingsChanged || options.restartHint) {
    console.log(
      '[hint] settings changed; restarting Pi is safer than /reload.',
    );
  }

  if (!ok) {
    console.error('❌ Pi dev sync check failed.');
    return 1;
  }

  console.log('✅ Pi dev sync check passed.');
  return 0;
}

process.exit(main());
