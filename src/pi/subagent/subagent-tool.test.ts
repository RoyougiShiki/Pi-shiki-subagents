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
  test('prefers live results and retains failure detail', () => {
    expect(
      selectPoolResultText(
        { lastResponse: 'live result' },
        { lastResponse: 'persisted result' },
      ),
    ).toBe('live result');
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
