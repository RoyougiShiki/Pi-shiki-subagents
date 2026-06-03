import { describe, expect, test } from "bun:test";
import { auditCompletion, type CompletionEvidenceSummary } from "./completion-auditor";

const emptyEvidence: CompletionEvidenceSummary = { kinds: [] };

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

  test("blocks completion with pending subagent", () => {
    const result = auditCompletion({ finalText: "全部完成。", evidence: { kinds: [], pendingSubagentCount: 1 } });
    expect(result.action).toBe("block");
    expect(result.issues[0]?.id).toBe("completion_with_pending_subagent");
  });

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
