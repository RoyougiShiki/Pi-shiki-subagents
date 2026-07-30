#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const ignoredDirs = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.codebase-memory',
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(filePath));
    else out.push(filePath);
  }
  return out;
}

function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const srcDir = path.join(root, 'src');
const srcFiles = walk(srcDir).filter((filePath) => /\.tsx?$/.test(filePath));
const prodFiles = srcFiles.filter(
  (filePath) => !/\.test\.tsx?$/.test(filePath),
);
const texts = new Map(srcFiles.map((filePath) => [filePath, read(filePath)]));

const largestFiles = srcFiles
  .map((filePath) => ({
    file: rel(filePath),
    lines: texts.get(filePath).split(/\r?\n/).length,
  }))
  .sort((left, right) => right.lines - left.lines)
  .slice(0, 25);

const incoming = new Map(srcFiles.map((filePath) => [filePath, []]));
const outgoing = new Map(srcFiles.map((filePath) => [filePath, []]));
const edges = [];

for (const [filePath, text] of texts) {
  for (const match of text.matchAll(
    /import(?:\s+type)?[\s\S]*?from\s+['"]([^'"]+)['"]/g,
  )) {
    const target = resolveImport(filePath, match[1]);
    if (!target || !incoming.has(target)) continue;
    edges.push([filePath, target]);
    incoming.get(target).push(filePath);
    outgoing.get(filePath).push(target);
  }
}

const prodSet = new Set(prodFiles);
const prodIncoming = new Map(prodFiles.map((filePath) => [filePath, []]));
const prodOutgoing = new Map(prodFiles.map((filePath) => [filePath, []]));
for (const [from, to] of edges) {
  if (prodSet.has(from) && prodSet.has(to)) {
    prodIncoming.get(to).push(from);
    prodOutgoing.get(from).push(to);
  }
}

const highFanIn = [...prodIncoming.entries()]
  .map(([filePath, refs]) => ({ file: rel(filePath), incoming: refs.length }))
  .filter((entry) => entry.incoming >= 5)
  .sort((left, right) => right.incoming - left.incoming)
  .slice(0, 30);

const highFanOut = [...prodOutgoing.entries()]
  .map(([filePath, refs]) => ({ file: rel(filePath), outgoing: refs.length }))
  .filter((entry) => entry.outgoing >= 8)
  .sort((left, right) => right.outgoing - left.outgoing)
  .slice(0, 30);

const cycles = [];
for (const start of prodFiles) {
  const stack = [[start, [start]]];
  while (stack.length && cycles.length < 40) {
    const [current, seen] = stack.pop();
    if (seen.length > 8) continue;
    for (const next of prodOutgoing.get(current) ?? []) {
      if (next === start && seen.length > 1)
        cycles.push([...seen, next].map(rel));
      else if (!seen.includes(next)) stack.push([next, [...seen, next]]);
    }
  }
  if (cycles.length >= 40) break;
}

const uniqueCycles = [];
const cycleKeys = new Set();
for (const cycle of cycles) {
  const key = [...new Set(cycle)].sort().join('|');
  if (cycleKeys.has(key)) continue;
  cycleKeys.add(key);
  uniqueCycles.push(cycle);
}

const boundaryFindings = [];
for (const [filePath, text] of texts) {
  const file = rel(filePath);
  if (
    /src\/pi\/subagent\/subagent-run-(state|view|detail-view|tool-details|widget-lines)\.ts$/.test(
      file,
    )
  ) {
    if (
      /@earendil-works\/pi-coding-agent|ctx\.ui|setWidget|renderCall|renderResult/.test(
        text,
      )
    ) {
      boundaryFindings.push({
        file,
        issue: 'pure subagent module references Pi SDK/UI',
      });
    }
  }
  if (file === 'src/pi/subagent/subagent-pool.ts') {
    if (
      /ctx\.ui|setWidget|renderCall|renderResult|from ['"].*widget|from ['"].*renderer/.test(
        text,
      )
    ) {
      boundaryFindings.push({
        file,
        issue: 'AgentPool/runtime imports or uses UI/renderer',
      });
    }
  }
}

const allSearchFiles = walk(root).filter((filePath) =>
  /\.(ts|tsx|js|json|md)$/.test(filePath),
);
const referenceCandidates = [
  'agent-mcps',
  'runtime-preset',
  'pi-chat-bridge',
  'getAgentMcpList',
  'getAvailableMcpNames',
  'setActiveRuntimePreset',
  'getActiveRuntimePreset',
  'autoOpenChat',
  'runPrivateChat',
  'runGroupChat',
  'registerHarnessHooks',
  'registerSubagentTool',
  'registerPoolNoticeBridge',
];

const referenceScan = {};
for (const name of referenceCandidates) {
  const pattern = new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
  );
  referenceScan[name] = allSearchFiles
    .filter((filePath) => pattern.test(read(filePath)))
    .map(rel)
    .slice(0, 40);
}

const packageJson = JSON.parse(read(path.join(root, 'package.json')));
const docsAndPackageFindings = {
  packagePiExtensions: packageJson.pi?.extensions ?? [],
  readmeMentionsPiModesExtension: read(path.join(root, 'README.md')).includes(
    './src/pi/core/pi-modes.ts',
  ),
  platformCleanupMentionsOldOpenCodeEntrypoint:
    read(
      path.join(
        root,
        'docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md',
      ),
    ).includes('src/opencode') ||
    read(
      path.join(
        root,
        'docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md',
      ),
    ).includes('旧 OpenCode'),
};

const report = {
  summary: {
    srcTypeScriptFiles: srcFiles.length,
    srcTypeScriptLines: [...texts.values()].reduce(
      (total, text) => total + text.split(/\r?\n/).length,
      0,
    ),
  },
  largestFiles,
  highFanIn,
  highFanOut,
  staticImportCycles: uniqueCycles.slice(0, 20),
  boundaryFindings,
  referenceScan,
  docsAndPackageFindings,
};

console.log(JSON.stringify(report, null, 2));
