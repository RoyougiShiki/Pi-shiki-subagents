import { describe, expect, test } from 'bun:test';
import {
  createSubagentRunState,
  updateSubagentRunState,
} from './subagent-run-state';

function startRun(runId: string, startedAt = 100, parentRunId?: string) {
  return {
    type: 'run_started' as const,
    runId,
    parentRunId,
    agentName: runId === 'parent' ? 'standard-dev' : 'oracle',
    displayName: runId,
    depth: parentRunId ? 1 : 0,
    startedAt,
    taskPreview:
      'Investigate subagent TUI observability without storing full prompts',
  };
}

describe('subagent run state', () => {
  test('records stable parent child tree identity', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100));
    state = updateSubagentRunState(state, startRun('child', 200, 'parent'));

    expect(state.rootRunIds).toEqual(['parent']);
    expect(state.runs.parent.children).toEqual(['child']);
    expect(state.runs.child.parentRunId).toBe('parent');
    expect(state.runs.child.depth).toBe(1);
  });

  test('bounds recent event count and event text', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100), {
      maxRecentEvents: 2,
      maxEventTextChars: 12,
    });

    state = updateSubagentRunState(
      state,
      {
        type: 'assistant_text',
        runId: 'parent',
        timestamp: 110,
        text: 'first long assistant message',
      },
      {
        maxRecentEvents: 2,
        maxEventTextChars: 12,
      },
    );
    state = updateSubagentRunState(
      state,
      {
        type: 'assistant_text',
        runId: 'parent',
        timestamp: 120,
        text: 'second long assistant message',
      },
      {
        maxRecentEvents: 2,
        maxEventTextChars: 12,
      },
    );
    state = updateSubagentRunState(
      state,
      {
        type: 'assistant_text',
        runId: 'parent',
        timestamp: 130,
        text: 'third long assistant message',
      },
      {
        maxRecentEvents: 2,
        maxEventTextChars: 12,
      },
    );

    expect(state.runs.parent.recentEvents).toHaveLength(2);
    expect(state.runs.parent.recentEvents[0]?.text).toBe('second long…');
    expect(state.runs.parent.recentEvents[1]?.text).toBe('third long …');
  });

  test('bounds task preview separately from event text', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100), {
      maxTaskPreviewChars: 20,
    });

    expect(state.runs.parent.taskPreview).toBe('Investigate subagen…');
  });

  test('tracks tool summaries without raw args or results', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100));
    state = updateSubagentRunState(state, {
      type: 'tool_call',
      runId: 'parent',
      timestamp: 110,
      toolName: 'read',
      summary: 'src/pi/subagent/subagent-pool.ts',
    });
    state = updateSubagentRunState(state, {
      type: 'tool_result',
      runId: 'parent',
      timestamp: 120,
      toolName: 'read',
      summary: '120 lines',
    });

    expect(state.runs.parent.toolCount).toBe(1);
    expect(state.runs.parent.recentEvents.map((event) => event.text)).toEqual([
      'read: src/pi/subagent/subagent-pool.ts',
      'read: 120 lines',
    ]);
  });

  test('usage is optional and merged only when observed', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100));

    expect(state.runs.parent.usage).toBeUndefined();

    state = updateSubagentRunState(state, {
      type: 'usage',
      runId: 'parent',
      timestamp: 110,
      usage: { input: 1200 },
    });
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'parent',
      timestamp: 200,
      status: 'completed',
      usage: { output: 300, cost: 0.0012 },
    });

    expect(state.runs.parent.status).toBe('completed');
    expect(state.runs.parent.completedAt).toBe(200);
    expect(state.runs.parent.usage).toEqual({
      input: 1200,
      output: 300,
      cost: 0.0012,
    });
  });

  test('marks failed tool result as failed', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100));
    state = updateSubagentRunState(state, {
      type: 'tool_result',
      runId: 'parent',
      timestamp: 120,
      toolName: 'bash',
      summary: 'exit 1',
      isError: true,
    });

    expect(state.runs.parent.status).toBe('failed');
    expect(state.runs.parent.recentEvents[0]?.isError).toBe(true);
  });

  test('clamps zero recent event limit to keep bounded summaries', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('parent', 100), {
      maxRecentEvents: 0,
    });
    state = updateSubagentRunState(
      state,
      {
        type: 'assistant_text',
        runId: 'parent',
        timestamp: 110,
        text: 'one',
      },
      { maxRecentEvents: 0 },
    );
    state = updateSubagentRunState(
      state,
      {
        type: 'assistant_text',
        runId: 'parent',
        timestamp: 120,
        text: 'two',
      },
      { maxRecentEvents: 0 },
    );

    expect(state.runs.parent.recentEvents).toHaveLength(1);
    expect(state.runs.parent.recentEvents[0]?.text).toBe('two');
  });

  test('adopts child that starts before parent event arrives', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('child', 100, 'parent'));
    expect(state.rootRunIds).toEqual(['child']);

    state = updateSubagentRunState(state, startRun('parent', 200));

    expect(state.rootRunIds).toEqual(['parent']);
    expect(state.runs.parent.children).toEqual(['child']);
    expect(state.runs.child.parentRunId).toBe('parent');
  });
});
