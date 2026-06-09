import type { WorkflowStageRecoveryCandidate } from "./workflow-stage-runtime";

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

function extractTextPart(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const obj = value as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
  };
  const parts: string[] = [];

  if (typeof obj.text === "string") parts.push(obj.text);
  if (typeof obj.content === "string") parts.push(obj.content);
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) parts.push(...extractTextPart(item));
  }
  if (obj.message) parts.push(...extractTextPart(obj.message));
  return parts;
}

function extractEntryText(entry: unknown): string {
  return extractTextPart(entry).join("\n");
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

export function parseWorkflowStageMarkersFromEntries(entries: unknown[], options: WorkflowStageMarkerParseOptions = {}): WorkflowStageRecoveryCandidate | null {
  let last: WorkflowStageRecoveryCandidate | null = null;
  for (const entry of entries ?? []) {
    const text = extractEntryText(entry);
    if (!text) continue;
    const regex = /\[workflow-stage-marker\]([\s\S]*?)\[\/workflow-stage-marker\]/g;
    let match = regex.exec(text);
    while (match) {
      const parsed = parseMarkerBlock(match[1] ?? "", options);
      if (parsed) last = parsed;
      match = regex.exec(text);
    }
  }
  return last;
}
