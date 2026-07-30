/**
 * Completion Auditor — 完成声明审计
 *
 * 设计原则（cc-haha 对齐）：
 * - 不扫描模型自然语言输出（去正则 claim 检测）
 * - 只做 evidence-kind 判断：有修改 + 无验证 → 拦截
 * - blockOnUnverifiedModification 控制 warn/block
 *
 * 历史说明：原实现用正则扫 finalText 判断"模型是否声称完成"，
 * cc-haha 源码核对确认 Claude Code 不扫模型输出。改造为纯 evidence-kind 判断，
 * 触发由 register-harness-hooks.ts 的 message_end handler 保证。
 * 详见 proposal-v2.md §2 H5 + 附录 A4。
 */

import {
  buildInjectedGuardMessage,
  DEFAULT_HARNESS_MESSAGES,
} from './messages';
import type {
  HarnessDecision,
  HarnessIssue,
  HarnessMessageCatalog,
} from './types';

// ─── Types ────────────────────────────────────────────────────────────────

export type CompletionEvidenceKind =
  | 'modification'
  | 'verification'
  | 'test_success'
  | 'test_failure'
  | 'lint_success'
  | 'lint_failure'
  | 'typecheck_success'
  | 'typecheck_failure'
  | 'tool_failure'
  | 'verifier_pass'
  | 'verifier_fail'
  | 'verifier_partial'
  | 'subagent_pending';

export interface CompletionEvidenceSummary {
  kinds: readonly CompletionEvidenceKind[];
  pendingSubagentCount?: number;
  pendingTaskCount?: number;
  failedToolCount?: number;
  modifiedFileCount?: number;
  verifierVerdict?: 'PASS' | 'FAIL' | 'PARTIAL';
  verifierSummary?: string;
}

export interface CompletionAuditorOptions {
  messages?: HarnessMessageCatalog;
  blockOnUnverifiedModification?: boolean;
}

export interface CompletionAuditInput {
  finalText: string;
  evidence: CompletionEvidenceSummary;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function hasKind(
  evidence: CompletionEvidenceSummary,
  kind: CompletionEvidenceKind,
): boolean {
  return evidence.kinds.includes(kind);
}

function hasVerificationEvidence(evidence: CompletionEvidenceSummary): boolean {
  return (
    hasKind(evidence, 'verification') ||
    hasKind(evidence, 'test_success') ||
    hasKind(evidence, 'lint_success') ||
    hasKind(evidence, 'typecheck_success')
  );
}

function issue(
  id: string,
  action: HarnessIssue['action'],
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
 * 单规则：有修改 + 无验证 → warn/block
 * 触发由 register-harness-hooks.ts 的 message_end handler 保证。
 */
export function auditCompletion(
  input: CompletionAuditInput,
  options: CompletionAuditorOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const evidence = input.evidence;
  const issues: HarnessIssue[] = [];

  if (hasKind(evidence, 'modification') && !hasVerificationEvidence(evidence)) {
    issues.push(
      issue(
        'modification_without_verification',
        options.blockOnUnverifiedModification ? 'block' : 'warn',
        'modificationWithoutVerification',
        messages.completionAuditor.modificationWithoutVerification,
        { modifiedFileCount: evidence.modifiedFileCount },
      ),
    );
  }

  const action = issues.some((item) => item.action === 'block')
    ? 'block'
    : issues.length > 0
      ? 'warn'
      : 'allow';

  return {
    action,
    issues,
    injectedMessage: buildInjectedGuardMessage(messages, issues),
  };
}
