import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildToolResultBudgetSessionDir } from "./tool-result-budget";
import {
  createToolResultBudgetState,
  fromToolResultBudgetPersistenceJson,
  toToolResultBudgetPersistenceJson,
  type ToolResultBudgetState,
} from "./tool-result-budget-state";

const BUDGET_STATE_FILENAME = ".budget-state.json";

export function getBudgetStatePath(baseDir: string, sessionId: string): string {
  return path.join(buildToolResultBudgetSessionDir({ baseDir, sessionId }), BUDGET_STATE_FILENAME);
}

export async function loadBudgetState(baseDir: string, sessionId: string): Promise<ToolResultBudgetState | null> {
  const statePath = getBudgetStatePath(baseDir, sessionId);
  try {
    const content = await readFile(statePath, "utf8");
    const state = fromToolResultBudgetPersistenceJson(JSON.parse(content));
    if (!state) {
      console.warn(`[oh-my-opencode-slim] Ignoring invalid tool result budget state: ${statePath}`);
      return null;
    }
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(`[oh-my-opencode-slim] Failed to load tool result budget state: ${statePath}`);
    return null;
  }
}

export async function saveBudgetState(
  state: ToolResultBudgetState,
  baseDir: string,
  sessionId: string,
): Promise<boolean> {
  const statePath = getBudgetStatePath(baseDir, sessionId);
  const sessionDir = path.dirname(statePath);
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(toToolResultBudgetPersistenceJson(state), null, 2), "utf8");
    await rename(tmpPath, statePath);
    return true;
  } catch {
    console.warn(`[oh-my-opencode-slim] Failed to save tool result budget state: ${statePath}`);
    return false;
  }
}

export function createEmptyBudgetState(): ToolResultBudgetState {
  return createToolResultBudgetState();
}
