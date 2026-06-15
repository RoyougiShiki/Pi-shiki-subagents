/**
 * Harness — 防幻觉机制
 *
 * 模块结构：
 * - agent-context: 区分主 agent 和子代理角色
 * - thresholds: 阈值常量（唯一真源）
 * - messages: 文案（唯一真源）
 * - types: 公共类型
 * - tool-result-budget-state: 状态管理
 * - tool-result-budget: 工具结果预算
 * - completion-auditor: 完成声明审计
 * - evidence-adapter: 证据转换
 * - run-harness-audit: 整合审计入口
 * - harness-config: 配置解析
 */

// Agent Context
export {
  detectAgentRole,
  getAgentContext,
  isMainAgent,
  isSubagent,
  getHookEventName,
  type AgentRole,
  type AgentContext,
  type HookEventName,
} from "./agent-context";

// Thresholds (唯一真源)
export {
  DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  DEFAULT_PREVIEW_CHARS,
  BYTES_PER_TOKEN_ESTIMATE,
  MAX_TOOL_RESULT_TOKENS,
  MAX_TOOL_RESULT_BYTES,
  SYSTEM_TOOL_THRESHOLDS,
  SYSTEM_DEFAULT_THRESHOLD,
  getToolThreshold,
  shouldSkipPersist,
  SKIP_PERSIST_TOOL_NAMES,
  type UserThresholdConfig,
} from "./thresholds";

// Types
export type {
  HarnessDecisionAction,
  HarnessIssue,
  HarnessDecision,
  HarnessMessageCatalog,
} from "./types";

// Messages (唯一真源)
export { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";

// Tool Result Budget State
export {
  createToolResultBudgetState,
  isSeenId,
  markSeenId,
  getReplacement,
  recordReplacement,
  partitionCandidates,
  serializeToolResultBudgetState,
  reconstructToolResultBudgetState,
  mergeToolResultBudgetState,
  toToolResultBudgetPersistenceJson,
  fromToolResultBudgetPersistenceJson,
  type ToolResultBudgetState,
  type ToolResultReplacementRecord,
  type ToolResultBudgetPersistenceJson,
  type ToolResultCandidate,
  type PartitionedCandidates,
} from "./tool-result-budget-state";

// Tool Result Budget
export {
  shouldPersistToolResult,
  applyToolResultBudget,
  applyPerMessageBudget,
  summarizeCommandOutput,
  safeSegment,
  buildToolResultBudgetSessionDir,
  type ToolResultBudgetOptions,
  type ToolResultInput,
  type PersistedToolResultRef,
  type ToolResultDecision,
  type PerMessageBudgetResult,
} from "./tool-result-budget";

// Completion Auditor
export {
  auditCompletion,
  compilePatterns,
  DEFAULT_PATTERN_SOURCES,
  type CompletionEvidenceKind,
  type CompletionEvidenceSummary,
  type CompletionClaimPatterns,
  type CompletionAuditorOptions,
  type CompletionAuditInput,
} from "./completion-auditor";

// Evidence Adapter
export {
  toCompletionEvidenceSummary,
  toVerificationEvidenceState,
  type EvidenceAdapterOptions,
} from "./evidence-adapter";

// Run Harness Audit
export {
  runHarnessAudit,
  type HarnessAuditInput,
  type HarnessAuditOptions,
} from "./run-harness-audit";

// Config
export {
  resolveHarnessConfig,
  type HarnessConfig,
  type ResolvedHarnessConfig,
  type HarnessMessageConfig,
  type HarnessPatternConfig,
} from "./harness-config";

// Verifier Verdict Parser
export {
  parseVerifierVerdict,
  hasVerifierVerdict,
  getVerdictStatus,
  type VerifierVerdict,
  type VerifierVerdictStatus,
  type VerifierCheckBlock,
  type VerifierVerdictParseResult,
} from "./verifier-verdict-parser";

// Verifier Verdict Adapter
export {
  applyVerifierVerdictsToEvidenceSummary,
} from "./verifier-verdict-adapter";

// Verifier Verdict Evidence
export {
  ingestVerifierVerdict,
  type VerifierVerdictEvidence,
  type VerifierVerdictEvidenceSource,
  type VerifierVerdictIngestionInput,
  type VerifierVerdictIngestionResult,
} from "./verifier-verdict-evidence";

// Completion Audit Scope
export {
  hasModificationEvidence,
  selectCompletionAuditEvidence,
  type CompletionAuditScope,
  type SelectCompletionAuditEvidenceInput,
  type SelectCompletionAuditEvidenceResult,
} from "./completion-audit-scope";

// Evidence Session Store
export {
  createEvidenceSessionStore,
  type EvidenceSessionStore,
  type EvidenceSnapshotOptions,
  type EvidenceSessionStoreOptions,
  type SessionStoredToolEvidence,
} from "./evidence-session-store";

// Tool Result Normalizer
export {
  normalizeToolResult,
  type SessionArtifactRef,
  type ToolResultNormalizeInput,
  type StructuredToolResult,
  type ToolResultNormalizeOutput,
} from "./tool-result-normalizer";