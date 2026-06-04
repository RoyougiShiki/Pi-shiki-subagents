import { describe, expect, test } from "bun:test";
import { updateTaskStateFromToolResult } from "./verification-nudge-runtime";

const initialTasks = [
  { id: "1", content: "implement", status: "in_progress" as const },
  { id: "2", content: "docs", status: "pending" as const },
];

describe("verification-nudge-runtime", () => {
  test("tracks todo update status changes", () => {
    const result = updateTaskStateFromToolResult(initialTasks, {
      toolName: "todo",
      rawInput: { action: "update", id: 1, status: "completed" },
    });

    expect(result.changed).toBe(true);
    expect(result.tasks[0]).toMatchObject({ id: "1", content: "implement", status: "completed" });
  });

  test("tracks todo create", () => {
    const result = updateTaskStateFromToolResult([], {
      toolName: "todo",
      rawInput: { action: "create", id: "3", subject: "verify tests", status: "pending" },
    });

    expect(result.changed).toBe(true);
    expect(result.tasks).toEqual([{ id: "3", content: "verify tests", status: "pending" }]);
  });

  test("ignores non-task tools", () => {
    const result = updateTaskStateFromToolResult(initialTasks, {
      toolName: "bash",
      rawInput: { command: "echo ok" },
    });

    expect(result.changed).toBe(false);
    expect(result.tasks).toEqual(initialTasks);
  });

  test("can recover id from tool result content", () => {
    const result = updateTaskStateFromToolResult([], {
      toolName: "todo",
      rawInput: { action: "create", subject: "task" },
      contentText: "Created #12: task",
    });

    expect(result.changed).toBe(true);
    expect(result.tasks[0]?.id).toBe("12");
  });
});
