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
  includeTitle?: boolean;
}

const DEFAULT_WIDTH = 72;
const DEFAULT_MAX_LINES = 6;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_TTL_MS = 10_000;

function toPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function sanitizeLabel(text: string): string {
  return text
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

function visibleWidth(text: string): number {
  return text.length;
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return '~';
  return `${text.slice(0, Math.max(0, width - 1))}~`;
}


function isHot(node: SubagentRunViewNode): boolean {
  return node.status === 'starting' || node.status === 'streaming';
}

function isLive(node: SubagentRunViewNode): boolean {
  return isHot(node) || node.status === 'idle';
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
    if (isLive(node)) activeItems.push({ node, depth });
    else if (isTtlVisible(node, now, ttlMs))
      inactiveItems.push({ node, depth });
    activeItems.push(...children.filter((item) => isLive(item.node)));
    inactiveItems.push(...children.filter((item) => !isLive(item.node)));
  }

  return [...activeItems, ...inactiveItems];
}

function nodeName(node: SubagentRunViewNode): string {
  // Display/spawn name only — no (role) suffix in chrome.
  const name = sanitizeLabel(node.displayName || node.title || node.runId);
  return name || node.runId;
}

function compactTokens(usageText: string | undefined): string | undefined {
  if (!usageText) return undefined;
  const cleaned = usageText.replace(/[\t\r\n]+/g, ' ').trim();
  if (!cleaned) return undefined;
  // Prefer in/out token fragments when present.
  const tokenBits = cleaned
    .split(/\s+/)
    .filter((part) => /^(in:|out:|↑|↓|R|W|\$|ctx:|\d)/.test(part));
  const picked = (tokenBits.length > 0 ? tokenBits : cleaned.split(/\s+/))
    .slice(0, 4)
    .join(' ');
  return picked.length > 24 ? `${picked.slice(0, 23)}~` : picked;
}

function statusLabel(status: SubagentRunViewNode['status']): string {
  if (status === 'starting') return 'starting';
  if (status === 'streaming') return 'running';
  if (status === 'idle') return 'idle';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'dead';
}

function nodeLine(
  node: SubagentRunViewNode,
  depth: number,
  width: number,
): string {
  const indent = '  '.repeat(depth);
  const separator = ' · ';
  const tokens = compactTokens(node.usageText);
  const status = statusLabel(node.status);
  // Format: elapsed · name [· tokens] · status
  const prefix = node.elapsedText;
  const middle = tokens ? `${separator}${tokens}` : '';
  const suffix = status;
  const fixedWidth =
    visibleWidth(indent) +
    visibleWidth(prefix) +
    visibleWidth(separator) +
    visibleWidth(middle) +
    visibleWidth(separator) +
    visibleWidth(suffix);
  const nameWidth = Math.max(1, width - fixedWidth);
  const name = truncateToWidth(nodeName(node), nameWidth);
  return truncateToWidth(
    `${indent}${prefix}${separator}${name}${middle}${separator}${suffix}`,
    width,
  );
}

function visibleSummary(
  visible: ReadonlyArray<{ node: SubagentRunViewNode; depth: number }>,
): string {
  const hot = visible.filter((item) => isHot(item.node)).length;
  const idle = visible.filter((item) => item.node.status === 'idle').length;
  const completed = visible.filter(
    (item) => item.node.status === 'completed',
  ).length;
  const failed = visible.filter((item) => item.node.status === 'failed').length;
  const dead = visible.filter((item) => item.node.status === 'dead').length;
  const parts: string[] = [];
  if (hot > 0) parts.push(`${hot} running`);
  if (idle > 0) parts.push(`${idle} idle`);
  if (completed > 0) parts.push(`${completed} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (dead > 0) parts.push(`${dead} dead`);
  return parts.length > 0 ? parts.join(' · ') : 'none';
}

function headerLine(
  summary: string,
  width: number,
  includeTitle: boolean,
): string {
  return truncateToWidth(
    includeTitle ? `Subagents · ${summary}` : summary,
    width,
  );
}

function shouldUseIdleCompactForm(
  visible: ReadonlyArray<{ node: SubagentRunViewNode; depth: number }>,
): boolean {
  const live = visible.filter((item) => isLive(item.node));
  return live.length > 0 && live.every((item) => item.node.status === 'idle');
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
  const includeTitle = options.includeTitle ?? true;

  const visible = flattenWidgetNodes(view.roots, now, ttlMs, maxDepth);
  if (visible.length === 0) return [];

  const summary = visibleSummary(visible);

  // Idle Compact Form: live sessions are only idle (UI density; not agent state).
  if (shouldUseIdleCompactForm(visible)) {
    return [headerLine(summary, width, includeTitle)];
  }

  const lines = [headerLine(summary, width, includeTitle)];
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

    lines.push(nodeLine(item.node, item.depth, width));
    renderedNodes++;
  }

  const hidden = Math.max(0, visible.length - renderedNodes);
  if (hidden > 0) {
    const more = truncateToWidth(`+${hidden} more`, width);
    if (lines.length >= maxLines) lines[lines.length - 1] = more;
    else lines.push(more);
  }

  return lines.slice(0, maxLines);
}
