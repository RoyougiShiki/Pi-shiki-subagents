import { describe, expect, test } from "bun:test";
import { auditCompletion } from "./completion-auditor";
import { resolveHarnessConfig } from "./harness-config";
import { applyToolResultBudget } from "./tool-result-budget";

describe("harness config", () => {
  test("resolves default config", () => {
    const resolved = resolveHarnessConfig();
    expect(resolved.messages.completionAuditor.testPassWithoutEvidence).toContain("测试通过声明");
    expect(resolved.completionAuditor.messages).toBe(resolved.messages);
  });

  test("overrides messages without changing policy logic", () => {
    const resolved = resolveHarnessConfig({
      messages: {
        completionAuditor: {
          testPassWithoutEvidence: "CUSTOM_TEST_PASS",
        },
        verificationEvidence: {
          subagentPending: "CUSTOM_SUBAGENT",
        },
      },
    });

    expect(resolved.messages.completionAuditor.testPassWithoutEvidence).toBe("CUSTOM_TEST_PASS");
    expect(resolved.messages.verificationEvidence.subagentPending).toBe("CUSTOM_SUBAGENT");
    expect(resolved.messages.verificationEvidence.toolFailedWithoutRecovery).toContain("工具失败");
  });

  test("compiles custom completion patterns", () => {
    const resolved = resolveHarnessConfig({
      completionAuditor: {
        patterns: {
          testPass: ["CUSTOM_TEST_OK"],
        },
      },
    });

    const result = auditCompletion(
      { finalText: "CUSTOM_TEST_OK", evidence: { kinds: [] } },
      resolved.completionAuditor,
    );

    expect(result.action).toBe("block");
    expect(result.issues[0]?.id).toBe("test_pass_without_evidence");
  });

  test("resolves tool result template", async () => {
    const resolved = resolveHarnessConfig({
      messages: {
        toolResultBudget: {
          persistedOutputTemplate: "SAVED:{filepath}:{originalSize}:{preview}",
        },
      },
      toolResultBudget: {
        thresholds: { default: 3 },
      },
    });

    const result = await applyToolResultBudget(
      { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
      {
        ...resolved.toolResultBudget,
        storage: { baseDir: "/tmp/omo-harness-config-test", sessionId: "s1" },
        previewChars: 2,
      },
    );

    expect(result.action).toBe("persist");
    expect(result.content).toContain("SAVED:");
    expect(result.content).toContain(":6:");
  });
});
