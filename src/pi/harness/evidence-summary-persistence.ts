import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildToolResultBudgetSessionDir } from "./tool-result-budget";
import {
  fromRecoveredEvidenceSummaryJson,
  toRecoveredEvidenceSummaryJson,
  type RecoveredEvidenceSummaryState,
} from "./evidence-summary-state";

const EVIDENCE_SUMMARY_FILENAME = ".evidence-summary.json";

export function getEvidenceSummaryPath(baseDir: string, sessionId: string): string {
  return path.join(buildToolResultBudgetSessionDir({ baseDir, sessionId }), EVIDENCE_SUMMARY_FILENAME);
}

export async function loadEvidenceSummaryState(
  baseDir: string,
  sessionId: string,
): Promise<RecoveredEvidenceSummaryState | null> {
  const statePath = getEvidenceSummaryPath(baseDir, sessionId);
  try {
    const content = await readFile(statePath, "utf8");
    const state = fromRecoveredEvidenceSummaryJson(JSON.parse(content));
    if (!state) {
      console.warn(`[oh-my-opencode-slim] Ignoring invalid evidence summary state: ${statePath}`);
      return null;
    }
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(`[oh-my-opencode-slim] Failed to load evidence summary state: ${statePath}`);
    return null;
  }
}

export async function saveEvidenceSummaryState(
  state: RecoveredEvidenceSummaryState,
  baseDir: string,
  sessionId: string,
): Promise<boolean> {
  const statePath = getEvidenceSummaryPath(baseDir, sessionId);
  const sessionDir = path.dirname(statePath);
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(toRecoveredEvidenceSummaryJson(state), null, 2), "utf8");
    await rename(tmpPath, statePath);
    return true;
  } catch {
    console.warn(`[oh-my-opencode-slim] Failed to save evidence summary state: ${statePath}`);
    return false;
  }
}
