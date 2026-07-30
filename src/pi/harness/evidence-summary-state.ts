import type { ToolEvidence } from '../policy/tool-evidence-types';
import type {
  CompletionEvidenceKind,
  CompletionEvidenceSummary,
} from './completion-auditor';
import { toCompletionEvidenceSummary } from './evidence-adapter';

export interface RecoveredEvidenceSummaryState {
  kinds: CompletionEvidenceKind[];
  modifiedFileCount: number;
  failedToolCount: number;
  lastModifiedAt?: number;
  lastVerificationAt?: number;
  lastFailureAt?: number;
  lastTestSuccessAt?: number;
  lastLintSuccessAt?: number;
  lastTypecheckSuccessAt?: number;
}

export interface RecoveredEvidenceSummaryJson {
  version: 1;
  kinds: CompletionEvidenceKind[];
  modifiedFileCount: number;
  failedToolCount: number;
  lastModifiedAt?: number;
  lastVerificationAt?: number;
  lastFailureAt?: number;
  lastTestSuccessAt?: number;
  lastLintSuccessAt?: number;
  lastTypecheckSuccessAt?: number;
}

const FAILURE_KINDS = new Set<CompletionEvidenceKind>([
  'tool_failure',
  'test_failure',
  'lint_failure',
  'typecheck_failure',
]);

const VERIFICATION_KINDS = new Set<CompletionEvidenceKind>([
  'verification',
  'test_success',
  'lint_success',
  'typecheck_success',
]);

export function createRecoveredEvidenceSummaryState(): RecoveredEvidenceSummaryState {
  return {
    kinds: [],
    modifiedFileCount: 0,
    failedToolCount: 0,
  };
}

function maxTimestamp(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next);
}

function mergeKinds(
  left: readonly CompletionEvidenceKind[],
  right: readonly CompletionEvidenceKind[],
): CompletionEvidenceKind[] {
  return [...new Set([...left, ...right])];
}

function latestVerificationKindTimestamp(
  state: RecoveredEvidenceSummaryState,
  kind: CompletionEvidenceKind,
  evidenceTimestamp: number,
  evidenceKinds: readonly CompletionEvidenceKind[],
): number | undefined {
  if (!evidenceKinds.includes(kind)) {
    if (kind === 'test_success') return state.lastTestSuccessAt;
    if (kind === 'lint_success') return state.lastLintSuccessAt;
    if (kind === 'typecheck_success') return state.lastTypecheckSuccessAt;
    return state.lastVerificationAt;
  }
  const current =
    kind === 'test_success'
      ? state.lastTestSuccessAt
      : kind === 'lint_success'
        ? state.lastLintSuccessAt
        : kind === 'typecheck_success'
          ? state.lastTypecheckSuccessAt
          : state.lastVerificationAt;
  return maxTimestamp(current, evidenceTimestamp);
}

function isKindValidAfterModification(
  kind: CompletionEvidenceKind,
  state: RecoveredEvidenceSummaryState,
  latestModificationAt: number | undefined,
): boolean {
  if (!VERIFICATION_KINDS.has(kind) || latestModificationAt === undefined)
    return true;
  if (kind === 'test_success')
    return (
      state.lastTestSuccessAt !== undefined &&
      state.lastTestSuccessAt > latestModificationAt
    );
  if (kind === 'lint_success')
    return (
      state.lastLintSuccessAt !== undefined &&
      state.lastLintSuccessAt > latestModificationAt
    );
  if (kind === 'typecheck_success')
    return (
      state.lastTypecheckSuccessAt !== undefined &&
      state.lastTypecheckSuccessAt > latestModificationAt
    );
  return [
    state.lastTestSuccessAt,
    state.lastLintSuccessAt,
    state.lastTypecheckSuccessAt,
    state.lastVerificationAt,
  ].some(
    (timestamp) => timestamp !== undefined && timestamp > latestModificationAt,
  );
}

export function updateRecoveredEvidenceSummaryState(
  state: RecoveredEvidenceSummaryState,
  evidence: ToolEvidence,
): RecoveredEvidenceSummaryState {
  const summary = toCompletionEvidenceSummary([evidence]);
  const kinds = mergeKinds(state.kinds, summary.kinds);
  const timestamp = evidence.timestamp;

  return {
    kinds,
    modifiedFileCount:
      state.modifiedFileCount + (summary.modifiedFileCount ?? 0),
    failedToolCount: state.failedToolCount + (summary.failedToolCount ?? 0),
    lastModifiedAt: summary.kinds.includes('modification')
      ? maxTimestamp(state.lastModifiedAt, timestamp)
      : state.lastModifiedAt,
    lastVerificationAt: summary.kinds.some((kind) =>
      VERIFICATION_KINDS.has(kind),
    )
      ? maxTimestamp(state.lastVerificationAt, timestamp)
      : state.lastVerificationAt,
    lastTestSuccessAt: latestVerificationKindTimestamp(
      state,
      'test_success',
      timestamp,
      summary.kinds,
    ),
    lastLintSuccessAt: latestVerificationKindTimestamp(
      state,
      'lint_success',
      timestamp,
      summary.kinds,
    ),
    lastTypecheckSuccessAt: latestVerificationKindTimestamp(
      state,
      'typecheck_success',
      timestamp,
      summary.kinds,
    ),
    lastFailureAt: summary.kinds.some((kind) => FAILURE_KINDS.has(kind))
      ? maxTimestamp(state.lastFailureAt, timestamp)
      : state.lastFailureAt,
  };
}

