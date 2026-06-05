/**
 * Tool Result Budget — 工具结果预算管理
 *
 * 设计原则（cc-haha 设计）：
 * - 状态管理：seenIds 保证已发送内容不被重新处理 → prompt cache 稳定性
 * - Per-message 预算：防止 N 个并发工具各自达到阈值，总量超标
 * - 恢复支持：从 transcript 记录重建状态
 *
 * 模块解耦：
 * - 阈值来自 thresholds.ts（唯一真源）
 * - 状态来自 tool-result-budget-state.ts
 * - 文案来自 HarnessMessageCatalog
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  createToolResultBudgetState,
  reconstructToolResultBudgetState,
  serializeToolResultBudgetState,
  isSeenId,
  markSeenId,
  getReplacement,
  recordReplacement,
  partitionCandidates,
  type ToolResultBudgetState,
  type ToolResultReplacementRecord,
  type ToolResultCandidate,
} from "./tool-result-budget-state";
import {
  DEFAULT_PREVIEW_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  getToolThreshold,
  shouldSkipPersist,
  type UserThresholdConfig,
} from "./thresholds";
import { DEFAULT_HARNESS_MESSAGES } from "./messages";
import type { HarnessMessageCatalog } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ToolResultBudgetOptions {
  /** 用户阈值配置（结构化） */
  thresholds?: UserThresholdConfig;
  storage?: {
    baseDir: string;
    sessionId: string;
  };
  previewChars?: number;
  messages?: HarnessMessageCatalog;
  state?: ToolResultBudgetState;
  skipToolNames?: ReadonlySet<string>;
  now?: () => number;
}

export interface ToolResultInput {
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

export type ToolResultDecision =
  | { action: "keep"; content: string; originalSize: number }
  | { action: "persist"; content: string; ref: PersistedToolResultRef }
  | { action: "reapply"; content: string; originalSize: number };

export interface PerMessageBudgetResult {
  decisions: ToolResultDecision[];
  newlyReplaced: ToolResultReplacementRecord[];
  totalSize: number;
  frozenSize: number;
  freshSize: number;
}

// ─── Single Tool Result ────────────────────────────────────────────────────

/**
 * 检查单个工具结果是否需要持久化
 */
export function shouldPersistToolResult(
  input: ToolResultInput,
  thresholds?: UserThresholdConfig,
): boolean {
  if (shouldSkipPersist(input.toolName)) return false;
  const threshold = getToolThreshold(input.toolName, thresholds);
  return input.content.length > threshold;
}

/**
 * 处理单个工具结果
 */
export async function applyToolResultBudget(
  input: ToolResultInput,
  options: ToolResultBudgetOptions = {},
): Promise<ToolResultDecision> {
  const state = options.state;
  const thresholds = options.thresholds;

  // 检查是否有已存在的替换
  if (state) {
    const existingReplacement = getReplacement(state, input.toolCallId);
    if (existingReplacement) {
      return { action: "reapply", content: existingReplacement, originalSize: input.content.length };
    }

    // 检查是否已发送（冻结状态）
    if (isSeenId(state, input.toolCallId)) {
      return { action: "keep", content: input.content, originalSize: input.content.length };
    }
  }

  // 检查是否应该跳过
  const skipNames = options.skipToolNames ?? new Set();
  if (skipNames.has(input.toolName.trim().toLowerCase()) || shouldSkipPersist(input.toolName)) {
    if (state) markSeenId(state, input.toolCallId);
    return { action: "keep", content: input.content, originalSize: input.content.length };
  }

  // 检查阈值
  if (!shouldPersistToolResult(input, thresholds)) {
    if (state) markSeenId(state, input.toolCallId);
    return { action: "keep", content: input.content, originalSize: input.content.length };
  }

  // 需要持久化但没有 storage 配置
  if (!options.storage) {
    if (state) markSeenId(state, input.toolCallId);
    return { action: "keep", content: input.content, originalSize: input.content.length };
  }

  // 执行持久化
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const filepath = buildToolResultPath(options.storage, input);
  const { preview, hasMore } = previewContent(input.content, previewChars);
  const createdAt = options.now?.() ?? Date.now();

  await mkdir(path.dirname(filepath), { recursive: true });
  await writeFile(filepath, input.content, "utf8");

  const ref: PersistedToolResultRef = {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    filepath,
    originalSize: input.content.length,
    preview,
    hasMore,
    createdAt,
  };

  const replacementContent = messages.toolResultBudget.persistedOutput({
    originalSize: ref.originalSize,
    filepath: ref.filepath,
    previewSize: previewChars,
    preview: ref.preview,
    hasMore: ref.hasMore,
  });

  // 记录替换
  if (state) {
    recordReplacement(state, {
      kind: "tool-result",
      toolUseId: input.toolCallId,
      toolName: input.toolName,
      originalSize: ref.originalSize,
      replacement: replacementContent,
      filepath: ref.filepath,
      createdAt: ref.createdAt,
    });
  }

  return { action: "persist", content: replacementContent, ref };
}

// ─── Per-Message Budget ────────────────────────────────────────────────────

/**
 * 处理一批并发工具结果（per-message 预算）
 * 
 * cc-haha 设计：
 * - 每个 user message（一批并发工具结果）有总预算
 * - 防止 N 个并发工具各自达到阈值，总量超标
 * - 已发送内容冻结，保证 prompt cache 稳定性
 */
export async function applyPerMessageBudget(
  inputs: readonly ToolResultInput[],
  options: ToolResultBudgetOptions = {},
): Promise<PerMessageBudgetResult> {
  const state = options.state ?? createToolResultBudgetState();
  const thresholds = options.thresholds;
  const limit = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS;
  const decisions: ToolResultDecision[] = [];
  const newlyReplaced: ToolResultReplacementRecord[] = [];

  // 构建候选列表
  const candidates: ToolResultCandidate[] = inputs.map((input) => ({
    toolUseId: input.toolCallId,
    toolName: input.toolName,
    size: input.content.length,
    content: input.content,
  }));

  // 分区：根据 prior decision 划分
  const { mustReapply, frozen, fresh } = partitionCandidates(candidates, state);

  // 重新应用已有替换
  for (const candidate of mustReapply) {
    decisions.push({
      action: "reapply",
      content: candidate.replacement,
      originalSize: candidate.size,
    });
  }

  // 标记冻结的候选为已发送
  for (const candidate of frozen) {
    markSeenId(state, candidate.toolUseId);
    decisions.push({
      action: "keep",
      content: candidate.content,
      originalSize: candidate.size,
    });
  }

  // 计算预算
  const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0);
  const skipNames = options.skipToolNames ?? new Set();

