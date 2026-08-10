export type SubagentRunStatus =
  | 'starting'
  | 'streaming'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'dead';

export interface SubagentUsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  contextTokens?: number;
  turns?: number;
}

export interface SubagentRunLimits {
  maxRecentEvents: number;
  maxEventTextChars: number;
  maxTaskPreviewChars: number;
}

export const DEFAULT_SUBAGENT_RUN_LIMITS: SubagentRunLimits = {
  maxRecentEvents: 10,
  maxEventTextChars: 500,
  maxTaskPreviewChars: 160,
};

export type SubagentRunEvent =
  | {
      type: 'run_started';
      runId: string;
      parentRunId?: string;
      agentName: string;
      displayName: string;
      depth: number;
      startedAt: number;
      taskPreview?: string;
      model?: string;
      /** 发起会话标识：子代理归属（嵌套子代理继承根会话）。 */
      ownerSessionId: string;
    }
  | {
      type: 'status';
      runId: string;
      timestamp: number;
      status: SubagentRunStatus;
      text?: string;
    }
  | {
      type: 'assistant_text';
      runId: string;
      timestamp: number;
      text: string;
    }
  | {
      type: 'tool_call';
      runId: string;
      timestamp: number;
      toolName: string;
      summary: string;
    }
  | {
      type: 'tool_result';
      runId: string;
      timestamp: number;
      toolName: string;
      summary: string;
      isError?: boolean;
    }
  | {
      type: 'usage';
      runId: string;
      timestamp: number;
      usage: SubagentUsageSnapshot;
    }
  | {
      type: 'run_finished';
      runId: string;
      timestamp: number;
      status: 'completed' | 'failed' | 'dead';
      text?: string;
      errorMessage?: string;
      usage?: SubagentUsageSnapshot;
    };

