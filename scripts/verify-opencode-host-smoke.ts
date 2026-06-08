import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');

type PackageManifest = {
  pi?: {
    extensions?: unknown;
  };
};

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(
      `Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function verifyPackageEntrypoint(): void {
  const script = [
    "import pkg from './dist/index.js';",
    "if (typeof pkg !== 'function') throw new Error('default export is not a function');",
    "console.log('package entrypoint loads');",
  ].join('\n');
  run('node', ['--input-type=module', '--eval', script]);
}

function verifyPiExtensions(): void {
  const pkg = readJson(packageJsonPath) as PackageManifest;
  const extensions = pkg.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    fail('package.json must declare pi.extensions');
  }

  for (const extension of extensions) {
    if (typeof extension !== 'string' || !extension.trim()) {
      fail(`Invalid pi extension entry: ${String(extension)}`);
    }
    const extensionPath = path.resolve(repoRoot, extension);
    if (!existsSync(extensionPath)) {
      fail(`Pi extension entry does not exist: ${extension}`);
    }
    const source = readFileSync(extensionPath, 'utf8');
    for (const required of [
      'registerSubagentTool',
      'registerModeCommands',
      'createWorkflowStageGateHelpers',
    ]) {
      if (!source.includes(required)) {
        fail(`Pi extension ${extension} is missing ${required}`);
      }
    }
  }
}

function main(): void {
  verifyPackageEntrypoint();
  verifyPiExtensions();
  console.log('Host smoke verification passed.');
}

main();
