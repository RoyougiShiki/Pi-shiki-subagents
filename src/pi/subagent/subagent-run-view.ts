import type {
  SubagentRunRecord,
  SubagentRunState,
  SubagentRunStatus,
  SubagentUsageSnapshot,
} from './subagent-run-state';

export interface SubagentRunViewOptions {
  now?: number;
  maxRecentLines?: number;
}

export interface SubagentRunViewNode {
  runId: string;
  parentRunId?: string;
  agentName: string;
  displayName: string;
  depth: number;
  status: SubagentRunStatus;
  title: string;
  taskPreview?: string;
  model?: string;
  startedAt: number;
  completedAt?: number;
  elapsedText: string;
  usageText?: string;
  toolCount: number;
  recentLines: string[];
  children: SubagentRunViewNode[];
}

export interface SubagentRunTreeView {
  roots: SubagentRunViewNode[];
  counts: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    dead: number;
  };
  summaryLine: string;
}

const DEFAULT_MAX_RECENT_LINES = 3;

function toPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

export function formatSubagentTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatSubagentUsage(
  usage: SubagentUsageSnapshot | undefined,
): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns === 1 ? '' : 's'}`);
  if (usage.input) parts.push(`↑${formatSubagentTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatSubagentTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatSubagentTokens(usage.cacheRead)}`);
  if (usage.cacheWrite)
    parts.push(`W${formatSubagentTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens)
    parts.push(`ctx:${formatSubagentTokens(usage.contextTokens)}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function formatSubagentElapsed(
  startedAt: number,
  now: number,
  completedAt?: number,
): string {
  const end = completedAt ?? now;
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isRunningStatus(status: SubagentRunStatus): boolean {
  return status === 'starting' || status === 'streaming' || status === 'idle';
}

function sortRunIdsByStart(
  state: SubagentRunState,
  runIds: readonly string[],
): string[] {
  return [...runIds].sort((a, b) => {
    const left = state.runs[a]?.startedAt ?? 0;
    const right = state.runs[b]?.startedAt ?? 0;
    if (left !== right) return left - right;
    return a.localeCompare(b);
  });
}

function toViewNode(
  state: SubagentRunState,
  run: SubagentRunRecord,
  now: number,
  maxRecentLines: number,
  visited: Set<string>,
): SubagentRunViewNode {
  if (visited.has(run.runId)) {
    return {
      runId: run.runId,
      parentRunId: run.parentRunId,
      agentName: run.agentName,
      displayName: run.displayName,
      depth: run.depth,
      status: run.status,
      title: run.displayName,
      taskPreview: run.taskPreview,
      model: run.model,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      elapsedText: formatSubagentElapsed(run.startedAt, now, run.completedAt),
      usageText: formatSubagentUsage(run.usage),
      toolCount: run.toolCount,
      recentLines: ['cycle detected'],
      children: [],
    };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(run.runId);
  const childIds = sortRunIdsByStart(state, run.children);
  const children = childIds
    .map((id) => state.runs[id])
    .filter((child): child is SubagentRunRecord => Boolean(child))
    .map((child) => toViewNode(state, child, now, maxRecentLines, nextVisited));

  return {
    runId: run.runId,
    parentRunId: run.parentRunId,
    agentName: run.agentName,
    displayName: run.displayName,
    depth: run.depth,
    status: run.status,
    title:
      run.displayName === run.agentName
        ? run.displayName
        : `${run.displayName} (${run.agentName})`,
    taskPreview: run.taskPreview,
    model: run.model,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedText: formatSubagentElapsed(run.startedAt, now, run.completedAt),
    usageText: formatSubagentUsage(run.usage),
    toolCount: run.toolCount,
    recentLines: run.recentEvents
      .slice(-maxRecentLines)
      .map((event) => event.text),
    children,
  };
}

export function createSubagentRunTreeView(
  state: SubagentRunState,
  options: SubagentRunViewOptions = {},
): SubagentRunTreeView {
  const now = options.now ?? Date.now();
  const maxRecentLines = toPositiveInteger(
    options.maxRecentLines,
    DEFAULT_MAX_RECENT_LINES,
  );
  const runs = Object.values(state.runs);
  const counts = {
    total: runs.length,
    running: runs.filter((run) => isRunningStatus(run.status)).length,
    completed: runs.filter((run) => run.status === 'completed').length,
    failed: runs.filter((run) => run.status === 'failed').length,
    dead: runs.filter((run) => run.status === 'dead').length,
  };

  const rootIds = sortRunIdsByStart(
    state,
    state.rootRunIds.length > 0
      ? state.rootRunIds
      : runs.map((run) => run.runId),
  );
  const roots = rootIds
    .map((id) => state.runs[id])
    .filter((run): run is SubagentRunRecord => Boolean(run))
    .map((run) =>
      toViewNode(state, run, now, maxRecentLines, new Set<string>()),
    );

  const summaryParts: string[] = [];
  if (counts.running > 0) summaryParts.push(`${counts.running} running`);
  if (counts.completed > 0) summaryParts.push(`${counts.completed} completed`);
  if (counts.failed > 0) summaryParts.push(`${counts.failed} failed`);
  if (counts.dead > 0) summaryParts.push(`${counts.dead} dead`);

  return {
    roots,
    counts,
    summaryLine:
      summaryParts.length > 0 ? summaryParts.join(' · ') : 'no subagents',
  };
}
