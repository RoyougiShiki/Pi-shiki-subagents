import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepMerge, loadPluginConfig } from "../config/loader";

export interface RuntimeAgentDefinition {
  type?: "mode" | "subagent" | "both";
  label?: string;
  tools?: string[];
  delegates?: string[];
  blocked?: string[];
  hidden?: boolean;
  next?: string[];
  instructions?: string;
  model?: string | Array<string | { id: string; variant?: string }>;
  variant?: string;
  thinking?: string;
  options?: Record<string, unknown>;
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

  const sharedConfig = loadPluginConfig(cwd);
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

export function getRuntimeBlockedAgents(name: string, cwd = process.cwd()): readonly string[] {
  const blocked = getRuntimeAgentDefinition(name, cwd)?.blocked;
  return Array.isArray(blocked) ? blocked : [];
}

export function getDelegationRulesFromConfig(cwd = process.cwd()): Record<string, readonly string[]> {
  const defs = loadRuntimeAgentDefinitions(cwd);
  const rules: Record<string, readonly string[]> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (Array.isArray(def.delegates)) rules[name] = def.delegates;
  }
  return rules;
}
