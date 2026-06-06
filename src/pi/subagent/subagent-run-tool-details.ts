import {
  createSubagentRunDetailView,
  createSubagentRunTreeSummaryView,
  type SubagentRunDetailView,
  type SubagentRunDetailViewOptions,
  type SubagentRunTreeSummaryView,
  type SubagentToolAction,
} from './subagent-run-detail-view';
import type { SubagentRunTreeView } from './subagent-run-view';

export interface OmoSubagentToolDetailsV1 {
  version: 1;
  action: SubagentToolAction;
  runId?: string;
  summary: SubagentRunTreeSummaryView;
  focusedRun?: SubagentRunDetailView;
}

export interface BuildOmoSubagentToolDetailsOptions
  extends SubagentRunDetailViewOptions {
  action: SubagentToolAction;
  runId?: string;
  focusRun?: boolean;
}

function sanitizeRunId(value: string | undefined): string | undefined {
  const normalized = (value ?? '')
    .replace(/SECRET[_A-Za-z0-9-]*SENTINEL/g, '[redacted]')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 79)}~`;
}
export function buildOmoSubagentToolDetails(
  view: SubagentRunTreeView,
  options: BuildOmoSubagentToolDetailsOptions,
): OmoSubagentToolDetailsV1 {
  const focusedRun =
    options.focusRun && options.runId
      ? createSubagentRunDetailView(view, options.runId, options)
      : undefined;
  return {
    version: 1,
    action: options.action,
    runId: focusedRun?.runId ?? sanitizeRunId(options.runId),
    summary: createSubagentRunTreeSummaryView(view, options),
    ...(focusedRun ? { focusedRun } : {}),
  };
}

export function isOmoSubagentToolDetailsV1(
  value: unknown,
): value is OmoSubagentToolDetailsV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.summary !== undefined;
}
