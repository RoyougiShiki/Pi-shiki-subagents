import { describe, expect, test } from "bun:test";
import { toCompletionEvidenceSummary, toVerificationEvidenceState } from "./evidence-adapter";
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

describe("evidence adapter", () => {
  test("maps edit/write evidence to modification", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "edit" }),
      evidence({ toolName: "write" }),
    ]);

    expect(summary.kinds).toContain("modification");
    expect(summary.modifiedFileCount).toBe(2);
  });

  test("maps successful test command to verification and test_success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "bun test" }, success: true }),
    ]);

    expect(summary.kinds).toContain("verification");
    expect(summary.kinds).toContain("test_success");
  });

  test("maps failed commands to failure kinds", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "npm test" }, success: false }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("test_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("creates verification evidence state", () => {
    const state = toVerificationEvidenceState({
      kinds: ["modification", "test_success"],
      pendingSubagentCount: 0,
    });

    expect(state.hasModify).toBe(true);
    expect(state.hasVerification).toBe(true);
    expect(state.hasFailure).toBe(false);
  });
});
