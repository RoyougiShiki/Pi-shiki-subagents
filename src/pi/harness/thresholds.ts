/**
 * Tool Result Budget Thresholds — 阈值常量
 *
 * 设计原则：
 * - 唯一真源：所有系统默认阈值在此模块定义
 * - 用户配置优先：用户的 default 覆盖系统的 byTool
 * - 不合并到用户配置：保持清晰分离，便于正确判断优先级
 *
 * cc-haha 阈值参考：
 * - DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000
 * - MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000
 * - PREVIEW_SIZE_BYTES = 2,000
 */

// ─── System Default Thresholds (唯一真源) ────────────────────────────────────

/**
 * 默认单个工具结果阈值（chars）
 * cc-haha: 50,000
 */
export const DEFAULT_TOOL_RESULT_THRESHOLD_CHARS = 50_000;

/**
 * Per-message 预算阈值（chars）
 * cc-haha: 200,000
 *
 * 防止 N 个并发工具各自达到阈值，总量超标
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/**
 * Preview 大小（chars）
 * cc-haha: 2,000 bytes
 */
export const DEFAULT_PREVIEW_CHARS = 2_000;

/**
 * 字节/Token 估算比例
 * cc-haha: 4 bytes per token
 */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

/**
 * 最大工具结果 Token 数
 * cc-haha: 100,000 tokens
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000;

/**
 * 最大工具结果字节数
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN_ESTIMATE;

/**
 * 系统默认阈值（按工具类型）
 *
 * 注意：这是系统默认值，不应与用户配置合并
 */
export const SYSTEM_TOOL_THRESHOLDS: Record<string, number> = {
  bash: DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  grep: 30_000,
  find: 30_000,
  read: DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  web_fetch: DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  subagent: 60_000,
};

/**
 * 系统默认的 default 阈值
 */
export const SYSTEM_DEFAULT_THRESHOLD = DEFAULT_TOOL_RESULT_THRESHOLD_CHARS;

// ─── Threshold Resolution ────────────────────────────────────────────────────

/**
 * 用户阈值配置（结构化）
 */
export interface UserThresholdConfig {
  /** 用户配置的工具阈值 */
  byTool?: Record<string, number>;
  /** 用户配置的默认阈值 */
  default?: number;
}

/**
 * 获取工具阈值
 *
 * 优先级（关键设计）：
 * 1. 用户配置的 byTool[toolName]（精确匹配）
 * 2. 用户配置的 default（覆盖系统的 byTool 和 default）
 * 3. 系统默认的 byTool[toolName]
 * 4. 系统默认的 default
 *
 * 为什么用户 default 优先于系统 byTool？
 * - 用户设置 default=3 意味着"所有工具都用 3"
 * - 如果系统 byTool 优先，用户的 default 只能覆盖系统的 default，
 *   而无法覆盖系统的 bash=50000，这是不直观的
 */
export function getToolThreshold(
  toolName: string,
  userConfig?: UserThresholdConfig,
): number {
  const normalized = toolName.trim().toLowerCase();

  // 1. 用户配置的 byTool（精确匹配）
  if (userConfig?.byTool) {
    const userByTool = userConfig.byTool[normalized] ?? userConfig.byTool[toolName];
    if (typeof userByTool === "number" && Number.isFinite(userByTool) && userByTool > 0) {
      return userByTool;
    }
  }

  // 2. 用户配置的 default（覆盖系统 byTool 和系统 default）
  if (userConfig?.default !== undefined) {
    const userDefault = userConfig.default;
    if (typeof userDefault === "number" && Number.isFinite(userDefault) && userDefault > 0) {
      return userDefault;
    }
  }

  // 3. 系统默认的 byTool
  const systemByTool = SYSTEM_TOOL_THRESHOLDS[normalized];
  if (typeof systemByTool === "number") {
    return systemByTool;
  }

  // 4. 系统默认的 default
  return SYSTEM_DEFAULT_THRESHOLD;
}

// ─── Skip Persist ────────────────────────────────────────────────────────────

/**
 * 检查是否应该跳过持久化
 * 某些工具（如 Read）不应该持久化，因为会造成循环
 */
export const SKIP_PERSIST_TOOL_NAMES = new Set([
  "read", // Read 自己会用 maxTokens 控制大小
]);

/**
 * 检查工具是否应该跳过持久化
 */
export function shouldSkipPersist(toolName: string): boolean {
  return SKIP_PERSIST_TOOL_NAMES.has(toolName.trim().toLowerCase());
}