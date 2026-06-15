import { describe, expect, test } from "bun:test";
import { auditCompletion } from "./completion-auditor";
import { toCompletionEvidenceSummary, toVerificationEvidenceState } from "./evidence-adapter";
import type { ToolEvidence } from "../policy/tool-evidence-types";

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

  test("maps context-mode code and output to verification kinds", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_execute",
        args: {
          code: "const { spawnSync } = require('child_process'); spawnSync('bun', ['test']); spawnSync('bun', ['run', 'typecheck']); spawnSync('git', ['diff', '--check']);",
        },
        result: "targeted-tests: exit=0; 75 pass 0 fail\ntypecheck: exit=0; $ tsc --noEmit\ndiff-check: exit=0",
        success: true,
      }),
    ]);

    expect(summary.kinds).toContain("verification");
    expect(summary.kinds).toContain("test_success");
    expect(summary.kinds).toContain("typecheck_success");
  });

  test("maps context-mode commands arrays to verification kinds", () => {
    const stringArraySummary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_batch_execute",
        args: { commands: ["bun test", "bun run typecheck"] },
        result: "targeted-tests: exit=0; 3 pass 0 fail\ntypecheck: exit=0",
        success: true,
      }),
    ]);
    expect(stringArraySummary.kinds).toContain("test_success");
    expect(stringArraySummary.kinds).toContain("typecheck_success");

    const objectArraySummary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_batch_execute",
        args: {
          commands: [
            { command: "git diff --check" },
            { command: "npm run lint" },
          ],
        },
        result: "diff-check: exit=0\nlint: exit=0",
        success: true,
      }),
    ]);
    expect(objectArraySummary.kinds).toContain("verification");
    expect(objectArraySummary.kinds).toContain("lint_success");
  });

  test("requires explicit test exit summary for output-derived test success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "script_runner",
        args: { code: "run tests" },
        result: "75 pass 0 fail",
        success: true,
      }),
    ]);

    expect(summary.kinds).not.toContain("test_success");
    expect(summary.kinds).not.toContain("verification");
  });

  test("does not infer wrapper command success without explicit summaries", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "script_runner",
        args: { commands: ["bun test", "bun run typecheck", "npm run lint"] },
        result: "commands completed",
        success: true,
      }),
    ]);

    expect(summary.kinds).not.toContain("verification");
    expect(summary.kinds).not.toContain("test_success");
    expect(summary.kinds).not.toContain("typecheck_success");
    expect(summary.kinds).not.toContain("lint_success");
  });

  test("does not infer typecheck success from command echo when exit summary failed", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "spawnSync('bun', ['run', 'typecheck'])" },
        result: "typecheck: exit=1; $ tsc --noEmit\nerror TS2322",
        success: true,
      }),
    ]);

    expect(summary.kinds).not.toContain("typecheck_success");
    expect(summary.kinds).not.toContain("verification");
  });

  test("does not infer verification success from failed context-mode summaries", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "spawnSync('bun', ['test']); spawnSync('bun', ['run', 'typecheck']);" },
        result: "targeted-tests: exit=1; 3 pass 1 fail\ntypecheck: exit=1\nlint: exit=1",
        success: true,
      }),
    ]);

    expect(summary.kinds).not.toContain("test_success");
    expect(summary.kinds).not.toContain("typecheck_success");
    expect(summary.kinds).not.toContain("lint_success");
    expect(summary.kinds).not.toContain("verification");
    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("test_failure");
    expect(summary.kinds).toContain("typecheck_failure");
    expect(summary.kinds).toContain("lint_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("maps args.commands test failure output to failure and blocks command success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_batch_execute",
        args: { commands: ["bun test"] },
        result: "targeted-tests: exit=1; 3 pass 1 fail",
        success: true,
      }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("test_failure");
    expect(summary.kinds).not.toContain("test_success");
    expect(summary.failedToolCount).toBe(1);
  });

  test("maps args.commands typecheck failure output to failure and blocks command success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_batch_execute",
        args: { commands: ["bun run typecheck"] },
        result: "typecheck: exit=1; $ tsc --noEmit\nerror TS2322",
        success: true,
      }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("typecheck_failure");
    expect(summary.kinds).not.toContain("typecheck_success");
    expect(summary.failedToolCount).toBe(1);
  });

  test("maps args.commands lint failure output to failure and blocks command success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_batch_execute",
        args: { commands: ["npm run lint"] },
        result: "lint: exit=1\n1 problem",
        success: true,
      }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("lint_failure");
    expect(summary.kinds).not.toContain("lint_success");
    expect(summary.failedToolCount).toBe(1);
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

  test("uses command semantics to treat piped grep exit code 1 as success", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "cat file.txt | grep pattern" }, success: false, exitCode: 1 }),
    ]);

    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(0);
  });

  test("keeps quoted fake pipeline as tool failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "bash", args: { command: "python -c \"print('| grep pattern')\"" }, success: false, exitCode: 1 }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.failedToolCount).toBe(1);
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

  test("allows completion auditor after modification plus context-mode verification", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({ toolName: "edit", timestamp: 1 }),
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "spawnSync('bun', ['test']); spawnSync('bun', ['run', 'typecheck']);" },
        result: "targeted-tests: exit=0; 51 pass 0 fail\ntypecheck: exit=0; $ tsc --noEmit",
        success: true,
        timestamp: 2,
      }),
    ]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(decision.issues.map((issue) => issue.id)).not.toContain("modification_without_verification");
  });

  test("downgrades context-mode wait timeout infrastructure failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "sleep 60; echo waited" },
        result: "MCP error -32001: Request timed out",
        success: false,
        timestamp: 1,
      }),
    ]);

    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(0);
  });

  test("preserves real verification failure summaries before timeout downgrade", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "script_runner",
        args: { code: "sleep 60; run checks" },
        result: "Request timed out\ntargeted-tests: exit=1\ntypecheck: exit=1\nlint: exit=1",
        success: false,
        timestamp: 1,
      }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.kinds).toContain("test_failure");
    expect(summary.kinds).toContain("typecheck_failure");
    expect(summary.kinds).toContain("lint_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("does not downgrade compound sleep command timeout as infrastructure noise", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "script_runner",
        args: { code: "sleep 60; bun test" },
        result: "Request timed out",
        success: false,
        timestamp: 1,
      }),
    ]);

    expect(summary.kinds).toContain("tool_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("later verification success covers earlier ordinary tool failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "sleep 60; echo waited" },
        result: "Request timed out",
        success: false,
        timestamp: 1,
      }),
      evidence({
        toolName: "context_mode_ctx_execute",
        args: { code: "spawnSync('bun', ['test'])" },
        result: "targeted-tests: exit=0; 10 pass 0 fail",
        success: true,
        timestamp: 2,
      }),
    ]);

    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(0);
  });

  test("non-corresponding verification success does not clear test failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "bash",
        args: { command: "npm test" },
        success: false,
        timestamp: 1,
      }),
      evidence({
        toolName: "bash",
        args: { command: "bun run typecheck" },
        success: true,
        timestamp: 2,
      }),
    ]);

    expect(summary.kinds).toContain("test_failure");
    expect(summary.kinds).toContain("typecheck_success");
    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("non-corresponding verification success does not clear typecheck failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "bash",
        args: { command: "bun run typecheck" },
        success: false,
        timestamp: 1,
      }),
      evidence({
        toolName: "bash",
        args: { command: "bun test" },
        success: true,
        timestamp: 2,
      }),
    ]);

    expect(summary.kinds).toContain("typecheck_failure");
    expect(summary.kinds).toContain("test_success");
    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(1);
  });

  test("corresponding later success clears matching verification failure", () => {
    const summary = toCompletionEvidenceSummary([
      evidence({
        toolName: "bash",
        args: { command: "npm test" },
        success: false,
        timestamp: 1,
      }),
      evidence({
        toolName: "bash",
        args: { command: "bun test" },
        success: true,
        timestamp: 2,
      }),
    ]);

    expect(summary.kinds).not.toContain("test_failure");
    expect(summary.kinds).toContain("test_success");
    expect(summary.kinds).not.toContain("tool_failure");
    expect(summary.failedToolCount).toBe(0);
  });
});
