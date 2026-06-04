import type { VerifierVerdict, VerifierVerdictStatus } from "./verifier-verdict-parser";
import { parseVerifierVerdict } from "./verifier-verdict-parser";

export type VerifierVerdictEvidenceSource = "subagent" | "tool" | "flue_workflow" | "manual";

export interface VerifierVerdictEvidence {
  source: VerifierVerdictEvidenceSource;
  verdict: VerifierVerdictStatus;
  summary: string;
  verifier?: string;
  rawText: string;
  parsed: VerifierVerdict;
  timestamp: number;
}

export interface VerifierVerdictIngestionInput {
  text: string;
  source: VerifierVerdictEvidenceSource;
  verifier?: string;
  now?: () => number;
}

export interface VerifierVerdictIngestionResult {
  ingested: boolean;
  evidence?: VerifierVerdictEvidence;
  reason?: string;
}

function firstNonEmptyLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function summarizeVerdict(text: string, verdict: VerifierVerdict): string {
  const details = verdict.failDetails ?? verdict.partialDetails;
  if (details?.trim()) return details.trim();
  const firstLine = firstNonEmptyLine(text);
  return firstLine || `VERDICT: ${verdict.verdict}`;
}

export function ingestVerifierVerdict(
  input: VerifierVerdictIngestionInput,
): VerifierVerdictIngestionResult {
  const parsed = parseVerifierVerdict(input.text);
  if (!parsed.success || !parsed.verdict) {
    return { ingested: false, reason: parsed.error ?? "No verifier verdict found" };
  }

  return {
    ingested: true,
    evidence: {
      source: input.source,
      verdict: parsed.verdict.verdict,
      summary: summarizeVerdict(input.text, parsed.verdict),
      verifier: input.verifier,
      rawText: input.text,
      parsed: parsed.verdict,
      timestamp: input.now?.() ?? Date.now(),
    },
  };
}
