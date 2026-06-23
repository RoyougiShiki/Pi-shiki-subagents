import { describe, expect, test } from "bun:test";
import { runHarnessAudit } from "./run-harness-audit";
import type { ToolEvidence } from "../policy/tool-evidence-types";

function evidence(partial: Partial<ToolEvidence>): ToolEvidence {
  return {
    toolName: partial.toolName ?? "bash",
    toolCallId: partial.toolCallId ?? "call-1",
    args: partial.args ?? {},
    result: partial.result,
    timestamp: partial.timestamp ?? 1,
    success: partial.success ?? true,
  };
}

describe("runHarnessAudit", () => {
  test("deduplicates: completion auditor's modification_without_verification supersedes policy's warn", () => {
    const result = runHarnessAudit({
      finalText: "修复完成。",
      evidences: [evidence({ toolName: "edit" })],
      verificationContext: { afterModification: true },
    });

    expect(result.action).toBe("warn");
    expect(result.issues.some((issue) => issue.id === "modified_without_verification")).toBe(false);
    expect(result.issues.some((issue) => issue.id === "modification_without_verification")).toBe(true);
  });

  test("H5: text acknowledging unverified no longer exempts — single rule fires on modification evidence", () => {
    // acknowledgesMissingValidation 门已删（H5）。模型说"尚未验证"不再放行，
    // 只要 evidence 有 modification 无 verification 就 warn/block。
    const result = runHarnessAudit({
      finalText: "已修改文件，但没有运行测试或 typecheck，因此尚未验证。",
      evidences: [evidence({ toolName: "edit" })],
      verificationContext: { afterModification: true },
    });

    expect(result.action).toBe("warn");
    expect(result.issues.some((issue) => issue.id === "modification_without_verification")).toBe(true);
  });

  test("H5: no longer blocks on test-pass claim text — single rule ignores finalText", () => {
    // test_pass_without_evidence issue 已删（H5）。模型说"测试通过"但无 test_success evidence，
    // 只要没 modification 就 allow；有 modification 无验证则走 modification_without_verification。
    const result = runHarnessAudit({
      finalText: "已完成，测试通过。",
      evidences: [evidence({ toolName: "edit" })],
      verificationContext: { afterModification: true },
    });

    expect(result.issues.some((issue) => issue.id === "test_pass_without_evidence")).toBe(false);
    expect(result.issues.some((issue) => issue.id === "modification_without_verification")).toBe(true);
  });

  test("allows completion when evidence is sufficient", () => {
    const result = runHarnessAudit({
      finalText: "已完成，测试通过。",
      evidences: [
        evidence({ toolName: "edit" }),
        evidence({ toolName: "bash", args: { command: "bun test" }, success: true }),
      ],
      verificationContext: { afterModification: true },
    });

    expect(result.action).toBe("allow");
  });

  // ─── H7: 连续阻止上限 ────────────────────────────────────────────────────

  test("H7: blocks when consecutiveBlocks below max", () => {
    const result = runHarnessAudit(
      {
        finalText: "done",
        evidences: [evidence({ toolName: "edit" })],
      },
      {
        completion: { blockOnUnverifiedModification: true },
        consecutiveBlocks: 3,
        maxConsecutiveBlocks: 8,
      },
    );
    expect(result.action).toBe("block");
  });

  test("H7: degrades block to warn when consecutiveBlocks reaches max", () => {
    const result = runHarnessAudit(
      {
        finalText: "done",
        evidences: [evidence({ toolName: "edit" })],
      },
      {
        completion: { blockOnUnverifiedModification: true },
        consecutiveBlocks: 8,
        maxConsecutiveBlocks: 8,
      },
    );
    expect(result.action).toBe("warn");
  });

  test("H7: defaults to DEFAULT_MAX_CONSECUTIVE_BLOCKS (8) when options omitted", () => {
    // consecutiveBlocks 默认 0 → 未达上限 → block
    const result = runHarnessAudit(
      {
        finalText: "done",
        evidences: [evidence({ toolName: "edit" })],
      },
      { completion: { blockOnUnverifiedModification: true } },
    );
    expect(result.action).toBe("block");
  });
});
