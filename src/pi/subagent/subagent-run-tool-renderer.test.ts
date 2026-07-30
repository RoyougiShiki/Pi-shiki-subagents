import { describe, expect, test } from 'bun:test';
import type { OmoSubagentToolDetailsV1 } from './subagent-run-tool-details';
import {
  renderOmoSubagentCallLines,
  renderOmoSubagentResultLines,
} from './subagent-run-tool-renderer';

function details(
  overrides: Partial<OmoSubagentToolDetailsV1> = {},
): OmoSubagentToolDetailsV1 {
  return {
    version: 1,
    action: 'spawn',
    runId: 'run-1',
    summary: {
      roots: [],
      counts: {
        total: 1,
        running: 0,
        completed: 1,
        failed: 0,
        dead: 0,
      },
      hiddenRootCount: 0,
    },
    focusedRun: {
      runId: 'run-1',
      title: 'oracle-review',
      agentName: 'oracle',
      status: 'completed',
      model: 'test/model',
      elapsedText: '00:42',
      usageText: 'in:35k out:332',
      toolCount: 3,
      latestEvents: [
        { type: 'status', summary: 'status: streaming' },
        {
          type: 'tool_activity',
          summary: 'tool read activity',
          toolName: 'read',
        },
        { type: 'activity', summary: 'activity observed' },
      ],
      hiddenEventCount: 0,
      children: [],
      hiddenChildCount: 0,
    },
    ...overrides,
  };
}

describe('omo subagent tool renderer', () => {
  test('renderCall omits task and message prompt', () => {
    const lines = renderOmoSubagentCallLines(
      {
        pool: 'spawn',
        id: 'oracle-review',
        agent: 'oracle',
        task: 'SECRET_TASK_PROMPT_SENTINEL',
        message: 'SECRET_SEND_MESSAGE_SENTINEL',
      },
      { width: 120 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('omo_subagent spawn oracle-review (oracle)');
    expect(rendered).not.toContain('SECRET_TASK_PROMPT_SENTINEL');
    expect(rendered).not.toContain('SECRET_SEND_MESSAGE_SENTINEL');
  });

  test('spawn collapsed result does not duplicate the tool call line', () => {
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          focusedRun: {
            ...details().focusedRun!,
            status: 'starting',
            elapsedText: '00:00',
            toolCount: 0,
          },
        }),
      },
      { expanded: false, width: 120 },
    );
    expect(lines).toEqual([]);
  });
  test('collapsed result is at most 3 lines and uses bounded summaries', () => {
    const lines = renderOmoSubagentResultLines(
      { details: details({ action: 'send' }) },
      { expanded: false, width: 120 },
    );
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toContain('Subagent oracle-review');
    expect(lines.join('\n')).toContain('tool read activity');
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  test('collapsed result shows child summary within line budget', () => {
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          action: 'send',
          focusedRun: {
            ...details().focusedRun!,
            latestEvents: [],
            children: [
              {
                runId: 'child',
                title: 'nested-search',
                agentName: 'search',
                status: 'completed',
                elapsedText: '00:12',
                toolCount: 1,
                children: [],
                hiddenChildCount: 0,
              },
            ],
            hiddenChildCount: 1,
          },
        }),
      },
      { expanded: false, width: 120 },
    );
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join('\n')).toContain('+2 child runs');
  });

  test('expanded result shows metadata, +N more events, and +N more children', () => {
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          focusedRun: {
            ...details().focusedRun!,
            hiddenEventCount: 2,
            children: [
              {
                runId: 'child',
                title: 'nested-search',
                agentName: 'search',
                status: 'completed',
                elapsedText: '00:12',
                toolCount: 1,
                children: [],
                hiddenChildCount: 0,
              },
            ],
            hiddenChildCount: 3,
          },
        }),
      },
      { expanded: true, width: 120 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('Subagent oracle-review (oracle)');
    expect(rendered).toContain('model: test/model');
    expect(rendered).toContain('usage: in:35k out:332');
    expect(rendered).toContain('+2 earlier events');
    expect(rendered).toContain('+3 more children');
  });

  test('missing details falls back to normal text', () => {
    expect(
      renderOmoSubagentResultLines({
        content: [{ type: 'text', text: 'fallback' }],
      }),
    ).toEqual(['fallback']);
  });

  test('renderer preserves unicode text and strips control characters', () => {
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          action: 'send',
          focusedRun: {
            ...details().focusedRun!,
            title: '实现 子代理\u0007',
            latestEvents: [
              { type: 'activity', summary: '完成 中文摘要\u0007' },
            ],
          },
        }),
      },
      { expanded: false, width: 120 },
    );

    const rendered = lines.join('\n');
    expect(rendered).toContain('实现 子代理');
    expect(rendered).toContain('完成 中文摘要');
    expect(rendered).not.toContain('\u0007');
    expect(rendered).not.toContain('????');
  });

  test('renderer does not render raw prompt/message sentinels', () => {
    const lines = renderOmoSubagentResultLines(
      {
        content: [{ type: 'text', text: 'SECRET_CONTENT_SENTINEL' }],
        details: details(),
      },
      { expanded: true, width: 120 },
    );
    expect(lines.join('\n')).not.toContain('SECRET_CONTENT_SENTINEL');
  });

  test('narrow width rendering does not exceed width', () => {
    const width = 24;
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          focusedRun: {
            ...details().focusedRun!,
            title: 'very-long-subagent-title-that-must-be-clipped',
          },
        }),
      },
      { expanded: true, width },
    );
    expect(lines.every((line) => line.length <= width)).toBe(true);
  });

  test('no-focus summary labels hidden roots as subagents', () => {
    const lines = renderOmoSubagentResultLines(
      {
        details: details({
          focusedRun: undefined,
          summary: {
            roots: [
              {
                runId: 'root-1',
                title: 'root-1',
                agentName: 'oracle',
                status: 'completed',
                elapsedText: '00:01',
                toolCount: 0,
                children: [],
                hiddenChildCount: 0,
              },
            ],
            counts: {
              total: 3,
              running: 0,
              completed: 3,
              failed: 0,
              dead: 0,
            },
            hiddenRootCount: 2,
          },
        }),
      },
      { expanded: true, width: 120 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('+2 more subagents');
    expect(rendered).not.toContain('+2 more children');
  });
});
