import type { ToolEvidence } from "../policy/tool-evidence-types";
import type { VerifierVerdictEvidence } from "./verifier-verdict-evidence";
import type { SessionArtifactRef, StructuredToolResult } from "./tool-result-normalizer";

export interface EvidenceSessionStore {
  recordEvidence(input: StructuredToolResult): void;
  recordVerifierVerdict(sessionId: string, evidence: VerifierVerdictEvidence): void;
  hydrateVerifierVerdicts(sessionId: string, evidences: readonly VerifierVerdictEvidence[]): void;
  getEvidenceSnapshot(sessionId: string, options?: EvidenceSnapshotOptions): ToolEvidence[];
  getVerifierVerdicts(sessionId: string): VerifierVerdictEvidence[];
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

function verifierVerdictKey(evidence: VerifierVerdictEvidence): string {
  return [evidence.timestamp, evidence.source, evidence.verdict, evidence.verifier ?? "", evidence.summary].join("\u0000");
}

function mergeVerifierVerdicts(
  current: readonly VerifierVerdictEvidence[],
  incoming: readonly VerifierVerdictEvidence[],
): VerifierVerdictEvidence[] {
  const byKey = new Map<string, VerifierVerdictEvidence>();
  for (const evidence of current) byKey.set(verifierVerdictKey(evidence), evidence);
  for (const evidence of incoming) byKey.set(verifierVerdictKey(evidence), evidence);
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function createEvidenceSessionStore(_options: EvidenceSessionStoreOptions = {}): EvidenceSessionStore {
  let evidences: SessionStoredToolEvidence[] = [];
  let verifierVerdicts = new Map<string, VerifierVerdictEvidence[]>();

  return {
    recordEvidence(input: StructuredToolResult): void {
      evidences.push(toToolEvidence(input));
    },

    recordVerifierVerdict(sessionId: string, evidence: VerifierVerdictEvidence): void {
      const current = verifierVerdicts.get(sessionId) ?? [];
      verifierVerdicts.set(sessionId, [...current, evidence]);
    },

    hydrateVerifierVerdicts(sessionId: string, evidences: readonly VerifierVerdictEvidence[]): void {
      const current = verifierVerdicts.get(sessionId) ?? [];
      verifierVerdicts.set(sessionId, mergeVerifierVerdicts(current, evidences));
    },

    getVerifierVerdicts(sessionId: string): VerifierVerdictEvidence[] {
      return [...(verifierVerdicts.get(sessionId) ?? [])];
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
        if (sessionId) verifierVerdicts.delete(sessionId);
        else verifierVerdicts = new Map();
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
