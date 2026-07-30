import type {
  SubagentRecentEvent,
  SubagentRunRecord,
  SubagentRunState,
  SubagentRunStatus,
  SubagentUsageSnapshot,
} from './subagent-run-state';

export type SubagentSessionKind = 'subagent';

export type SubagentActivityPhase =
  | 'starting'
  | 'active'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'dead';

export interface SubagentSessionLineage {
  parentRunId?: string;
  childRunIds: string[];
  depth: number;
}

export interface SubagentSessionActivity {
  phase: SubagentActivityPhase;
  latestEvent?: SubagentRecentEvent;
  recentEvents: SubagentRecentEvent[];
  updatedAt: number;
  toolCount: number;
}

export interface SubagentSessionSnapshot {
  version: 1;
  kind: SubagentSessionKind;
  runId: string;
  agentName: string;
  displayName: string;
  status: SubagentRunStatus;
  activity: SubagentSessionActivity;
  lineage: SubagentSessionLineage;
  startedAt: number;
  completedAt?: number;
  taskPreview?: string;
  model?: string;
  resultSummary?: string;
  errorMessage?: string;
  usage?: SubagentUsageSnapshot;
}

function activityPhaseForStatus(
  status: SubagentRunStatus,
): SubagentActivityPhase {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'streaming':
      return 'active';
    case 'idle':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'dead':
      return 'dead';
  }
}

function cloneRecentEvent(
  event: SubagentRecentEvent | undefined,
): SubagentRecentEvent | undefined {
  return event ? { ...event } : undefined;
}

function cloneUsage(
  usage: SubagentUsageSnapshot | undefined,
): SubagentUsageSnapshot | undefined {
  return usage ? { ...usage } : undefined;
}

function cloneRecentEvents(
  events: readonly SubagentRecentEvent[],
): SubagentRecentEvent[] {
  return events.map((event) => ({ ...event }));
}

function latestEvent(run: SubagentRunRecord): SubagentRecentEvent | undefined {
  return run.recentEvents.at(-1);
}

function updatedAt(run: SubagentRunRecord): number {
  return run.completedAt ?? latestEvent(run)?.timestamp ?? run.startedAt;
}

function resultSummary(run: SubagentRunRecord): string | undefined {
  if (run.errorMessage) return run.errorMessage;
  const latest = latestEvent(run);
  if (latest?.type === 'run_finished' || latest?.type === 'assistant_text') {
    return latest.text;
  }
  return undefined;
}

function sortRunIdsByStart(
  state: SubagentRunState,
  runIds: readonly string[],
): string[] {
  return [...runIds].sort((left, right) => {
    const leftStartedAt = state.runs[left]?.startedAt ?? 0;
    const rightStartedAt = state.runs[right]?.startedAt ?? 0;
    if (leftStartedAt !== rightStartedAt) return leftStartedAt - rightStartedAt;
    return left.localeCompare(right);
  });
}

function appendRunAndChildren(
  state: SubagentRunState,
  runId: string,
  visited: Set<string>,
  output: SubagentSessionSnapshot[],
): void {
  if (visited.has(runId)) return;
  const run = state.runs[runId];
  if (!run) return;
  visited.add(runId);
  output.push(toSubagentSessionSnapshot(run));
  for (const childRunId of sortRunIdsByStart(state, run.children)) {
    appendRunAndChildren(state, childRunId, visited, output);
  }
}

export function toSubagentSessionSnapshot(
  run: SubagentRunRecord,
): SubagentSessionSnapshot {
  const latest = latestEvent(run);
  return {
    version: 1,
    kind: 'subagent',
    runId: run.runId,
    agentName: run.agentName,
    displayName: run.displayName,
    status: run.status,
    activity: {
      phase: activityPhaseForStatus(run.status),
      latestEvent: cloneRecentEvent(latest),
      updatedAt: updatedAt(run),
      toolCount: run.toolCount,
      recentEvents: cloneRecentEvents(run.recentEvents),
    },
    lineage: {
      parentRunId: run.parentRunId,
      childRunIds: [...run.children],
      depth: run.depth,
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    taskPreview: run.taskPreview,
    model: run.model,
    resultSummary: resultSummary(run),
    errorMessage: run.errorMessage,
    usage: cloneUsage(run.usage),
  };
}

export function createSubagentSessionSnapshots(
  state: SubagentRunState,
): SubagentSessionSnapshot[] {
  const snapshots: SubagentSessionSnapshot[] = [];
  const visited = new Set<string>();
  const rootIds =
    state.rootRunIds.length > 0 ? state.rootRunIds : Object.keys(state.runs);
  for (const rootRunId of sortRunIdsByStart(state, rootIds)) {
    appendRunAndChildren(state, rootRunId, visited, snapshots);
  }
  for (const runId of sortRunIdsByStart(state, Object.keys(state.runs))) {
    appendRunAndChildren(state, runId, visited, snapshots);
  }
  return snapshots;
}
