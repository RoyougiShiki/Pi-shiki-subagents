import { describe, expect, test } from "bun:test";
import { resolveHarnessConfig } from "./harness-config";
import { auditCompletion } from "./completion-auditor";
import { applyToolResultBudget, createToolResultBudgetState } from "./tool-result-budget";

describe("harness config", () => {
  test("resolves default config", () => {
    const resolved = resolveHarnessConfig();
    // 检查 messages 结构
    expect(resolved.messages.completionAuditor.testPassWithoutEvidence).toContain("测试通过声明");
    expect(resolved.messages.verificationEvidence.subagentPending).toContain("子代理");
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
      { patterns: resolved.completionAuditor.patterns, messages: resolved.messages },
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

    const state = createToolResultBudgetState();
    const result = await applyToolResultBudget(
      { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
      {
        state,
        thresholds: resolved.toolResultBudget.thresholds,
        messages: resolved.messages,
        storage: { baseDir: "/tmp/omo-harness-config-test", sessionId: "s1" },
        previewChars: 2,
      },
    );

    expect(result.action).toBe("persist");
    expect(result.content).toContain("SAVED:");
    expect(result.content).toContain(":6:");
  });

  test("uses thresholds from config", () => {
    const resolved = resolveHarnessConfig({
      toolResultBudget: {
        thresholds: {
          default: 100_000,
          byTool: { grep: 50_000 },
        },
      },
    });

    // 检查阈值结构（用户配置，不包含系统默认）
    expect(resolved.toolResultBudget.thresholds.default).toBe(100_000);
    expect(resolved.toolResultBudget.thresholds.byTool?.grep).toBe(50_000);
    // 系统默认不合并到用户配置
    expect(resolved.toolResultBudget.thresholds.byTool?.bash).toBeUndefined();
  });
});