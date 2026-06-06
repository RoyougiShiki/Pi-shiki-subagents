import type {
  SubagentRunTreeView,
  SubagentRunViewNode,
} from './subagent-run-view';

export interface SubagentRunWidgetLineOptions {
  now?: number;
  width?: number;
  maxLines?: number;
  maxDepth?: number;
  ttlMs?: number;
}

const DEFAULT_WIDTH = 80;
const DEFAULT_MAX_LINES = 8;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_TTL_MS = 10_000;

function toPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function sanitizeAscii(text: string): string {
  return text
    .replace(/↑/g, 'in:')
    .replace(/↓/g, 'out:')
    .replace(/·/g, '|')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\t\r\n]+/g, ' ');
}

function truncateLine(text: string, width: number): string {
  const sanitized = sanitizeAscii(text);
  if (sanitized.length <= width) return sanitized;
  if (width <= 1) return sanitized.slice(0, width);
  return `${sanitized.slice(0, width - 1)}~`;
}

function statusIcon(status: SubagentRunViewNode['status']): string {
  if (status === 'completed') return '+';
  if (status === 'failed') return 'x';
  if (status === 'dead') return '-';
  return '*';
}

function isActive(node: SubagentRunViewNode): boolean {
  return (
    node.status === 'starting' ||
    node.status === 'streaming' ||
    node.status === 'idle'
  );
}

function isInformativeRecentLine(line: string): boolean {
  return !/^(starting|streaming|idle|completed|failed|dead)$/i.test(
    line.trim(),
  );
}

function isTtlVisible(
  node: SubagentRunViewNode,
  now: number,
  ttlMs: number,
): boolean {
  if (typeof node.completedAt !== 'number') return false;
  return now - node.completedAt <= ttlMs;
}

function flattenWidgetNodes(
  nodes: readonly SubagentRunViewNode[],
  now: number,
  ttlMs: number,
  maxDepth: number,
  depth = 0,
): Array<{ node: SubagentRunViewNode; depth: number }> {
  const activeItems: Array<{ node: SubagentRunViewNode; depth: number }> = [];
  const inactiveItems: Array<{ node: SubagentRunViewNode; depth: number }> = [];

  for (const node of nodes) {
    const children =
      depth < maxDepth
        ? flattenWidgetNodes(node.children, now, ttlMs, maxDepth, depth + 1)
        : [];
    if (isActive(node)) activeItems.push({ node, depth });
    else if (isTtlVisible(node, now, ttlMs))
      inactiveItems.push({ node, depth });
    activeItems.push(...children.filter((item) => isActive(item.node)));
    inactiveItems.push(...children.filter((item) => !isActive(item.node)));
  }

  return [...activeItems, ...inactiveItems];
}

function nodeLine(node: SubagentRunViewNode, depth: number): string {
  const parts = [
    `${'  '.repeat(depth)}${statusIcon(node.status)} ${node.title}`,
    node.status,
  ];
  if (node.toolCount > 0)
    parts.push(`${node.toolCount} tool${node.toolCount === 1 ? '' : 's'}`);
  if (node.usageText) parts.push(node.usageText);
  parts.push(node.elapsedText);
  return parts.join(' · ');
}

function visibleSummary(
  visible: ReadonlyArray<{ node: SubagentRunViewNode; depth: number }>,
): string {
  const running = visible.filter((item) => isActive(item.node)).length;
  const completed = visible.filter(
    (item) => item.node.status === 'completed',
  ).length;
  const failed = visible.filter((item) => item.node.status === 'failed').length;
  const dead = visible.filter((item) => item.node.status === 'dead').length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (completed > 0) parts.push(`${completed} completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (dead > 0) parts.push(`${dead} dead`);
  return parts.length > 0 ? parts.join(' | ') : 'no subagents';
}

export function renderSubagentRunWidgetLines(
  view: SubagentRunTreeView,
  options: SubagentRunWidgetLineOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const width = toPositiveInteger(options.width, DEFAULT_WIDTH);
  const maxLines = toPositiveInteger(options.maxLines, DEFAULT_MAX_LINES);
  const maxDepth = toPositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const ttlMs = Math.max(0, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));

  const visible = flattenWidgetNodes(view.roots, now, ttlMs, maxDepth);
  if (visible.length === 0) return [];

  const lines = [truncateLine(`Subagents: ${visibleSummary(visible)}`, width)];
  let renderedNodes = 0;

  for (let index = 0; index < visible.length; index++) {
    const item = visible[index];
    const remainingNodes = visible.length - renderedNodes;
    const reserveMoreLine = remainingNodes > 1;
    if (
      lines.length >= maxLines ||
      (reserveMoreLine && lines.length >= maxLines - 1)
    )
      break;

    lines.push(truncateLine(nodeLine(item.node, item.depth), width));
    renderedNodes++;

    const recent = item.node.recentLines.find(isInformativeRecentLine);
    if (recent && item.depth < maxDepth) {
      const hasHiddenNodesAfterThis = visible.length - renderedNodes > 0;
      if (
        lines.length < maxLines &&
        (!hasHiddenNodesAfterThis || lines.length < maxLines - 1)
      ) {
        lines.push(
          truncateLine(`${'  '.repeat(item.depth + 1)}> ${recent}`, width),
        );
      }
    }
  }

  const hidden = Math.max(0, visible.length - renderedNodes);
  if (hidden > 0) {
    const more = truncateLine(`+${hidden} more`, width);
    if (lines.length >= maxLines) lines[lines.length - 1] = more;
    else lines.push(more);
  }

  return lines.slice(0, maxLines);
}
