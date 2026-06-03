import { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";
import type { HarnessDecision, HarnessIssue, HarnessMessageCatalog } from "./types";

export type CompletionEvidenceKind =
  | "modification"
  | "verification"
  | "test_success"
  | "test_failure"
  | "lint_success"
  | "lint_failure"
  | "typecheck_success"
  | "typecheck_failure"
  | "tool_failure"
  | "subagent_pending";

export interface CompletionEvidenceSummary {
  kinds: readonly CompletionEvidenceKind[];
  pendingSubagentCount?: number;
  pendingTaskCount?: number;
  failedToolCount?: number;
  modifiedFileCount?: number;
}

export interface CompletionClaimPatterns {
  completion: readonly RegExp[];
  testPass: readonly RegExp[];
  lintPass: readonly RegExp[];
  typecheckPass: readonly RegExp[];
  acknowledgesFailure: readonly RegExp[];
  acknowledgesUnverified: readonly RegExp[];
}

export interface CompletionAuditorOptions {
  messages?: HarnessMessageCatalog;
  patterns?: Partial<CompletionClaimPatterns>;
  blockOnUnverifiedModification?: boolean;
}

export interface CompletionAuditInput {
  finalText: string;
  evidence: CompletionEvidenceSummary;
  userAskedForFinal?: boolean;
}

const DEFAULT_PATTERNS: CompletionClaimPatterns = {
  completion: [
    /\b(done|fixed|implemented|complete|completed)\b/i,
    /(?:已|已经|全部)?(?:完成|修复|实现|处理好了)/,
  ],
  testPass: [/\b(all\s+tests?\s+pass(?:ed)?|tests?\s+pass(?:ed)?)\b/i, /测试(?:已)?通过/],
  lintPass: [/\b(lint(?:ing)?\s+pass(?:ed)?|lint\s+clean)\b/i, /lint\s*(?:已)?通过/i],
  typecheckPass: [
    /\b(type\s*check(?:ing)?\s+pass(?:ed)?|typecheck\s+pass(?:ed)?)\b/i,
    /类型检查(?:已)?通过/,
  ],
  acknowledgesFailure: [
    /\b(fail(?:ed|ure)?|error|not\s+fixed|not\s+complete|partial)\b/i,
    /(?:失败|报错|未完成|部分完成|仍有问题)/,
  ],
  acknowledgesUnverified: [
    /\b(not\s+verified|unverified|did\s+not\s+run|not\s+run)\b/i,
    /(?:未验证|尚未验证|没有运行|未运行)/,
  ],
};

function mergePatterns(patterns?: Partial<CompletionClaimPatterns>): CompletionClaimPatterns {
  return {
    completion: patterns?.completion ?? DEFAULT_PATTERNS.completion,
    testPass: patterns?.testPass ?? DEFAULT_PATTERNS.testPass,
    lintPass: patterns?.lintPass ?? DEFAULT_PATTERNS.lintPass,
    typecheckPass: patterns?.typecheckPass ?? DEFAULT_PATTERNS.typecheckPass,
    acknowledgesFailure: patterns?.acknowledgesFailure ?? DEFAULT_PATTERNS.acknowledgesFailure,
    acknowledgesUnverified: patterns?.acknowledgesUnverified ?? DEFAULT_PATTERNS.acknowledgesUnverified,
  };
}

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasKind(evidence: CompletionEvidenceSummary, kind: CompletionEvidenceKind): boolean {
  return evidence.kinds.includes(kind);
}

function issue(
  id: string,
  action: HarnessIssue["action"],
  messageKey: string,
  message: string,
  details?: Record<string, unknown>,
): HarnessIssue {
  return { id, action, messageKey, message, details };
}

export function auditCompletion(
  input: CompletionAuditInput,
  options: CompletionAuditorOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const patterns = mergePatterns(options.patterns);
  const text = input.finalText;
  const evidence = input.evidence;
  const issues: HarnessIssue[] = [];
  const claimsCompletion = input.userAskedForFinal || matches(text, patterns.completion);

  if (matches(text, patterns.testPass) && !hasKind(evidence, "test_success")) {
    issues.push(issue("test_pass_without_evidence", "block", "testPassWithoutEvidence", messages.completionAuditor.testPassWithoutEvidence));
  }

  if (matches(text, patterns.lintPass) && !hasKind(evidence, "lint_success")) {
    issues.push(issue("lint_pass_without_evidence", "block", "lintPassWithoutEvidence", messages.completionAuditor.lintPassWithoutEvidence));
  }

  if (matches(text, patterns.typecheckPass) && !hasKind(evidence, "typecheck_success")) {
    issues.push(issue("typecheck_pass_without_evidence", "block", "typecheckPassWithoutEvidence", messages.completionAuditor.typecheckPassWithoutEvidence));
  }

  if (claimsCompletion && (evidence.pendingSubagentCount ?? 0) > 0) {
    issues.push(issue("completion_with_pending_subagent", "block", "completionWithPendingSubagent", messages.completionAuditor.completionWithPendingSubagent, { pendingSubagentCount: evidence.pendingSubagentCount }));
  }

  if (claimsCompletion && (evidence.pendingTaskCount ?? 0) > 0) {
    issues.push(issue("completion_with_pending_tasks", "block", "completionWithPendingTasks", messages.completionAuditor.completionWithPendingTasks, { pendingTaskCount: evidence.pendingTaskCount }));
  }

  if (
    claimsCompletion &&
    (hasKind(evidence, "tool_failure") || hasKind(evidence, "test_failure") || hasKind(evidence, "lint_failure") || hasKind(evidence, "typecheck_failure")) &&
    !matches(text, patterns.acknowledgesFailure)
  ) {
    issues.push(issue("completion_after_failure_without_acknowledgement", "block", "completionAfterFailureWithoutAcknowledgement", messages.completionAuditor.completionAfterFailureWithoutAcknowledgement, { failedToolCount: evidence.failedToolCount }));
  }

  if (
    claimsCompletion &&
    hasKind(evidence, "modification") &&
    !hasKind(evidence, "verification") &&
    !hasKind(evidence, "test_success") &&
    !hasKind(evidence, "lint_success") &&
    !hasKind(evidence, "typecheck_success") &&
    !matches(text, patterns.acknowledgesUnverified)
  ) {
    issues.push(issue("modification_without_verification", options.blockOnUnverifiedModification ? "block" : "warn", "modificationWithoutVerification", messages.completionAuditor.modificationWithoutVerification, { modifiedFileCount: evidence.modifiedFileCount }));
  }

  const action = issues.some((item) => item.action === "block")
    ? "block"
    : issues.length > 0
      ? "warn"
      : "allow";

  return {
    action,
    issues,
    injectedMessage: buildInjectedGuardMessage(messages, issues),
  };
}
