import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepMerge, loadPluginConfig } from "../config/loader";

export interface RuntimeAgentDefinition {
  type?: "mode" | "subagent" | "both";
  label?: string;
  tools?: string[];
  roles?: string[];
  delegates?: string[];
  hidden?: boolean;
  instructions?: string;
  model?: string | Array<string | { id: string; variant?: string }>;
  variant?: string;
  thinking?: string;
  options?: Record<string, unknown>;
}

export interface ToolExpressionResolveOptions {
  maxDepth?: number;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStringList(items: readonly string[] | undefined): string[] {
  const result = new Set<string>();
  for (const item of items ?? []) {
    const trimmed = item.trim();
    if (trimmed) result.add(trimmed);
  }
  return [...result];
}

export function resolveToolExpressions(
  expressions: readonly string[] | undefined,
  groups: Record<string, readonly string[] | undefined> = {},
  allToolNames: readonly string[] = [],
  options: ToolExpressionResolveOptions = {},
): string[] {
  const result = new Set<string>();
  const allTools = normalizeStringList(allToolNames);
  const maxDepth = options.maxDepth ?? 8;

  const visit = (raw: string, depth: number): void => {
    const item = raw.trim();
    if (!item) return;

    if (item === "*") {
      for (const tool of allTools) result.add(tool);
      return;
    }

    if (item.startsWith("@")) {
      if (depth >= maxDepth) return;
      const groupName = item.slice(1).trim();
      const group = groupName ? groups[groupName] : undefined;
      if (!Array.isArray(group)) return;
      for (const groupItem of group) {
        if (typeof groupItem === "string") visit(groupItem, depth + 1);
      }
      return;
    }

    if (item.includes("*")) {
      const regex = new RegExp(`^${escapeRegexLiteral(item).replace(/\*/g, ".*")}$`);
      for (const tool of allTools) {
        if (regex.test(tool)) result.add(tool);
      }
      return;
    }

    result.add(item);
  };

  for (const expression of expressions ?? []) {
    if (typeof expression === "string") visit(expression, 0);
  }

  return [...result];
}

function toRoleToolExpressions(roles: readonly string[]): string[] {
  return roles
    .map((role) => role.trim())
    .filter(Boolean)
    .map((role) =>
      role === "*" || role.startsWith("@") || role.includes("*")
        ? role
        : `@${role}`,
    );
}

export function resolveAgentToolNames(
  agent: {
    roles?: readonly string[];
    tools?: readonly string[];
  },
  groups: Record<string, readonly string[] | undefined> = {},
  allToolNames: readonly string[] = [],
): string[] | undefined {
  if (Array.isArray(agent.roles) && agent.roles.length > 0) {
    return resolveToolExpressions(
      toRoleToolExpressions(agent.roles),
      groups,
      allToolNames,
    );
  }

  if (Array.isArray(agent.tools) && agent.tools.length > 0) {
    return resolveToolExpressions(agent.tools, groups, allToolNames);
  }

  return undefined;
}

function readJsonFile(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function getDefaultAgentsPath(): string {
  return path.join(__dirname, "agents-default.json");
}

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export function getUserConfigPath(): string {
  return path.join(getHomeDir(), ".pi", "agent", "oh-my-opencode-slim.json");
}

function normalizeConfigAgents(config: Record<string, any>): Record<string, RuntimeAgentDefinition> {
  let agents = config.agents && typeof config.agents === "object"
    ? config.agents as Record<string, RuntimeAgentDefinition>
    : {};

  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const presetName = envPreset || config.preset;
  const preset = presetName && config.presets && typeof config.presets === "object"
    ? config.presets[presetName]
    : undefined;
  if (preset && typeof preset === "object") {
    agents = (deepMerge(
      preset as Record<string, RuntimeAgentDefinition>,
      agents,
    ) ?? agents) as Record<string, RuntimeAgentDefinition>;
  }

  return agents;
}

function getRuntimeConfigAgents(cwd: string): Record<string, RuntimeAgentDefinition> {
  const piNativeAgents = normalizeConfigAgents(readJsonFile(getUserConfigPath()));

  const sharedConfig = loadPluginConfig(cwd, { quiet: true });
  const sharedAgents = sharedConfig.agents && typeof sharedConfig.agents === "object"
    ? sharedConfig.agents as Record<string, RuntimeAgentDefinition>
    : {};

  return deepMerge(piNativeAgents, sharedAgents) ?? {};
}

export function normalizeRuntimeModel(model: RuntimeAgentDefinition["model"]): string | undefined {
  if (typeof model === "string") return model;
  if (!Array.isArray(model)) return undefined;
  const first = model[0];
  if (typeof first === "string") return first;
  return first?.id;
}

export function loadRuntimeAgentDefinitions(cwd = process.cwd()): Record<string, RuntimeAgentDefinition> {
  const defaults = readJsonFile(getDefaultAgentsPath()) as Record<string, RuntimeAgentDefinition>;
  const runtimeAgents = getRuntimeConfigAgents(cwd);

  const merged: Record<string, RuntimeAgentDefinition> = { ...defaults };
  for (const [name, override] of Object.entries(runtimeAgents)) {
    const base = (merged[name] ?? {}) as Record<string, unknown>;
    const overrideRecord = override as Record<string, unknown>;
    merged[name] = (deepMerge(base, overrideRecord) ?? overrideRecord) as RuntimeAgentDefinition;
  }
  return merged;
}

export function getRuntimeAgentDefinition(name: string, cwd = process.cwd()): RuntimeAgentDefinition | undefined {
  return loadRuntimeAgentDefinitions(cwd)[name];
}

export function getDelegationRulesFromConfig(cwd = process.cwd()): Record<string, readonly string[]> {
  const defs = loadRuntimeAgentDefinitions(cwd);
  const rules: Record<string, readonly string[]> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (Array.isArray(def.delegates)) rules[name] = def.delegates;
  }
  return rules;
}
