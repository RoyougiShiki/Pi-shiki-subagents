import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifierVerdictEvidence } from './verifier-verdict-evidence';
import {
  fromVerifierVerdictsPersistenceJson,
  getVerifierVerdictsPath,
  loadVerifierVerdicts,
  saveVerifierVerdicts,
  toVerifierVerdictsPersistenceJson,
} from './verifier-verdict-persistence';

function verdict(
  partial: Partial<VerifierVerdictEvidence> = {},
): VerifierVerdictEvidence {
  const status = partial.verdict ?? 'PASS';
  return {
    source: partial.source ?? 'subagent',
    verdict: status,
    summary: partial.summary ?? 'verified',
    verifier: partial.verifier ?? 'reviewer',
    rawText: partial.rawText ?? `VERDICT: ${status}`,
    parsed: partial.parsed ?? {
      verdict: status,
      checkBlocks: [],
      hasCommandRun: false,
      hasOutputObserved: false,
    },
    timestamp: partial.timestamp ?? 123,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'omo-verifier-state-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('verifier verdict persistence', () => {
  test('roundtrips minimal verifier verdict state', () => {
    const restored = fromVerifierVerdictsPersistenceJson(
      toVerifierVerdictsPersistenceJson([
        verdict({ verdict: 'FAIL', summary: 'regression', timestamp: 456 }),
      ]),
    );

    expect(restored?.[0]?.verdict).toBe('FAIL');
    expect(restored?.[0]?.summary).toBe('regression');
    expect(restored?.[0]?.parsed.failDetails).toBe('regression');
  });

  test('saves and loads verifier verdicts', async () => {
    await withTempDir(async (dir) => {
      expect(await saveVerifierVerdicts([verdict()], dir, 'session-1')).toBe(
        true,
      );
      const loaded = await loadVerifierVerdicts(dir, 'session-1');

      expect(loaded).toHaveLength(1);
      expect(loaded?.[0]?.verdict).toBe('PASS');
      expect(loaded?.[0]?.verifier).toBe('reviewer');
    });
  });

  test('missing or invalid verifier state returns null', async () => {
    const warnSpy = spyOn(console, 'warn');
    try {
      await withTempDir(async (dir) => {
        expect(await loadVerifierVerdicts(dir, 'missing-session')).toBeNull();

        await saveVerifierVerdicts([verdict()], dir, 'broken-session');
        await writeFile(
          getVerifierVerdictsPath(dir, 'broken-session'),
          'not json',
          'utf8',
        );

        expect(await loadVerifierVerdicts(dir, 'broken-session')).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
