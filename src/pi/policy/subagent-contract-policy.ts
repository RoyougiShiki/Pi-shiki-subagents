import { checkTaskContract } from "./task-contract-policy";
import type { TaskContractDecision } from "./task-contract-policy";

export interface SubagentSpawnContractInput {
  pool?: unknown;
  id?: unknown;
  agent?: unknown;
  task?: unknown;
}

/**
 * Thin adapter for omo_subagent spawn task quality.
 *
 * Keeps subagent implementation decoupled from policy details:
 * - no Pi API
 * - no pool access
 * - no runtime state
 * - no approval logic
 */
export function checkSubagentSpawnContract(input: SubagentSpawnContractInput): TaskContractDecision {
  if (input?.pool !== "spawn") {
    return { action: "allow" };
  }

  return checkTaskContract({
    kind: "subagent_spawn",
    subagentTask: typeof input.task === "string" ? input.task : undefined,
  });
}
