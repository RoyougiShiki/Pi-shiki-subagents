import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_HARNESS_MESSAGES } from "./messages";
import type { HarnessMessageCatalog } from "./types";

export interface ToolResultBudgetThresholds {
  default: number;
  byTool?: Record<string, number>;
}

export interface ToolResultBudgetStorage {
  baseDir: string;
  sessionId: string;
}

export interface ToolResultBudgetOptions {
  thresholds?: ToolResultBudgetThresholds;
  storage?: ToolResultBudgetStorage;
  previewChars?: number;
  messages?: HarnessMessageCatalog;
  now?: () => number;
}

export interface ToolResultBudgetInput {
  toolName: string;
  toolCallId: string;
  content: string;
}

export interface PersistedToolResultRef {
  toolName: string;
  toolCallId: string;
  filepath: string;
  originalSize: number;
  preview: string;
  hasMore: boolean;
  createdAt: number;
}

export type ToolResultBudgetDecision =
  | {
      action: "keep";
      content: string;
      originalSize: number;
    }
  | {
      action: "persist";
      content: string;
      ref: PersistedToolResultRef;
    };

const DEFAULT_THRESHOLDS: ToolResultBudgetThresholds = {
  default: 40_000,
  byTool: {
    bash: 40_000,
    grep: 30_000,
    find: 30_000,
    read: 50_000,
    web_fetch: 50_000,
    subagent: 60_000,
  },
};

const DEFAULT_PREVIEW_CHARS = 2_000;

export { DEFAULT_THRESHOLDS };

function getThreshold(toolName: string, thresholds: ToolResultBudgetThresholds): number {
  const byTool = thresholds.byTool?.[toolName];
  if (typeof byTool === "number" && Number.isFinite(byTool) && byTool > 0) return byTool;
  return thresholds.default;
}

function safeSegment(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildToolResultPath(storage: ToolResultBudgetStorage, input: ToolResultBudgetInput): string {
  const tool = safeSegment(input.toolName);
  const call = safeSegment(input.toolCallId);
  return path.join(storage.baseDir, safeSegment(storage.sessionId), `${tool}-${call}.txt`);
}

function previewContent(content: string, previewChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= previewChars) return { preview: content, hasMore: false };
  return { preview: content.slice(0, previewChars), hasMore: true };
}

export function shouldPersistToolResult(
  input: ToolResultBudgetInput,
  thresholds: ToolResultBudgetThresholds = DEFAULT_THRESHOLDS,
): boolean {
  return input.content.length > getThreshold(input.toolName, thresholds);
}

export async function applyToolResultBudget(
  input: ToolResultBudgetInput,
  options: ToolResultBudgetOptions = {},
): Promise<ToolResultBudgetDecision> {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const originalSize = input.content.length;

  if (!shouldPersistToolResult(input, thresholds)) {
    return { action: "keep", content: input.content, originalSize };
  }

  if (!options.storage) {
    return { action: "keep", content: input.content, originalSize };
  }

  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const filepath = buildToolResultPath(options.storage, input);
  const { preview, hasMore } = previewContent(input.content, previewChars);

  await mkdir(path.dirname(filepath), { recursive: true });
  await writeFile(filepath, input.content, "utf8");

  const ref: PersistedToolResultRef = {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    filepath,
    originalSize,
    preview,
    hasMore,
    createdAt: options.now?.() ?? Date.now(),
  };

  return {
    action: "persist",
    ref,
    content: messages.toolResultBudget.persistedOutput({
      originalSize,
      filepath,
      previewSize: previewChars,
      preview,
      hasMore,
    }),
  };
}

export function summarizeCommandOutput(content: string): {
  exitCode?: number;
  failedLines: string[];
  errorLines: string[];
} {
  const lines = content.split(/\r?\n/);
  const failedLines = lines.filter((line) => /\b(fail(?:ed|ure)?|✗|×)\b/i.test(line)).slice(0, 20);
  const errorLines = lines.filter((line) => /\b(error|exception|traceback|panic)\b/i.test(line)).slice(0, 20);
  const exitCodeLine = lines.find((line) => /exit\s*code\s*[:=]\s*\d+/i.test(line));
  const exitCodeMatch = exitCodeLine?.match(/exit\s*code\s*[:=]\s*(\d+)/i);
  return {
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : undefined,
    failedLines,
    errorLines,
  };
}
