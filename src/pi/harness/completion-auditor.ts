/**
 * Completion Auditor — 完成声明审计
 *
 * 设计原则（cc-haha 设计）：
 * - 主 agent (Stop)：需要检查 pending subagents, pending tasks
 * - 子代理 (SubagentStop)：只检查自己的 evidences，不检查 pending
 * - 区分角色：根据 AgentContext 决定检查范围
 *
 * 模块解耦：
 * - Agent role 来自 agent-context.ts
 * - 文案来自 HarnessMessageCatalog
 * - Patterns 可配置，不硬编码
 */

import { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";
import { isMainAgent, type AgentContext } from "./agent-context";
import type { HarnessDecision, HarnessIssue, HarnessMessageCatalog } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────

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
  | "verifier_pass"
  | "verifier_fail"
  | "verifier_partial"
  | "subagent_pending";

export interface CompletionEvidenceSummary {
  kinds: readonly CompletionEvidenceKind[];
  pendingSubagentCount?: number;
  pendingTaskCount?: number;
  failedToolCount?: number;
  modifiedFileCount?: number;
  verifierVerdict?: "PASS" | "FAIL" | "PARTIAL";
  verifierSummary?: string;
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
  agentContext?: AgentContext;
}

export function acknowledgesMissingValidation(
  text: string,
  patterns?: Partial<CompletionClaimPatterns>,
): boolean {
  return matches(text, mergePatterns(patterns).acknowledgesUnverified);
}

// ─── Patterns ──────────────────────────────────────────────────────────────

/**
 * 默认 pattern（唯一真源）
 * 
 * 注意：Pattern 是声明检测，不是语义分析
 * - completion: 检测"完成"类声明
 * - testPass/lintPass/typecheckPass: 检测"通过"类声明
 * - acknowledgesFailure: 检测失败承认
 * - acknowledgesUnverified: 检测未验证承认
 */
const DEFAULT_PATTERN_SOURCES: Record<keyof CompletionClaimPatterns, readonly string[]> = {
  completion: [
    "\\b(done|fixed|implemented|complete|completed)\\b",
    "(?:已|已经|全部)?(?:完成|修复|实现|处理好了)",
  ],
  testPass: [
    "\\b(all\\s+tests?\\s+pass(?:ed)?|tests?\\s+pass(?:ed)?)\\b",
    "测试(?:已)?通过",
  ],
  lintPass: [
    "\\b(lint(?:ing)?\\s+pass(?:ed)?|lint\\s+clean)\\b",
    "lint\\s*(?:已)?通过",
  ],
  typecheckPass: [
    "\\b(type\\s*check(?:ing)?\\s+pass(?:ed)?|typecheck\\s+pass(?:ed)?)\\b",
    "类型检查(?:已)?通过",
  ],
  acknowledgesFailure: [
    "\\b(fail(?:ed|ure)?|error|not\\s+fixed|not\\s+complete|partial)\\b",
    "(?:失败|报错|未完成|部分完成|仍有问题)",
  ],
  acknowledgesUnverified: [
    "\\b(not\\s+verified|unverified|did\\s+not\\s+run|not\\s+run)\\b",
    "(?:未验证|尚未验证|没有运行|未运行)",
  ],
};

/**
 * 编译 pattern（从 string 到 RegExp）
 */
export function compilePatterns(sources: Record<keyof CompletionClaimPatterns, readonly string[]>): CompletionClaimPatterns {
  return {
    completion: sources.completion.map((s) => new RegExp(s, "i")),
    testPass: sources.testPass.map((s) => new RegExp(s, "i")),
    lintPass: sources.lintPass.map((s) => new RegExp(s, "i")),
    typecheckPass: sources.typecheckPass.map((s) => new RegExp(s, "i")),
    acknowledgesFailure: sources.acknowledgesFailure.map((s) => new RegExp(s, "i")),
    acknowledgesUnverified: sources.acknowledgesUnverified.map((s) => new RegExp(s, "i")),
  };
}

const DEFAULT_PATTERNS = compilePatterns(DEFAULT_PATTERN_SOURCES);

function mergePatterns(patterns?: Partial<CompletionClaimPatterns>): CompletionClaimPatterns {
  if (!patterns) return DEFAULT_PATTERNS;
  return {
    completion: patterns.completion ?? DEFAULT_PATTERNS.completion,
    testPass: patterns.testPass ?? DEFAULT_PATTERNS.testPass,
    lintPass: patterns.lintPass ?? DEFAULT_PATTERNS.lintPass,
    typecheckPass: patterns.typecheckPass ?? DEFAULT_PATTERNS.typecheckPass,
    acknowledgesFailure: patterns.acknowledgesFailure ?? DEFAULT_PATTERNS.acknowledgesFailure,
    acknowledgesUnverified: patterns.acknowledgesUnverified ?? DEFAULT_PATTERNS.acknowledgesUnverified,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Audit ─────────────────────────────────────────────────────────────────

/**
 * 审计完成声明
 *
 * 关键设计：区分主 agent 和子代理
 * - 主 agent (Stop)：检查 pending subagents, pending tasks
 * - 子代理 (SubagentStop)：不检查 pending（子代理完成自己是正常的）
 */
export function auditCompletion(
  input: CompletionAuditInput,
  options: CompletionAuditorOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const patterns = mergePatterns(options.patterns);
  const text = input.finalText;
  const evidence = input.evidence;
  const issues: HarnessIssue[] = [];
  const agentContext = input.agentContext ?? { role: "main" };
  const isMain = isMainAgent(agentContext);

  // ─── 完成声明 vs 最终汇报场景 ──────────────────────────────────────────
  //
  // cc-haha design: Stop hook 检查 assistant 的 last_assistant_message
  // 是否与 evidence 相符，而不是根据用户提问判断。
  //
  // claimsCompletion: assistant 自己说“完成了” → 检查虚假完成声明
  // isFinalReport: 当前轮像最终汇报 → 检查是否需要说明未验证/失败/pending
  //
  // 区别：用户问“做完了吗” + assistant 回“还没，测试失败” → allow
  // 因为 claimsCompletion=false（没说完成了），只是 isFinalReport=true

  const claimsCompletion = matches(text, patterns.completion);
  const isFinalReport = input.userAskedForFinal || claimsCompletion;

  // ─── 虚假完成声明检测（所有角色都检查）────────────────────────────────
  //
  // 只有 claimsCompletion=true 时才检查“声称完成但证据不支持”
  // 这是 cc-haha 风格的 false claim detection

  // 测试通过声明无证据
  if (matches(text, patterns.testPass) && !hasKind(evidence, "test_success")) {
    issues.push(
      issue(
        "test_pass_without_evidence",
        "block",
        "testPassWithoutEvidence",
        messages.completionAuditor.testPassWithoutEvidence,
      ),
    );
  }

  // Lint 通过声明无证据
  if (matches(text, patterns.lintPass) && !hasKind(evidence, "lint_success")) {
    issues.push(
      issue(
        "lint_pass_without_evidence",
        "block",
        "lintPassWithoutEvidence",
        messages.completionAuditor.lintPassWithoutEvidence,
      ),
    );
  }

  // Typecheck 通过声明无证据
  if (matches(text, patterns.typecheckPass) && !hasKind(evidence, "typecheck_success")) {
    issues.push(
      issue(
        "typecheck_pass_without_evidence",
        "block",
        "typecheckPassWithoutEvidence",
        messages.completionAuditor.typecheckPassWithoutEvidence,
      ),
    );
  }

  // ─── Pending 检测（仅主 agent 检查）──────────────────────────────────────
  //
  // claimsCompletion: 声称完成但有 pending → 虚假完成
  // isFinalReport: 最终汇报时有 pending → 需要说明状态

  // 子代理完成自己是正常的，只有主 agent 需要等待所有子代理
  if (isMain) {
    // 虚假完成：声称完成但有 pending subagent
    if (claimsCompletion && (evidence.pendingSubagentCount ?? 0) > 0) {
      issues.push(
        issue(
          "completion_with_pending_subagent",
          "block",
          "completionWithPendingSubagent",
          messages.completionAuditor.completionWithPendingSubagent,
          { pendingSubagentCount: evidence.pendingSubagentCount },
        ),
      );
    }

    // 虚假完成：声称完成但有 pending tasks
    if (claimsCompletion && (evidence.pendingTaskCount ?? 0) > 0) {
      issues.push(
        issue(
          "completion_with_pending_tasks",
          "block",
          "completionWithPendingTasks",
          messages.completionAuditor.completionWithPendingTasks,
          { pendingTaskCount: evidence.pendingTaskCount },
        ),
      );
    }
  }

  // ─── Verifier verdict 检测（所有角色都检查）───────────────────────────────

  if (claimsCompletion && hasKind(evidence, "verifier_fail") && !matches(text, patterns.acknowledgesFailure)) {
    issues.push(
      issue(
        "completion_against_verifier_fail",
        "warn",
        "completionAgainstVerifierFail",
        messages.completionAuditor.completionAgainstVerifierFail,
        { verifierSummary: evidence.verifierSummary },
      ),
    );
  }

  if (
    claimsCompletion &&
    hasKind(evidence, "verifier_partial") &&
    !matches(text, patterns.acknowledgesFailure) &&
    !matches(text, patterns.acknowledgesUnverified)
  ) {
    issues.push(
      issue(
        "completion_against_verifier_partial",
        "warn",
        "completionAgainstVerifierPartial",
        messages.completionAuditor.completionAgainstVerifierPartial,
        { verifierSummary: evidence.verifierSummary },
      ),
    );
  }

  // ─── 失败后完成检测（所有角色都检查）──────────────────────────────────────
  //
  // claimsCompletion: 声称完成但有失败 → 虚假完成
  // isFinalReport: 最终汇报时有失败但未说明 → 需要说明

  // 虚假完成：声称完成但有失败未说明
  if (
    claimsCompletion &&
    (hasKind(evidence, "tool_failure") ||
      hasKind(evidence, "test_failure") ||
      hasKind(evidence, "lint_failure") ||
      hasKind(evidence, "typecheck_failure")) &&
    !matches(text, patterns.acknowledgesFailure)
  ) {
    issues.push(
      issue(
        "completion_after_failure_without_acknowledgement",
        "block",
        "completionAfterFailureWithoutAcknowledgement",
        messages.completionAuditor.completionAfterFailureWithoutAcknowledgement,
        { failedToolCount: evidence.failedToolCount },
      ),
    );
  }

  // 最终汇报：有失败但未说明（比 false claim 轻一些，用 warn）
  if (
    isFinalReport &&
    !claimsCompletion &&
    (hasKind(evidence, "tool_failure") ||
      hasKind(evidence, "test_failure") ||
      hasKind(evidence, "lint_failure") ||
      hasKind(evidence, "typecheck_failure")) &&
    !matches(text, patterns.acknowledgesFailure)
  ) {
    issues.push(
      issue(
        "final_report_without_acknowledging_failure",
        "warn",
        "finalReportWithoutAcknowledgingFailure",
        messages.completionAuditor.finalReportWithoutAcknowledgingFailure,
        { failedToolCount: evidence.failedToolCount },
      ),
    );
  }

  // ─── 修改后未验证检测（所有角色都检查）──────────────────────────────────────

  // 虚假完成：声称完成但有修改未验证
  if (
    claimsCompletion &&
    hasKind(evidence, "modification") &&
    !hasKind(evidence, "verification") &&
    !hasKind(evidence, "test_success") &&
    !hasKind(evidence, "lint_success") &&
    !hasKind(evidence, "typecheck_success") &&
    !matches(text, patterns.acknowledgesUnverified)
  ) {
    issues.push(
      issue(
        "modification_without_verification",
        options.blockOnUnverifiedModification ? "block" : "warn",
        "modificationWithoutVerification",
        messages.completionAuditor.modificationWithoutVerification,
        { modifiedFileCount: evidence.modifiedFileCount },
      ),
    );
  }

  // 最终汇报：有修改未验证但未说明（比 false claim 轻一些，用 warn）
  if (
    isFinalReport &&
    !claimsCompletion &&
    hasKind(evidence, "modification") &&
    !hasKind(evidence, "verification") &&
    !hasKind(evidence, "test_success") &&
    !hasKind(evidence, "lint_success") &&
    !hasKind(evidence, "typecheck_success") &&
    !matches(text, patterns.acknowledgesUnverified)
  ) {
    issues.push(
      issue(
        "final_report_without_acknowledging_unverified",
        "warn",
        "finalReportWithoutAcknowledgingUnverified",
        messages.completionAuditor.finalReportWithoutAcknowledgingUnverified,
        { modifiedFileCount: evidence.modifiedFileCount },
      ),
    );
  }

  // ─── 决策 ──────────────────────────────────────────────────────────────────

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

// ─── Re-export ─────────────────────────────────────────────────────────────

export { DEFAULT_PATTERN_SOURCES };