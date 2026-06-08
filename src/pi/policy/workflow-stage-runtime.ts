export type StageHistoryEntry =
  | {
      type: "transition_approved";
      workflowName: string;
      fromStageIndex: number;
      toStageIndex: number;
      fromStageId?: string;
      toStageId?: string;
      targetAgent: string;
      timestamp: number;
    }
  | {
      type: "recovery_confirmed";
      workflowName: string;
      stageIndex: number;
      stageId?: string;
      targetAgent: string;
      timestamp: number;
    }
  | {
      type: "attempt_started";
      workflowName: string;
      stageIndex: number;
      stageId?: string;
      targetAgent: string;
      timestamp: number;
    };

export interface WorkflowStageRecoveryCandidate {
  workflowName: string;
  stageIndex: number;
  stageId?: string;
  stageAgent?: string;
  markerEvent: "transition_approved" | "recovery_confirmed";
  timestamp?: number;
  source: "session_marker";
}

export interface WorkflowStageRuntimeSnapshot {
  workflowName?: string;
  currentStageIndex: number;
  sessionWasResumed: boolean;
  recoveryCandidate?: WorkflowStageRecoveryCandidate;
  recoveryConsumed: boolean;
  history: readonly StageHistoryEntry[];
}

export type RuntimeDecision = { ok: true } | { ok: false; reason: string };

export interface WorkflowStageRuntime {
  getSnapshot(): WorkflowStageRuntimeSnapshot;
  getCurrentStageIndex(): number;
  setRecoveryContext(args: { sessionWasResumed?: boolean; recoveryCandidate?: WorkflowStageRecoveryCandidate | null }): void;
  reset(args?: { workflowName?: string; initialStageIndex?: number; preserveRecoveryContext?: boolean }): void;
  advanceToNextStage(args: {
    workflowName: string;
    fromStageIndex: number;
    toStageIndex: number;
    fromStageId?: string;
    toStageId?: string;
    targetAgent: string;
    timestamp?: number;
  }): RuntimeDecision;
  confirmRecovery(args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    timestamp?: number;
  }): RuntimeDecision;
  recordAttemptStarted(args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    timestamp?: number;
  }): void;
}

function normalizeStageIndex(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return 0;
  return numeric;
}

function cloneCandidate(candidate?: WorkflowStageRecoveryCandidate | null): WorkflowStageRecoveryCandidate | undefined {
  if (!candidate) return undefined;
  if (!Number.isInteger(candidate.stageIndex) || candidate.stageIndex < 0) return undefined;
  if (!candidate.workflowName?.trim()) return undefined;
  return { ...candidate, workflowName: candidate.workflowName.trim() };
}

export function createWorkflowStageRuntime(args: {
  workflowName?: string;
  initialStageIndex?: number;
  sessionWasResumed?: boolean;
  recoveryCandidate?: WorkflowStageRecoveryCandidate | null;
} = {}): WorkflowStageRuntime {
  let workflowName = args.workflowName?.trim() || undefined;
  let currentStageIndex = normalizeStageIndex(args.initialStageIndex ?? 0);
  let sessionWasResumed = args.sessionWasResumed === true;
  let recoveryCandidate = cloneCandidate(args.recoveryCandidate);
  let recoveryConsumed = false;
  const history: StageHistoryEntry[] = [];

  const snapshot = (): WorkflowStageRuntimeSnapshot => ({
    workflowName,
    currentStageIndex,
    sessionWasResumed,
    recoveryCandidate,
    recoveryConsumed,
    history: [...history],
  });

  return {
    getSnapshot: snapshot,
    getCurrentStageIndex: () => currentStageIndex,
    setRecoveryContext(next) {
      sessionWasResumed = next.sessionWasResumed === true;
      recoveryCandidate = cloneCandidate(next.recoveryCandidate);
      if (!sessionWasResumed) {
        recoveryCandidate = undefined;
        recoveryConsumed = false;
      }
    },
    reset(next = {}) {
      workflowName = next.workflowName?.trim() || undefined;
      currentStageIndex = normalizeStageIndex(next.initialStageIndex ?? 0);
      if (!next.preserveRecoveryContext) {
        sessionWasResumed = false;
        recoveryCandidate = undefined;
      }
      recoveryConsumed = next.preserveRecoveryContext ? recoveryConsumed : false;
      history.length = 0;
    },
    advanceToNextStage(next) {
      const requestedFrom = normalizeStageIndex(next.fromStageIndex);
      const requestedTo = normalizeStageIndex(next.toStageIndex);
      if (requestedFrom !== currentStageIndex) {
        return { ok: false, reason: `stage cursor mismatch: current=${currentStageIndex}, from=${requestedFrom}` };
      }
      if (requestedTo !== currentStageIndex + 1) {
        return { ok: false, reason: `stage transition must advance exactly one stage: current=${currentStageIndex}, to=${requestedTo}` };
      }
      const wf = next.workflowName.trim();
      if (!wf) return { ok: false, reason: "missing workflow name" };
      workflowName = wf;
      currentStageIndex = requestedTo;
      history.push({
        type: "transition_approved",
        workflowName: wf,
        fromStageIndex: requestedFrom,
        toStageIndex: requestedTo,
        fromStageId: next.fromStageId,
        toStageId: next.toStageId,
        targetAgent: next.targetAgent,
        timestamp: next.timestamp ?? Date.now(),
      });
      return { ok: true };
    },
    confirmRecovery(next) {
      if (!sessionWasResumed) return { ok: false, reason: "stage recovery is only available after session resume" };
      if (recoveryConsumed) return { ok: false, reason: "stage recovery candidate has already been consumed" };
      if (!recoveryCandidate) return { ok: false, reason: "missing stage recovery candidate" };
      const wf = next.workflowName.trim();
      if (!wf) return { ok: false, reason: "missing workflow name" };
      if (recoveryCandidate.workflowName !== wf) {
        return { ok: false, reason: `recovery workflow mismatch: candidate=${recoveryCandidate.workflowName}, target=${wf}` };
      }
      const requestedStage = normalizeStageIndex(next.stageIndex);
      if (recoveryCandidate.stageIndex !== requestedStage) {
        return { ok: false, reason: `recovery stage mismatch: candidate=${recoveryCandidate.stageIndex}, target=${requestedStage}` };
      }
      workflowName = wf;
      currentStageIndex = requestedStage;
      recoveryConsumed = true;
      history.push({
        type: "recovery_confirmed",
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        targetAgent: next.targetAgent,
        timestamp: next.timestamp ?? Date.now(),
      });
      return { ok: true };
    },
    recordAttemptStarted(next) {
      const wf = next.workflowName.trim();
      if (!wf) return;
      history.push({
        type: "attempt_started",
        workflowName: wf,
        stageIndex: normalizeStageIndex(next.stageIndex),
        stageId: next.stageId,
        targetAgent: next.targetAgent,
        timestamp: next.timestamp ?? Date.now(),
      });
    },
  };
}
