import { describe, expect, mock, test } from 'bun:test';
import type { SubagentRunTreeView } from './subagent-run-view';
import {
  disposeRegisteredSubagentRunWidget,
  ensureSubagentRunWidgetRegistered,
  registerSubagentRunWidget,
} from './subagent-run-widget';

function emptyView(): SubagentRunTreeView {
  return {
    roots: [],
    counts: { total: 0, running: 0, completed: 0, failed: 0, dead: 0 },
    summaryLine: 'no subagents',
  };
}

function activeView(): SubagentRunTreeView {
  return {
    roots: [
      {
        runId: 'run-1',
        agentName: 'oracle',
        displayName: 'oracle',
        depth: 0,
        status: 'streaming',
        title: 'oracle (oracle)',
        startedAt: 100,
        elapsedText: '00:05',
        toolCount: 1,
        recentLines: ['thinking'],
        children: [],
      },
    ],
    counts: { total: 1, running: 1, completed: 0, failed: 0, dead: 0 },
    summaryLine: '1 running',
  };
}

describe('subagent run widget runtime', () => {
  test('clears widget when there are no visible lines', () => {
    let listener: (() => void) | undefined;
    let currentView = activeView();
    const setWidget = mock(() => {});
    const pool = {
      getRunTreeView: mock(() => currentView),
      onRunStateChange: mock((cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const widget = registerSubagentRunWidget({ ui: { setWidget } }, pool, {
      now: () => 1000,
      refreshMs: false,
    });
    expect(setWidget.mock.calls[0]?.[1]).toBeArray();

    currentView = emptyView();
    listener?.();

    expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
    widget.dispose();
  });

  test('avoids redundant setWidget calls for unchanged lines', () => {
    let listener: (() => void) | undefined;
    const setWidget = mock(() => {});
    const pool = {
      getRunTreeView: mock(() => activeView()),
      onRunStateChange: mock((cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const widget = registerSubagentRunWidget({ ui: { setWidget } }, pool, {
      now: () => 1000,
      refreshMs: false,
    });
    listener?.();

    expect(setWidget.mock.calls).toHaveLength(1);
    widget.dispose();
  });

  test('uses semantic snapshot and does not mutate pool state', () => {
    let listener: (() => void) | undefined;
    const view = activeView();
    const before = JSON.stringify(view);
    const setWidget = mock(() => {});
    const pool = {
      getRunTreeView: mock(() => view),
      onRunStateChange: mock((cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const widget = registerSubagentRunWidget({ ui: { setWidget } }, pool, {
      now: () => 1000,
      refreshMs: false,
    });
    listener?.();

    expect(pool.getRunTreeView).toHaveBeenCalledWith({ now: 1000 });
    expect(JSON.stringify(view)).toBe(before);
    expect(setWidget.mock.calls[0]?.[1]?.join('\n')).toContain('Subagents');
    widget.dispose();
  });

  test('dispose unsubscribes and clears visible widget', () => {
    let listener: (() => void) | undefined;
    let unsubscribeCalled = false;
    const setWidget = mock(() => {});
    const pool = {
      getRunTreeView: mock(() => activeView()),
      onRunStateChange: mock((cb: () => void) => {
        listener = cb;
        return () => {
          unsubscribeCalled = true;
          listener = undefined;
        };
      }),
    };

    const widget = registerSubagentRunWidget({ ui: { setWidget } }, pool, {
      now: () => 1000,
      refreshMs: false,
    });
    widget.dispose();

    expect(unsubscribeCalled).toBe(true);
    expect(listener).toBeUndefined();
    expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  test('stops refresh timer after widget becomes inactive', async () => {
    let listener: (() => void) | undefined;
    let currentView = activeView();
    const setWidget = mock(() => {});
    const getRunTreeView = mock(() => currentView);
    const pool = {
      getRunTreeView,
      onRunStateChange: mock((cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      }),
    };

    const widget = registerSubagentRunWidget({ ui: { setWidget } }, pool, {
      now: () => 1000,
      refreshMs: 250,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getRunTreeView.mock.calls.length).toBeGreaterThan(1);

    currentView = emptyView();
    listener?.();
    const callsAfterClear = getRunTreeView.mock.calls.length;
    expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getRunTreeView.mock.calls.length).toBe(callsAfterClear);
    widget.dispose();
  });

  test('shared ensure lazily registers once and force replaces widget', () => {
    let unsubscribeCount = 0;
    const setWidget = mock(() => {});
    const pool = {
      getRunTreeView: mock(() => activeView()),
      onRunStateChange: mock((_cb: () => void) => {
        return () => {
          unsubscribeCount++;
        };
      }),
    };

    const first = ensureSubagentRunWidgetRegistered(
      { ui: { setWidget } },
      pool,
      { refreshMs: false },
    );
    const second = ensureSubagentRunWidgetRegistered(
      { ui: { setWidget } },
      pool,
      { refreshMs: false },
    );

    expect(second).toBe(first);
    expect(pool.onRunStateChange).toHaveBeenCalledTimes(1);

    const replacement = ensureSubagentRunWidgetRegistered(
      { ui: { setWidget } },
      pool,
      { refreshMs: false, force: true },
    );

    expect(replacement).not.toBe(first);
    expect(unsubscribeCount).toBe(1);
    expect(pool.onRunStateChange).toHaveBeenCalledTimes(2);

    disposeRegisteredSubagentRunWidget();
  });
});
