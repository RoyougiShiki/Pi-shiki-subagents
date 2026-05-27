import { getDelegationRulesFromConfig } from "./agent-runtime-config";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export const FALLBACK_PI_DELEGATION_RULES: Record<string, readonly string[]> = {
  coordinator: [],
  "thinker": ["observer", "oracle"],
  designer: ["observer", "oracle"],
  worker: ["fixer", "oracle"],
  implementer: ["fixer", "oracle"],
  batch: ["fixer", "oracle"],
  observer: [],
  oracle: [],
  fixer: [],
};

export interface DelegationDecision {
  allowed: boolean;
  reason?: string;
  allowedAgents?: readonly string[];
}

export function parseAllowedSubagentsEnv(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

export function checkDelegationAllowed(args: {
  caller?: string;
  target: string;
  depth?: number;
  maxDepth?: number;
  rules?: Record<string, readonly string[]>;
  cwd?: string;
  allowedSubagents?: readonly string[];
}): DelegationDecision {
  const depth = args.depth ?? 0;
  const maxDepth = args.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  if (depth >= maxDepth) {
    return {
      allowed: false,
      reason: `Subagent depth ${depth} reached max ${maxDepth}`,
      allowedAgents: [],
    };
  }

  const caller = args.caller;
  if (!caller) return { allowed: true };

  const configuredRules = getDelegationRulesFromConfig(args.cwd);
  const rules = args.rules ?? (Object.keys(configuredRules).length > 0 ? configuredRules : FALLBACK_PI_DELEGATION_RULES);
  const allowedAgents = rules[caller];
  if (!allowedAgents) {
    return {
      allowed: false,
      reason: `Agent '${caller}' has no delegation rule configured`,
      allowedAgents: [],
    };
  }
  const effectiveAllowedAgents = args.allowedSubagents !== undefined
    ? allowedAgents.filter((agent) => args.allowedSubagents!.includes(agent))
    : allowedAgents;

  if (effectiveAllowedAgents.includes(args.target)) return { allowed: true, allowedAgents: effectiveAllowedAgents };

  return {
    allowed: false,
    reason: `Agent '${caller}' is not allowed to delegate to '${args.target}'`,
    allowedAgents: effectiveAllowedAgents,
  };
}
