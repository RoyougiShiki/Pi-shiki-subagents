import { describe, expect, test } from 'bun:test';
import type {
  SubagentRunTreeView,
  SubagentRunViewNode,
} from './subagent-run-view';
import { renderSubagentRunWidgetLines } from './subagent-run-widget-lines';

function node(
  overrides: Partial<SubagentRunViewNode> = {},
): SubagentRunViewNode {
  const displayName =
    overrides.displayName ??
    (typeof overrides.title === 'string' ? overrides.title : 'oracle');
  return {
    runId: 'run-1',
    agentName: 'oracle',
    displayName,
    depth: 0,
    status: 'streaming',
    title: overrides.title ?? `${displayName}`,
    taskPreview: 'SECRET PROMPT should not render',
    startedAt: 100,
    elapsedText: '00:05',
    toolCount: 1,
    recentLines: ['read: src/file.ts'],
    children: [],
    ...overrides,
    displayName:
      overrides.displayName ??
      (typeof overrides.title === 'string' ? overrides.title : displayName),
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


describe('subagent run widget lines', () => {
  test('returns empty lines for no subagents', () => {
    expect(renderSubagentRunWidgetLines(view([]), { now: 1000 })).toEqual([]);
  });

  test('keeps title and inline metadata in portable TUI text', () => {
    const lines = renderSubagentRunWidgetLines(view([node()]), {
      now: 1000,
      width: 96,
    });
    expect(lines).toEqual([
      'Subagents · 1 running',
      '00:05 · oracle · running',
    ]);
  });

  test('omits body title when the host already paints the widget key', () => {
    const lines = renderSubagentRunWidgetLines(view([node()]), {
      now: 1000,
      width: 96,
      includeTitle: false,
    });
    expect(lines).toEqual(['1 running', '00:05 · oracle · running']);
  });

  test('does not render recent activity lines or asterisk bullets', () => {
    const lines = renderSubagentRunWidgetLines(
      view([node({ recentLines: ['streaming', 'read: src/file.ts'] })]),
      { now: 1000, width: 96 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('running');
    expect(rendered).not.toContain('*');
    expect(rendered).not.toContain('> streaming');
    expect(rendered).not.toContain('read: src/file.ts');
  });

  test('renders nested hot children under maxDepth without role parentheses', () => {
    const parent = node({
      runId: 'parent',
      displayName: 'parent',
      title: 'parent',
      children: [
        node({
          runId: 'child',
          displayName: 'child',
          title: 'child',
          recentLines: [],
        }),
      ],
    });
    const lines = renderSubagentRunWidgetLines(view([parent]), {
      now: 1000,
      width: 96,
      maxLines: 8,
      maxDepth: 2,
    });
    expect(lines.some((line) => line.includes('parent'))).toBe(true);
    expect(lines.some((line) => line.includes('child'))).toBe(true);
    expect(lines.join('\n')).not.toContain('(main)');
    expect(lines.join('\n')).not.toContain('(oracle)');
  });

  test('truncates long lines to width', () => {
    const lines = renderSubagentRunWidgetLines(
      view([node({ displayName: 'a'.repeat(80), title: 'a'.repeat(80) })]),
      { now: 1000, width: 30 },
    );
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });

  test('line budget produces more summary', () => {
    const roots = [0, 1, 2, 3].map((index) =>
      node({
        runId: `run-${index}`,
        displayName: `run-${index}`,
        title: `run-${index}`,
        recentLines: [],
      }),
    );
    const lines = renderSubagentRunWidgetLines(view(roots), {
      now: 1000,
      width: 96,
      maxLines: 3,
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]?.trim()).toBe('+3 more');
  });

  test('reserves more summary when line budget is tight', () => {
    const roots = [0, 1, 2].map((index) =>
      node({
        runId: `run-${index}`,
        displayName: `run-${index}`,
        title: `run-${index}`,
        recentLines: index === 0 ? ['recent detail'] : [],
      }),
    );
    const lines = renderSubagentRunWidgetLines(view(roots), {
      now: 1000,
      width: 96,
      maxLines: 3,
    });

    expect(lines).toEqual([
      'Subagents · 3 running',
      '00:05 · run-0 · running',
      '+2 more',
    ]);
  });

  test('does not render taskPreview', () => {
    const lines = renderSubagentRunWidgetLines(view([node()]), {
      now: 1000,
      width: 120,
    });
    expect(lines.join('\n')).not.toContain('SECRET PROMPT');
  });

  test('hides inactive runs after ttl', () => {
    const completed = node({
      status: 'completed',
      completedAt: 1000,
      recentLines: [],
    });
    expect(
      renderSubagentRunWidgetLines(view([completed]), {
        now: 5000,
        ttlMs: 10_000,
      }),
    ).not.toEqual([]);
    expect(
      renderSubagentRunWidgetLines(view([completed]), {
        now: 20_000,
        ttlMs: 10_000,
      }),
    ).toEqual([]);
  });

  test('header excludes expired inactive runs when active run keeps widget visible', () => {
    const expired = node({
      runId: 'expired',
      displayName: 'expired completed',
      title: 'expired completed',
      status: 'completed',
      completedAt: 1000,
      recentLines: [],
    });
    const active = node({
      runId: 'active',
      displayName: 'active streaming',
      title: 'active streaming',
      recentLines: [],
    });
    const lines = renderSubagentRunWidgetLines(view([expired, active]), {
      now: 20_000,
      ttlMs: 10_000,
      width: 96,
    });

    expect(lines[0]).toBe('Subagents · 1 running');
    expect(lines.join('\n')).not.toContain('done');
    expect(lines.join('\n')).not.toContain('expired completed');
  });

  test('preserves unicode text while removing control characters before truncation', () => {
    const lines = renderSubagentRunWidgetLines(
      view([
        node({
          displayName: '审查 oracle 非ASCII\u0007',
          title: '审查 oracle 非ASCII\u0007',
          recentLines: ['读取 文件 内容'],
        }),
      ]),
      { now: 1000, width: 96 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('审查');
    expect(rendered).not.toContain('\u0007');
    expect(rendered).not.toContain('????');
    expect(rendered).not.toContain('读取');
  });

  test('shows active descendants under expired inactive parents', () => {
    const expiredParent = node({
      runId: 'expired-parent',
      displayName: 'expired parent',
      title: 'expired parent',
      status: 'completed',
      completedAt: 1000,
      recentLines: [],
      children: [
        node({
          runId: 'active-child',
          displayName: 'active child',
          title: 'active child',
          recentLines: [],
        }),
      ],
    });

    const lines = renderSubagentRunWidgetLines(view([expiredParent]), {
      now: 20_000,
      ttlMs: 10_000,
      width: 96,
      maxDepth: 2,
    });

    expect(lines.join('\n')).toContain('active child');
    expect(lines.join('\n')).not.toContain('expired parent');
  });

  test('prioritizes active runs over ttl-visible inactive runs', () => {
    const inactive = node({
      runId: 'inactive',
      displayName: 'inactive completed',
      title: 'inactive completed',
      status: 'completed',
      completedAt: 900,
      recentLines: [],
    });
    const active = node({
      runId: 'active',
      displayName: 'active streaming',
      title: 'active streaming',
      recentLines: [],
    });

    const lines = renderSubagentRunWidgetLines(view([inactive, active]), {
      now: 1000,
      ttlMs: 10_000,
      width: 96,
    });

    const activeIndex = lines.findIndex((line) =>
      line.includes('active streaming'),
    );
    const inactiveIndex = lines.findIndex((line) =>
      line.includes('inactive completed'),
    );
    expect(activeIndex).toBeGreaterThan(0);
    expect(inactiveIndex).toBeGreaterThan(activeIndex);
  });

  test('idle-only live sessions use count-only compact form', () => {
    const idleA = node({
      runId: 'idle-a',
      displayName: 'search',
      title: 'search',
      status: 'idle',
      recentLines: ['should not render'],
    });
    const idleB = node({
      runId: 'idle-b',
      displayName: 'fixer',
      title: 'fixer',
      status: 'idle',
      recentLines: [],
    });
    const lines = renderSubagentRunWidgetLines(view([idleA, idleB]), {
      now: 1000,
      width: 96,
    });
    expect(lines).toEqual(['Subagents · 2 idle']);
  });

  test('idle compact keeps ttl terminal counts without expanding rows', () => {
    const idle = node({
      runId: 'idle-1',
      displayName: 'search',
      title: 'search',
      status: 'idle',
      recentLines: [],
    });
    const completed = node({
      runId: 'done-1',
      displayName: 'oracle',
      title: 'oracle',
      status: 'completed',
      completedAt: 900,
      recentLines: ['finished detail'],
    });
    const lines = renderSubagentRunWidgetLines(view([idle, completed]), {
      now: 1000,
      ttlMs: 10_000,
      width: 96,
    });
    expect(lines).toEqual(['Subagents · 1 idle · 1 done']);
  });

  test('hot runs keep multi-line projection with inline metadata', () => {
    const streaming = node({
      runId: 'hot',
      displayName: 'search',
      title: 'search',
      status: 'streaming',
      recentLines: [],
    });
    const idle = node({
      runId: 'idle',
      displayName: 'fixer',
      title: 'fixer',
      status: 'idle',
      recentLines: [],
    });
    const lines = renderSubagentRunWidgetLines(view([streaming, idle]), {
      now: 1000,
      width: 96,
    });
    expect(lines).toEqual([
      'Subagents · 1 running · 1 idle',
      '00:05 · search · running',
      '00:05 · fixer · idle',
    ]);
  });

  test('puts compact tokens with status on the right cluster', () => {
    const lines = renderSubagentRunWidgetLines(
      view([
        node({
          displayName: 'gui-widget-probe',
          usageText: 'in:1.2k out:800',
        }),
      ]),
      { now: 1000, width: 96 },
    );
    expect(lines[1]).toBe(
      '00:05 · gui-widget-probe · in:1.2k out:800 · running',
    );
  });
});
