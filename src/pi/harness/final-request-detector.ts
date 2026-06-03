/**
 * FinalRequestDetector — 检测用户是否请求最终答案
 *
 * 设计原则：
 * - 纯函数，无 Pi API 依赖
 * - 文案 patterns 可配置
 * - 用于 completion auditor 调整审计策略
 *
 * 用途：
 * - userAskedForFinal: true → 审计更严格
 * - userAskedForFinal: false → 审计宽松
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface FinalRequestPatternConfig {
  /** 明确请求完成的 pattern */
  completion?: readonly string[];
  /** 询问状态/进度 */
  statusCheck?: readonly string[];
  /** 确认是否还需要做什么 */
  anythingElse?: readonly string[];
}

export interface FinalRequestDetectorOptions {
  patterns?: FinalRequestPatternConfig;
  /** 检查最近几条消息，默认 3 */
  recentMessageCount?: number;
}

export interface UserMessage {
  role: "user";
  content: string | any[];
}

// ─── Default Patterns (Single Source of Truth) ─────────────────────────────

const DEFAULT_COMPLETION_PATTERNS: readonly string[] = [
  // 中文
  "做完了吗",
  "完成了吗",
  "搞定了吗",
  "好了吗",
  "结束了吗",
  "已完成",
  "全部完成",
  "还有什么没做完",
  // 英文
  "is it done",
  "are you done",
  "have you finished",
  "is this complete",
  "did you finish",
  "all done",
  "task completed",
  "finished",
];

const DEFAULT_STATUS_CHECK_PATTERNS: readonly string[] = [
  // 中文
  "进度",
  "状态",
  "现在怎么样",
  "当前状态",
  // 英文
  "progress",
  "status",
  "current state",
  "how is it going",
];

const DEFAULT_ANYTHING_ELSE_PATTERNS: readonly string[] = [
  // 中文
  "还有什么要做的",
  "还有什么需要",
  "还需要什么",
  "下一步",
  "接下来",
  // 英文
  "anything else",
  "what's next",
  "next step",
  "need anything else",
];

export const DEFAULT_FINAL_REQUEST_PATTERNS: FinalRequestPatternConfig = {
  completion: DEFAULT_COMPLETION_PATTERNS,
  statusCheck: DEFAULT_STATUS_CHECK_PATTERNS,
  anythingElse: DEFAULT_ANYTHING_ELSE_PATTERNS,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * 从 content 数组提取文本
 */
function extractTextFromContent(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join(" ");
}

/**
 * 编译 pattern strings 为 RegExp
 */
function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

// ─── Core Function ────────────────────────────────────────────────────────

/**
 * 检测用户是否请求最终答案
 *
 * @param messages - 最近几条用户消息
 * @param options - 配置选项
 * @returns true 如果用户明确请求最终答案
 */
export function detectFinalRequest(
  messages: readonly UserMessage[],
  options: FinalRequestDetectorOptions = {},
): boolean {
  const patterns = options.patterns ?? DEFAULT_FINAL_REQUEST_PATTERNS;
  const recentCount = options.recentMessageCount ?? 3;

  // 只检查最近的用户消息
  const recentMessages = messages
    .filter((m) => m.role === "user")
    .slice(-recentCount);

  if (recentMessages.length === 0) return false;

  // 编译 patterns
  const completionRegexes = compilePatterns(patterns.completion ?? []);
  const statusRegexes = compilePatterns(patterns.statusCheck ?? []);
  const anythingElseRegexes = compilePatterns(patterns.anythingElse ?? []);

  // 检查每条消息
  for (const message of recentMessages) {
    const text = extractTextFromContent(message.content);
    const normalizedText = text.trim().toLowerCase();

    // 明确请求完成 → true
    for (const regex of completionRegexes) {
      if (regex.test(normalizedText)) return true;
    }

    // 询问状态 + 紧凑上下文 → true
    // 只有极短消息（如“进度？”“状态？”）才算 final request
    // 长句如“请详细说明当前的进度和遇到的问题”不算
    for (const regex of statusRegexes) {
      if (regex.test(normalizedText)) {
        // 极短消息（≤ 5 chars），如“进度？”“状态？”
        if (normalizedText.length <= 5) return true;
      }
    }

    // 确认是否还需要做什么 → true
    for (const regex of anythingElseRegexes) {
      if (regex.test(normalizedText)) return true;
    }
  }

  return false;
}

/**
 * 从完整消息列表提取最近用户消息并检测
 */
export function detectFinalRequestFromMessages(
  allMessages: readonly any[],
  options: FinalRequestDetectorOptions = {},
): boolean {
  const userMessages: UserMessage[] = allMessages
    .filter((m) => m?.role === "user")
    .map((m) => ({
      role: "user" as const,
      content: m.content,
    }));

  return detectFinalRequest(userMessages, options);
}