import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkflowStageToolResult } from "../../core/workflow-types";

const store = new Map<string, WorkflowStageToolResult>();

// AsyncLocalStorage propagates the poolId across async boundaries without
// env vars, module globals, or prompt hacks. Set by AgentPool.sendPrompt()
// before session.prompt(), read by stage_complete/ask_user tool handlers.
export const poolIdStorage = new AsyncLocalStorage<string>();

export function setStageResult(poolId: string, result: WorkflowStageToolResult): void {
  store.set(poolId, result);
}

export function getStageResult(poolId: string): WorkflowStageToolResult | undefined {
  return store.get(poolId);
}

export function deleteStageResult(poolId: string): void {
  store.delete(poolId);
}
