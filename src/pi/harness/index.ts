/**
 * Harness — mechanical runtime boundaries
 *
 * completion-auditor runtime path is retired. Budgeting, evidence helpers, and
 * verifier verdict capture remain available to other modules/tests.
 */

// Agent Context
export {
  type AgentContext,
  type AgentRole,
  detectAgentRole,
  getAgentContext,
  getHookEventName,
  type HookEventName,
  isMainAgent,
  isSubagent,
} from './agent-context';
// Completion Audit Scope
export {
  type CompletionAuditScope,
  hasModificationEvidence,
  type SelectCompletionAuditEvidenceInput,
  type SelectCompletionAuditEvidenceResult,
  selectCompletionAuditEvidence,
} from './completion-audit-scope';
// Completion Auditor
export {
  auditCompletion,
  type CompletionAuditInput,
  type CompletionAuditorOptions,
  type CompletionEvidenceKind,
  type CompletionEvidenceSummary,
} from './completion-auditor';
// Evidence Adapter
export {
  type EvidenceAdapterOptions,
  toCompletionEvidenceSummary,
  toVerificationEvidenceState,
} from './evidence-adapter';
// Evidence Session Store
export {
  createEvidenceSessionStore,
  type EvidenceSessionStore,
  type EvidenceSessionStoreOptions,
  type EvidenceSnapshotOptions,
  type SessionStoredToolEvidence,
} from './evidence-session-store';
// Config
export {
  type HarnessConfig,
  type HarnessMessageConfig,
  type ResolvedHarnessConfig,
  resolveHarnessConfig,
} from './harness-config';
// Messages (唯一真源)
export {
  buildInjectedGuardMessage,
  DEFAULT_HARNESS_MESSAGES,
} from './messages';
// Run Harness Audit
export {
  type HarnessAuditInput,
  type HarnessAuditOptions,
  runHarnessAudit,
} from './run-harness-audit';
// Thresholds (唯一真源)
export {
  BYTES_PER_TOKEN_ESTIMATE,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  getToolThreshold,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_TOKENS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  SKIP_PERSIST_TOOL_NAMES,
  SYSTEM_DEFAULT_THRESHOLD,
  SYSTEM_TOOL_THRESHOLDS,
  shouldSkipPersist,
  type UserThresholdConfig,
} from './thresholds';
// Tool Result Budget
export {
  applyPerMessageBudget,
  applyToolResultBudget,
  buildToolResultBudgetSessionDir,
  type PerMessageBudgetResult,
  type PersistedToolResultRef,
  safeSegment,
  shouldPersistToolResult,
  summarizeCommandOutput,
  type ToolResultBudgetOptions,
  type ToolResultDecision,
  type ToolResultInput,
} from './tool-result-budget';
// Tool Result Budget State
export {
  createToolResultBudgetState,
  fromToolResultBudgetPersistenceJson,
  getReplacement,
  isSeenId,
  markSeenId,
  mergeToolResultBudgetState,
  type PartitionedCandidates,
  partitionCandidates,
  reconstructToolResultBudgetState,
  recordReplacement,
  serializeToolResultBudgetState,
  type ToolResultBudgetPersistenceJson,
  type ToolResultBudgetState,
  type ToolResultCandidate,
  type ToolResultReplacementRecord,
  toToolResultBudgetPersistenceJson,
} from './tool-result-budget-state';
// Tool Result Normalizer
export {
  normalizeToolResult,
  type SessionArtifactRef,
  type StructuredToolResult,
  type ToolResultNormalizeInput,
  type ToolResultNormalizeOutput,
} from './tool-result-normalizer';
// Types
export type {
  HarnessDecision,
  HarnessDecisionAction,
  HarnessIssue,
  HarnessMessageCatalog,
} from './types';
// Verifier Verdict Adapter
export { applyVerifierVerdictsToEvidenceSummary } from './verifier-verdict-adapter';
// Verifier Verdict Evidence
export {
  ingestVerifierVerdict,
  type VerifierVerdictEvidence,
  type VerifierVerdictEvidenceSource,
  type VerifierVerdictIngestionInput,
  type VerifierVerdictIngestionResult,
} from './verifier-verdict-evidence';
// Verifier Verdict Parser
export {
  getVerdictStatus,
  hasVerifierVerdict,
  parseVerifierVerdict,
  type VerifierCheckBlock,
  type VerifierVerdict,
  type VerifierVerdictParseResult,
  type VerifierVerdictStatus,
} from './verifier-verdict-parser';
