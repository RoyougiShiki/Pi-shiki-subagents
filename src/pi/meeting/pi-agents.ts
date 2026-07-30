/**
 * Agent prompts loaded from ~/.pi/agents/*.md at runtime.
 * Previously this was a hardcoded AGENT_PROMPTS record.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface AgentPromptInfo {
  prompt: string;
  description: string;
  temperature: number;
}

function getAgentsDir(): string {
  return path.join(path.dirname(getAgentDir()), 'agents');
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const result: Record<string, any> = {};
  if (!content.startsWith('---')) return { frontmatter: result, body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: result, body: content };
  const block = content.slice(4, end);
  const body = content.slice(end + 4).trim();
  for (const line of block.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let value: any = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        value = JSON.parse(value);
      } catch {}
    } else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    result[m[1]] = value;
  }
  return { frontmatter: result, body };
}

export const AGENT_PROMPTS: Record<string, AgentPromptInfo> = {};

export function reloadAgentPrompts(): Record<string, AgentPromptInfo> {
  for (const key of Object.keys(AGENT_PROMPTS)) delete AGENT_PROMPTS[key];
  const agentsDir = getAgentsDir();
  try {
    if (fs.existsSync(agentsDir)) {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith('.md')) continue;
        if (!entry.isFile()) continue;
        const filePath = path.join(agentsDir, entry.name);
        const content = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);
        const name = frontmatter.name || entry.name.replace(/\.md$/, '');
        AGENT_PROMPTS[name] = {
          prompt: body,
          description: frontmatter.description || name,
          temperature:
            typeof frontmatter.temperature === 'number'
              ? frontmatter.temperature
              : 0.7,
        };
      }
    }
  } catch {}
  return AGENT_PROMPTS;
}

// Load once at module import; Pi adapter calls reloadAgentPrompts() after sync.
reloadAgentPrompts();
