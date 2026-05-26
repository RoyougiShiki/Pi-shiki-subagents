// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  'frontend-ui-ux-engineer': 'designer',
};

export const SUBAGENT_NAMES = [
  'search',
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
  'councillor',
] as const;

export const ORCHESTRATOR_NAME = 'orchestrator' as const;

export const ALL_AGENT_NAMES = [ORCHESTRATOR_NAME, ...SUBAGENT_NAMES] as const;

// Agent name type (for use in DEFAULT_MODELS)
export type AgentName = (typeof ALL_AGENT_NAMES)[number];

// Subagent delegation rules: which agents can spawn which subagents
// orchestrator: can spawn all subagents (full delegation)
// fixer: leaf node — prompt forbids delegation; use grep/glob for lookups
// oracle: cannot spawn any subagents (leaf node)
// Unknown agent types not listed here default to restricted access
// Which agents each agent type can spawn via delegation.
// councillor is internal — only CouncilManager spawns it.
export const ORCHESTRATABLE_AGENTS = [
  'oracle',
  'designer',
  'fixer',
  'observer',
  'council',
] as const;

/** Agents that cannot be disabled even if listed in disabled_agents config. */
export const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);

/**
 * Get the list of orchestratable agents, excluding any disabled agents.
 * This is used for delegation validation at runtime.
 */
export function getOrchestratableAgents(
  disabledAgents?: Set<string>,
): string[] {
  return ORCHESTRATABLE_AGENTS.filter((name) => !disabledAgents?.has(name));
}

export const SUBAGENT_DELEGATION_RULES: Record<AgentName, readonly string[]> = {
  orchestrator: ORCHESTRATABLE_AGENTS,
  fixer: [],
  designer: [],
  search: [],
  oracle: [],
  observer: [],
  council: [],
  councillor: [],
};

// Default models for each agent
// orchestrator is undefined so its model is fully resolved at runtime via priority fallback
// DEFAULT_MODELS is intentionally removed. Only active preset configures models.
// Ultimate fallback is "openai/gpt-4o-mini" used directly where needed.

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

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = [];
