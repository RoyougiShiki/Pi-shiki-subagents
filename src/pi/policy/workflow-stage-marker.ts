import type { WorkflowStageRecoveryCandidate } from "./workflow-stage-runtime";
import { PI_AGENT_EVENT_SCHEMA, createPiAgentEventDetails, type PiAgentEventDetails } from "./pi-agent-event";

export type WorkflowStageMarkerEvent = "transition_approved" | "recovery_confirmed" | "work_package_approved";

export interface WorkflowStageMarkerInput {
  event: WorkflowStageMarkerEvent;
  workflowName: string;
  stageIndex: number;
  stageId?: string;
  stageAgent?: string;
  targetAgent: string;
  timestamp?: number;
  poolId?: string;
  task?: string;
}

export interface WorkflowStageNotice {
  content: string;
  details: PiAgentEventDetails;
}

const MARKER_START = "[workflow-stage-marker]";
const MARKER_END = "[/workflow-stage-marker]";

function lineValue(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]/g, " ").trim();
}

export function formatWorkflowStageMarker(args: WorkflowStageMarkerInput): string {
  const timestamp = Number.isFinite(args.timestamp) ? Number(args.timestamp) : Date.now();
  return [
    MARKER_START,
    "version: 1",
    `event: ${lineValue(args.event)}`,
    `workflow: ${lineValue(args.workflowName)}`,
    `stageIndex: ${Math.max(0, Math.trunc(args.stageIndex))}`,
    `stageId: ${lineValue(args.stageId)}`,
    `stageAgent: ${lineValue(args.stageAgent)}`,
    `targetAgent: ${lineValue(args.targetAgent)}`,
    `poolId: ${lineValue(args.poolId)}`,
    `task: ${lineValue(args.task)}`,
    `timestamp: ${timestamp}`,
    MARKER_END,
  ].join("\n");
}

function markerStageLabel(args: { stageId?: string; stageIndex: number }): string {
  return args.stageId?.trim() || String(Math.max(0, Math.trunc(args.stageIndex)));
}

export function createWorkflowStageMarkerNotice(args: WorkflowStageMarkerInput): WorkflowStageNotice {
  const timestamp = Number.isFinite(args.timestamp) ? Number(args.timestamp) : Date.now();
  const rawMarker = formatWorkflowStageMarker({ ...args, timestamp });
  const stageLabel = markerStageLabel(args);
  const summary = `Workflow stage recorded: ${args.workflowName}/${stageLabel} -> ${args.targetAgent}`;
  return {
    content: summary,
    details: createPiAgentEventDetails({
      kind: "workflow_stage_marker",
      title: "Workflow stage recorded",
      summary,
      fields: {
        event: args.event,
        workflowName: args.workflowName,
        stageIndex: Math.max(0, Math.trunc(args.stageIndex)),
        stageId: args.stageId,
        stageAgent: args.stageAgent,
        targetAgent: args.targetAgent,
        poolId: args.poolId,
        task: args.task,
        timestamp,
      },
      rawText: rawMarker,
    }),
  };
}

export function formatWorkflowStageResumeNotice(args: { candidate?: WorkflowStageRecoveryCandidate | null } = {}): string {
  const candidate = args.candidate;
  const candidateLine = candidate
    ? `检测到历史 stage marker：workflow="${candidate.workflowName}", stageIndex=${candidate.stageIndex}, stageId="${candidate.stageId ?? ""}"。`
    : "未检测到可用于自动恢复审批的历史 stage marker。";
  return [
    "[workflow-stage-resume]",
    "这是恢复后的对话。请先回顾历史中的 [workflow-stage-marker]、pool 完成通知、todo 和当前 git diff/修改文件。",
    "确认中断前所处 stage 和已完成进度后，再调用对应 stage 子代理继续；同一话题优先使用 pool send/resume 恢复原子代理。",
    "系统只会对历史 marker 对应的 stage 触发恢复 runtime 位置审批；其他 future stage 仍会被系统拦截。",
    candidateLine,
    "[/workflow-stage-resume]",
  ].join("\n");
}

export function createWorkflowStageResumeNotice(args: { candidate?: WorkflowStageRecoveryCandidate | null } = {}): WorkflowStageNotice {
  const candidate = args.candidate;
  const stageLabel = candidate
    ? markerStageLabel({ stageId: candidate.stageId, stageIndex: candidate.stageIndex })
    : undefined;
  const summary = candidate
    ? `Workflow resume context: ${candidate.workflowName}/${stageLabel}`
    : "Workflow resume context: no stage marker candidate";
  return {
    content: summary,
    details: createPiAgentEventDetails({
      kind: "workflow_stage_resume",
      title: "Workflow resume context",
      summary,
      fields: {
        hasRecoveryCandidate: Boolean(candidate),
        candidate: candidate ? { ...candidate } : undefined,
      },
      rawText: formatWorkflowStageResumeNotice(args),
    }),
  };
}

