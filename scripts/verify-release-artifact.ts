import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

const suspiciousPathPatterns = [
  /\/Users\/[^\s'"`]+oh-my-opencode-slim\/(?:src|scripts|docs|dist)[^\s'"`]*/,
  /\/home\/[^\s'"`]+oh-my-opencode-slim\/(?:src|scripts|docs|dist)[^\s'"`]*/,
  /[A-Z]:\\+[^\s'"`]+oh-my-opencode-slim\\+(?:src|scripts|docs|dist)[^\s'"`]*/i,
  /\\+wsl(?:\.localhost|\$)\\+[^\s'"`]+\\+oh-my-opencode-slim\\+(?:src|scripts|docs|dist)[^\s'"`]*/i,
];

const staticPackagedRequiredFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/index.js',
  'oh-my-opencode-slim.schema.json',
  'src/adapters/agents-default.json',
  'src/cli/index.ts',
];

function fail(message: string): never {
  throw new Error(message);
}

function toNativeCwd(cwd: string): string {
  return realpathSync.native(cwd);
}

function parseWslUncPath(
  filePath: string,
): { distro: string; linuxPath: string } | null {
  const match = filePath.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.+)$/i);
  if (!match) return null;
  return {
    distro: match[1],
    linuxPath: `/${match[2].replace(/\\/g, '/')}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: toNativeCwd(options.cwd ?? repoRoot),
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

function runInWsl(
  distro: string,
  command: string,
  options: { cwd: string },
): string {
  const result = spawnSync(
    'wsl',
    [
      '-d',
      distro,
      '--',
      'bash',
      '-lc',
      `cd ${shellQuote(options.cwd)} && ${command}`,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(`Command failed in WSL: ${command}${detail ? `\n${detail}` : ''}`);
  }

  return result.stdout.trim();
}

function parsePackJson(output: string) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    fail(`Could not locate npm pack JSON output:\n${output}`);
  }

  return JSON.parse(output.slice(start, end + 1)) as Array<{
    filename?: string;
    files?: Array<{ path: string }>;
  }>;
}

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

function toPackagePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function findRequiredRuntimeSourceFiles(): string[] {
  const managedAgentPrompts = walkFiles(
    path.join(repoRoot, 'src', 'adapters', 'agents'),
  ).filter((file) => file.endsWith('.md'));

  const runtimeSourceRoots = [
    path.join(repoRoot, 'src', 'pi'),
    path.join(repoRoot, 'src', 'adapters'),
    path.join(repoRoot, 'src', 'config'),
  ];
  const runtimeSources = runtimeSourceRoots.flatMap((root) =>
    walkFiles(root).filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('.d.ts'),
    ),
  );

  return [...managedAgentPrompts, ...runtimeSources].map(toPackagePath);
}

function getPackagedRequiredFiles(): string[] {
  return [
    ...new Set([
      ...staticPackagedRequiredFiles,
      ...findRequiredRuntimeSourceFiles(),
    ]),
  ].sort();
}

function readPackageFilesConfig(): string[] {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { files?: unknown };
  return Array.isArray(packageJson.files)
    ? packageJson.files.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
}

function isUnderPackagePath(filePath: string, packagePath: string): boolean {
  const normalized = packagePath.replace(/\/+$/, '');
  return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

function verifyPackagedPathsMatchCurrentSource(packagedFiles: Set<string>) {
  const allowedSourcePrefixes = readPackageFilesConfig()
    .filter((entry) => entry === 'src' || entry.startsWith('src/'))
    .map((entry) => entry.replace(/\/+$/, ''));

  const unexpectedSourceFiles = [...packagedFiles].filter(
    (file) =>
      file.startsWith('src/') &&
      !allowedSourcePrefixes.some((prefix) => isUnderPackagePath(file, prefix)),
  );

  if (unexpectedSourceFiles.length > 0) {
    fail(
      `npm pack artifact contains source files outside package.json.files:\n${unexpectedSourceFiles.join('\n')}`,
    );
  }

  const invalidDistRoots = [
    ...new Set(
      [...packagedFiles]
        .map((file) => file.match(/^dist\/([^/]+)\//)?.[1])
        .filter((root): root is string => Boolean(root)),
    ),
  ].filter((root) => {
    const sourceRoot = `src/${root}`;
    return (
      !existsSync(path.join(repoRoot, sourceRoot)) ||
      !allowedSourcePrefixes.some((prefix) =>
        isUnderPackagePath(sourceRoot, prefix),
      )
    );
  });

  if (invalidDistRoots.length > 0) {
    fail(
      `npm pack artifact contains dist roots without matching package source roots:\n${invalidDistRoots.map((root) => `dist/${root}/`).join('\n')}`,
    );
  }

  const staleDistDeclarations = [...packagedFiles].filter((file) => {
    const sourcePath = file.match(/^dist\/(.+)\.d\.ts$/)?.[1];
    return (
      sourcePath && !existsSync(path.join(repoRoot, 'src', `${sourcePath}.ts`))
    );
  });

  if (staleDistDeclarations.length > 0) {
    fail(
      `npm pack artifact contains declaration files without matching source files:\n${staleDistDeclarations.join('\n')}`,
    );
  }
}

function verifyDistHasNoLeakedPaths() {
  console.log('Checking dist for leaked machine paths...');
  const files = walkFiles(distDir).filter((file) =>
    /\.(?:js|d\.ts|map|json)$/.test(file),
  );

  const leaks: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of suspiciousPathPatterns) {
      const match = content.match(pattern);
      if (!match) continue;
      leaks.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
    }
  }

  if (leaks.length > 0) {
    fail(
      `Built artifact contains machine-specific paths:\n${leaks.join('\n')}`,
    );
  }
}

function packArtifact() {
  console.log('Packing npm artifact...');
  const wslPath = parseWslUncPath(repoRoot);
  const output = wslPath
    ? runInWsl(wslPath.distro, 'npm pack --json --ignore-scripts', {
        cwd: wslPath.linuxPath,
      })
    : run('npm', ['pack', '--json', '--ignore-scripts'], {
        cwd: repoRoot,
      });
  const parsed = parsePackJson(output);
  const tarball = parsed[0]?.filename;

  if (!tarball) {
    fail(`npm pack did not return a tarball filename:\n${output}`);
  }

  const packagedFiles = new Set(
    (parsed[0]?.files ?? []).map((file) => file.path),
  );
  verifyPackagedPathsMatchCurrentSource(packagedFiles);

  for (const requiredFile of getPackagedRequiredFiles()) {
    if (!packagedFiles.has(requiredFile)) {
      fail(`npm pack artifact is missing required file: ${requiredFile}`);
    }
  }

  return path.join(repoRoot, tarball);
}

function verifyFreshInstall(tarballPath: string) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'omos-release-'));

  try {
    console.log('Installing packed artifact into clean temp project...');
    const installDir = path.join(tempRoot, 'install');
    const tarballTarget = path.join(tempRoot, path.basename(tarballPath));

    copyFileSync(tarballPath, tarballTarget);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify(
        { name: 'verify-release-artifact', private: true },
        null,
        2,
      ),
    );
    run('bun', ['add', '--ignore-scripts', tarballTarget], {
      cwd: installDir,
    });

    const installedRoot = path.join(
      installDir,
      'node_modules',
      'oh-my-opencode-slim',
    );
    const installedEntry = path.join(installedRoot, 'dist', 'index.js');
    const installedEntryContent = readFileSync(installedEntry, 'utf8');
    for (const pattern of suspiciousPathPatterns) {
      const match = installedEntryContent.match(pattern);
      if (match) {
        fail(
          `Installed package still contains machine-specific path: ${match[0]}`,
        );
      }
    }

    const piExtension = path.join(installedRoot, 'src', 'pi', 'core', 'pi.ts');
    readFileSync(piExtension, 'utf8');

    const smokeScript = [
      "import pkg from 'oh-my-opencode-slim';",
      "if (typeof pkg !== 'function') throw new Error('default export is not a function');",
      "console.log('package loads');",
      'process.exit(0);',
    ].join('\n');
    console.log('Importing installed package entrypoint...');
    run('node', ['--input-type=module', '--eval', smokeScript], {
      cwd: installDir,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function cleanupTarball(tarballPath: string) {
  const wslPath = parseWslUncPath(tarballPath);
  if (wslPath) {
    runInWsl(wslPath.distro, `rm -f ${shellQuote(wslPath.linuxPath)}`, {
      cwd: '/',
    });
    return;
  }

  rmSync(tarballPath, { force: true });
}

function main() {
  verifyDistHasNoLeakedPaths();
  const tarballPath = packArtifact();
  try {
    verifyFreshInstall(tarballPath);
  } finally {
    cleanupTarball(tarballPath);
  }
  console.log('Release artifact verification passed.');
}

main();
