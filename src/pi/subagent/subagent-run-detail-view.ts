import type { SubagentRunStatus } from './subagent-run-state';
import type { SubagentRunTreeView, SubagentRunViewNode } from './subagent-run-view';

export type SubagentToolAction =
  | 'spawn'
  | 'send'
  | 'list'
  | 'kill'
  | 'resume'
  | 'listSaved'
  | 'result';

export interface SubagentRunDetailEventView {
  type: string;
  summary: string;
  toolName?: string;
  isError?: boolean;
}

export interface SubagentRunSummaryNode {
  runId: string;
  title: string;
  agentName: string;
  status: SubagentRunStatus;
  elapsedText: string;
  usageText?: string;
  toolCount: number;
  children: SubagentRunSummaryNode[];
  hiddenChildCount: number;
}

export interface SubagentRunTreeSummaryView {
  roots: SubagentRunSummaryNode[];
  counts: SubagentRunTreeView['counts'];
  hiddenRootCount: number;
}

export interface SubagentRunDetailView {
  runId: string;
  title: string;
  agentName: string;
  status: SubagentRunStatus;
  model?: string;
  elapsedText: string;
  usageText?: string;
  toolCount: number;
  latestEvents: SubagentRunDetailEventView[];
  hiddenEventCount: number;
  children: SubagentRunSummaryNode[];
  hiddenChildCount: number;
}

export interface SubagentRunDetailViewOptions {
  eventLimit?: number;
  maxChildren?: number;
  maxDepth?: number;
  maxRoots?: number;
}

const DEFAULT_EVENT_LIMIT = 10;
const DEFAULT_MAX_CHILDREN = 5;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ROOTS = 5;

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function optionsWithDefaults(options: SubagentRunDetailViewOptions = {}) {
  return {
    eventLimit: positiveInteger(options.eventLimit, DEFAULT_EVENT_LIMIT),
    maxChildren: positiveInteger(options.maxChildren, DEFAULT_MAX_CHILDREN),
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxRoots: positiveInteger(options.maxRoots, DEFAULT_MAX_ROOTS),
  };
}

const FIELD_LIMITS = {
  runId: 80,
  title: 120,
  agentName: 80,
  model: 120,
  elapsedText: 32,
  usageText: 120,
};

function redactSensitiveMarkers(value: string): string {
  return value.replace(/SECRET[_A-Za-z0-9-]*SENTINEL/g, '[redacted]');
}

function truncateField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '~';
  return `${value.slice(0, maxChars - 1)}~`;
}

function sanitizeField(value: string | undefined, maxChars: number): string | undefined {
  const normalized = redactSensitiveMarkers(value ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  return truncateField(normalized, maxChars);
}

function requiredField(value: string | undefined, maxChars: number, fallback: string): string {
  return sanitizeField(value, maxChars) ?? fallback;
}

function safeToolName(line: string): string | undefined {
  const match = line.match(/^([a-z][a-z0-9_-]{0,40}):(?:\s|$)/);
  return match?.[1];
}

export function summarizeSubagentRunEventLine(
  line: string,
): SubagentRunDetailEventView {
  const normalized = sanitizeField(line, 160) ?? '';
  const toolName = safeToolName(normalized);
  if (toolName) {
    return {
      type: 'tool_activity',
      summary: `tool ${toolName} activity`,
      toolName,
      isError: /\berror\b|\bfailed\b/i.test(normalized),
    };
  }
  if (/^(starting|streaming|idle|completed|failed|dead)$/i.test(normalized)) {
    return { type: 'status', summary: `status: ${normalized.toLowerCase()}` };
  }
  return { type: 'activity', summary: 'activity observed' };
}

function boundedEvents(
  lines: readonly string[],
  eventLimit: number,
): { events: SubagentRunDetailEventView[]; hiddenEventCount: number } {
  const hiddenEventCount = Math.max(0, lines.length - eventLimit);
  return {
    events: lines.slice(-eventLimit).map(summarizeSubagentRunEventLine),
    hiddenEventCount,
  };
}

function findNode(
  nodes: readonly SubagentRunViewNode[],
  runId: string,
): SubagentRunViewNode | undefined {
  for (const node of nodes) {
    if (node.runId === runId) return node;
    const child = findNode(node.children, runId);
    if (child) return child;
  }
  return undefined;
}

function toSummaryNode(
  node: SubagentRunViewNode,
  depth: number,
  options: ReturnType<typeof optionsWithDefaults>,
): SubagentRunSummaryNode {
  const childBudget = depth < options.maxDepth ? options.maxChildren : 0;
  const children = node.children
    .slice(0, childBudget)
    .map((child) => toSummaryNode(child, depth + 1, options));
  return {
    runId: requiredField(node.runId, FIELD_LIMITS.runId, 'unknown'),
    title: requiredField(node.title, FIELD_LIMITS.title, 'unknown'),
    agentName: requiredField(node.agentName, FIELD_LIMITS.agentName, 'unknown'),
    status: node.status,
    elapsedText: requiredField(node.elapsedText, FIELD_LIMITS.elapsedText, '00:00'),
    usageText: sanitizeField(node.usageText, FIELD_LIMITS.usageText),
    toolCount: node.toolCount,
    children,
    hiddenChildCount: Math.max(0, node.children.length - childBudget),
  };
}

export function createSubagentRunTreeSummaryView(
  view: SubagentRunTreeView,
  options: SubagentRunDetailViewOptions = {},
): SubagentRunTreeSummaryView {
  const normalized = optionsWithDefaults(options);
  return {
    roots: view.roots
      .slice(0, normalized.maxRoots)
      .map((root) => toSummaryNode(root, 1, normalized)),
    counts: { ...view.counts },
    hiddenRootCount: Math.max(0, view.roots.length - normalized.maxRoots),
  };
}

export function createSubagentRunDetailView(
  view: SubagentRunTreeView,
  runId: string,
  options: SubagentRunDetailViewOptions = {},
): SubagentRunDetailView | undefined {
  const normalized = optionsWithDefaults(options);
  const node = findNode(view.roots, runId);
  if (!node) return undefined;
  const events = boundedEvents(node.recentLines, normalized.eventLimit);
  const childBudget = normalized.maxChildren;
  return {
    runId: requiredField(node.runId, FIELD_LIMITS.runId, 'unknown'),
    title: requiredField(node.title, FIELD_LIMITS.title, 'unknown'),
    agentName: requiredField(node.agentName, FIELD_LIMITS.agentName, 'unknown'),
    status: node.status,
    model: sanitizeField(node.model, FIELD_LIMITS.model),
    elapsedText: requiredField(node.elapsedText, FIELD_LIMITS.elapsedText, '00:00'),
    usageText: sanitizeField(node.usageText, FIELD_LIMITS.usageText),
    toolCount: node.toolCount,
    latestEvents: events.events,
    hiddenEventCount: events.hiddenEventCount,
    children: node.children
      .slice(0, childBudget)
      .map((child) => toSummaryNode(child, 2, normalized)),
    hiddenChildCount: Math.max(0, node.children.length - childBudget),
  };
}
