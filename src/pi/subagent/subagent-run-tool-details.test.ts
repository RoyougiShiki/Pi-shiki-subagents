import { describe, expect, test } from 'bun:test';
import type {
  SubagentRunTreeView,
  SubagentRunViewNode,
} from './subagent-run-view';
import { buildOmoSubagentToolDetails } from './subagent-run-tool-details';

function node(overrides: Partial<SubagentRunViewNode> = {}): SubagentRunViewNode {
  return {
    runId: 'run-1',
    agentName: 'oracle',
    displayName: 'oracle',
    depth: 0,
    status: 'completed',
    title: 'oracle (oracle)',
    taskPreview: 'SECRET_TASK_PROMPT_SENTINEL',
    model: 'test/model',
    startedAt: 1000,
    elapsedText: '00:42',
    toolCount: 2,
    recentLines: [
      'SECRET_SEND_MESSAGE_SENTINEL',
      'SECRET_ASSISTANT_TEXT_SENTINEL',
      'SECRET_USER_TEXT_SENTINEL',
      'SECRET_SYSTEM_HIDDEN_SENTINEL',
      'read: SECRET_TOOL_ARGS_SENTINEL',
      'write: SECRET_TOOL_RESULT_SENTINEL',
    ],
    children: [],
    ...overrides,
  };
}

function view(roots: SubagentRunViewNode[]): SubagentRunTreeView {
  return {
    roots,
    counts: {
      total: roots.length,
      running: 0,
      completed: roots.length,
      failed: 0,
      dead: 0,
    },
    summaryLine: `${roots.length} completed`,
  };
}

describe('omo subagent tool details', () => {
  test('spawn details focus the spawned run', () => {
    const details = buildOmoSubagentToolDetails(view([node()]), {
      action: 'spawn',
      runId: 'run-1',
      focusRun: true,
    });
    expect(details.focusedRun?.runId).toBe('run-1');
    expect(details.summary.roots[0]?.runId).toBe('run-1');
  });

  test('list details include sanitized summary without focus', () => {
    const details = buildOmoSubagentToolDetails(view([node()]), {
      action: 'list',
    });
    expect(details.focusedRun).toBeUndefined();
    expect(details.summary.roots[0]?.title).toBe('oracle (oracle)');
  });

  test('serialized payload excludes prompt/message/tool sentinels and taskPreview key', () => {
    const details = buildOmoSubagentToolDetails(view([node()]), {
      action: 'spawn',
      runId: 'run-1',
      focusRun: true,
    });
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('taskPreview');
    for (const sentinel of [
      'SECRET_TASK_PROMPT_SENTINEL',
      'SECRET_SEND_MESSAGE_SENTINEL',
      'SECRET_ASSISTANT_TEXT_SENTINEL',
      'SECRET_USER_TEXT_SENTINEL',
      'SECRET_SYSTEM_HIDDEN_SENTINEL',
      'SECRET_TOOL_ARGS_SENTINEL',
      'SECRET_TOOL_RESULT_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  test('payload bounds roots, children, nested depth, and events', () => {
    const grandchild = node({ runId: 'grandchild', title: 'grandchild' });
    const child = node({ runId: 'child', title: 'child', children: [grandchild] });
    const roots = Array.from({ length: 7 }, (_, index) =>
      node({
        runId: `root-${index}`,
        title: `root-${index}`,
        recentLines: Array.from({ length: 12 }, (_, eventIndex) =>
          `event-${eventIndex}`,
        ),
        children: index === 0 ? Array.from({ length: 7 }, () => child) : [],
      }),
    );
    const details = buildOmoSubagentToolDetails(view(roots), {
      action: 'spawn',
      runId: 'root-0',
      focusRun: true,
      eventLimit: 10,
      maxChildren: 5,
      maxDepth: 2,
      maxRoots: 5,
    });

    expect(details.summary.roots).toHaveLength(5);
    expect(details.summary.hiddenRootCount).toBe(2);
    expect(details.focusedRun?.latestEvents).toHaveLength(10);
    expect(details.focusedRun?.hiddenEventCount).toBe(2);
    expect(details.focusedRun?.children).toHaveLength(5);
    expect(details.focusedRun?.hiddenChildCount).toBe(2);
    expect(details.focusedRun?.children[0]?.children).toHaveLength(0);
    expect(details.focusedRun?.children[0]?.hiddenChildCount).toBe(1);
  });

  test('serialized payload sanitizes and bounds copied string fields', () => {
    const longText = 'x'.repeat(300);
    const rawRunId = `run\nSECRET_FIELD_SENTINEL\u0000${longText}`;
    const details = buildOmoSubagentToolDetails(
      view([
        node({
          runId: rawRunId,
          title: `title\nSECRET_TITLE_SENTINEL\u0007${longText}`,
          agentName: `agent\nSECRET_AGENT_SENTINEL\u0001${longText}`,
          model: `model\nSECRET_MODEL_SENTINEL\u001b${longText}`,
          elapsedText: `00:42\nSECRET_ELAPSED_SENTINEL${longText}`,
          usageText: `usage\nSECRET_USAGE_SENTINEL${longText}`,
          recentLines: [],
        }),
      ]),
      {
        action: 'spawn',
        runId: rawRunId,
        focusRun: true,
      },
    );
    const serialized = JSON.stringify(details);

    for (const sentinel of [
      'SECRET_FIELD_SENTINEL',
      'SECRET_TITLE_SENTINEL',
      'SECRET_AGENT_SENTINEL',
      'SECRET_MODEL_SENTINEL',
      'SECRET_ELAPSED_SENTINEL',
      'SECRET_USAGE_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain('\n');
    expect(serialized).not.toContain('\u0000');
    expect(details.focusedRun?.runId.length).toBeLessThanOrEqual(80);
    expect(details.runId?.length).toBeLessThanOrEqual(80);
    expect(details.focusedRun?.title.length).toBeLessThanOrEqual(120);
    expect(details.focusedRun?.agentName.length).toBeLessThanOrEqual(80);
    expect(details.focusedRun?.model?.length).toBeLessThanOrEqual(120);
    expect(details.focusedRun?.elapsedText.length).toBeLessThanOrEqual(32);
    expect(details.focusedRun?.usageText?.length).toBeLessThanOrEqual(120);
    expect(details.summary.roots[0]?.runId.length).toBeLessThanOrEqual(80);
    expect(details.summary.roots[0]?.title.length).toBeLessThanOrEqual(120);
  });
});
