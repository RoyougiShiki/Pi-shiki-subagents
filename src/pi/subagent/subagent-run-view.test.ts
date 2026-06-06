import { describe, expect, test } from 'bun:test';
import {
  createSubagentRunState,
  updateSubagentRunState,
} from './subagent-run-state';
import {
  createSubagentRunTreeView,
  formatSubagentElapsed,
  formatSubagentTokens,
  formatSubagentUsage,
} from './subagent-run-view';

function startRun(runId: string, startedAt: number, parentRunId?: string) {
  return {
    type: 'run_started' as const,
    runId,
    parentRunId,
    agentName: runId === 'parent' ? 'coordinator' : 'oracle',
    displayName: runId === 'parent' ? 'Coordinator' : 'Oracle Review',
    depth: parentRunId ? 1 : 0,
    startedAt,
    taskPreview: 'short task',
    model: 'dmxapi-responses/gpt-5.5',
  };
}

describe('subagent run view', () => {
  test('builds semantic tree view without TUI components', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 1_000));
    state = updateSubagentRunState(state, startRun('child', 2_000, 'parent'));
    state = updateSubagentRunState(state, {
      type: 'assistant_text',
      runId: 'child',
      timestamp: 3_000,
      text: 'reviewing plan',
    });

    const view = createSubagentRunTreeView(state, { now: 6_000 });

    expect(view.counts).toEqual({
      total: 2,
      running: 2,
      completed: 0,
      failed: 0,
      dead: 0,
    });
    expect(view.summaryLine).toBe('2 running');
    expect(view.roots).toHaveLength(1);
    expect(view.roots[0]?.runId).toBe('parent');
    expect(view.roots[0]?.startedAt).toBe(1_000);
    expect(view.roots[0]?.children[0]?.runId).toBe('child');
    expect(view.roots[0]?.children[0]?.recentLines).toEqual(['reviewing plan']);
  });

  test('limits recent lines at view time', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 1_000));
    state = updateSubagentRunState(state, {
      type: 'assistant_text',
      runId: 'parent',
      timestamp: 2_000,
      text: 'one',
    });
    state = updateSubagentRunState(state, {
      type: 'assistant_text',
      runId: 'parent',
      timestamp: 3_000,
      text: 'two',
    });
    state = updateSubagentRunState(state, {
      type: 'assistant_text',
      runId: 'parent',
      timestamp: 4_000,
      text: 'three',
    });

    const view = createSubagentRunTreeView(state, {
      now: 5_000,
      maxRecentLines: 2,
    });

    expect(view.roots[0]?.recentLines).toEqual(['two', 'three']);

    const clamped = createSubagentRunTreeView(state, {
      now: 5_000,
      maxRecentLines: 0,
    });
    expect(clamped.roots[0]?.recentLines).toEqual(['three']);

    const nanLimit = createSubagentRunTreeView(state, {
      now: 5_000,
      maxRecentLines: Number.NaN,
    });
    expect(nanLimit.roots[0]?.recentLines).toEqual(['one', 'two', 'three']);

    const infiniteLimit = createSubagentRunTreeView(state, {
      now: 5_000,
      maxRecentLines: Number.POSITIVE_INFINITY,
    });
    expect(infiniteLimit.roots[0]?.recentLines).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('formats optional usage only when fields are present', () => {
    expect(formatSubagentUsage(undefined)).toBeUndefined();
    expect(formatSubagentUsage({})).toBeUndefined();
    expect(
      formatSubagentUsage({
        input: 1530,
        output: 240,
        cost: 0.01234,
        turns: 2,
        contextTokens: 10_500,
      }),
    ).toBe('2 turns ↑1.5k ↓240 $0.0123 ctx:11k');
  });

  test('formats tokens and elapsed time', () => {
    expect(formatSubagentTokens(999)).toBe('999');
    expect(formatSubagentTokens(1500)).toBe('1.5k');
    expect(formatSubagentTokens(12_300)).toBe('12k');
    expect(formatSubagentElapsed(0, 65_000)).toBe('01:05');
    expect(formatSubagentElapsed(0, 3_665_000)).toBe('1:01:05');
  });

  test('counts completed failed and dead states separately', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('done', 1_000));
    state = updateSubagentRunState(state, startRun('failed', 2_000));
    state = updateSubagentRunState(state, startRun('dead', 3_000));
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'done',
      timestamp: 4_000,
      status: 'completed',
    });
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'failed',
      timestamp: 5_000,
      status: 'failed',
    });
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'dead',
      timestamp: 6_000,
      status: 'dead',
    });

    const view = createSubagentRunTreeView(state, { now: 7_000 });

    expect(view.counts).toEqual({
      total: 3,
      running: 0,
      completed: 1,
      failed: 1,
      dead: 1,
    });
    expect(view.summaryLine).toBe('1 completed · 1 failed · 1 dead');
    expect(view.roots[0]?.completedAt).toBe(4_000);
  });
});
