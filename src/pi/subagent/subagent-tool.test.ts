import { describe, expect, test } from 'bun:test';
import {
  checkPoolContinuationAllowed,
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

describe('checkPoolContinuationAllowed', () => {
  const rules = {
    'research-only': ['search', 'oracle'],
    'standard-dev': ['search', 'oracle'],
  };

  test('allows continuing a parent-owned pool run only when it belongs to the parent workflow', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'standard-dev',
        parentAgent: 'standard-dev',
        targetAgent: 'dispatcher',
        parentWorkflowAgents: ['analyst', 'designer', 'dispatcher', 'fixer', 'oracle'],
        depth: 0,
        rules,
      }).ok,
    ).toBe(true);
  });

  test('blocks same-parent implementation records outside the current workflow', () => {
    const result = checkPoolContinuationAllowed({
      callerAgent: 'research-only',
      parentAgent: 'research-only',
      targetAgent: 'fixer',
      parentWorkflowAgents: ['analyst', 'search'],
      depth: 0,
      rules,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.allowedAgents).toEqual(['search', 'oracle']);
  });

  test('blocks continuing an unrelated implementation agent in research-only mode', () => {
    const result = checkPoolContinuationAllowed({
      callerAgent: 'research-only',
      targetAgent: 'fixer',
      depth: 0,
      rules,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.allowedAgents).toEqual(['search', 'oracle']);
  });

  test('allows research-only to continue configured read-only delegates', () => {
    expect(
      checkPoolContinuationAllowed({
        callerAgent: 'research-only',
        targetAgent: 'oracle',
        depth: 0,
        rules,
      }).ok,
    ).toBe(true);
  });
});
