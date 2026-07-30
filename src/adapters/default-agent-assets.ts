import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_GROUPS_CONFIG_KEY } from '../config/config-keys';

function firstExistingPath(candidates: readonly string[]): string {
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!
  );
}

function adapterRootCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    moduleDir,
    path.resolve(moduleDir, '..', 'src', 'adapters'),
    path.resolve(moduleDir, '..', '..', 'src', 'adapters'),
  ];
}

export function getDefaultAgentsPath(): string {
  return firstExistingPath(
    adapterRootCandidates().map((root) =>
      path.join(root, 'agents-default.json'),
    ),
  );
}

export function getDefaultAgentPromptsDir(): string {
  return firstExistingPath(
    adapterRootCandidates().map((root) => path.join(root, 'agents')),
  );
}

export function getDefaultAgentPromptPath(name: string): string {
  return path.join(getDefaultAgentPromptsDir(), `${name}.md`);
}

export function readDefaultAgentDefinitions(): Record<string, any> {
  try {
    return JSON.parse(
      fs.readFileSync(getDefaultAgentsPath(), 'utf-8'),
    ) as Record<string, any>;
  } catch {
    return {};
  }
}

export function getDefaultAgentDefinitionNames(): string[] {
  return Object.keys(readDefaultAgentDefinitions()).filter(
    (name) => name !== TOOL_GROUPS_CONFIG_KEY,
  );
}
