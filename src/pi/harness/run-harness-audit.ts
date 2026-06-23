/**
 * Run Harness Audit — 整合审计入口
 *
 * 设计原则：
 * - 整合 verification evidence + completion auditor
 * - 根据 agentContext 区分主 agent 和子代理行为
 * - 状态通过 adapter 转换，保持模块解耦
 *
 * 模块解耦：
 * - verification evidence policy 来自 verification-evidence-policy.ts
 * - completion auditor 来自 completion-auditor.ts
 * - agent context 来自 agent-context.ts
 * - evidence adapter 来自 evidence-adapter.ts
 */

import type { ToolEvidence } from "../policy/tool-evidence-types";
import {
  checkVerificationEvidence,
  type VerificationEvidenceContext,
  type VerificationEvidenceState,
} from "../policy/verification-evidence-policy";
import {
  auditCompletion,
  type CompletionAuditorOptions,
  type CompletionEvidenceSummary,
  type CompletionAuditInput,
} from "./completion-auditor";
import {
  toCompletionEvidenceSummary,
  toVerificationEvidenceState,
  type EvidenceAdapterOptions,
} from "./evidence-adapter";
import { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";
import type { AgentContext } from "./agent-context";
import type { HarnessDecision, HarnessIssue, HarnessMessageCatalog } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface HarnessAuditInput {
  finalText: string;
  evidences?: readonly ToolEvidence[];
  evidenceSummary?: CompletionEvidenceSummary;
  verificationState?: VerificationEvidenceState;
  verificationContext?: VerificationEvidenceContext;
  evidenceAdapter?: EvidenceAdapterOptions;
  /** Agent 角色 context（区分主 agent 和子代理） */
  agentContext?: AgentContext;
}

export interface HarnessAuditOptions extends ConsecutiveBlockOptions {
  messages?: HarnessMessageCatalog;
  completion?: Omit<CompletionAuditorOptions, "messages">;
}
// ─── H7: 连续阻止上限（防无限阻塞，对应 cc-haha 8 次硬上限） ────────────────

/**
 * 默认连续阻止上限。超过此值后，block 降级为 warn，防止模型陷入
 * "被阻止 → 再次声称完成 → 再被阻止" 的死循环。
 */
export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 8;

export interface ConsecutiveBlockOptions {
  /** 当前已连续阻止次数 */
  consecutiveBlocks?: number;
  /** 允许的最大连续阻止次数；超过后 block 降级为 warn */
  maxConsecutiveBlocks?: number;
}

// ─── Audit ─────────────────────────────────────────────────────────────────

function toIssueFromVerification(
  reason: string,
  messageKey: string | undefined,
  message: string,
): HarnessIssue {
  return {
    id: reason,
    action: "warn",
    messageKey: messageKey ?? reason,
    message,
  };
}

const SUPERSEDED_ISSUES: Readonly<Record<string, readonly string[]>> = {
  modification_without_verification: ["modified_without_verification"],
  final_report_without_acknowledging_unverified: ["modified_without_verification"],
};

function deduplicateIssues(issues: readonly HarnessIssue[]): HarnessIssue[] {
  const ids = new Set(issues.map((issue) => issue.id));
  const superseded = new Set<string>();

  for (const issue of issues) {
    for (const id of SUPERSEDED_ISSUES[issue.id] ?? []) {
      if (ids.has(id)) superseded.add(id);
    }
  }

  return issues.filter((issue, index) => {
    if (superseded.has(issue.id)) return false;
    return issues.findIndex((candidate) => candidate.id === issue.id) === index;
  });
}

/**
 * 运行整合审计
 *
 * 整合 verification evidence policy + completion auditor。
 * completion-auditor 收敛为单规则（有修改+无验证），不再区分主/子代理角色。
 */
export function runHarnessAudit(
  input: HarnessAuditInput,
  options: HarnessAuditOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;

  // 构建 evidence summary
  const evidenceSummary =
    input.evidenceSummary ?? toCompletionEvidenceSummary(input.evidences ?? [], input.evidenceAdapter);

  // 构建 verification state
  const verificationState = input.verificationState ?? toVerificationEvidenceState(evidenceSummary);

  const issues: HarnessIssue[] = [];

  // ─── Verification Evidence Check ────────────────────────────────────────

  const verificationDecision = checkVerificationEvidence(
    verificationState,
    input.verificationContext ?? {},
    { messages: messages.verificationEvidence },
  );

  if (
    verificationDecision.action === "warn" &&
    verificationDecision.reason &&
    verificationDecision.hint
  ) {
    issues.push(
      toIssueFromVerification(
        verificationDecision.reason,
        verificationDecision.messageKey,
        verificationDecision.hint,
      ),
    );
  }

  // ─── Completion Audit ───────────────────────────────────────────────────

  const completionInput: CompletionAuditInput = {
    finalText: input.finalText,
    evidence: evidenceSummary,
  };

  const completionDecision = auditCompletion(completionInput, {
    ...options.completion,
    messages,
  });

  issues.push(...completionDecision.issues);

  // ─── Final Decision ─────────────────────────────────────────────────────

  const deduplicatedIssues = deduplicateIssues(issues);

  const wantsBlock = deduplicatedIssues.some((item) => item.action === "block");
  const max = options.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS;
  const count = options.consecutiveBlocks ?? 0;

  // H7: 达到连续阻止上限时，block 降级为 warn，避免无限阻塞
  const action = wantsBlock
    ? (count >= max ? "warn" : "block")
    : deduplicatedIssues.length > 0
      ? "warn"
      : "allow";

  return {
    action,
    issues: deduplicatedIssues,
    injectedMessage: buildInjectedGuardMessage(messages, deduplicatedIssues),
  };
}