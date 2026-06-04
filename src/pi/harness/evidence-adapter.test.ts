import { describe, expect, test } from "bun:test";
import { auditCompletion } from "./completion-auditor";
import { toCompletionEvidenceSummary, toVerificationEvidenceState } from "./evidence-adapter";
import { interpretCommandSemantic } from "../policy/command-semantics";
import type { ToolEvidence } from "../policy/evidence-tracker";

function evidence(partial: Partial<ToolEvidence>): ToolEvidence {
  return {
    toolName: partial.toolName ?? "bash",
    toolCallId: partial.toolCallId ?? "call-1",
    args: partial.args ?? {},
    result: partial.result,
    timestamp: partial.timestamp ?? 1,
    success: partial.success ?? true,
    exitCode: partial.exitCode,
  };
}

function expectNoVerification(command: string): void {
  const summary = toCompletionEvidenceSummary([
    evidence({ toolName: "bash", args: { command }, success: true }),
  ]);

  expect(summary.kinds).not.toContain("verification");
  expect(summary.kinds).not.toContain("test_success");
  expect(summary.kinds).not.toContain("lint_success");
  expect(summary.kinds).not.toContain("typecheck_success");
}

function expectVerification(command: string, kind: "test_success" | "lint_success" | "typecheck_success"): void {
  const summary = toCompletionEvidenceSummary([
    evidence({ toolName: "bash", args: { command }, success: true }),
  ]);

  expect(summary.kinds).toContain("verification");
  expect(summary.kinds).toContain(kind);
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

  test("does not treat ordinary successful bash commands as verification", () => {
    expectNoVerification("git status --short");
    expectNoVerification("grep -R DEFAULT_VERIFICATION_TOOLS src");
    expectNoVerification("echo done");
    expectNoVerification("ls src/pi/harness");
  });

  test("maps successful verification commands to verification kinds", () => {
    expectVerification("bun test", "test_success");
    expectVerification("bun run typecheck", "typecheck_success");
    expectVerification("npm run lint", "lint_success");
    expectVerification("pnpm test", "test_success");
    expectVerification("tsc --noEmit", "typecheck_success");
  });

  test("keeps explicit verification tool names as configurable verification evidence", () => {
    const summary = toCompletionEvidenceSummary(
      [evidence({ toolName: "verification_agent", success: true })],
      { verificationToolNames: ["verification_agent"] },
    );

    expect(summary.kinds).toContain("verification");
  });

  test("maps failed verification commands to failure kinds without verification success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "npm test" }, success: false }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("test_failure");
    expect(summary.kinds).not.toContain("verification");
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

  test("keeps completion auditor warning after modification plus ordinary bash", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "edit" }),
      evidence({ toolName: "bash", args: { command: "git status --short" }, success: true }),
    ]);

    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(decision.action).toBe("warn");
    expect(decision.issues.map((issue) => issue.id)).toContain("modification_without_verification");
  });

  test("uses command semantics to treat grep exit code 1 as success, not tool_failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "grep pattern file.txt" }, success: false, exitCode: 1 }),
    ]);

    // grep exit code 1 = no matches, not error
    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(0);
  });

  test("still treats grep exit code 2 as tool_failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "grep pattern /nonexistent" }, success: false, exitCode: 2 }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("uses command semantics to treat find exit code 1 as success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "find / -name file" }, success: false, exitCode: 1 }),
    ]);

    expect(summary.kinds).not.toContain("tool_failure");
  });

  test("keeps completion auditor warning after modification plus grep no matches", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "edit" }),
      evidence({ toolName: "bash", args: { command: "grep pattern missing_file" }, success: false, exitCode: 1 }),
    ]);

    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    // grep exit 1 is not error, so no tool_failure warning
    // but still modification without verification
    expect(decision.issues.map((issue) => issue.id)).toContain("modification_without_verification");
    expect(decision.issues.map((issue) => issue.id)).not.toContain("completion_after_failure_without_acknowledgement");
  });

  test("allows completion auditor after modification plus verification command", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "edit" }),
      evidence({ toolName: "bash", args: { command: "bun test" }, success: true }),
    ]);

    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(decision.issues.map((issue) => issue.id)).not.toContain("modification_without_verification");
  });
});
