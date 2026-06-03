import { describe, expect, test } from "bun:test";
import { runHarnessAudit } from "./run-harness-audit";
import type { ToolEvidence } from "../policy/evidence-tracker";

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
  test("combines verification evidence warning and completion audit", () => {
    const result = runHarnessAudit({
      finalText: "修复完成。",
      evidences: [evidence({ toolName: "edit" })],
      verificationContext: { afterModification: true },
    });

    expect(result.action).toBe("warn");
    expect(result.issues.some((issue) => issue.id === "modified_without_verification")).toBe(true);
    expect(result.issues.some((issue) => issue.id === "modification_without_verification")).toBe(true);
    expect(result.injectedMessage).toContain("完成前审计");
  });

  test("blocks unsupported test pass claim", () => {
    const result = runHarnessAudit({
      finalText: "已完成，测试通过。",
      evidences: [evidence({ toolName: "edit" })],
      verificationContext: { afterModification: true },
    });

    expect(result.action).toBe("block");
    expect(result.issues.some((issue) => issue.id === "test_pass_without_evidence")).toBe(true);
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
});
