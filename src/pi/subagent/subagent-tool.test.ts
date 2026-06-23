import { describe, expect, test } from 'bun:test';
import {
  checkPoolContinuationAllowed,
  formatPoolResultContent,
  planPoolResume,
  selectPoolResultText,
} from './subagent-tool';

describe('planPoolResume', () => {
  const record = {
    id: 'saved-run',
    agentName: 'saved-agent',
    sessionFile: '/sessions/subagent.jsonl',
  };

  test('uses saved session file when it exists', () => {
    const plan = planPoolResume(record, 'continue work', () => true);

    expect(plan.canResumeSession).toBe(true);
    expect(plan.resumeSessionFile).toBe('/sessions/subagent.jsonl');
    expect(plan.resumeMessage).toBe('continue work');
    expect(plan.successText).toContain('resumed from saved session');
  });

  test('falls back to saved task context when session file is missing', () => {
    const plan = planPoolResume(record, 'continue work', () => false);

    expect(plan.canResumeSession).toBe(false);
    expect(plan.resumeSessionFile).toBeUndefined();
    expect(plan.resumeMessage).toBeUndefined();
    expect(plan.successText).toContain('restarted from saved task context');
  });

  test('falls back when registry has no session file', () => {
    const plan = planPoolResume(
      { id: 'saved-run', agentName: 'saved-agent' },
      'continue work',
      () => true,
    );

    expect(plan.canResumeSession).toBe(false);
    expect(plan.resumeSessionFile).toBeUndefined();
    expect(plan.resumeMessage).toBeUndefined();
  });
});

describe('selectPoolResultText', () => {
  test('uses active in-memory response before persisted registry response', () => {
    expect(
      selectPoolResultText(
        { lastResponse: 'fresh active result' },
        { lastResponse: 'older registry result' },
      ),
    ).toBe('fresh active result');
  });

  test('falls back to persisted registry response when no active response exists', () => {
    expect(
      selectPoolResultText(undefined, { lastResponse: 'registry result' }),
    ).toBe('registry result');
  });
});

describe('formatPoolResultContent', () => {
  test('separates failure status from partial result text', () => {
    const text = formatPoolResultContent({
      id: 'deep-local-refs',
      agentName: 'search',
      response: '完成：只读证据扫描已完成。',
      errorMessage: 'Agent "deep-local-refs" timed out',
    });

    expect(text).toContain('Status: failed (Agent "deep-local-refs" timed out)');
    expect(text).toContain('Partial result captured before failure:');
    expect(text).toContain('完成：只读证据扫描已完成。');
    expect(text).not.toContain('✗ Agent "deep-local-refs" timed out');
  });
});

describe('checkPoolContinuationAllowed', () => {
  const rules = {
    'standard-dev': ['search', 'oracle'],
    'quick-fix': ['search', 'fixer', 'oracle'],
  };

  test('allows continuing a parent-owned pool run only when it belongs to the parent workflow', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'standard-dev',
        parentAgent: 'standard-dev',
        targetAgent: 'dispatcher',
        parentWorkflowAgents: ['standard-dev', 'dispatcher', 'fixer', 'oracle'],
        depth: 0,
        rules,
      }).ok,
    ).toBe(true);
  });

  test('blocks same-parent implementation records outside the current workflow', () => {
    const result = checkPoolContinuationAllowed({
      callerAgent: 'standard-dev',
      parentAgent: 'standard-dev',
      targetAgent: 'fixer',
      parentWorkflowAgents: ['standard-dev', 'search'],
      depth: 0,
      rules,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.allowedAgents).toEqual(['search', 'oracle']);
  });

  test('blocks continuing an unrelated implementation agent outside configured delegates', () => {
    const result = checkPoolContinuationAllowed({
      callerAgent: 'standard-dev',
      targetAgent: 'fixer',
      depth: 0,
      rules,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.allowedAgents).toEqual(['search', 'oracle']);
  });

  test('allows standard-dev to continue configured read-only delegates', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'standard-dev',
        targetAgent: 'oracle',
        depth: 0,
        rules,
      }).ok,
    ).toBe(true);
  });

  test('allows quick-fix to continue its short-path fixer runs', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'quick-fix',
        parentAgent: 'quick-fix',
        targetAgent: 'fixer',
        parentWorkflowAgents: ['fixer', 'search', 'oracle'],
        depth: 0,
        rules,
      }).ok,
    ).toBe(true);
  });
});
