import { describe, expect, test } from "bun:test";
import { auditCompletion, type CompletionEvidenceSummary } from "./completion-auditor";
import { type AgentContext } from "./agent-context";

const emptyEvidence: CompletionEvidenceSummary = { kinds: [] };
const mainAgentContext: AgentContext = { role: "main" };
const subagentContext: AgentContext = { role: "subagent", agentName: "worker-1" };

describe("completion auditor", () => {
  test("allows neutral text without claims", () => {
    const result = auditCompletion({ finalText: "我查看了一下当前情况。", evidence: emptyEvidence });
    expect(result.action).toBe("allow");
    expect(result.issues).toHaveLength(0);
  });

  test("blocks test-pass claim without test evidence", () => {
    const result = auditCompletion({ finalText: "已完成，测试通过。", evidence: { kinds: ["modification"] } });
    expect(result.action).toBe("block");
    expect(result.issues.map((item) => item.id)).toContain("test_pass_without_evidence");
    expect(result.injectedMessage).toContain("测试通过声明");
  });

  test("allows test-pass claim with test success evidence", () => {
    const result = auditCompletion({ finalText: "已完成，测试通过。", evidence: { kinds: ["modification", "test_success"] } });
    expect(result.action).toBe("allow");
  });

  test("warns when completion follows modification without verification acknowledgement", () => {
    const result = auditCompletion({ finalText: "修复完成。", evidence: { kinds: ["modification"], modifiedFileCount: 1 } });
    expect(result.action).toBe("warn");
    expect(result.issues[0]?.id).toBe("modification_without_verification");
  });

  test("allows unverified acknowledgement after modification", () => {
    const result = auditCompletion({ finalText: "修复已完成，但尚未验证。", evidence: { kinds: ["modification"], modifiedFileCount: 1 } });
    expect(result.action).toBe("allow");
  });

  // ─── Agent Context 区分测试 ───────────────────────────────────────────────

  test("blocks completion with pending subagent for main agent", () => {
    const result = auditCompletion({
      finalText: "全部完成。",
      evidence: { kinds: [], pendingSubagentCount: 1 },
      agentContext: mainAgentContext,
    });
    expect(result.action).toBe("block");
    expect(result.issues[0]?.id).toBe("completion_with_pending_subagent");
  });

  test("allows completion with pending subagent for subagent (it completes itself)", () => {
    // 子代理完成自己的任务是正常的，不应该被 block
    const result = auditCompletion({
      finalText: "任务完成。",
      evidence: { kinds: ["modification", "verification"], pendingSubagentCount: 0 },
      agentContext: subagentContext,
    });
    expect(result.action).toBe("allow");
  });

  test("subagent does not check pending subagents even if count > 0", () => {
    // 子代理不应该检查 pending subagent count
    // 因为它只完成自己的任务，不负责等待其他子代理
    const result = auditCompletion({
      finalText: "我的任务完成了。",
      evidence: { kinds: ["modification"], pendingSubagentCount: 5 },
      agentContext: subagentContext,
    });
    // 子代理声明完成，没有 verification，所以会 warn
    expect(result.action).toBe("warn");
    expect(result.issues.map((i) => i.id)).not.toContain("completion_with_pending_subagent");
  });

  test("main agent checks pending tasks", () => {
    const result = auditCompletion({
      finalText: "全部完成。",
      evidence: { kinds: [], pendingTaskCount: 2 },
      agentContext: mainAgentContext,
    });
    expect(result.action).toBe("block");
    expect(result.issues[0]?.id).toBe("completion_with_pending_tasks");
  });

  test("subagent does not check pending tasks", () => {
    const result = auditCompletion({
      finalText: "我的任务完成了。",
      evidence: { kinds: [], pendingTaskCount: 3 },
      agentContext: subagentContext,
    });
    expect(result.action).toBe("allow");
    expect(result.issues).toHaveLength(0);
  });

  // ─── userAskedForFinal vs claimsCompletion 区分测试 ────────────────────────

  test("userAskedForFinal does NOT make claimsCompletion true", () => {
    // 用户问“做完了吗”，但 assistant 回“还没，测试失败了”
    // claimsCompletion = false（没说“完成”）
    // isFinalReport = true（用户问了）
    // 应该 allow，因为不是虚假完成声明
    const result = auditCompletion({
      finalText: "还没做完，测试失败了。",
      evidence: { kinds: ["test_failure"], failedToolCount: 1 },
      userAskedForFinal: true,
    });
    // 没有声称完成，但有 test_failure，且已经说明了失败
    expect(result.action).toBe("allow");
    expect(result.issues).toHaveLength(0);
  });

  test("userAskedForFinal triggers finalReportWithoutAcknowledgingFailure", () => {
    // 用户问“做完了吗”，assistant 回“好的，继续”但没说明有失败
    const result = auditCompletion({
      finalText: "好的，继续处理。",
      evidence: { kinds: ["test_failure"], failedToolCount: 1 },
      userAskedForFinal: true,
    });
    // isFinalReport=true, claimsCompletion=false
    // 有失败但没说明 → warn
    expect(result.action).toBe("warn");
    expect(result.issues[0]?.id).toBe("final_report_without_acknowledging_failure");
  });

  test("userAskedForFinal triggers finalReportWithoutAcknowledgingUnverified", () => {
    // 用户问“进度？”，assistant 回“我修改了文件”但没说没验证
    const result = auditCompletion({
      finalText: "我已经修改了相关文件。",
      evidence: { kinds: ["modification"], modifiedFileCount: 2 },
      userAskedForFinal: true,
    });
    // isFinalReport=true, claimsCompletion=false
    // 有修改没验证没说明 → warn
    expect(result.action).toBe("warn");
    expect(result.issues[0]?.id).toBe("final_report_without_acknowledging_unverified");
  });

  test("claimsCompletion is stricter than isFinalReport", () => {
    // assistant 自己说“完成了”，但没验证 → warn/block
    // 比 userAskedForFinal 更严格
    const result = auditCompletion({
      finalText: "修改完成。",
      evidence: { kinds: ["modification"], modifiedFileCount: 1 },
      userAskedForFinal: false,
    });
    // claimsCompletion=true（匹配“完成”）
    // 有修改没验证 → warn
    expect(result.action).toBe("warn");
    expect(result.issues[0]?.id).toBe("modification_without_verification");
  });

  // ─── 自定义 messages 测试 ────────────────────────────────────────────────

  test("supports caller-provided messages without hard-coded logic strings", () => {
    const result = auditCompletion(
      { finalText: "all tests pass", evidence: emptyEvidence },
      {
        messages: {
          completionAuditor: {
            testPassWithoutEvidence: "CUSTOM_TEST",
            lintPassWithoutEvidence: "CUSTOM_LINT",
            typecheckPassWithoutEvidence: "CUSTOM_TYPE",
            completionWithPendingSubagent: "CUSTOM_SUBAGENT",
            completionWithPendingTasks: "CUSTOM_TASK",
            completionAfterFailureWithoutAcknowledgement: "CUSTOM_FAILURE",
            modificationWithoutVerification: "CUSTOM_UNVERIFIED",
            finalReportWithoutAcknowledgingFailure: "CUSTOM_FINAL_FAILURE",
            finalReportWithoutAcknowledgingUnverified: "CUSTOM_FINAL_UNVERIFIED",
            injectedHeader: "CUSTOM_HEADER",
          },
          toolResultBudget: {
            persistedOutput: () => "CUSTOM_PERSISTED",
            clearedOutput: () => "CUSTOM_CLEARED",
          },
        },
      },
    );

    expect(result.action).toBe("block");
    expect(result.injectedMessage).toContain("CUSTOM_HEADER");
    expect(result.injectedMessage).toContain("CUSTOM_TEST");
  });
});