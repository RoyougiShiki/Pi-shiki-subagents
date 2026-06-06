import { describe, expect, test } from 'bun:test';
import {
  extractUsageSnapshot,
  toSubagentRunEvents,
} from './subagent-run-adapter';

const context = { runId: 'run-1', agentName: 'oracle', now: () => 123 };

describe('subagent run adapter', () => {
  test('maps turn_start to streaming status', () => {
    expect(toSubagentRunEvents(context, { type: 'turn_start' })).toEqual([
      { type: 'status', runId: 'run-1', timestamp: 123, status: 'streaming' },
    ]);
  });

  test('maps agent_end to idle and assistant summary', () => {
    expect(
      toSubagentRunEvents(context, {
        type: 'agent_end',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'ignore' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
      }),
    ).toEqual([
      { type: 'status', runId: 'run-1', timestamp: 123, status: 'idle' },
      { type: 'assistant_text', runId: 'run-1', timestamp: 123, text: 'done' },
    ]);
  });

  test('maps assistant message_end usage when present', () => {
    expect(
      toSubagentRunEvents(context, {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          usage: { input: 1000, output: 200, cost: { total: 0.01 } },
        },
      }),
    ).toEqual([
      {
        type: 'assistant_text',
        runId: 'run-1',
        timestamp: 123,
        text: 'answer',
      },
      {
        type: 'usage',
        runId: 'run-1',
        timestamp: 123,
        usage: { input: 1000, output: 200, cost: 0.01 },
      },
    ]);
  });

  test('ignores unknown and malformed events', () => {
    expect(
      toSubagentRunEvents(context, { type: 'unknown', raw: { nested: true } }),
    ).toEqual([]);
    expect(toSubagentRunEvents(context, null)).toEqual([]);
  });

  test('maps tool events to sanitized summaries', () => {
    expect(
      toSubagentRunEvents(context, {
        type: 'tool_call',
        name: 'bash',
        args: { command: 'cat secret-token && echo done' },
      }),
    ).toEqual([
      {
        type: 'tool_call',
        runId: 'run-1',
        timestamp: 123,
        toolName: 'bash',
        summary: 'command',
      },
    ]);
    expect(
      toSubagentRunEvents(context, {
        type: 'tool_result',
        toolName: 'read',
        args: { path: 'src/file.ts' },
        isError: true,
      }),
    ).toEqual([
      {
        type: 'tool_result',
        runId: 'run-1',
        timestamp: 123,
        toolName: 'read',
        summary: 'src/file.ts',
        isError: true,
      },
    ]);
  });

  test('extracts alternate usage field names defensively', () => {
    expect(
      extractUsageSnapshot({
        inputTokens: 11,
        completionTokens: 22,
        cache_read: 33,
        cacheWrite: 44,
        context_tokens: 55,
        turns: 2,
      }),
    ).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      contextTokens: 55,
      turns: 2,
    });
  });
});
