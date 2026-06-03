import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  applyToolResultBudget,
  shouldPersistToolResult,
  summarizeCommandOutput,
  applyPerMessageBudget,
  createToolResultBudgetState,
  isSeenId,
  getReplacement,
  recordReplacement,
  partitionCandidates,
  type ToolResultBudgetState,
  type ToolResultReplacementRecord,
} from "./index";

describe("tool result budget", () => {
  test("keeps small output", async () => {
    const state = createToolResultBudgetState();
    const result = await applyToolResultBudget(
      { toolName: "bash", toolCallId: "call-1", content: "small" },
      { state },
    );
    expect(result.action).toBe("keep");
    expect(result.content).toBe("small");
  });

  test("detects output above per-tool threshold", () => {
    expect(
      shouldPersistToolResult(
        { toolName: "bash", toolCallId: "call-1", content: "123456" },
        { byTool: { bash: 5 }, default: 10 },
      ),
    ).toBe(true);
  });

  test("persists large output and returns preview message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-tool-budget-"));
    try {
      const state = createToolResultBudgetState();
      const result = await applyToolResultBudget(
        { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
        {
          state,
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

      // 检查状态被记录
      expect(isSeenId(state, "call-1")).toBe(true);
      expect(getReplacement(state, "call-1")).toBe(result.content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reapplies existing replacement from state", async () => {
    const state = createToolResultBudgetState();

    // 预先记录替换
    recordReplacement(state, {
      kind: "tool-result",
      toolUseId: "call-1",
      toolName: "bash",
      originalSize: 100,
      replacement: "REPLACEMENT_CONTENT",
      filepath: "/tmp/test.txt",
      createdAt: 123,
    });

    // 再次处理相同的 tool call
    const result = await applyToolResultBudget(
      { toolName: "bash", toolCallId: "call-1", content: "original content" },
      { state },
    );

    expect(result.action).toBe("reapply");
    if (result.action !== "reapply") throw new Error("expected reapply");
    expect(result.content).toBe("REPLACEMENT_CONTENT");
  });

  test("keeps frozen content (seen but not replaced)", async () => {
    const state = createToolResultBudgetState();

    // 标记为已发送
    state.seenIds.add("call-1");

    const result = await applyToolResultBudget(
      { toolName: "bash", toolCallId: "call-1", content: "original content" },
      { state, thresholds: { default: 3 } },
    );

    // 已发送但未替换，应该保持原样（冻结）
    expect(result.action).toBe("keep");
    expect(result.content).toBe("original content");
  });

  test("uses custom persisted message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-tool-budget-"));
    try {
      const state = createToolResultBudgetState();
      const result = await applyToolResultBudget(
        { toolName: "bash", toolCallId: "call-1", content: "abcdef" },
        {
          state,
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

// ─── State Management Tests ────────────────────────────────────────────────

describe("tool result budget state", () => {
  test("creates empty state", () => {
    const state = createToolResultBudgetState();
    expect(state.seenIds.size).toBe(0);
    expect(state.replacements.size).toBe(0);
    expect(state.records.length).toBe(0);
  });

  test("marks seen id", () => {
    const state = createToolResultBudgetState();
    expect(isSeenId(state, "call-1")).toBe(false);
    state.seenIds.add("call-1");
    expect(isSeenId(state, "call-1")).toBe(true);
  });

  test("records and retrieves replacement", () => {
    const state = createToolResultBudgetState();
    const record: ToolResultReplacementRecord = {
      kind: "tool-result",
      toolUseId: "call-1",
      toolName: "bash",
      originalSize: 100,
      replacement: "REPLACED",
      filepath: "/tmp/test.txt",
      createdAt: 123,
    };

    recordReplacement(state, record);

    expect(getReplacement(state, "call-1")).toBe("REPLACED");
    expect(isSeenId(state, "call-1")).toBe(true);
    expect(state.records).toContainEqual(record);
  });

  test("partitions candidates", () => {
    const state = createToolResultBudgetState();

    // 预设状态
    recordReplacement(state, {
      kind: "tool-result",
      toolUseId: "call-1",
      toolName: "bash",
      originalSize: 100,
      replacement: "REPLACED_1",
      filepath: "/tmp/1.txt",
      createdAt: 123,
    });
    state.seenIds.add("call-2");

    const candidates = [
      { toolUseId: "call-1", toolName: "bash", size: 100, content: "content1" },
      { toolUseId: "call-2", toolName: "bash", size: 200, content: "content2" },
      { toolUseId: "call-3", toolName: "bash", size: 300, content: "content3" },
    ];

    const { mustReapply, frozen, fresh } = partitionCandidates(candidates, state);

    // call-1 有替换记录
    expect(mustReapply.length).toBe(1);
    expect(mustReapply[0]?.replacement).toBe("REPLACED_1");

    // call-2 已发送但无替换
    expect(frozen.length).toBe(1);
    expect(frozen[0]?.toolUseId).toBe("call-2");

    // call-3 是新的
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.toolUseId).toBe("call-3");
  });
});

// ─── Per-Message Budget Tests ───────────────────────────────────────────────

describe("per-message budget", () => {
  test("processes multiple inputs", async () => {
    const state = createToolResultBudgetState();
    const dir = await mkdtemp(join(tmpdir(), "omo-tool-budget-"));

    try {
      const inputs = [
        { toolName: "bash", toolCallId: "call-1", content: "a".repeat(60_000) },
        { toolName: "bash", toolCallId: "call-2", content: "b".repeat(60_000) },
        { toolName: "bash", toolCallId: "call-3", content: "c".repeat(60_000) },
        { toolName: "bash", toolCallId: "call-4", content: "d".repeat(60_000) },
      ];

      const result = await applyPerMessageBudget(inputs, {
        state,
        storage: { baseDir: dir, sessionId: "session-1" },
        thresholds: { default: 10_000 },
      });

      // 总量超过 200,000，应该触发替换
      expect(result.decisions.length).toBe(4);
      expect(result.freshSize).toBe(240_000);
      expect(result.newlyReplaced.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});