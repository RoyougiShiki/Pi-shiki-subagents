import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildToolResultBudgetSessionDir } from './tool-result-budget';
import type {
  VerifierVerdictEvidence,
  VerifierVerdictEvidenceSource,
} from './verifier-verdict-evidence';
import type { VerifierVerdictStatus } from './verifier-verdict-parser';

const VERIFIER_VERDICTS_FILENAME = '.verifier-verdicts.json';

interface PersistedVerifierVerdict {
  source: VerifierVerdictEvidenceSource;
  verdict: VerifierVerdictStatus;
  summary: string;
  verifier?: string;
  timestamp: number;
}

interface PersistedVerifierVerdictsFile {
  version: 1;
  verdicts: PersistedVerifierVerdict[];
}

function isVerdictStatus(value: unknown): value is VerifierVerdictStatus {
  return value === 'PASS' || value === 'FAIL' || value === 'PARTIAL';
}

function isEvidenceSource(
  value: unknown,
): value is VerifierVerdictEvidenceSource {
  return value === 'subagent' || value === 'tool' || value === 'manual';
}

function toPersistedVerifierVerdict(
  evidence: VerifierVerdictEvidence,
): PersistedVerifierVerdict {
  return {
    source: evidence.source,
    verdict: evidence.verdict,
    summary: evidence.summary,
    verifier: evidence.verifier,
    timestamp: evidence.timestamp,
  };
}

function fromPersistedVerifierVerdict(
  value: unknown,
): VerifierVerdictEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isEvidenceSource(record.source)) return null;
  if (!isVerdictStatus(record.verdict)) return null;
  if (typeof record.summary !== 'string') return null;
  if (record.verifier !== undefined && typeof record.verifier !== 'string')
    return null;
  if (
    typeof record.timestamp !== 'number' ||
    !Number.isFinite(record.timestamp)
  )
    return null;

  return {
    source: record.source,
    verdict: record.verdict,
    summary: record.summary,
    verifier: record.verifier,
    rawText: `VERDICT: ${record.verdict}\n${record.summary}`,
    parsed: {
      verdict: record.verdict,
      checkBlocks: [],
      hasCommandRun: false,
      hasOutputObserved: false,
      failDetails: record.verdict === 'FAIL' ? record.summary : undefined,
      partialDetails: record.verdict === 'PARTIAL' ? record.summary : undefined,
    },
    timestamp: record.timestamp,
  };
}

export function getVerifierVerdictsPath(
  baseDir: string,
  sessionId: string,
): string {
  return path.join(
    buildToolResultBudgetSessionDir({ baseDir, sessionId }),
    VERIFIER_VERDICTS_FILENAME,
  );
}

export function toVerifierVerdictsPersistenceJson(
  verdicts: readonly VerifierVerdictEvidence[],
): PersistedVerifierVerdictsFile {
  return {
    version: 1,
    verdicts: verdicts.map(toPersistedVerifierVerdict),
  };
}

export function fromVerifierVerdictsPersistenceJson(
  json: unknown,
): VerifierVerdictEvidence[] | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!Array.isArray(record.verdicts)) return null;

  const verdicts: VerifierVerdictEvidence[] = [];
  for (const value of record.verdicts) {
    const verdict = fromPersistedVerifierVerdict(value);
    if (!verdict) return null;
    verdicts.push(verdict);
  }
  return verdicts;
}

export async function loadVerifierVerdicts(
  baseDir: string,
  sessionId: string,
): Promise<VerifierVerdictEvidence[] | null> {
  const statePath = getVerifierVerdictsPath(baseDir, sessionId);
  try {
    const content = await readFile(statePath, 'utf8');
    const verdicts = fromVerifierVerdictsPersistenceJson(JSON.parse(content));
    if (!verdicts) {
      console.warn(
        `[pi-shiki-subagents] Ignoring invalid verifier verdict state: ${statePath}`,
      );
      return null;
    }
    return verdicts;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    console.warn(
      `[pi-shiki-subagents] Failed to load verifier verdict state: ${statePath}`,
    );
    return null;
  }
}

/**
 * Writes the session verdict companion file for the current Pi runtime.
 * register-harness-hooks serializes read/modify/write within one active runtime;
 * concurrent independent runtimes for the same session are intentionally out of scope.
 */
export async function saveVerifierVerdicts(
  verdicts: readonly VerifierVerdictEvidence[],
  baseDir: string,
  sessionId: string,
): Promise<boolean> {
  const statePath = getVerifierVerdictsPath(baseDir, sessionId);
  const sessionDir = path.dirname(statePath);
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      tmpPath,
      JSON.stringify(toVerifierVerdictsPersistenceJson(verdicts), null, 2),
      'utf8',
    );
    await rename(tmpPath, statePath);
    return true;
  } catch {
    console.warn(
      `[pi-shiki-subagents] Failed to save verifier verdict state: ${statePath}`,
    );
    return false;
  }
}
