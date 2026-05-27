import type { WorkflowStageToolResult } from "../../core/workflow-types";

const store = new Map<string, WorkflowStageToolResult>();

// Module-level poolId register — set by AgentPool.spawn() and read by
// stage_complete/ask_user tools.  Avoids fragile env-var-based IPC that
// breaks when spawn's error/timeout paths restore env vars mid-turn.
let _currentPoolId: string | undefined;

export function setCurrentPoolId(id: string | undefined): void {
  _currentPoolId = id;
}

export function getCurrentPoolId(): string | undefined {
  return _currentPoolId;
}

export function setStageResult(poolId: string, result: WorkflowStageToolResult): void {
  store.set(poolId, result);
}

export function getStageResult(poolId: string): WorkflowStageToolResult | undefined {
  return store.get(poolId);
}

export function deleteStageResult(poolId: string): void {
  store.delete(poolId);
}
