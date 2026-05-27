import type { WorkflowStageToolResult } from "../../core/workflow-types";

// Single-slot stage result store.  stage_complete writes here,
// WorkflowManager reads from here.  No poolId needed — the slot is
// implicit.  Safe because stages run sequentially (one at a time).
let _result: WorkflowStageToolResult | undefined;

export function setStageResult(result: WorkflowStageToolResult): void {
  _result = result;
}

export function getStageResult(): WorkflowStageToolResult | undefined {
  return _result;
}

export function clearStageResult(): void {
  _result = undefined;
}
