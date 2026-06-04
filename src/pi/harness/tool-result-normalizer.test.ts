import { describe, expect, test } from "bun:test";
import { normalizeToolResult, type ToolResultNormalizeInput, type StructuredToolResult } from "./tool-result-normalizer";

describe("tool-result-normalizer", () => {
  function input(partial: Partial<ToolResultNormalizeInput>): ToolResultNormalizeInput {
    return {
      toolName: partial.toolName ?? "bash",
      toolCallId: partial.toolCallId ?? "call-1",
      rawInput: partial.rawInput ?? {},
      modelFacingContent: partial.modelFacingContent ?? { type: "text", text: "(no output)\nCommand exited with code 1" },
      isError: partial.isError ?? true,
      exitCode: partial.exitCode ?? 1,
      sessionArtifactRef: partial.sessionArtifactRef,
    };
  }

  test("normalizes bash tool result with exit code", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "grep pattern file.txt" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(true); // grep exit 1 = no_matches, not error
    expect(result.evidence.semantic).toBe("no_matches");
    expect(result.messageModified).toBe(true);
    expect(result.modelFacingMessage).toEqual({ type: "text", text: "No matches found" });
  });

  test("preserves original message when there's actual output", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "grep pattern file.txt" },
      modelFacingContent: { type: "text", text: "found: line1\nline2" },
      exitCode: 0,
      isError: false,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.messageModified).toBe(false);
    expect(result.modelFacingMessage).toEqual({ type: "text", text: "found: line1\nline2" });
  });

  test("treats grep exit 2 as error", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "grep pattern /nonexistent" },
      exitCode: 2,
    }));

    expect(result.evidence.success).toBe(false);
    expect(result.evidence.semantic).toBe("error");
  });

  test("handles rg (ripgrep) same as grep", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "rg pattern src/" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBe("no_matches");
  });

  test("handles find exit 1 as partial_success", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "find / -name file" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBe("partial_success");
  });

  test("handles diff exit 1 as files_differ", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "diff file1.txt file2.txt" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBe("files_differ");
  });

  test("handles unknown commands exit != 0 as error", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "git status" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(false);
    expect(result.evidence.semantic).toBe("error");
  });

  test("handles unknown commands exit 0 as success", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "git status" },
      exitCode: 0,
      isError: false,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBeUndefined();
  });

  test("includes session artifact ref in evidence", () => {
    const result = normalizeToolResult(input({
      sessionArtifactRef: { kind: "session_file", sessionId: "sess-123", path: "/path/to/session.json" },
    }));

    expect(result.evidence.sessionArtifactRef).toEqual({
      kind: "session_file",
      sessionId: "sess-123",
      path: "/path/to/session.json",
    });
  });

  test("handles non-bash tools", () => {
    const result = normalizeToolResult(input({
      toolName: "read",
      rawInput: { path: "/file.txt" },
      modelFacingContent: { type: "text", text: "file contents" },
      isError: false,
      exitCode: undefined,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBeUndefined();
    expect(result.messageModified).toBe(false);
  });

  test("extracts text from array content", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "grep pattern file.txt" },
      modelFacingContent: [
        { type: "text", text: "(no output)" },
        { type: "text", text: "Command exited with code 1" },
      ],
      exitCode: 1,
    }));

    expect(result.messageModified).toBe(true);
    expect(result.modelFacingMessage).toEqual({ type: "text", text: "No matches found" });
  });

  test("preserves message when diff has actual output", () => {
    const result = normalizeToolResult(input({
      rawInput: { command: "diff file1.txt file2.txt" },
      modelFacingContent: { type: "text", text: "2c2\n< old\n---\n> new\n" },
      exitCode: 1,
    }));

    expect(result.evidence.success).toBe(true);
    expect(result.evidence.semantic).toBe("files_differ");
    expect(result.messageModified).toBe(false); // 有实际输出，不替换
    expect(result.modelFacingMessage).toEqual({ type: "text", text: "2c2\n< old\n---\n> new\n" });
  });
});