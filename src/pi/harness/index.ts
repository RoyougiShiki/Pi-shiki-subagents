export {
  auditCompletion,
  type CompletionAuditInput,
  type CompletionAuditorOptions,
  type CompletionClaimPatterns,
  type CompletionEvidenceKind,
  type CompletionEvidenceSummary,
} from "./completion-auditor";

export {
  toCompletionEvidenceSummary,
  toVerificationEvidenceState,
  type EvidenceAdapterOptions,
} from "./evidence-adapter";

export {
  resolveHarnessConfig,
  type HarnessConfig,
  type HarnessMessageConfig,
  type HarnessPatternConfig,
  type ResolvedHarnessConfig,
} from "./harness-config";

export {
  runHarnessAudit,
  type HarnessAuditInput,
  type HarnessAuditOptions,
} from "./run-harness-audit";

export {
  applyToolResultBudget,
  shouldPersistToolResult,
  summarizeCommandOutput,
  DEFAULT_THRESHOLDS,
  type PersistedToolResultRef,
  type ToolResultBudgetDecision,
  type ToolResultBudgetInput,
  type ToolResultBudgetOptions,
  type ToolResultBudgetStorage,
  type ToolResultBudgetThresholds,
} from "./tool-result-budget";

export { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";

export type { HarnessDecision, HarnessDecisionAction, HarnessIssue, HarnessMessageCatalog } from "./types";
