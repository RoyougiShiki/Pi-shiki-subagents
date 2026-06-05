// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  'frontend-ui-ux-engineer': 'designer',
};

export const ALL_AGENT_NAMES = [
  'coordinator',
  'analyst',
  'designer',
  'worker',
  'oracle',
  'fixer',
  'observer',
  'fallback',
  'dispatcher',
  'search',
  'council',
] as const;

export const PRIMARY_MODE_AGENT_NAME = 'coordinator' as const;

export const PRESET_CONFIGURABLE_AGENT_NAMES = ALL_AGENT_NAMES.filter(
  (name) => name !== 'fallback',
);

export type AgentName = (typeof ALL_AGENT_NAMES)[number];

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
  coordinator: ORCHESTRATABLE_AGENTS,
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
