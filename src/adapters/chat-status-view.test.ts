import { describe, expect, test } from 'bun:test';
import { createChatStatusView, groupChatStatusViews } from '../pi/subagent/chat-status-view';

describe('chat status view', () => {
  test('formats a workflow agent list row and bottom line', () => {
    const view = createChatStatusView({
      name: 'thinker',
      state: 'working',
      scope: 'workflow',
      startedAt: 1_000,
      now: 313_000,
    });

    expect(view.listRow).toBe('thinker · working · 05:12');
    expect(view.bottomLine).toBe('thinker · working · workflow');
  });

  test('formats pool agent status without workflow details', () => {
    const view = createChatStatusView({
      name: 'fixer-1',
      state: 'idle',
      scope: 'pool',
      startedAt: 0,
      now: 130_000,
    });

    expect(view.listRow).toBe('fixer-1 · idle · 02:10');
    expect(view.bottomLine).toBe('fixer-1 · idle · pool');
  });

  test('adds fallback hint for failed or dead agents only in bottom line', () => {
    const failed = createChatStatusView({ name: 'thinker', state: 'failed', scope: 'workflow' });
    const dead = createChatStatusView({ name: 'worker', state: 'dead', scope: 'workflow' });

    expect(failed.listRow).toBe('thinker · failed');
    expect(failed.bottomLine).toBe('thinker · failed · workflow · fallback?');
    expect(dead.bottomLine).toBe('worker · dead · workflow · fallback?');
  });

  test('groups status rows by scope order', () => {
    const workflow = createChatStatusView({ name: 'thinker', state: 'working', scope: 'workflow' });
    const pool = createChatStatusView({ name: 'fixer-1', state: 'idle', scope: 'pool' });
    const standalone = createChatStatusView({ name: 'explorer-1', state: 'idle', scope: 'standalone' });

    const groups = groupChatStatusViews([pool, standalone, workflow]);

    expect(groups.map((group) => group.title)).toEqual(['Workflow', 'Pool', 'Standalone']);
    expect(groups[0].items[0].listRow).toBe('thinker · working');
    expect(groups[1].items[0].listRow).toBe('fixer-1 · idle');
    expect(groups[2].items[0].listRow).toBe('explorer-1 · idle');
  });
});
