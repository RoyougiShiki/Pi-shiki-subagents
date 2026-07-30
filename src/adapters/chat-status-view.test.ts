import { describe, expect, test } from 'bun:test';
import {
  createChatStatusView,
  groupChatStatusViews,
} from '../pi/subagent/chat-status-view';

describe('chat status view', () => {
  test('formats pool agent status', () => {
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

  test('groups pool and standalone rows without workflow state', () => {
    const pool = createChatStatusView({
      name: 'fixer-1',
      state: 'idle',
      scope: 'pool',
    });
    const standalone = createChatStatusView({
      name: 'search-1',
      state: 'idle',
      scope: 'standalone',
    });

    const groups = groupChatStatusViews([standalone, pool]);

    expect(groups.map((group) => group.title)).toEqual(['Pool', 'Standalone']);
  });
});
