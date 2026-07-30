import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getHiddenRuntimeAgentNames,
  loadRuntimeAgentDefinitions,
  normalizeRuntimeModel,
  type RuntimeAgentDefinition,
} from './agent-runtime-config';

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}

function findNearestDir(start: string, target: string): string | null {
  let current = start;
  while (true) {
    const candidate = path.join(current, target);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const block = content.slice(4, end);
  const body = content.slice(end + 4).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim();
  }
  return { frontmatter, body };
}

function readAgentFile(filePath: string): AgentConfig | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const name =
    frontmatter.name ?? content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description =
    frontmatter.description ??
    content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;

  return {
    name,
    description,
    systemPrompt: body || content,
  };
}

function descriptionForRuntimeAgent(
  name: string,
  runtime: RuntimeAgentDefinition,
): string {
  return runtime.displayName ?? runtime.label ?? name;
}

export function discoverAgents(cwd: string): AgentConfig[] {
  const homeDir = os.homedir();
  const dirs: string[] = [];
  const directProjectDir = path.join(cwd, '.pi', 'agents');
  try {
    if (fs.statSync(directProjectDir).isDirectory())
      dirs.push(directProjectDir);
  } catch {}
  const projectDir = findNearestDir(cwd, '.pi/agents');
  if (projectDir && !dirs.includes(projectDir)) dirs.push(projectDir);
  dirs.push(path.join(homeDir, '.pi', 'agents'));

  const runtimeAgents: Record<string, RuntimeAgentDefinition> =
    loadRuntimeAgentDefinitions(cwd);
  const hiddenRuntimeAgents = getHiddenRuntimeAgentNames(cwd);
  const agents: AgentConfig[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith('.md')) continue;
        if (entry.name.endsWith('.chain.md')) continue;
        const agent = readAgentFile(path.join(dir, entry.name));
        if (!agent || seen.has(agent.name)) continue;
        const runtime = runtimeAgents[agent.name];
        if (
          hiddenRuntimeAgents.has(agent.name) ||
          runtime?.hidden ||
          runtime?.type === 'main'
        )
          continue;
        seen.add(agent.name);
        agents.push({
          ...agent,
          tools: runtime?.tools,
          model: normalizeRuntimeModel(runtime?.model),
        });
      }
    } catch {}
  }

  for (const [name, runtime] of Object.entries(runtimeAgents)) {
    if (seen.has(name)) continue;
    if (runtime.hidden || runtime.type === 'main') continue;
    const prompt = runtime.prompt ?? runtime.instructions;
    if (!prompt?.trim()) continue;
    seen.add(name);
    agents.push({
      name,
      description: descriptionForRuntimeAgent(name, runtime),
      systemPrompt: prompt.trim(),
      tools: runtime.tools,
      model: normalizeRuntimeModel(runtime.model),
    });
  }

  return agents;
}

export function resolveAgent(
  cwd: string,
  name: string,
): AgentConfig | undefined {
  return discoverAgents(cwd).find((agent) => agent.name === name);
}