export interface SubagentRecentEvent {
  type: Exclude<SubagentRunEvent['type'], 'run_started'>;
  timestamp: number;
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface SubagentRunRecord {
  runId: string;
  parentRunId?: string;
  agentName: string;
  displayName: string;
  depth: number;
  startedAt: number;
  /** 发起会话标识：子代理归属（嵌套子代理继承根会话）。 */
  ownerSessionId: string;
  completedAt?: number;
  status: SubagentRunStatus;
  taskPreview?: string;
  model?: string;
  usage?: SubagentUsageSnapshot;
  toolCount: number;
  errorMessage?: string;
  recentEvents: SubagentRecentEvent[];
  children: string[];
}

export interface SubagentRunState {
  runs: Record<string, SubagentRunRecord>;
  rootRunIds: string[];
}

export function createSubagentRunState(): SubagentRunState {
  return { runs: {}, rootRunIds: [] };
}

function toPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function withLimits(limits?: Partial<SubagentRunLimits>): SubagentRunLimits {
  return {
    maxRecentEvents: toPositiveInteger(
      limits?.maxRecentEvents,
      DEFAULT_SUBAGENT_RUN_LIMITS.maxRecentEvents,
    ),
    maxEventTextChars: toPositiveInteger(
      limits?.maxEventTextChars,
      DEFAULT_SUBAGENT_RUN_LIMITS.maxEventTextChars,
    ),
    maxTaskPreviewChars: toPositiveInteger(
      limits?.maxTaskPreviewChars,
      DEFAULT_SUBAGENT_RUN_LIMITS.maxTaskPreviewChars,
    ),
  };
}

function cleanText(
  text: string | undefined,
  maxChars: number,
): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function mergeUsage(
  current: SubagentUsageSnapshot | undefined,
  update: SubagentUsageSnapshot | undefined,
): SubagentUsageSnapshot | undefined {
  if (!update) return current;
  const merged = { ...(current ?? {}), ...update };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function removeValue(values: readonly string[], value: string): string[] {
  return values.filter((item) => item !== value);
}

function appendRecentEvent(
  run: SubagentRunRecord,
  event: SubagentRecentEvent | undefined,
  limits: SubagentRunLimits,
): SubagentRunRecord {
  if (!event) return run;
  const recentEvents = [...run.recentEvents, event].slice(
    -limits.maxRecentEvents,
  );
  return { ...run, recentEvents };
}

function toRecentEvent(
  event: Exclude<SubagentRunEvent, { type: 'run_started' }>,
  limits: SubagentRunLimits,
): SubagentRecentEvent | undefined {
  switch (event.type) {
    case 'status': {
      const text = cleanText(
        event.text ?? event.status,
        limits.maxEventTextChars,
      );
      return text
        ? { type: event.type, timestamp: event.timestamp, text }
        : undefined;
    }
    case 'assistant_text': {
      const text = cleanText(event.text, limits.maxEventTextChars);
      return text
        ? { type: event.type, timestamp: event.timestamp, text }
        : undefined;
    }
    case 'tool_call': {
      const summary = cleanText(event.summary, limits.maxEventTextChars);
      const text = cleanText(
        summary ? `${event.toolName}: ${summary}` : event.toolName,
        limits.maxEventTextChars,
      );
      return text
        ? {
            type: event.type,
            timestamp: event.timestamp,
            text,
            toolName: event.toolName,
          }
        : undefined;
    }
    case 'tool_result': {
      const summary = cleanText(event.summary, limits.maxEventTextChars);
      const text = cleanText(
        summary ? `${event.toolName}: ${summary}` : event.toolName,
        limits.maxEventTextChars,
      );
      return text
        ? {
            type: event.type,
            timestamp: event.timestamp,
            text,
            toolName: event.toolName,
            isError: event.isError,
          }
        : undefined;
    }
    case 'usage': {
      const text = cleanText('usage updated', limits.maxEventTextChars);
      return text
        ? { type: event.type, timestamp: event.timestamp, text }
        : undefined;
    }
    case 'run_finished': {
      const text = cleanText(
        event.text ?? event.errorMessage ?? event.status,
        limits.maxEventTextChars,
      );
      return text
        ? {
            type: event.type,
            timestamp: event.timestamp,
            text,
            isError: event.status !== 'completed',
          }
        : undefined;
    }
  }
}

function createPlaceholderRun(
  runId: string,
  timestamp: number,
  ownerSessionId?: string,
): SubagentRunRecord {
  return {
    runId,
    agentName: 'unknown',
    displayName: runId,
    depth: 0,
    startedAt: timestamp,
    ownerSessionId: ownerSessionId ?? 'unknown',
    status: 'starting',
    toolCount: 0,
    recentEvents: [],
    children: [],
  };
}

export function updateSubagentRunState(
  state: SubagentRunState,
  event: SubagentRunEvent,
  limits?: Partial<SubagentRunLimits>,
): SubagentRunState {
  const bounded = withLimits(limits);

  if (event.type === 'run_started') {
    const existing = state.runs[event.runId];
    const existingChildren = existing?.children ?? [];
    const adoptedChildren = Object.values(state.runs)
      .filter(
        (run) => run.parentRunId === event.runId && run.runId !== event.runId,
      )
      .map((run) => run.runId);
    const children = [...existingChildren];
    for (const childRunId of adoptedChildren) {
      if (!children.includes(childRunId)) children.push(childRunId);
    }

    const nextRun: SubagentRunRecord = {
      ...(existing ??
        createPlaceholderRun(
          event.runId,
          event.startedAt,
          event.ownerSessionId,
        )),
      runId: event.runId,
      parentRunId: event.parentRunId,
      agentName: event.agentName,
      displayName: event.displayName,
      depth: Math.max(0, event.depth),
      startedAt: event.startedAt,
      ownerSessionId: event.ownerSessionId,
      status: 'starting',
      taskPreview: cleanText(event.taskPreview, bounded.maxTaskPreviewChars),
      model: event.model,
      children,
    };

    const runs = { ...state.runs, [event.runId]: nextRun };
    let rootRunIds = state.rootRunIds.filter((id) => !children.includes(id));
    if (event.parentRunId && runs[event.parentRunId]) {
      const parent = runs[event.parentRunId];
      runs[event.parentRunId] = {
        ...parent,
        children: appendUnique(parent.children, event.runId),
      };
      rootRunIds = removeValue(rootRunIds, event.runId);
      return { runs, rootRunIds };
    }

    return { runs, rootRunIds: appendUnique(rootRunIds, event.runId) };
  }

  const current =
    state.runs[event.runId] ??
    createPlaceholderRun(event.runId, event.timestamp);
  let nextRun = current;

  switch (event.type) {
    case 'status':
      nextRun = { ...nextRun, status: event.status };
      break;
    case 'tool_call':
      nextRun = {
        ...nextRun,
        status: nextRun.status === 'starting' ? 'streaming' : nextRun.status,
        toolCount: nextRun.toolCount + 1,
      };
      break;
    case 'tool_result':
      if (event.isError) nextRun = { ...nextRun, status: 'failed' };
      break;
    case 'usage':
      nextRun = { ...nextRun, usage: mergeUsage(nextRun.usage, event.usage) };
      break;
    case 'run_finished':
      nextRun = {
        ...nextRun,
        status: event.status,
        completedAt: event.timestamp,
        errorMessage: event.errorMessage,
        usage: mergeUsage(nextRun.usage, event.usage),
      };
      break;
    case 'assistant_text':
      if (nextRun.status === 'starting')
        nextRun = { ...nextRun, status: 'streaming' };
      break;
  }

  nextRun = appendRecentEvent(nextRun, toRecentEvent(event, bounded), bounded);

  return {
    runs: { ...state.runs, [event.runId]: nextRun },
    rootRunIds: state.runs[event.runId]
      ? [...state.rootRunIds]
      : appendUnique(state.rootRunIds, event.runId),
  };
}
