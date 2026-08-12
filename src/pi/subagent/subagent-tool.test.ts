import { describe, expect, test } from 'bun:test';
import {
  checkPoolContinuationAllowed,
  formatPoolResultContent,
  planPoolResume,
  selectPoolResultText,
} from './subagent-tool';

describe('pool resume planning', () => {
  test('uses a saved session when it remains available', () => {
    const plan = planPoolResume(
      { id: 'saved', agentName: 'fixer', sessionFile: '/sessions/fixer.jsonl' },
      'continue',
      () => true,
    );

    expect(plan.canResumeSession).toBe(true);
    expect(plan.resumeMessage).toBe('continue');
  });

  test('falls back to saved task context without a session file', () => {
    const plan = planPoolResume(
      { id: 'saved', agentName: 'fixer' },
      'continue',
    );

    expect(plan.canResumeSession).toBe(false);
    expect(plan.resumeMessage).toBeUndefined();
  });
});

describe('pool result access', () => {
  test('prefers persisted full results over live previews', () => {
    // registry 存全量 lastResponse；live 来自 pool.list()，是 200 字符预览，不能顶替全量。
    expect(
      selectPoolResultText(
        { lastResponse: 'live preview' },
        { lastResponse: 'persisted full result' },
      ),
    ).toBe('persisted full result');
    // 无 registry 记录时退回 live（可能仍只是预览，但至少不是空）。
    expect(selectPoolResultText({ lastResponse: 'live result' }, undefined)).toBe(
      'live result',
    );
    expect(
      formatPoolResultContent({
        id: 'search-1',
        agentName: 'search',
        response: 'partial result',
        errorMessage: 'timed out',
      }),
    ).toContain('Partial result captured before failure:');
  });
});

describe('pool continuation boundaries', () => {
  const rules = { main: ['search', 'fixer', 'oracle'], oracle: [] };

  test('allows main-session continuation for configured roles', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'main',
        targetAgent: 'fixer',
        rules,
      }).ok,
    ).toBe(true);
  });

  test('blocks leaf and unknown continuation targets', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'oracle',
        targetAgent: 'search',
        rules,
      }).ok,
    ).toBe(false);
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'main',
        targetAgent: 'unknown',
        rules,
      }).ok,
    ).toBe(false);
  });
});
