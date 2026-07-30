import {
  getDefaultAgentDefinitionNames,
  readDefaultAgentDefinitions,
} from '../adapters/default-agent-assets';

// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  'frontend-ui-ux-engineer': 'main',
};

const CONFIG_ONLY_AGENT_NAMES = ['council'] as const;

export const ALL_AGENT_NAMES = [
  ...getDefaultAgentDefinitionNames(),
  ...CONFIG_ONLY_AGENT_NAMES,
] as const;

export const MODEL_PLACEHOLDER = '<YOUR_MODEL>' as const;

function getPrimaryAgentName(): string {
  const defaults = readDefaultAgentDefinitions();
  const primaryAgents = Object.entries(defaults)
    .filter(([, definition]) => {
      const typed = definition as { type?: unknown; presetPrimary?: unknown };
      return typed.presetPrimary === true && typed.type === 'main';
    })
    .map(([name]) => name);
  if (primaryAgents.length !== 1) {
    throw new Error(
      `[oh-my-opencode-slim] agents-default.json must define exactly one presetPrimary main session; found ${primaryAgents.length}`,
    );
  }
  return primaryAgents[0]!;
}

export const PRIMARY_AGENT_NAME = getPrimaryAgentName();

function getBuiltInRoleSubagentNames(): string[] {
  const defaults = readDefaultAgentDefinitions();
  return Object.entries(defaults)
    .filter(([, definition]) => {
      const type = (definition as { type?: unknown } | undefined)?.type;
      return type === 'subagent';
    })
    .map(([name]) => name)
    .filter((name) => (ALL_AGENT_NAMES as readonly string[]).includes(name));
}

/** Built-in leaf role subagent names (search/fixer/oracle, etc.). */
export const BUILT_IN_ROLE_SUBAGENT_NAMES = getBuiltInRoleSubagentNames();

/**
 * Preset model override slots: shared subagent default + per-role overrides.
 * Main session and council are intentionally excluded.
 */
export const PRESET_MODEL_SLOT_NAMES = [
  'subagent',
  ...BUILT_IN_ROLE_SUBAGENT_NAMES,
] as const;

export type AgentName = string;

// Subagent delegation rules: which agents can spawn which subagents.
// These are only fallback rules. Runtime prefers agents-default.json / user config.
export const ORCHESTRATABLE_AGENTS = [
  'search',
  'oracle',
  'fixer',
  'council',
] as const;

/**
 * Get the list of orchestratable agents, excluding any disabled agents.
 * This is used for delegation validation at runtime.
 */
export function getOrchestratableAgents(
  disabledAgents?: Set<string>,
): string[] {
  return ORCHESTRATABLE_AGENTS.filter((name) => !disabledAgents?.has(name));
}

export const SUBAGENT_DELEGATION_RULES: Partial<
  Record<AgentName, readonly string[]>
> = {
  main: ['search', 'fixer', 'oracle'],
  oracle: [],
  fixer: [],
  search: [],
  council: [],
};

// Default models are intentionally not defined here.
// Only the active preset configures agent models.

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_SLOW_MS = 1000;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
export const FALLBACK_FAILOVER_TIMEOUT_MS = 15_000;

// Subagent depth limits
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;
