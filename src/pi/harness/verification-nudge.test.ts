import { describe, expect, test } from "bun:test";
import {
  detectVerificationNudge,
  getDefaultNudgeMessage,
  formatNudgeMessage,
  DEFAULT_THRESHOLD,
  DEFAULT_VERIFICATION_STEP_PATTERN,
} from "./verification-nudge";
import type { TaskItem } from "./verification-nudge";

function task(content: string, status: TaskItem["status"] = "completed"): TaskItem {
  return { content, status };
}

describe("verification nudge", () => {
  test("does not nudge when closing fewer than threshold tasks", () => {
    const oldTasks = [task("task 1", "in_progress"), task("task 2", "pending")];
    const newTasks = [task("task 1", "completed"), task("task 2", "pending")];

    const result = detectVerificationNudge(oldTasks, newTasks);

    expect(result.needed).toBe(false);
    expect(result.closedCount).toBe(1);
  });

  test("nudges when closing threshold or more tasks without verification step", () => {
    const oldTasks = [
      task("task 1", "in_progress"),
      task("task 2", "in_progress"),
      task("task 3", "in_progress"),
    ];
    const newTasks = [
      task("task 1", "completed"),
      task("task 2", "completed"),
      task("task 3", "completed"),
    ];

    const result = detectVerificationNudge(oldTasks, newTasks);

    expect(result.needed).toBe(true);
    expect(result.closedCount).toBe(3);
    expect(result.hasVerificationStep).toBe(false);
    expect(result.reason).toContain("3 tasks");
  });

  test("does not nudge when there is a verification step", () => {
    const oldTasks = [
      task("implement feature", "in_progress"),
      task("verify tests pass", "in_progress"),
      task("update docs", "in_progress"),
    ];
    const newTasks = [
      task("implement feature", "completed"),
      task("verify tests pass", "completed"),
      task("update docs", "completed"),
    ];

    const result = detectVerificationNudge(oldTasks, newTasks);

    expect(result.needed).toBe(false);
    expect(result.hasVerificationStep).toBe(true);
  });

  test("default verification step pattern is intentionally narrow", () => {
    const oldTasks = [
      task("write unit tests", "in_progress"),
      task("check error handling", "in_progress"),
      task("lint cleanup", "in_progress"),
    ];
    const newTasks = [
      task("write unit tests", "completed"),
      task("check error handling", "completed"),
      task("lint cleanup", "completed"),
    ];

    const result = detectVerificationNudge(oldTasks, newTasks);
    expect(result.hasVerificationStep).toBe(false);
    expect(result.needed).toBe(true);
  });

  test("supports broader verification step patterns via config", () => {
    const oldTasks = [task("run tests", "in_progress"), task("other", "in_progress"), task("more", "in_progress")];
    const newTasks = [task("run tests", "completed"), task("other", "completed"), task("more", "completed")];

    const result = detectVerificationNudge(oldTasks, newTasks, { verificationStepPattern: /test/i });
    expect(result.hasVerificationStep).toBe(true);
    expect(result.needed).toBe(false);
  });

  test("nudges when all tasks are completed", () => {
    const oldTasks = [
      task("task 1", "in_progress"),
      task("task 2", "in_progress"),
      task("task 3", "pending"),
    ];
    const newTasks = [
      task("task 1", "completed"),
      task("task 2", "completed"),
      task("task 3", "completed"),
    ];

    const result = detectVerificationNudge(oldTasks, newTasks);

    expect(result.needed).toBe(true);
    expect(result.closedCount).toBe(3);
  });

  test("does not nudge when disabled", () => {
    const oldTasks = [
      task("task 1", "in_progress"),
      task("task 2", "in_progress"),
      task("task 3", "in_progress"),
    ];
    const newTasks = [
      task("task 1", "completed"),
      task("task 2", "completed"),
      task("task 3", "completed"),
    ];

    const result = detectVerificationNudge(oldTasks, newTasks, { enabled: false });

    expect(result.needed).toBe(false);
  });

  test("respects custom threshold", () => {
    const oldTasks = [task("task 1", "in_progress"), task("task 2", "in_progress")];
    const newTasks = [task("task 1", "completed"), task("task 2", "completed")];

    const result = detectVerificationNudge(oldTasks, newTasks, { threshold: 2 });

    expect(result.needed).toBe(true);
    expect(result.closedCount).toBe(2);
  });

  test("getDefaultNudgeMessage returns non-empty string", () => {
    const msg = getDefaultNudgeMessage();
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain("verification");
  });

  test("formatNudgeMessage replaces count placeholder", () => {
    const msg = formatNudgeMessage(5);
    expect(msg).toContain("5+");
    expect(msg).not.toContain("3+");
  });

  test("formatNudgeMessage uses custom message", () => {
    const custom = "Custom nudge for {count} tasks";
    const msg = formatNudgeMessage(4, custom);
    expect(msg).toBe(custom);
  });

  test("handles empty task lists", () => {
    const result = detectVerificationNudge([], []);
    expect(result.needed).toBe(false);
    expect(result.closedCount).toBe(0);
  });

  test("DEFAULT_THRESHOLD is 3", () => {
    expect(DEFAULT_THRESHOLD).toBe(3);
  });

  test("DEFAULT_VERIFICATION_STEP_PATTERN matches only verification wording", () => {
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("verify")).toBe(true);
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("verification")).toBe(true);
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("test")).toBe(false);
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("lint")).toBe(false);
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("check")).toBe(false);
    expect(DEFAULT_VERIFICATION_STEP_PATTERN.test("implement")).toBe(false);
  });
});