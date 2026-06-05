import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { registerHarnessHooks } from "./register-harness-hooks";
import { resetEvidence } from "../policy/evidence-tracker";

type HookName = "turn_start" | "tool_result" | "message_end";
type HookMap = Partial<Record<HookName, Function[]>>;

function createPiMock() {
  const hooks: HookMap = {};
  return {
    hooks,
    pi: {
      on(name: HookName, handler: Function) {
        hooks[name] = [...(hooks[name] ?? []), handler];
      },
    },
  };
}

function createCtx(entries: unknown[] = [], sessionId = "s1") {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    notifications,
    ctx: {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => "/tmp/session.json",
        getEntries: () => entries,
      },
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
      },
    },
  };
}

describe("register-harness-hooks", () => {
  test("registers harness runtime hooks", () => {
    const { pi, hooks } = createPiMock();

    registerHarnessHooks(pi as any, {});

    expect(hooks.turn_start).toHaveLength(1);
    expect(hooks.tool_result).toHaveLength(1);
    expect(hooks.message_end).toHaveLength(1);
  });

  test("normalizes grep exit 1 through tool_result hook", async () => {
    resetEvidence();
    const { pi, hooks } = createPiMock();
    const { ctx } = createCtx();
    registerHarnessHooks(pi as any, {});

    const result = await hooks.tool_result?.[0]?.({
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "grep missing file.txt" },
      content: [{ type: "text", text: "(no output)\nCommand exited with code 1" }],
      isError: true,
      details: { ok: true },
    }, ctx as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "No matches found" }],
      details: { ok: true },
      isError: false,
    });
  });

  test("ingests pool verifier verdict and suppresses nudge", async () => {
    resetEvidence();
    const { pi, hooks } = createPiMock();
    const { ctx, notifications } = createCtx();
    const runtime = registerHarnessHooks(pi as any, {});

    runtime.ingestPoolCompleted({ agentName: "reviewer", response: "VERDICT: PASS" }, ctx as any);

    for (const id of [1, 2, 3]) {
      await hooks.tool_result?.[0]?.({
        toolName: "todo",
        toolCallId: `todo-${id}`,
        input: { action: "create", id, subject: `task ${id}`, status: "in_progress" },
        content: [{ type: "text", text: `Created #${id}` }],
        isError: false,
      }, ctx as any);
    }
    for (const id of [1, 2, 3]) {
      await hooks.tool_result?.[0]?.({
        toolName: "todo",
        toolCallId: `todo-${id}-done`,
        input: { action: "update", id, status: "completed" },
        content: [{ type: "text", text: `Updated #${id}` }],
        isError: false,
      }, ctx as any);
    }

    expect(notifications.some((item) => item.message.includes("verifier verdict captured: PASS"))).toBe(true);
    expect(notifications.some((item) => item.message.includes("closed out"))).toBe(false);
  });

  test("verifier FAIL is consumed by message_end audit", async () => {
    resetEvidence();
    const { pi, hooks } = createPiMock();
    const { ctx, notifications } = createCtx();
    const runtime = registerHarnessHooks(pi as any, {
      config: { completionAuditor: { enabled: true } },
    });

    await hooks.tool_result?.[0]?.({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "file.ts" },
      content: [{ type: "text", text: "edited" }],
      isError: false,
    }, ctx as any);
    runtime.ingestPoolCompleted({
      agentName: "reviewer",
      response: "VERDICT: FAIL\nRegression found.",
    }, ctx as any);
    await hooks.message_end?.[0]?.({
      message: { role: "assistant", content: [{ type: "text", text: "已完成" }] },
    }, ctx as any);

    expect(notifications.some((item) => item.message.includes("verifier verdict captured: FAIL"))).toBe(true);
    expect(notifications.some((item) => item.message.includes("verifier verdict 为 FAIL"))).toBe(true);
  });

  test("notifies when multiple tasks close without verifier verdict", async () => {
    resetEvidence();
    const { pi, hooks } = createPiMock();
    const { ctx, notifications } = createCtx();
    registerHarnessHooks(pi as any, {});

    for (const id of [1, 2, 3]) {
      await hooks.tool_result?.[0]?.({
        toolName: "todo",
        toolCallId: `todo-${id}`,
        input: { action: "create", id, subject: `task ${id}`, status: "in_progress" },
        content: [{ type: "text", text: `Created #${id}` }],
        isError: false,
      }, ctx as any);
    }
    let lastResult: any;
    for (const id of [1, 2, 3]) {
      lastResult = await hooks.tool_result?.[0]?.({
        toolName: "todo",
        toolCallId: `todo-${id}-done`,
        input: { action: "update", id, status: "completed" },
        content: [{ type: "text", text: `Updated #${id}` }],
        isError: false,
      }, ctx as any);
    }

    expect(notifications.some((item) => item.message.includes("closed out"))).toBe(true);
    expect(lastResult?.content?.some((part: any) => part.text?.includes("Before writing your final summary"))).toBe(true);
  });

  test("verifier PASS satisfies message_end audit after modification", async () => {
    resetEvidence();
    const { pi, hooks } = createPiMock();
    const { ctx, notifications } = createCtx();
    const runtime = registerHarnessHooks(pi as any, {
      config: { completionAuditor: { enabled: true } },
    });

    await hooks.tool_result?.[0]?.({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "file.ts" },
      content: [{ type: "text", text: "edited" }],
      isError: false,
    }, ctx as any);
    runtime.ingestPoolCompleted({
      agentName: "reviewer",
      response: "Command run: bun test\nOutput observed: pass\nResult: PASS\nVERDICT: PASS",
    }, ctx as any);
    await hooks.message_end?.[0]?.({
      message: { role: "assistant", content: [{ type: "text", text: "已完成，测试通过。" }] },
    }, ctx as any);

    expect(notifications.some((item) => item.message.includes("verifier verdict captured: PASS"))).toBe(true);
    expect(notifications.some((item) => item.message.includes("完成审计提醒"))).toBe(false);
  });

  test("reapplies persisted tool result budget state after hook reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omo-register-budget-"));
    try {
      const first = createPiMock();
      const firstCtx = createCtx([], "persisted-session").ctx;
      registerHarnessHooks(first.pi as any, {
        config: { toolResultBudget: { enabled: true, storageBaseDir: dir, thresholds: { default: 3 }, previewChars: 2 } },
      });

      const firstResult = await first.hooks.tool_result?.[0]?.({
        toolName: "bash",
        toolCallId: "call-large",
        input: { command: "printf abcdef" },
        content: [{ type: "text", text: "abcdef" }],
        isError: false,
      }, firstCtx as any);

      expect(firstResult?.content?.[0]?.text).toContain("Preview (first 2 chars)");
      expect(await readFile(join(dir, "persisted-session", ".budget-state.json"), "utf8")).toContain("call-large");

      const second = createPiMock();
      const secondCtx = createCtx([], "persisted-session").ctx;
      registerHarnessHooks(second.pi as any, {
        config: { toolResultBudget: { enabled: true, storageBaseDir: dir, thresholds: { default: 3 }, previewChars: 1 } },
      });

      const secondResult = await second.hooks.tool_result?.[0]?.({
        toolName: "bash",
        toolCallId: "call-large",
        input: { command: "printf abcdef" },
        content: [{ type: "text", text: "abcdef" }],
        isError: false,
      }, secondCtx as any);

      expect(secondResult?.content?.[0]?.text).toContain("Preview (first 2 chars)");
      expect(secondResult?.content?.[0]?.text).not.toContain("Preview (first 1 chars)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
