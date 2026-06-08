import * as fs from "node:fs";
import * as path from "node:path";
import { deepMerge, loadPluginConfig } from "../config/loader";
import { TOOL_GROUPS_CONFIG_KEY } from "../config/config-keys";
import { parseJsonc } from "../config/jsonc";
import {
  getPiNativeConfigPath,
  readPiNativeConfigObject,
} from "../config/pi-native";

export interface RuntimeAgentDefinition {
  type?: "mode" | "subagent" | "both";
  label?: string;
  tools?: string[];
  roles?: string[];
  delegates?: string[];
  workflow?: string;
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

export type RuntimeToolGroups = Record<string, string[]>;

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

function isInternalConfigKey(name: string): boolean {
  return name.trim() === TOOL_GROUPS_CONFIG_KEY;
}

function filterRuntimeAgentDefinitions(
  agents: Record<string, RuntimeAgentDefinition>,
): Record<string, RuntimeAgentDefinition> {
  const result: Record<string, RuntimeAgentDefinition> = {};
  for (const [name, definition] of Object.entries(agents)) {
    if (!isInternalConfigKey(name)) result[name] = definition;
  }
  return result;
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

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return parseJsonc<Record<string, unknown>>(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function getDefaultAgentsPath(): string {
  return path.join(__dirname, "agents-default.json");
}

export function getUserConfigPath(): string {
  return getPiNativeConfigPath();
}

function normalizeConfigAgents(config: Record<string, unknown>): Record<string, RuntimeAgentDefinition> {
  let agents = config.agents && typeof config.agents === "object"
    ? config.agents as Record<string, RuntimeAgentDefinition>
    : {};

  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const configPreset = typeof config.preset === "string"
    ? config.preset
    : undefined;
  const presetName = envPreset || configPreset;
  const presets = config.presets && typeof config.presets === "object"
    ? config.presets as Record<string, unknown>
    : undefined;
  const preset = presetName && presets
    ? presets[presetName]
    : undefined;
  if (preset && typeof preset === "object") {
    agents = (deepMerge(
      preset as Record<string, RuntimeAgentDefinition>,
      agents,
    ) ?? agents) as Record<string, RuntimeAgentDefinition>;
  }

  return filterRuntimeAgentDefinitions(agents);
}

function getRuntimeConfigAgents(cwd: string): Record<string, RuntimeAgentDefinition> {
  const piNativeAgents = normalizeConfigAgents(readPiNativeConfigObject());

  const sharedConfig = loadPluginConfig(cwd, { quiet: true });
  const sharedAgents = sharedConfig.agents && typeof sharedConfig.agents === "object"
    ? sharedConfig.agents as Record<string, RuntimeAgentDefinition>
    : {};

  return deepMerge(piNativeAgents, sharedAgents) ?? {};
}

function normalizeToolGroups(groups: unknown): RuntimeToolGroups {
  const normalized: RuntimeToolGroups = {};
  if (!groups || typeof groups !== "object") return normalized;

  for (const [name, tools] of Object.entries(
    groups as Record<string, unknown>,
  )) {
    const groupName = name.trim();
    if (!groupName || !Array.isArray(tools)) continue;
    const entries = normalizeStringList(
      tools.filter((tool): tool is string => typeof tool === "string"),
    );
    normalized[groupName] = entries;
  }

  return normalized;
}

function mergeToolGroups(
  ...sources: readonly unknown[]
): RuntimeToolGroups {
  const merged: RuntimeToolGroups = {};
  for (const source of sources) {
    for (const [name, tools] of Object.entries(normalizeToolGroups(source))) {
      merged[name] = tools;
    }
  }
  return merged;
}

export function loadRuntimeToolGroups(cwd = process.cwd()): RuntimeToolGroups {
  const defaults = readJsonFile(getDefaultAgentsPath())[TOOL_GROUPS_CONFIG_KEY];
  const piNative = readPiNativeConfigObject()[TOOL_GROUPS_CONFIG_KEY];
  const sharedConfig = loadPluginConfig(cwd, { quiet: true });

  return mergeToolGroups(
    defaults,
    piNative,
    sharedConfig[TOOL_GROUPS_CONFIG_KEY],
  );
}

export function normalizeRuntimeModel(model: RuntimeAgentDefinition["model"]): string | undefined {
  if (typeof model === "string") return model;
  if (!Array.isArray(model)) return undefined;
  const first = model[0];
  if (typeof first === "string") return first;
  return first?.id;
}

export function loadRuntimeAgentDefinitions(cwd = process.cwd()): Record<string, RuntimeAgentDefinition> {
  const defaults = filterRuntimeAgentDefinitions(
    readJsonFile(getDefaultAgentsPath()) as Record<string, RuntimeAgentDefinition>,
  );
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
