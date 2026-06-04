import { describe, expect, test } from "bun:test";
import { createEvidenceSessionStore } from "./evidence-session-store";
import type { StructuredToolResult } from "./tool-result-normalizer";

function evidence(partial: Partial<StructuredToolResult> = {}): StructuredToolResult {
  return {
    toolName: partial.toolName ?? "bash",
    toolCallId: partial.toolCallId ?? "call-1",
    rawInput: partial.rawInput ?? { command: "bun test" },
    rawResponse: partial.rawResponse ?? [{ type: "text", text: "ok" }],
    timestamp: partial.timestamp ?? 1000,
    success: partial.success ?? true,
    exitCode: partial.exitCode,
    semantic: partial.semantic,
    sessionArtifactRef: partial.sessionArtifactRef,
  };
}

describe("evidence-session-store", () => {
  test("records and snapshots evidence per session", () => {
    const store = createEvidenceSessionStore();
    store.recordEvidence(evidence({
      toolCallId: "a",
      sessionArtifactRef: { kind: "session_file", sessionId: "s1", path: "/tmp/session.json" },
    }));
    store.recordEvidence(evidence({
      toolCallId: "b",
      sessionArtifactRef: { kind: "session_entries", sessionId: "s2" },
    }));

    const snapshot = store.getEvidenceSnapshot("s1");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.toolCallId).toBe("a");
    expect(snapshot[0]?.args).toEqual({ command: "bun test" });
  });

  test("preserves success and exit code from structured tool result", () => {
    const store = createEvidenceSessionStore();
    store.recordEvidence(evidence({
      success: false,
      exitCode: 2,
      semantic: "error",
      sessionArtifactRef: { kind: "session_entries", sessionId: "s1" },
    }));

    const snapshot = store.getEvidenceSnapshot("s1");
    expect(snapshot[0]?.success).toBe(false);
    expect(snapshot[0]?.exitCode).toBe(2);
  });

  test("reset session evidence removes only that session", () => {
    const store = createEvidenceSessionStore();
    store.recordEvidence(evidence({ toolCallId: "a", sessionArtifactRef: { kind: "session_entries", sessionId: "s1" } }));
    store.recordEvidence(evidence({ toolCallId: "b", sessionArtifactRef: { kind: "session_entries", sessionId: "s2" } }));

    store.resetEvidence("session", "s1");

    expect(store.getEvidenceSnapshot("s1")).toHaveLength(0);
    expect(store.getEvidenceSnapshot("s2")).toHaveLength(1);
  });

  test("records verifier verdict evidence per session", () => {
    const store = createEvidenceSessionStore();
    store.recordVerifierVerdict("s1", {
      source: "subagent",
      verdict: "PASS",
      summary: "verified",
      rawText: "VERDICT: PASS",
      parsed: {
        verdict: "PASS",
        checkBlocks: [],
        hasCommandRun: false,
        hasOutputObserved: false,
      },
      timestamp: 123,
    });

    expect(store.getVerifierVerdicts("s1")).toHaveLength(1);
    expect(store.getVerifierVerdicts("s2")).toHaveLength(0);
  });

  test("reconstructs minimal evidence from tool result-like entries", () => {
    const store = createEvidenceSessionStore();
    const reconstructed = store.reconstructFromSessionEntries([
      {
        timestamp: 123,
        event: {
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "grep x file" },
          content: [{ type: "text", text: "No matches found" }],
          isError: false,
          exitCode: 1,
        },
      },
      { role: "assistant", content: [] },
    ]);

    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({
      toolName: "bash",
      toolCallId: "call-1",
      args: { command: "grep x file" },
      success: true,
      exitCode: 1,
    });
  });
});
