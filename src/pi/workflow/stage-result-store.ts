import type { WorkflowStageToolResult } from "../../core/workflow-types";

const store = new Map<string, WorkflowStageToolResult>();

// Module-level poolId — set by sendPrompt() right before session.prompt().
// Read by stage_complete/stage_ask_user tool handlers during tool execution.
// Set here (not in spawn's env) because tool calls may fire after spawn's
// finally block restores env vars.
let _currentPoolId: string | undefined;

export function setCurrentPoolId(id: string): void {
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
