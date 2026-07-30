import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getBudgetStatePath,
  loadBudgetState,
  saveBudgetState,
} from './tool-result-budget-persistence';
import {
  createToolResultBudgetState,
  recordReplacement,
} from './tool-result-budget-state';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'omo-budget-state-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('tool result budget persistence', () => {
  test('saves and loads budget state', async () => {
    await withTempDir(async (dir) => {
      const state = createToolResultBudgetState();
      state.seenIds.add('call-2');
      recordReplacement(state, {
        kind: 'tool-result',
        toolUseId: 'call-1',
        toolName: 'bash',
        originalSize: 100,
        replacement: 'REPLACED',
        filepath: '/tmp/output.txt',
        createdAt: 123,
      });

      expect(await saveBudgetState(state, dir, 'session-1')).toBe(true);
      const loaded = await loadBudgetState(dir, 'session-1');

      expect(loaded?.seenIds.has('call-1')).toBe(true);
      expect(loaded?.seenIds.has('call-2')).toBe(true);
      expect(loaded?.replacements.get('call-1')).toBe('REPLACED');
    });
  });

  test('missing or invalid state returns null', async () => {
    const warnSpy = spyOn(console, 'warn');
    try {
      await withTempDir(async (dir) => {
        expect(await loadBudgetState(dir, 'missing-session')).toBeNull();

        const statePath = getBudgetStatePath(dir, 'broken-session');
        await writeFile(statePath, 'not json', 'utf8').catch(async () => {
          await saveBudgetState(
            createToolResultBudgetState(),
            dir,
            'broken-session',
          );
          await writeFile(statePath, 'not json', 'utf8');
        });

        expect(await loadBudgetState(dir, 'broken-session')).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
