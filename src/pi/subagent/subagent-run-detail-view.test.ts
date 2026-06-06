import { describe, expect, test } from 'bun:test';
import type {
  SubagentRunTreeView,
  SubagentRunViewNode,
} from './subagent-run-view';
import {
  createSubagentRunDetailView,
  createSubagentRunTreeSummaryView,
} from './subagent-run-detail-view';

function node(overrides: Partial<SubagentRunViewNode> = {}): SubagentRunViewNode {
  return {
    runId: 'run-1',
    agentName: 'oracle',
    displayName: 'oracle',
    depth: 0,
    status: 'streaming',
    title: 'oracle (oracle)',
    taskPreview: 'SECRET_TASK_PROMPT_SENTINEL',
    model: 'test/model',
    startedAt: 1000,
    elapsedText: '00:05',
    toolCount: 1,
    recentLines: ['SECRET_ASSISTANT_SENTINEL raw assistant output'],
    children: [],
    ...overrides,
  };
}

function view(roots: SubagentRunViewNode[]): SubagentRunTreeView {
  return {
    roots,
    counts: {
      total: roots.length,
      running: roots.length,
      completed: 0,
      failed: 0,
      dead: 0,
    },
    summaryLine: roots.length ? `${roots.length} running` : 'no subagents',
  };
}

describe('subagent run detail view', () => {
  test('builds focused detail without taskPreview or raw assistant text', () => {
    const detail = createSubagentRunDetailView(view([node()]), 'run-1');
    expect(detail).toBeDefined();
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('taskPreview');
    expect(serialized).not.toContain('SECRET_TASK_PROMPT_SENTINEL');
    expect(serialized).not.toContain('SECRET_ASSISTANT_SENTINEL');
    expect(detail?.latestEvents[0]?.summary).toBe('activity observed');
  });

  test('summarizes tool-like recent lines without copying raw payload', () => {
    const detail = createSubagentRunDetailView(
      view([
        node({
          recentLines: ['read: SECRET_TOOL_ARGS_SENTINEL src/secret.ts'],
        }),
      ]),
      'run-1',
    );
    expect(detail?.latestEvents[0]).toEqual({
      type: 'tool_activity',
      summary: 'tool read activity',
      toolName: 'read',
      isError: false,
    });
    expect(JSON.stringify(detail)).not.toContain('SECRET_TOOL_ARGS_SENTINEL');
  });

  test('bounds expanded events to max 10 and reports earlier events', () => {
    const detail = createSubagentRunDetailView(
      view([
        node({
          recentLines: Array.from({ length: 12 }, (_, index) => `status-${index}`),
        }),
      ]),
      'run-1',
      { eventLimit: 10 },
    );
    expect(detail?.latestEvents).toHaveLength(10);
    expect(detail?.hiddenEventCount).toBe(2);
  });

  test('bounds collapsed events to max 2 when requested', () => {
    const detail = createSubagentRunDetailView(
      view([
        node({
          recentLines: ['one', 'two', 'three'],
        }),
      ]),
      'run-1',
      { eventLimit: 2 },
    );
    expect(detail?.latestEvents).toHaveLength(2);
    expect(detail?.hiddenEventCount).toBe(1);
  });

  test('bounds children to max 5 and reports hidden children', () => {
    const parent = node({
      children: Array.from({ length: 7 }, (_, index) =>
        node({ runId: `child-${index}`, title: `child-${index}` }),
      ),
    });
    const detail = createSubagentRunDetailView(view([parent]), 'run-1', {
      maxChildren: 5,
    });
    expect(detail?.children).toHaveLength(5);
    expect(detail?.hiddenChildCount).toBe(2);
  });

  test('bounds nested depth to max 2', () => {
    const grandchild = node({ runId: 'grandchild', title: 'grandchild' });
    const child = node({ runId: 'child', title: 'child', children: [grandchild] });
    const parent = node({ children: [child] });
    const summary = createSubagentRunTreeSummaryView(view([parent]), {
      maxDepth: 2,
      maxChildren: 5,
    });
    expect(summary.roots[0]?.children).toHaveLength(1);
    expect(summary.roots[0]?.children[0]?.children).toHaveLength(0);
    expect(summary.roots[0]?.children[0]?.hiddenChildCount).toBe(1);
  });

  test('does not render fake usage when usage is absent', () => {
    const detail = createSubagentRunDetailView(
      view([node({ usageText: undefined })]),
      'run-1',
    );
    expect(detail?.usageText).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain('usageText');
  });
});
