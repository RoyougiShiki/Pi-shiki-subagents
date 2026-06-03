import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { applyToolResultBudget, shouldPersistToolResult, summarizeCommandOutput } from "./tool-result-budget";

describe("tool result budget", () => {
  test("keeps small output", async () => {
    const result = await applyToolResultBudget({ toolName: "bash", toolCallId: "call-1", content: "small" });
    expect(result.action).toBe("keep");
    expect(result.content).toBe("small");
  });

  test("detects output above per-tool threshold", () => {
    expect(
      shouldPersistToolResult(
        { toolName: "bash", toolCallId: "call-1", content: "123456" },
        { default: 10, byTool: { bash: 5 } },
      ),
    ).toBe(true);
  });

  test("persists large output and returns preview message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-tool-budget-"));
    try {
      const result = await applyToolResultBudget(
        { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
        {
          thresholds: { default: 3 },
          previewChars: 2,
          storage: { baseDir: dir, sessionId: "session-1" },
          now: () => 123,
        },
      );

      expect(result.action).toBe("persist");
      if (result.action !== "persist") throw new Error("expected persist");
      expect(result.ref.originalSize).toBe(6);
      expect(result.ref.preview).toBe("ab");
      expect(result.ref.hasMore).toBe(true);
      expect(result.ref.createdAt).toBe(123);
      expect(result.content).toContain("<persisted-output>");
      expect(await readFile(result.ref.filepath, "utf8")).toBe("abcdef");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses custom persisted message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-tool-budget-"));
    try {
      const result = await applyToolResultBudget(
        { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
        {
          thresholds: { default: 3 },
          storage: { baseDir: dir, sessionId: "session-1" },
          messages: {
            completionAuditor: {
              testPassWithoutEvidence: "",
              lintPassWithoutEvidence: "",
              typecheckPassWithoutEvidence: "",
              completionWithPendingSubagent: "",
              completionWithPendingTasks: "",
              completionAfterFailureWithoutAcknowledgement: "",
              modificationWithoutVerification: "",
              injectedHeader: "",
            },
            toolResultBudget: {
              persistedOutput: () => "CUSTOM_PERSISTED",
              clearedOutput: () => "CUSTOM_CLEARED",
            },
          },
        },
      );

      expect(result.content).toBe("CUSTOM_PERSISTED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("summarizes command failure and error lines", () => {
    const result = summarizeCommandOutput("one\nFAILED foo\nError: bad\nexit code: 1");
    expect(result.exitCode).toBe(1);
    expect(result.failedLines).toContain("FAILED foo");
    expect(result.errorLines).toContain("Error: bad");
  });
});