function effectiveRecoveredKinds(
  state: RecoveredEvidenceSummaryState,
): CompletionEvidenceKind[] {
  return state.kinds.filter((kind) =>
    isKindValidAfterModification(kind, state, state.lastModifiedAt),
  );
}

export function toTemporalCompletionEvidenceSummary(
  evidences: readonly ToolEvidence[],
): CompletionEvidenceSummary {
  const state = evidences.reduce(
    updateRecoveredEvidenceSummaryState,
    createRecoveredEvidenceSummaryState(),
  );
  return toRecoveredCompletionEvidenceSummary(state);
}
export function toRecoveredCompletionEvidenceSummary(
  state: RecoveredEvidenceSummaryState,
): CompletionEvidenceSummary {
  return {
    kinds: effectiveRecoveredKinds(state),
    modifiedFileCount: state.modifiedFileCount,
    failedToolCount: state.failedToolCount,
  };
}

export function mergeRecoveredCompletionEvidenceSummary(
  current: CompletionEvidenceSummary,
  recovered: RecoveredEvidenceSummaryState,
): CompletionEvidenceSummary {
  return {
    ...current,
    kinds: mergeKinds(current.kinds, effectiveRecoveredKinds(recovered)),
    modifiedFileCount: Math.max(
      current.modifiedFileCount ?? 0,
      recovered.modifiedFileCount,
    ),
    failedToolCount: Math.max(
      current.failedToolCount ?? 0,
      recovered.failedToolCount,
    ),
  };
}

export function toRecoveredEvidenceSummaryJson(
  state: RecoveredEvidenceSummaryState,
): RecoveredEvidenceSummaryJson {
  return {
    version: 1,
    kinds: state.kinds,
    modifiedFileCount: state.modifiedFileCount,
    failedToolCount: state.failedToolCount,
    lastModifiedAt: state.lastModifiedAt,
    lastVerificationAt: state.lastVerificationAt,
    lastFailureAt: state.lastFailureAt,
    lastTestSuccessAt: state.lastTestSuccessAt,
    lastLintSuccessAt: state.lastLintSuccessAt,
    lastTypecheckSuccessAt: state.lastTypecheckSuccessAt,
  };
}

function isCompletionEvidenceKind(
  value: unknown,
): value is CompletionEvidenceKind {
  return (
    typeof value === 'string' &&
    new Set<CompletionEvidenceKind>([
      'modification',
      'verification',
      'test_success',
      'test_failure',
      'lint_success',
      'lint_failure',
      'typecheck_success',
      'typecheck_failure',
      'tool_failure',
      'verifier_pass',
      'verifier_fail',
      'verifier_partial',
      'subagent_pending',
    ]).has(value as CompletionEvidenceKind)
  );
}

function optionalTimestamp(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function fromRecoveredEvidenceSummaryJson(
  json: unknown,
): RecoveredEvidenceSummaryState | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (
    !Array.isArray(record.kinds) ||
    !record.kinds.every(isCompletionEvidenceKind)
  )
    return null;
  if (
    typeof record.modifiedFileCount !== 'number' ||
    !Number.isFinite(record.modifiedFileCount)
  )
    return null;
  if (
    typeof record.failedToolCount !== 'number' ||
    !Number.isFinite(record.failedToolCount)
  )
    return null;

  const lastModifiedAt = optionalTimestamp(record.lastModifiedAt);
  const lastVerificationAt = optionalTimestamp(record.lastVerificationAt);
  const lastFailureAt = optionalTimestamp(record.lastFailureAt);
  const lastTestSuccessAt = optionalTimestamp(record.lastTestSuccessAt);
  const lastLintSuccessAt = optionalTimestamp(record.lastLintSuccessAt);
  const lastTypecheckSuccessAt = optionalTimestamp(
    record.lastTypecheckSuccessAt,
  );
  if (
    lastModifiedAt === null ||
    lastVerificationAt === null ||
    lastFailureAt === null ||
    lastTestSuccessAt === null ||
    lastLintSuccessAt === null ||
    lastTypecheckSuccessAt === null
  )
    return null;

  return {
    kinds: [...new Set(record.kinds)],
    modifiedFileCount: record.modifiedFileCount,
    failedToolCount: record.failedToolCount,
    lastModifiedAt,
    lastVerificationAt,
    lastFailureAt,
    lastTestSuccessAt,
    lastLintSuccessAt,
    lastTypecheckSuccessAt,
  };
}
