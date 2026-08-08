import { Text } from '@earendil-works/pi-tui';
import type { OmoSubagentToolDetailsV1 } from './subagent-run-tool-details';
import { isOmoSubagentToolDetailsV1 } from './subagent-run-tool-details';

interface ThemeLike {
  fg?: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

interface RenderResultOptions {
  expanded?: boolean;
}

export interface RenderOmoSubagentToolLinesOptions {
  expanded?: boolean;
  width?: number;
}

const DEFAULT_WIDTH = 100;
const COLLAPSED_EVENT_LIMIT = 2;
const COLLAPSED_LINE_LIMIT = 3;

function sanitizeAscii(value: string): string {
  return value
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(line: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const sanitized = sanitizeAscii(line);
  if (sanitized.length <= safeWidth) return sanitized;
  if (safeWidth === 1) return '~';
  return `${sanitized.slice(0, safeWidth - 1)}~`;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function statusCounts(details: OmoSubagentToolDetailsV1): string {
  const parts: string[] = [];
  if (details.summary.counts.running)
    parts.push(`${details.summary.counts.running} running`);
  if (details.summary.counts.completed)
    parts.push(`${details.summary.counts.completed} completed`);
  if (details.summary.counts.failed)
    parts.push(`${details.summary.counts.failed} failed`);
  if (details.summary.counts.dead)
    parts.push(`${details.summary.counts.dead} dead`);
  return parts.length ? parts.join(', ') : 'no subagents';
}

function fallbackText(result: ToolResultLike): string {
  const text = result.content?.find((part) => part.type === 'text')?.text;
  return text || '(no output)';
}

function focusedHeader(details: OmoSubagentToolDetailsV1): string {
  const run = details.focusedRun;
  if (!run) return `Subagents: ${statusCounts(details)}`;
  const parts = [
    `Subagent ${run.title}`,
    run.status,
    plural(run.toolCount, 'tool'),
    run.elapsedText,
  ];
  if (run.usageText) parts.splice(3, 0, run.usageText);
  return parts.join(' | ');
}

function renderSpawnCollapsed(
  details: OmoSubagentToolDetailsV1,
): string[] | undefined {
  const run = details.focusedRun;
  if (details.action !== 'spawn' || !run) return undefined;
  return [];
}

function renderCollapsed(details: OmoSubagentToolDetailsV1): string[] {
  const run = details.focusedRun;
  if (!run) return [`Subagents: ${statusCounts(details)}`];
  const spawnLines = renderSpawnCollapsed(details);
  if (spawnLines) return spawnLines;
  const lines = [focusedHeader(details)];
  for (const event of run.latestEvents.slice(-COLLAPSED_EVENT_LIMIT)) {
    if (lines.length >= COLLAPSED_LINE_LIMIT) break;
    lines.push(`  > ${event.summary}`);
  }
  if (lines.length < COLLAPSED_LINE_LIMIT) {
    const hiddenChildren = run.hiddenChildCount;
    const shownChildren = run.children.length;
    const totalChildren = shownChildren + hiddenChildren;
    if (totalChildren > 0)
      lines.push(
        `  +${totalChildren} child run${totalChildren === 1 ? '' : 's'}`,
      );
  }
  return lines.slice(0, COLLAPSED_LINE_LIMIT);
}

function renderSummaryChildLines(
  children: OmoSubagentToolDetailsV1['summary']['roots'],
  hiddenCount: number,
  hiddenLabel = 'children',
): string[] {
  const lines = children.map(
    (child) => `  * ${child.title} | ${child.status} | ${child.elapsedText}`,
  );
  if (hiddenCount > 0) lines.push(`  +${hiddenCount} more ${hiddenLabel}`);
  return lines;
}

function renderExpanded(details: OmoSubagentToolDetailsV1): string[] {
  const run = details.focusedRun;
  if (!run) {
    const lines = [`Subagents: ${statusCounts(details)}`];
    lines.push(
      ...renderSummaryChildLines(
        details.summary.roots,
        details.summary.hiddenRootCount,
        'subagents',
      ),
    );
    return lines;
  }

  const lines = [
    `Subagent ${run.title} (${run.agentName})`,
    `status: ${run.status}`,
  ];
  if (run.model) lines.push(`model: ${run.model}`);
  if (run.usageText) lines.push(`usage: ${run.usageText}`);
  lines.push(`elapsed: ${run.elapsedText}`);
  lines.push('');
  lines.push('Events:');
  if (run.hiddenEventCount > 0)
    lines.push(`  +${run.hiddenEventCount} earlier events`);
  if (run.latestEvents.length === 0) lines.push('  (no recent events)');
  for (const event of run.latestEvents) lines.push(`  ${event.summary}`);
  if (run.children.length > 0 || run.hiddenChildCount > 0) {
    lines.push('');
    lines.push('Children:');
    lines.push(...renderSummaryChildLines(run.children, run.hiddenChildCount));
  }
  return lines;
}

export function renderOmoSubagentResultLines(
  result: ToolResultLike,
  options: RenderOmoSubagentToolLinesOptions = {},
): string[] {
  const width = options.width ?? DEFAULT_WIDTH;
  const details = result.details;
  const lines = isOmoSubagentToolDetailsV1(details)
    ? options.expanded
      ? renderExpanded(details)
      : renderCollapsed(details)
    : fallbackText(result).split('\n');
  return lines.map((line) => clip(line, width));
}

export function renderOmoSubagentCallLines(
  args: Record<string, unknown>,
  options: { width?: number } = {},
): string[] {
  const width = options.width ?? DEFAULT_WIDTH;
  const action = typeof args.pool === 'string' ? args.pool : 'call';
  const id =
    typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
  const agent =
    typeof args.agent === 'string' && args.agent.trim()
      ? args.agent.trim()
      : undefined;
  const parts = ['omo_subagent', action];
  if (id) parts.push(id);
  if (agent) parts.push(`(${agent})`);
  return [clip(parts.join(' '), width)];
}

export function renderOmoSubagentCall(
  args: Record<string, unknown>,
  _theme?: unknown,
): Text {
  return new Text(renderOmoSubagentCallLines(args).join('\n'), 0, 0);
}

export function renderOmoSubagentResult(
  result: ToolResultLike,
  options: RenderResultOptions,
  _theme?: unknown,
): Text {
  return new Text(
    renderOmoSubagentResultLines(result, { expanded: options.expanded }).join(
      '\n',
    ),
    0,
    0,
  );
}
