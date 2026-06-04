import type { ToolEvidence } from "../policy/evidence-tracker";
import type { SessionArtifactRef, StructuredToolResult } from "./tool-result-normalizer";

export interface EvidenceSessionStore {
  recordEvidence(input: StructuredToolResult): void;
  getEvidenceSnapshot(sessionId: string, options?: EvidenceSnapshotOptions): ToolEvidence[];
  reconstructFromSessionEntries(entries: readonly unknown[]): ToolEvidence[];
  resetEvidence(boundary: "session" | "turn", sessionId?: string): void;
}

export interface EvidenceSnapshotOptions {
  turnId?: string;
  taskId?: string;
  evidenceWindow?: "current_turn" | "current_task" | "current_session";
}

export interface EvidenceSessionStoreOptions {
  now?: () => number;
}

export interface SessionStoredToolEvidence extends ToolEvidence {
  sessionId: string;
  turnId?: string;
  taskId?: string;
  semantic?: string;
  sessionArtifactRef?: SessionArtifactRef;
}

function sessionIdFromArtifact(ref?: SessionArtifactRef): string {
  return ref?.sessionId ?? "default";
}

function toToolEvidence(input: StructuredToolResult): SessionStoredToolEvidence {
  return {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    args: input.rawInput,
    result: input.rawResponse,
    timestamp: input.timestamp,
    success: input.success,
    exitCode: input.exitCode,
    sessionId: sessionIdFromArtifact(input.sessionArtifactRef),
    semantic: input.semantic,
    sessionArtifactRef: input.sessionArtifactRef,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeToolResultEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return typeof value.toolName === "string" || typeof value.tool === "string" || typeof value.name === "string";
}

function reconstructOne(entry: unknown): ToolEvidence | undefined {
  if (!isRecord(entry)) return undefined;
  let event: Record<string, unknown> | undefined;
  if (looksLikeToolResultEvent(entry)) {
    event = entry;
  } else if (looksLikeToolResultEvent(entry["event"])) {
    event = entry["event"];
  } else if (looksLikeToolResultEvent(entry["data"])) {
    event = entry["data"];
  }
  if (!event) return undefined;

  const toolName = event.toolName ?? event.tool ?? event.name;
  if (typeof toolName !== "string") return undefined;

  const args = event.input ?? event.args ?? {};
  const result = event.content ?? event.result;
  const successValue = event.success;
  const isErrorValue = event.isError;
  const success = typeof successValue === "boolean"
    ? successValue
    : typeof isErrorValue === "boolean"
      ? !isErrorValue
      : true;

  return {
    toolName,
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
    args: isRecord(args) ? args : {},
    result,
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    success,
    exitCode: typeof event.exitCode === "number" ? event.exitCode : undefined,
  };
}

export function createEvidenceSessionStore(_options: EvidenceSessionStoreOptions = {}): EvidenceSessionStore {
  let evidences: SessionStoredToolEvidence[] = [];

  return {
    recordEvidence(input: StructuredToolResult): void {
      evidences.push(toToolEvidence(input));
    },

    getEvidenceSnapshot(sessionId: string, options: EvidenceSnapshotOptions = {}): ToolEvidence[] {
      const window = options.evidenceWindow ?? "current_session";
      let filtered = evidences.filter((evidence) => evidence.sessionId === sessionId);

      if (window === "current_turn" && options.turnId) {
        filtered = filtered.filter((evidence) => evidence.turnId === options.turnId);
      } else if (window === "current_task" && options.taskId) {
        filtered = filtered.filter((evidence) => evidence.taskId === options.taskId);
      }

      return filtered.map(({ sessionId: _sessionId, turnId: _turnId, taskId: _taskId, semantic: _semantic, sessionArtifactRef: _ref, ...evidence }) => ({ ...evidence }));
    },

    reconstructFromSessionEntries(entries: readonly unknown[]): ToolEvidence[] {
      const reconstructed: ToolEvidence[] = [];
      for (const entry of entries) {
        const evidence = reconstructOne(entry);
        if (evidence) reconstructed.push(evidence);
      }
      return reconstructed;
    },

    resetEvidence(boundary: "session" | "turn", sessionId?: string): void {
      if (boundary === "session") {
        evidences = sessionId
          ? evidences.filter((evidence) => evidence.sessionId !== sessionId)
          : [];
        return;
      }

      const targetSessionId = sessionId;
      evidences = evidences.filter((evidence) => {
        if (targetSessionId && evidence.sessionId !== targetSessionId) return true;
        return evidence.turnId === undefined;
      });
    },
  };
}
