import { describe, expect, test } from 'bun:test';
import {
  createSubagentRunState,
  updateSubagentRunState,
} from './subagent-run-state';
import { createSubagentSessionSnapshots } from './subagent-session-contract';

function startRun(runId: string, startedAt: number, parentRunId?: string) {
  return {
    type: 'run_started' as const,
    runId,
    parentRunId,
    agentName: runId,
    displayName: runId.toUpperCase(),
    depth: parentRunId ? 1 : 0,
    startedAt,
    taskPreview: `task for ${runId}`,
    model: `test/${runId}`,
  };
}

describe('subagent session contract', () => {
  test('creates stable snapshots for parallel roots and nested children', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('root-b', 200));
    state = updateSubagentRunState(state, startRun('root-a', 100));
    state = updateSubagentRunState(state, startRun('child-a', 150, 'root-a'));

    const snapshots = createSubagentSessionSnapshots(state);

    expect(snapshots.map((snapshot) => snapshot.runId)).toEqual([
      'root-a',
      'child-a',
      'root-b',
    ]);
    expect(snapshots[0]).toMatchObject({
      version: 1,
      kind: 'subagent',
      runId: 'root-a',
      lineage: { childRunIds: ['child-a'], depth: 0 },
      activity: { phase: 'starting' },
    });
    expect(snapshots[1]).toMatchObject({
      runId: 'child-a',
      lineage: { parentRunId: 'root-a', childRunIds: [], depth: 1 },
    });
  });

  test('maps runtime statuses to activity phases without losing current status', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('active', 100));
    state = updateSubagentRunState(state, startRun('waiting', 100));
    state = updateSubagentRunState(state, startRun('done', 100));
    state = updateSubagentRunState(state, {
      type: 'status',
      runId: 'active',
      timestamp: 110,
      status: 'streaming',
    });
    state = updateSubagentRunState(state, {
      type: 'status',
      runId: 'waiting',
      timestamp: 120,
      status: 'idle',
    });
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'done',
      timestamp: 130,
      status: 'completed',
      text: 'final answer',
    });

    const byId = Object.fromEntries(
      createSubagentSessionSnapshots(state).map((snapshot) => [
        snapshot.runId,
        snapshot,
      ]),
    );

    expect(byId.active?.status).toBe('streaming');
    expect(byId.active?.activity.phase).toBe('active');
    expect(byId.waiting?.status).toBe('idle');
    expect(byId.waiting?.activity.phase).toBe('waiting');
    expect(byId.done?.status).toBe('completed');
    expect(byId.done?.activity.phase).toBe('completed');
    expect(byId.done?.resultSummary).toBe('final answer');
  });

  test('tracks latest activity timestamp, tool count, result summary, and usage', () => {
    let state = createSubagentRunState();
    state = updateSubagentRunState(state, startRun('worker', 100));
    state = updateSubagentRunState(state, {
      type: 'tool_call',
      runId: 'worker',
      timestamp: 120,
      toolName: 'read',
      summary: 'src/index.ts',
    });
    state = updateSubagentRunState(state, {
      type: 'usage',
      runId: 'worker',
      timestamp: 130,
      usage: { input: 100, output: 20 },
    });
    state = updateSubagentRunState(state, {
      type: 'run_finished',
      runId: 'worker',
      timestamp: 200,
      status: 'failed',
      errorMessage: 'boom',
    });

    const [snapshot] = createSubagentSessionSnapshots(state);

    expect(snapshot?.activity).toMatchObject({
      phase: 'failed',
      updatedAt: 200,
      toolCount: 1,
    });
    expect(snapshot?.activity.latestEvent).toMatchObject({
      type: 'run_finished',
      isError: true,
    });
    expect(snapshot?.resultSummary).toBe('boom');
    expect(snapshot?.errorMessage).toBe('boom');
    expect(snapshot?.usage).toEqual({ input: 100, output: 20 });
  });
});
