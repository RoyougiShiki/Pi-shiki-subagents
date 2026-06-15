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
  acknowledgesMissingValidation,
  compilePatterns,
  type CompletionAuditorOptions,
  type CompletionEvidenceSummary,
  type CompletionAuditInput,
  type CompletionClaimPatterns,
} from "./completion-auditor";
import {
  toCompletionEvidenceSummary,
  toVerificationEvidenceState,
  type EvidenceAdapterOptions,
} from "./evidence-adapter";
import { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";
import { isMainAgent, type AgentContext } from "./agent-context";
import type { HarnessDecision, HarnessIssue, HarnessMessageCatalog } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface HarnessAuditInput {
  finalText: string;
  evidences?: readonly ToolEvidence[];
  evidenceSummary?: CompletionEvidenceSummary;
  verificationState?: VerificationEvidenceState;
  verificationContext?: VerificationEvidenceContext;
  evidenceAdapter?: EvidenceAdapterOptions;
  userAskedForFinal?: boolean;
  /** Agent 角色 context（区分主 agent 和子代理） */
  agentContext?: AgentContext;
}

export interface HarnessAuditOptions {
  messages?: HarnessMessageCatalog;
  completion?: Omit<CompletionAuditorOptions, "messages">;
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
 * 关键设计：区分主 agent 和子代理
 * - 主 agent (Stop)：检查 pending subagents, pending tasks
 * - 子代理 (SubagentStop)：只检查自己的 evidences
 */
export function runHarnessAudit(
  input: HarnessAuditInput,
  options: HarnessAuditOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const agentContext = input.agentContext ?? { role: "main" };
  const isMain = isMainAgent(agentContext);

  // 构建 evidence summary
  const evidenceSummary =
    input.evidenceSummary ?? toCompletionEvidenceSummary(input.evidences ?? [], input.evidenceAdapter);

  // 构建 verification state
  const verificationState = input.verificationState ?? toVerificationEvidenceState(evidenceSummary);
  const finalTextAcknowledgesMissingValidation = acknowledgesMissingValidation(
    input.finalText,
    options.completion?.patterns,
  );

  const issues: HarnessIssue[] = [];

  // ─── Verification Evidence Check ────────────────────────────────────────

  if (!finalTextAcknowledgesMissingValidation) {
    const verificationDecision = checkVerificationEvidence(
      verificationState,
      input.verificationContext ?? { userAskedForFinal: input.userAskedForFinal },
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
  }

  // ─── Completion Audit ───────────────────────────────────────────────────

  // 主 agent 需要检查 pending；子代理不需要
  const completionInput: CompletionAuditInput = {
    finalText: input.finalText,
    evidence: evidenceSummary,
    userAskedForFinal: input.userAskedForFinal,
    agentContext,
  };

  // 如果是子代理，清除 pending 检查（子代理完成自己是正常的）
  // 注意：这里通过 agentContext 传递，completion auditor 内部处理
  const completionDecision = auditCompletion(completionInput, {
    ...options.completion,
    messages,
  });

  issues.push(...completionDecision.issues);

  // ─── Final Decision ─────────────────────────────────────────────────────

  const deduplicatedIssues = deduplicateIssues(issues);

  const action = deduplicatedIssues.some((item) => item.action === "block")
    ? "block"
    : deduplicatedIssues.length > 0
      ? "warn"
      : "allow";

  return {
    action,
    issues: deduplicatedIssues,
    injectedMessage: buildInjectedGuardMessage(messages, deduplicatedIssues),
  };
}