function extractTextPart(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const obj = value as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
    details?: unknown;
    rawText?: unknown;
    rawMarker?: unknown;
  };
  const parts: string[] = [];

  if (typeof obj.text === "string") parts.push(obj.text);
  if (typeof obj.content === "string") parts.push(obj.content);
  if (typeof obj.rawText === "string") parts.push(obj.rawText);
  if (typeof obj.rawMarker === "string") parts.push(obj.rawMarker);
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) parts.push(...extractTextPart(item));
  }
  if (obj.message) parts.push(...extractTextPart(obj.message));
  if (obj.details) parts.push(...extractTextPart(obj.details));
  return parts;
}

function extractEntryText(entry: unknown): string {
  return extractTextPart(entry).join("\n");
}

function collectDetailsObjects(value: unknown, output: unknown[]): void {
  if (!value || typeof value !== "object") return;
  const obj = value as {
    content?: unknown;
    details?: unknown;
    message?: unknown;
  };
  if (obj.details && typeof obj.details === "object") output.push(obj.details);
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) collectDetailsObjects(item, output);
  }
  if (obj.message) collectDetailsObjects(obj.message, output);
}

function extractDetailsObjects(entry: unknown): unknown[] {
  const output: unknown[] = [];
  collectDetailsObjects(entry, output);
  return output;
}

interface WorkflowStageMarkerParseOptions {
  /** Ignore markers older than this session timestamp. Prevents forked sessions from recovering parent-session markers. */
  minTimestamp?: number;
}

function isUsableTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseMarkerBlock(block: string, options: WorkflowStageMarkerParseOptions = {}): WorkflowStageRecoveryCandidate | null {
  const fields: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }

  if (fields.version !== "1") return null;
  const event = fields.event;
  if (event !== "transition_approved" && event !== "recovery_confirmed") return null;
  const workflowName = fields.workflow?.trim();
  if (!workflowName) return null;
  const stageIndex = Number(fields.stageIndex);
  if (!Number.isInteger(stageIndex) || stageIndex < 0) return null;
  const timestamp = fields.timestamp ? Number(fields.timestamp) : undefined;
  const parsedTimestamp = Number.isFinite(timestamp) ? timestamp : undefined;
  if (isUsableTimestamp(options.minTimestamp) && (!isUsableTimestamp(parsedTimestamp) || parsedTimestamp < options.minTimestamp)) {
    return null;
  }

  return {
    workflowName,
    stageIndex,
    stageId: fields.stageId?.trim() || undefined,
    stageAgent: fields.stageAgent?.trim() || undefined,
    markerEvent: event,
    timestamp: parsedTimestamp,
    source: "session_marker",
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function detailString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function detailNumber(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseMarkerDetails(details: unknown, options: WorkflowStageMarkerParseOptions = {}): WorkflowStageRecoveryCandidate | null {
  const detailObject = objectValue(details);
  const fields = objectValue(detailObject?.fields);
  if (!detailObject || !fields) return null;
  if (detailString(detailObject, "schema") !== PI_AGENT_EVENT_SCHEMA) return null;
  if (detailString(detailObject, "kind") !== "workflow_stage_marker") return null;

  const event = detailString(fields, "event");
  if (event !== "transition_approved" && event !== "recovery_confirmed") return null;
  const workflowName = detailString(fields, "workflowName") ?? detailString(fields, "workflow");
  if (!workflowName) return null;
  const stageIndex = detailNumber(fields, "stageIndex");
  if (typeof stageIndex !== "number" || !Number.isInteger(stageIndex) || stageIndex < 0) return null;
  const parsedStageIndex = stageIndex;
  const timestamp = detailNumber(fields, "timestamp");
  if (isUsableTimestamp(options.minTimestamp) && (!isUsableTimestamp(timestamp) || timestamp < options.minTimestamp)) {
    return null;
  }

  return {
    workflowName,
    stageIndex: parsedStageIndex,
    stageId: detailString(fields, "stageId"),
    stageAgent: detailString(fields, "stageAgent"),
    markerEvent: event,
    timestamp,
    source: "session_marker",
  };
}

export function parseWorkflowStageMarkersFromEntries(entries: unknown[], options: WorkflowStageMarkerParseOptions = {}): WorkflowStageRecoveryCandidate | null {
  let last: WorkflowStageRecoveryCandidate | null = null;
  for (const entry of entries ?? []) {
    const text = extractEntryText(entry);
    if (text) {
      const regex = /\[workflow-stage-marker\]([\s\S]*?)\[\/workflow-stage-marker\]/g;
      let match = regex.exec(text);
      while (match) {
        const parsed = parseMarkerBlock(match[1] ?? "", options);
        if (parsed) last = parsed;
        match = regex.exec(text);
      }
    }
    for (const details of extractDetailsObjects(entry)) {
      const parsed = parseMarkerDetails(details, options);
      if (parsed) last = parsed;
    }
  }
  return last;
}
