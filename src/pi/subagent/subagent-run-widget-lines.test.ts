import { describe, expect, test } from 'bun:test';
import type {
  SubagentRunTreeView,
  SubagentRunViewNode,
} from './subagent-run-view';
import { renderSubagentRunWidgetLines } from './subagent-run-widget-lines';

function node(
  overrides: Partial<SubagentRunViewNode> = {},
): SubagentRunViewNode {
  return {
    runId: 'run-1',
    agentName: 'oracle',
    displayName: 'oracle',
    depth: 0,
    status: 'streaming',
    title: 'oracle (oracle)',
    taskPreview: 'SECRET PROMPT should not render',
    startedAt: 100,
    elapsedText: '00:05',
    toolCount: 1,
    recentLines: ['read: src/file.ts'],
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

describe('subagent run widget lines', () => {
  test('returns empty lines for no subagents', () => {
    expect(renderSubagentRunWidgetLines(view([]), { now: 1000 })).toEqual([]);
  });

  test('renders active run compactly', () => {
    const lines = renderSubagentRunWidgetLines(view([node()]), {
      now: 1000,
      width: 80,
    });
    expect(lines[0]).toBe('Subagents: 1 running');
    expect(lines[1]).toContain('* oracle (oracle)');
    expect(lines[1]).toContain('streaming');
    expect(lines[2]).toContain('> read: src/file.ts');
  });

  test('filters duplicate status-only recent lines', () => {
    const lines = renderSubagentRunWidgetLines(
      view([node({ recentLines: ['streaming', 'read: src/file.ts'] })]),
      { now: 1000, width: 80 },
    );
    const rendered = lines.join('\n');
    expect(rendered).toContain('| streaming |');
    expect(rendered).not.toContain('> streaming');
    expect(rendered).toContain('> read: src/file.ts');
  });

  test('renders nested runs as indented tree lines', () => {
    const parent = node({
      runId: 'parent',
      title: 'parent (coordinator)',
      children: [
        node({ runId: 'child', title: 'child (oracle)', recentLines: [] }),
      ],
    });
    const lines = renderSubagentRunWidgetLines(view([parent]), {
      now: 1000,
      width: 80,
      maxLines: 8,
    });
    expect(lines.some((line) => line.includes('* parent (coordinator)'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('  * child (oracle)'))).toBe(
      true,
    );
  });

  test('truncates long lines to width', () => {
    const lines = renderSubagentRunWidgetLines(
      view([node({ title: 'a'.repeat(80) })]),
      { now: 1000, width: 30 },
    );
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });

  test('line budget produces more summary', () => {
    const roots = [0, 1, 2, 3].map((index) =>
      node({ runId: `run-${index}`, title: `run-${index}`, recentLines: [] }),
    );
    const lines = renderSubagentRunWidgetLines(view(roots), {
      now: 1000,
      width: 80,
      maxLines: 3,
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('more');
    expect(lines[2]).toBe('+3 more');
  });

  test('reserves more summary when recent lines consume budget', () => {
    const roots = [0, 1, 2].map((index) =>
      node({
        runId: `run-${index}`,
        title: `run-${index}`,
        recentLines: index === 0 ? ['recent detail'] : [],
      }),
    );
    const lines = renderSubagentRunWidgetLines(view(roots), {
      now: 1000,
      width: 80,
      maxLines: 3,
    });

    expect(lines).toEqual([
      'Subagents: 3 running',
      '* run-0 | streaming | 1 tool | 00:05',
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
      title: 'expired completed',
      status: 'completed',
      completedAt: 1000,
      recentLines: [],
    });
    const active = node({
      runId: 'active',
      title: 'active streaming',
      recentLines: [],
    });
    const lines = renderSubagentRunWidgetLines(view([expired, active]), {
      now: 20_000,
      ttlMs: 10_000,
      width: 80,
    });

    expect(lines[0]).toBe('Subagents: 1 running');
    expect(lines.join('\n')).not.toContain('completed');
    expect(lines.join('\n')).not.toContain('expired completed');
  });

  test('ascii-sanitizes wide text before truncation', () => {
    const lines = renderSubagentRunWidgetLines(
      view([
        node({ title: '审查 oracle 非ASCII', recentLines: ['读取 文件 内容'] }),
      ]),
      { now: 1000, width: 24 },
    );
    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines.join('\n')).not.toContain('审查');
    expect(lines.join('\n')).not.toContain('读取');
    for (const char of lines.join('\n')) {
      const code = char.charCodeAt(0);
      expect(code >= 0x20 || code === 0x0a).toBe(true);
      expect(code <= 0x7e || code === 0x0a).toBe(true);
    }
  });

  test('shows active descendants under expired inactive parents', () => {
    const expiredParent = node({
      runId: 'expired-parent',
      title: 'expired parent',
      status: 'completed',
      completedAt: 1000,
      recentLines: [],
      children: [
        node({ runId: 'active-child', title: 'active child', recentLines: [] }),
      ],
    });

    const lines = renderSubagentRunWidgetLines(view([expiredParent]), {
      now: 20_000,
      ttlMs: 10_000,
      width: 80,
    });

    expect(lines.join('\n')).toContain('active child');
    expect(lines.join('\n')).not.toContain('expired parent');
  });

  test('prioritizes active runs over ttl-visible inactive runs', () => {
    const inactive = node({
      runId: 'inactive',
      title: 'inactive completed',
      status: 'completed',
      completedAt: 900,
      recentLines: [],
    });
    const active = node({
      runId: 'active',
      title: 'active streaming',
      recentLines: [],
    });

    const lines = renderSubagentRunWidgetLines(view([inactive, active]), {
      now: 1000,
      ttlMs: 10_000,
      width: 80,
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
});