  // 过滤可处理的候选
  const eligible = fresh.filter(
    (c) => !skipNames.has(c.toolName.trim().toLowerCase()) && !shouldSkipPersist(c.toolName),
  );
  const skipped = fresh.filter(
    (c) => skipNames.has(c.toolName.trim().toLowerCase()) || shouldSkipPersist(c.toolName),
  );

  // 标记跳过的候选为已发送
  for (const candidate of skipped) {
    markSeenId(state, candidate.toolUseId);
    decisions.push({
      action: "keep",
      content: candidate.content,
      originalSize: candidate.size,
    });
  }

  const freshSize = eligible.reduce((sum, c) => sum + c.size, 0);

  // 检查是否超过 per-message 预算
  if (frozenSize + freshSize > limit) {
    // 选择需要替换的候选（按大小排序，优先替换大的）
    const sorted = [...eligible].sort((a, b) => b.size - a.size);
    let currentSize = frozenSize;

    for (const candidate of sorted) {
      if (currentSize + candidate.size > limit) {
        // 需要替换
        const decision = await applyToolResultBudget(
          {
            toolName: candidate.toolName,
            toolCallId: candidate.toolUseId,
            content: candidate.content,
          },
          { ...options, state, thresholds },
        );
        decisions.push(decision);

        if (decision.action === "persist") {
          newlyReplaced.push({
            kind: "tool-result",
            toolUseId: candidate.toolUseId,
            toolName: candidate.toolName,
            originalSize: candidate.size,
            replacement: decision.content,
            filepath: decision.ref.filepath,
            createdAt: decision.ref.createdAt,
          });
          // 替换后的内容大小显著减少
          currentSize += decision.content.length;
        } else {
          currentSize += candidate.size;
        }
      } else {
        // 不需要替换，标记为已发送
        markSeenId(state, candidate.toolUseId);
        decisions.push({
          action: "keep",
          content: candidate.content,
          originalSize: candidate.size,
        });
        currentSize += candidate.size;
      }
    }
  } else {
    // 不超过预算，直接处理
    for (const candidate of eligible) {
      const decision = await applyToolResultBudget(
        {
          toolName: candidate.toolName,
          toolCallId: candidate.toolUseId,
          content: candidate.content,
        },
        { ...options, state, thresholds },
      );
      decisions.push(decision);

      if (decision.action === "persist") {
        newlyReplaced.push({
          kind: "tool-result",
          toolUseId: candidate.toolUseId,
          toolName: candidate.toolName,
          originalSize: candidate.size,
          replacement: decision.content,
          filepath: decision.ref.filepath,
          createdAt: decision.ref.createdAt,
        });
      }
    }
  }

  return {
    decisions,
    newlyReplaced,
    totalSize: decisions.reduce(
      (sum, d) => sum + (d.action === "persist" ? d.content.length : d.originalSize),
      0,
    ),
    frozenSize,
    freshSize,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function safeSegment(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildToolResultPath(
  storage: { baseDir: string; sessionId: string },
  input: ToolResultInput,
): string {
  const tool = safeSegment(input.toolName);
  const call = safeSegment(input.toolCallId);
  return path.join(storage.baseDir, safeSegment(storage.sessionId), `${tool}-${call}.txt`);
}

export function buildToolResultBudgetSessionDir(
  storage: { baseDir: string; sessionId: string },
): string {
  return path.join(storage.baseDir, safeSegment(storage.sessionId));
}

function previewContent(content: string, previewChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= previewChars) return { preview: content, hasMore: false };
  return { preview: content.slice(0, previewChars), hasMore: true };
}

// ─── Command Output Summary ────────────────────────────────────────────────

export interface CommandOutputSummary {
  exitCode?: number;
  failedLines: string[];
  errorLines: string[];
}

/**
 * 总结命令输出（提取关键信息）
 */
export function summarizeCommandOutput(content: string): CommandOutputSummary {
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

// ─── Re-export state module ────────────────────────────────────────────────

export {
  createToolResultBudgetState,
  reconstructToolResultBudgetState,
  serializeToolResultBudgetState,
  type ToolResultBudgetState,
  type ToolResultReplacementRecord,
} from "./tool-result-budget-state";