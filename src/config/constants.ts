import {
  getDefaultAgentDefinitionNames,
  readDefaultAgentDefinitions,
} from '../adapters/default-agent-assets';

// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  'frontend-ui-ux-engineer': 'designer',
};

const CONFIG_ONLY_AGENT_NAMES = ['council'] as const;

export const ALL_AGENT_NAMES = [
  ...getDefaultAgentDefinitionNames(),
  ...CONFIG_ONLY_AGENT_NAMES,
] as const;

export const MODEL_PLACEHOLDER = '<YOUR_MODEL>' as const;

function getPrimaryModeAgentName(): string {
  const defaults = readDefaultAgentDefinitions();
  const primaryModes = Object.entries(defaults)
    .filter(([, definition]) => {
      const typed = definition as { type?: unknown; presetPrimary?: unknown };
      return (
        typed.presetPrimary === true &&
        (typed.type === 'mode' || typed.type === 'both')
      );
    })
    .map(([name]) => name);
  if (primaryModes.length !== 1) {
    throw new Error(
      `[oh-my-opencode-slim] agents-default.json must define exactly one presetPrimary mode; found ${primaryModes.length}`,
    );
  }
  return primaryModes[0]!;
}

export const PRIMARY_MODE_AGENT_NAME = getPrimaryModeAgentName();

function getPresetConfigurableAgentNames(): string[] {
  const defaults = readDefaultAgentDefinitions();
  const names = new Set<string>([PRIMARY_MODE_AGENT_NAME]);
  for (const [name, definition] of Object.entries(defaults)) {
    const type = (definition as { type?: unknown } | undefined)?.type;
    if (type === 'subagent' || type === 'both') names.add(name);
  }
  for (const name of CONFIG_ONLY_AGENT_NAMES) names.add(name);
  return [...names].filter((name) =>
    (ALL_AGENT_NAMES as readonly string[]).includes(name),
  );
}

export const PRESET_CONFIGURABLE_AGENT_NAMES =
  getPresetConfigurableAgentNames();

export type AgentName = string;

// Subagent delegation rules: which agents can spawn which subagents.
// These are only fallback rules. Runtime prefers agents-default.json / user config.
export const ORCHESTRATABLE_AGENTS = ['search', 'oracle', 'designer', 'fixer', 'observer', 'council'] as const;


/**
 * Get the list of orchestratable agents, excluding any disabled agents.
 * This is used for delegation validation at runtime.
 */
export function getOrchestratableAgents(
  disabledAgents?: Set<string>,
): string[] {
  return ORCHESTRATABLE_AGENTS.filter((name) => !disabledAgents?.has(name));
}

export const SUBAGENT_DELEGATION_RULES: Partial<Record<AgentName, readonly string[]>> = {
  'standard-dev': ['search', 'oracle'],
  'quick-fix': ['search', 'fixer', 'oracle'],
  'research-only': ['search', 'oracle'],
  designer: [],
  worker: [],
  oracle: [],
  fixer: [],
  observer: [],
  dispatcher: [],
  search: [],
  council: [],
  fallback: [],
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

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Understand → choose path → execute → verify.
If delegating, do it in the same turn. !END!`;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;
