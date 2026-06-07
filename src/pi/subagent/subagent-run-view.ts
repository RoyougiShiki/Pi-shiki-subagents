import type {
  SubagentRunState,
  SubagentRunStatus,
  SubagentUsageSnapshot,
} from './subagent-run-state';
import {
  createSubagentSessionSnapshots,
  type SubagentSessionSnapshot,
} from './subagent-session-contract';

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

function sortSnapshotsByStart(
  snapshots: Map<string, SubagentSessionSnapshot>,
  runIds: readonly string[],
): string[] {
  return [...runIds].sort((a, b) => {
    const left = snapshots.get(a)?.startedAt ?? 0;
    const right = snapshots.get(b)?.startedAt ?? 0;
    if (left !== right) return left - right;
    return a.localeCompare(b);
  });
}

function toViewNodeFromSnapshot(
  snapshots: Map<string, SubagentSessionSnapshot>,
  snapshot: SubagentSessionSnapshot,
  now: number,
  maxRecentLines: number,
  visited: Set<string>,
): SubagentRunViewNode {
  if (visited.has(snapshot.runId)) {
    return {
      runId: snapshot.runId,
      parentRunId: snapshot.lineage.parentRunId,
      agentName: snapshot.agentName,
      displayName: snapshot.displayName,
      depth: snapshot.lineage.depth,
      status: snapshot.status,
      title: snapshot.displayName,
      taskPreview: snapshot.taskPreview,
      model: snapshot.model,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      elapsedText: formatSubagentElapsed(
        snapshot.startedAt,
        now,
        snapshot.completedAt,
      ),
      usageText: formatSubagentUsage(snapshot.usage),
      toolCount: snapshot.activity.toolCount,
      recentLines: ['cycle detected'],
      children: [],
    };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(snapshot.runId);
  const childIds = sortSnapshotsByStart(snapshots, snapshot.lineage.childRunIds);
  const children = childIds
    .map((id) => snapshots.get(id))
    .filter((child): child is SubagentSessionSnapshot => Boolean(child))
    .map((child) =>
      toViewNodeFromSnapshot(snapshots, child, now, maxRecentLines, nextVisited),
    );

  return {
    runId: snapshot.runId,
    parentRunId: snapshot.lineage.parentRunId,
    agentName: snapshot.agentName,
    displayName: snapshot.displayName,
    depth: snapshot.lineage.depth,
    status: snapshot.status,
    title:
      snapshot.displayName === snapshot.agentName
        ? snapshot.displayName
        : `${snapshot.displayName} (${snapshot.agentName})`,
    taskPreview: snapshot.taskPreview,
    model: snapshot.model,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    elapsedText: formatSubagentElapsed(
      snapshot.startedAt,
      now,
      snapshot.completedAt,
    ),
    usageText: formatSubagentUsage(snapshot.usage),
    toolCount: snapshot.activity.toolCount,
    recentLines: snapshot.activity.recentEvents
      .slice(-maxRecentLines)
      .map((event) => event.text),
    children,
  };
}

function sortSnapshotsByRootOrder(
  snapshotsList: readonly SubagentSessionSnapshot[],
): SubagentSessionSnapshot[] {
  return [...snapshotsList].sort((left, right) => {
    if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt;
    return left.runId.localeCompare(right.runId);
  });
}

function markReachableSnapshots(
  snapshots: Map<string, SubagentSessionSnapshot>,
  runId: string,
  reachable: Set<string>,
): void {
  if (reachable.has(runId)) return;
  const snapshot = snapshots.get(runId);
  if (!snapshot) return;
  reachable.add(runId);
  for (const childRunId of snapshot.lineage.childRunIds) {
    markReachableSnapshots(snapshots, childRunId, reachable);
  }
}

function selectRootSnapshots(
  snapshots: Map<string, SubagentSessionSnapshot>,
  snapshotsList: readonly SubagentSessionSnapshot[],
  childIds: ReadonlySet<string>,
): SubagentSessionSnapshot[] {
  const rootCandidates = snapshotsList.filter((snapshot) => {
    const parentRunId = snapshot.lineage.parentRunId;
    return !parentRunId || !snapshots.has(parentRunId) || !childIds.has(snapshot.runId);
  });
  const roots = sortSnapshotsByRootOrder(rootCandidates);
  const reachable = new Set<string>();
  for (const root of roots) {
    markReachableSnapshots(snapshots, root.runId, reachable);
  }
  for (const snapshot of sortSnapshotsByRootOrder(snapshotsList)) {
    if (reachable.has(snapshot.runId)) continue;
    roots.push(snapshot);
    markReachableSnapshots(snapshots, snapshot.runId, reachable);
  }
  return roots;
}

export function createSubagentRunTreeViewFromSnapshots(
  snapshotsList: readonly SubagentSessionSnapshot[],
  options: SubagentRunViewOptions = {},
): SubagentRunTreeView {
  const now = options.now ?? Date.now();
  const maxRecentLines = toPositiveInteger(
    options.maxRecentLines,
    DEFAULT_MAX_RECENT_LINES,
  );
  const snapshots = new Map(
    snapshotsList.map((snapshot) => [snapshot.runId, snapshot]),
  );
  const counts = {
    total: snapshotsList.length,
    running: snapshotsList.filter((snapshot) => isRunningStatus(snapshot.status))
      .length,
    completed: snapshotsList.filter((snapshot) => snapshot.status === 'completed')
      .length,
    failed: snapshotsList.filter((snapshot) => snapshot.status === 'failed').length,
    dead: snapshotsList.filter((snapshot) => snapshot.status === 'dead').length,
  };

  const childIds = new Set(
    snapshotsList.flatMap((snapshot) => snapshot.lineage.childRunIds),
  );
  const roots = selectRootSnapshots(snapshots, snapshotsList, childIds).map(
    (snapshot) =>
      toViewNodeFromSnapshot(
        snapshots,
        snapshot,
        now,
        maxRecentLines,
        new Set<string>(),
      ),
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

export function createSubagentRunTreeView(
  state: SubagentRunState,
  options: SubagentRunViewOptions = {},
): SubagentRunTreeView {
  return createSubagentRunTreeViewFromSnapshots(
    createSubagentSessionSnapshots(state),
    options,
  );
}
