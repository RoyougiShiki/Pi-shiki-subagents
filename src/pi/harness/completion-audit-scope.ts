import type { ToolEvidence } from "../policy/tool-evidence-types";

export interface CompletionAuditScope {
  sessionId: string;
  turnId?: string;
  taskId?: string;
  currentTurnModified: boolean;
  hasCurrentWorkingTreeDiff?: boolean;
  evidenceWindow: "current_turn" | "current_task" | "current_session";
  forceSessionWindow?: boolean;
}

export interface SelectCompletionAuditEvidenceInput {
  sessionId: string;
  sessionEvidences: readonly ToolEvidence[];
  currentTurnEvidences: readonly ToolEvidence[];
  currentTurnModified?: boolean;
  currentTaskEvidences?: readonly ToolEvidence[];
  hasCurrentWorkingTreeDiff?: boolean;
  forceSessionWindow?: boolean;
}

export interface SelectCompletionAuditEvidenceResult {
  scope: CompletionAuditScope;
  evidences: readonly ToolEvidence[];
}

const MODIFICATION_TOOLS = new Set(["write", "edit"]);

export function hasModificationEvidence(evidences: readonly ToolEvidence[]): boolean {
  return evidences.some((evidence) => evidence.success && MODIFICATION_TOOLS.has(evidence.toolName));
}

/**
 * Select the smallest safe evidence window for completion audit.
 *
 * Minimal Sprint 1 rule:
 * - If forceSessionWindow is set (e.g. explicit completion claim), keep the
 *   current-session window to avoid hiding earlier unverified modifications.
 * - If this turn executed tools but did not modify files, audit only this turn.
 *   This prevents old session modifications from producing warnings on a later
 *   read-only/advisory turn.
 * - If this turn modified files, keep current-session evidence so verification
 *   from the same broader task/session can still be considered.
 */
export function selectCompletionAuditEvidence(
  input: SelectCompletionAuditEvidenceInput,
): SelectCompletionAuditEvidenceResult {
  const currentTurnModified = input.currentTurnModified ?? hasModificationEvidence(input.currentTurnEvidences);

  if (input.forceSessionWindow) {
    return {
      scope: {
        sessionId: input.sessionId,
        currentTurnModified,
        hasCurrentWorkingTreeDiff: input.hasCurrentWorkingTreeDiff,
        evidenceWindow: "current_session",
        forceSessionWindow: true,
      },
      evidences: input.sessionEvidences,
    };
  }

  if (input.currentTurnEvidences.length > 0 && !currentTurnModified) {
    return {
      scope: {
        sessionId: input.sessionId,
        currentTurnModified,
        hasCurrentWorkingTreeDiff: input.hasCurrentWorkingTreeDiff,
        evidenceWindow: "current_turn",
      },
      evidences: input.currentTurnEvidences,
    };
  }

  return {
    scope: {
      sessionId: input.sessionId,
      currentTurnModified,
      hasCurrentWorkingTreeDiff: input.hasCurrentWorkingTreeDiff,
      evidenceWindow: "current_session",
    },
    evidences: input.sessionEvidences,
  };
}
