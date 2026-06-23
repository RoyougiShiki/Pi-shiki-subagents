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
      type: "work_package_approved";
      workflowName: string;
      stageIndex: number;
      stageId?: string;
      targetAgent: string;
      poolId: string;
      task: string;
      timestamp: number;
    }
  | {
      type: "attempt_started";
      workflowName: string;
      stageIndex: number;
      stageId?: string;
      targetAgent: string;
      poolId?: string;
      timestamp: number;
    }
  | {
      type: "review_verdict_recorded";
      workflowName: string;
      stageIndex: number;
      stageId?: string;
      poolId: string;
      verifierAgent: string;
      verdict: "PASS" | "FAIL" | "PARTIAL";
      round: number;
      maxReviewRounds: number;
      exhausted: boolean;
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
  approvedWorkPackage?: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    poolId: string;
    task: string;
  };
  reviewLoop?: ReviewLoopSnapshot;
  history: readonly StageHistoryEntry[];
}

export type RuntimeDecision = { ok: true } | { ok: false; reason: string };

export interface ReviewLoopSnapshot {
  workflowName: string;
  stageIndex: number;
  stageId?: string;
  poolId: string;
  verifierAgent: string;
  rounds: number;
  maxReviewRounds: number;
  lastVerdict: "PASS" | "FAIL" | "PARTIAL";
  exhausted: boolean;
}

export type ReviewVerdictRecordResult =
  | ({ ok: true } & ReviewLoopSnapshot)
  | { ok: false; reason: string };

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
  approveWorkPackage(args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    poolId: string;
    task: string;
    timestamp?: number;
  }): RuntimeDecision;
  recordAttemptStarted(args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    poolId?: string;
    timestamp?: number;
  }): void;
  recordReviewVerdict(args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    poolId: string;
    verifierAgent: string;
    verdict: "PASS" | "FAIL" | "PARTIAL";
    maxReviewRounds: number;
    timestamp?: number;
  }): ReviewVerdictRecordResult;
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
  let approvedWorkPackage: WorkflowStageRuntimeSnapshot["approvedWorkPackage"];
  let reviewLoop: ReviewLoopSnapshot | undefined;
  const activeAttempts = new Map<string, {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
  }>();
  const history: StageHistoryEntry[] = [];

  const snapshot = (): WorkflowStageRuntimeSnapshot => ({
    workflowName,
    currentStageIndex,
    sessionWasResumed,
    recoveryCandidate,
    recoveryConsumed,
    approvedWorkPackage: approvedWorkPackage ? { ...approvedWorkPackage } : undefined,
    reviewLoop: reviewLoop ? { ...reviewLoop } : undefined,
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
      approvedWorkPackage = undefined;
      reviewLoop = undefined;
      activeAttempts.clear();
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
      approvedWorkPackage = undefined;
      reviewLoop = undefined;
      activeAttempts.clear();
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
      approvedWorkPackage = undefined;
      reviewLoop = undefined;
      activeAttempts.clear();
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
    approveWorkPackage(next) {
      const requestedStage = normalizeStageIndex(next.stageIndex);
      if (requestedStage !== currentStageIndex) {
        return { ok: false, reason: `work package approval stage mismatch: current=${currentStageIndex}, target=${requestedStage}` };
      }
      const wf = next.workflowName.trim();
      if (!wf) return { ok: false, reason: "missing workflow name" };
      const poolId = next.poolId.trim();
      if (!poolId) return { ok: false, reason: "missing work package pool id" };
      const task = next.task.trim();
      if (!task) return { ok: false, reason: "missing work package task" };
      workflowName = wf;
      approvedWorkPackage = {
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        targetAgent: next.targetAgent,
        poolId,
        task,
      };
      history.push({
        type: "work_package_approved",
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        targetAgent: next.targetAgent,
        poolId,
        task,
        timestamp: next.timestamp ?? Date.now(),
      });
      return { ok: true };
    },
    recordAttemptStarted(next) {
      const wf = next.workflowName.trim();
      if (!wf) return;
      const poolId = next.poolId?.trim();
      const requestedStage = normalizeStageIndex(next.stageIndex);
      if (poolId) {
        activeAttempts.set(poolId, {
          workflowName: wf,
          stageIndex: requestedStage,
          stageId: next.stageId,
          targetAgent: next.targetAgent,
        });
      }
      history.push({
        type: "attempt_started",
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        targetAgent: next.targetAgent,
        poolId: poolId || undefined,
        timestamp: next.timestamp ?? Date.now(),
      });
    },
    recordReviewVerdict(next) {
      const requestedStage = normalizeStageIndex(next.stageIndex);
      if (requestedStage !== currentStageIndex) {
        return { ok: false, reason: `review verdict stage mismatch: current=${currentStageIndex}, target=${requestedStage}` };
      }
      const wf = next.workflowName.trim();
      if (!wf) return { ok: false, reason: "missing workflow name" };
      const poolId = next.poolId.trim();
      if (!poolId) return { ok: false, reason: "missing review pool id" };
      const attempt = activeAttempts.get(poolId);
      if (!attempt) return { ok: false, reason: `unknown review pool id: ${poolId}` };
      if (
        attempt.workflowName !== wf ||
        attempt.stageIndex !== requestedStage ||
        attempt.stageId !== next.stageId
      ) {
        return {
          ok: false,
          reason: `review pool stage mismatch: pool=${attempt.workflowName}/${attempt.stageId ?? attempt.stageIndex}, target=${wf}/${next.stageId ?? requestedStage}`,
        };
      }
      const verifierAgent = next.verifierAgent.trim();
      if (!verifierAgent) return { ok: false, reason: "missing verifier agent" };
      if (attempt.targetAgent !== verifierAgent) {
        return { ok: false, reason: `review pool agent mismatch: pool=${attempt.targetAgent}, verifier=${verifierAgent}` };
      }
      const maxReviewRounds = normalizeStageIndex(next.maxReviewRounds);
      if (maxReviewRounds < 1) return { ok: false, reason: "maxReviewRounds must be at least 1" };
      if (
        reviewLoop?.workflowName === wf &&
        reviewLoop.stageIndex === requestedStage &&
        reviewLoop.exhausted
      ) {
        return { ok: false, reason: `review loop already exhausted after ${reviewLoop.rounds}/${reviewLoop.maxReviewRounds} rounds` };
      }
      const previousRounds =
        reviewLoop?.workflowName === wf && reviewLoop.stageIndex === requestedStage
          ? reviewLoop.rounds
          : 0;
      const rounds = previousRounds + 1;
      const exhausted = next.verdict !== "PASS" && rounds >= maxReviewRounds;
      activeAttempts.delete(poolId);
      workflowName = wf;
      reviewLoop = {
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        poolId,
        verifierAgent,
        rounds,
        maxReviewRounds,
        lastVerdict: next.verdict,
        exhausted,
      };
      history.push({
        type: "review_verdict_recorded",
        workflowName: wf,
        stageIndex: requestedStage,
        stageId: next.stageId,
        poolId,
        verifierAgent,
        verdict: next.verdict,
        round: rounds,
        maxReviewRounds,
        exhausted,
        timestamp: next.timestamp ?? Date.now(),
      });
      return { ok: true, ...reviewLoop };
    },
  };
}
