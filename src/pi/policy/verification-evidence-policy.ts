export interface VerificationEvidenceState {
  hasRead: boolean;
  hasModify: boolean;
  hasVerification: boolean;
  hasFailure: boolean;
  hasSubagentPending: boolean;
}

export interface VerificationEvidenceContext {
  userAskedForFinal?: boolean;
  afterToolFailure?: boolean;
  afterModification?: boolean;
  dependingOnSubagent?: boolean;
}

export interface VerificationEvidenceDecision {
  action: "allow" | "warn";
  reason?: string;
  hint?: string;
}

const allow = (): VerificationEvidenceDecision => ({ action: "allow" });

const warn = (reason: string, hint: string): VerificationEvidenceDecision => ({
  action: "warn",
  reason,
  hint,
});

/**
 * Verification Evidence Guard / Evidence Reminder.
 *
 * Pure policy: no text scanning, no UI, no Pi API, no global evidence reads.
 * The composition layer must pass a summarized evidence state.
 */
export function checkVerificationEvidence(
  state: VerificationEvidenceState,
  context: VerificationEvidenceContext = {},
): VerificationEvidenceDecision {
  if (context.dependingOnSubagent && state.hasSubagentPending) {
    return warn(
      "subagent_pending",
      "[guard] 子代理尚未完成；等待完成通知后再总结其结果。",
    );
  }

  if ((context.afterToolFailure || state.hasFailure) && !state.hasVerification) {
    return warn(
      "tool_failed_without_recovery",
      "[guard] 上一步工具失败；不要宣称完成，请先处理失败或说明未完成。",
    );
  }

  if ((context.afterModification || state.hasModify || context.userAskedForFinal) && state.hasModify && !state.hasVerification) {
    return warn(
      "modified_without_verification",
      "[guard] 已有修改证据，但未检测到验证证据；总结时请明确“尚未验证”。",
    );
  }

  return allow();
}
