import type { WorkflowStageToolResult } from "../../core/workflow-types";

const store = new Map<string, WorkflowStageToolResult>();

export function setStageResult(poolId: string, result: WorkflowStageToolResult): void {
  store.set(poolId, result);
}

export function getStageResult(poolId: string): WorkflowStageToolResult | undefined {
  return store.get(poolId);
}

export function deleteStageResult(poolId: string): void {
  store.delete(poolId);
}
