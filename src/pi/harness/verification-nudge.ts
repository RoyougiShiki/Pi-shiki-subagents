/**
 * Verification Nudge — 检测任务关闭时是否需要 verification 提醒
 *
 * 设计原则：
 * - 纯函数，无 Pi API 依赖
 * - 阈值/pattern/message 来自配置（唯一真源）
 * - 不依赖具体 agent 名
 *
 * 用途：
 * - todo/task 工具输出 verificationNudgeNeeded 字段
 * - tool result 或 UI 追加提醒：最终总结前需要 spawn verifier
 * - 降低"关闭多个任务后直接总结"的幻觉风险
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface TaskItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface VerificationNudgeConfig {
  /** 关闭任务数量阈值，默认 3 */
  threshold?: number;
  /** 检测 verification step 的正则 pattern */
  verificationStepPattern?: RegExp;
  /** 是否启用（可被 feature flag 控制） */
  enabled?: boolean;
}

export interface VerificationNudgeResult {
  needed: boolean;
  closedCount: number;
  hasVerificationStep: boolean;
  reason?: string;
}

// ─── Default Patterns (Single Source of Truth) ─────────────────────────────

const DEFAULT_THRESHOLD = 3;

const DEFAULT_VERIFICATION_STEP_PATTERN = /verif/i;

const DEFAULT_NUDGE_MESSAGE = `NOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, run verification commands (test/lint/typecheck) or spawn a verification agent. You cannot self-assign PARTIAL by listing caveats in your summary — only independent verification counts.`;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * 检测是否需要 verification nudge
 *
 * @param oldTasks 关闭前的任务列表
 * @param newTasks 关闭后的任务列表
 * @param config 配置项
 * @returns 检测结果
 */
export function detectVerificationNudge(
  oldTasks: readonly TaskItem[],
  newTasks: readonly TaskItem[],
  config?: VerificationNudgeConfig,
): VerificationNudgeResult {
  const threshold = config?.threshold ?? DEFAULT_THRESHOLD;
  const pattern = config?.verificationStepPattern ?? DEFAULT_VERIFICATION_STEP_PATTERN;
  const enabled = config?.enabled ?? true;

  if (!enabled) {
    return { needed: false, closedCount: 0, hasVerificationStep: false };
  }

  // 计算关闭的任务数量
  const oldCompletedCount = oldTasks.filter((t) => t.status === "completed").length;
  const newCompletedCount = newTasks.filter((t) => t.status === "completed").length;
  const closedCount = Math.max(0, newCompletedCount - oldCompletedCount);

  // 或者：所有任务都完成了（从非空变成空或全部 completed）
  const allDone = newTasks.length > 0 && newTasks.every((t) => t.status === "completed");
  const wasNotAllDone = oldTasks.some((t) => t.status !== "completed");

  // 检查是否有 verification step
  const hasVerificationStep = oldTasks.some((t) => pattern.test(t.content));

  // 触发条件：
  // 1. 关闭了 >= threshold 个任务
  // 2. 或者所有任务都完成了（且之前不是全部完成）
  // 3. 且没有 verification step
  const meetsThreshold = closedCount >= threshold || (allDone && wasNotAllDone && oldTasks.length >= threshold);

  if (meetsThreshold && !hasVerificationStep) {
    return {
      needed: true,
      closedCount: allDone ? oldTasks.length : closedCount,
      hasVerificationStep: false,
      reason: `Closed ${allDone ? oldTasks.length : closedCount} tasks without verification step`,
    };
  }

  return {
    needed: false,
    closedCount,
    hasVerificationStep,
  };
}

/**
 * 获取默认 nudge 消息
 */
export function getDefaultNudgeMessage(): string {
  return DEFAULT_NUDGE_MESSAGE;
}

/**
 * 格式化 nudge 消息（可自定义）
 */
export function formatNudgeMessage(
  closedCount: number,
  customMessage?: string,
): string {
  const base = customMessage ?? DEFAULT_NUDGE_MESSAGE;
  return base.replace("3+", `${closedCount}+`);
}

// ─── Re-export ──────────────────────────────────────────────────────────────

export { DEFAULT_THRESHOLD, DEFAULT_VERIFICATION_STEP_PATTERN, DEFAULT_NUDGE_MESSAGE };