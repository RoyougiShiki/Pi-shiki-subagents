import type { HarnessIssue, HarnessMessageCatalog } from "./types";

export const DEFAULT_HARNESS_MESSAGES: HarnessMessageCatalog = {
  verificationEvidence: {
    subagentPending:
      "[guard] 子代理尚未完成；等待完成通知后再总结其结果。",
    toolFailedWithoutRecovery:
      "[guard] 上一步工具失败；不要宣称完成，请先处理失败或说明未完成。",
    modificationWithoutVerification:
      "[guard] 已有修改证据，但未检测到验证证据；总结时请明确“尚未验证”。",
  },
  completionAuditor: {
    testPassWithoutEvidence:
      "[guard] 检测到测试通过声明，但没有找到测试成功证据。请先验证，或明确说明未验证。",
    lintPassWithoutEvidence:
      "[guard] 检测到 lint 通过声明，但没有找到 lint 成功证据。请先验证，或明确说明未验证。",
    typecheckPassWithoutEvidence:
      "[guard] 检测到 typecheck 通过声明，但没有找到类型检查成功证据。请先验证，或明确说明未验证。",
    completionWithPendingSubagent:
      "[guard] 仍有子代理未完成；请等待结果后再总结。",
    completionWithPendingTasks:
      "[guard] 仍有未完成任务；不要直接宣称全部完成。",
    completionAfterFailureWithoutAcknowledgement:
      "[guard] 检测到失败证据，但最终回复没有说明失败或恢复情况。",
    modificationWithoutVerification:
      "[guard] 检测到修改证据，但没有验证证据。总结时请明确说明尚未验证，或先执行验证。",
    finalReportWithoutAcknowledgingFailure:
      "[guard] 检测到失败证据，但回复没有说明失败情况。请在总结中说明当前状态。",
    finalReportWithoutAcknowledgingUnverified:
      "[guard] 检测到修改证据但没有验证。请在总结中明确说明“尚未验证”。",
    injectedHeader: "[guard] 完成前审计发现以下问题：",
  },
  toolResultBudget: {
    persistedOutput: ({ originalSize, filepath, previewSize, preview, hasMore }) =>
      `<persisted-output>\nOutput too large (${originalSize} chars). Full output saved to: ${filepath}\n\nPreview (first ${previewSize} chars):\n${preview}${hasMore ? "\n..." : ""}\n</persisted-output>`,
    clearedOutput: ({ filepath }) =>
      filepath
        ? `[old tool result cleared; full output saved at ${filepath}]`
        : "[old tool result cleared]",
  },
};

export function buildInjectedGuardMessage(
  messages: HarnessMessageCatalog,
  issues: readonly HarnessIssue[],
): string | undefined {
  if (issues.length === 0) return undefined;
  const body = issues.map((issue) => `- ${issue.message}`).join("\n");
  return `${messages.completionAuditor.injectedHeader}\n${body}`;
}
