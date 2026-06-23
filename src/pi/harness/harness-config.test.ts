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

  test("H5: patterns config is accepted but ignored (single-rule auditor)", () => {
    // completion-auditor 收敛为单规则后，patterns 配置不再编译。
    // 旧配置仍被 schema 接受（向后兼容），但 ResolvedHarnessConfig 不再暴露 patterns 字段。
    // 详见 proposal-v2.md §2 H5。
    const resolved = resolveHarnessConfig({
      completionAuditor: {
        patterns: {
          testPass: ["CUSTOM_TEST_OK"],
        },
      },
    });

    expect(resolved.completionAuditor.patterns).toBeUndefined();
    // 单规则：只看 modification evidence，不看 finalText 文本
    const result = auditCompletion(
      { finalText: "CUSTOM_TEST_OK", evidence: { kinds: [] } },
      { messages: resolved.messages },
    );
    expect(result.action).toBe("allow");
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

  test("H7: maxConsecutiveBlocks defaults to 8", () => {
    const resolved = resolveHarnessConfig();
    expect(resolved.completionAuditor.maxConsecutiveBlocks).toBe(8);
  });

  test("H7: maxConsecutiveBlocks can be overridden", () => {
    const resolved = resolveHarnessConfig({
      completionAuditor: { maxConsecutiveBlocks: 3 },
    });
    expect(resolved.completionAuditor.maxConsecutiveBlocks).toBe(3);
  });
});
