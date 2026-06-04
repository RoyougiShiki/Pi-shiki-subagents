/**
 * Command Semantics — 命令退出码语义判断
 *
 * 设计原则：
 * - 纯函数，无 Pi API 依赖
 * - 语义表来自唯一真源（DEFAULT_COMMAND_SEMANTICS）
 * - 可配置 override
 *
 * 用途：
 * - evidence-adapter 判断工具是否真正失败
 * - grep/rg/find 等命令退出码 1 不等于错误
 * - 降低误判 tool_failure
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface CommandSemanticResult {
  isError: boolean;
  semantic: "success" | "no_matches" | "partial_success" | "condition_false" | "files_differ" | "error";
  message?: string;
}

export interface CommandSemanticConfig {
  [command: string]: {
    /** 退出码语义映射 */
    exitCodeMap: Record<number, CommandSemanticResult["semantic"]>;
    /** 默认语义（未映射的退出码） */
    defaultSemantic: CommandSemanticResult["semantic"];
    /** 自定义消息 */
    messages?: Record<number, string>;
  };
}

// ─── Default Semantics (Single Source of Truth) ─────────────────────────────

/**
 * 默认命令语义表
 *
 * grep/rg: 0=matches found, 1=no matches, 2+=error
 * find: 0=success, 1=partial success, 2+=error
 * diff: 0=no differences, 1=differences found, 2+=error
 * test: 0=condition true, 1=condition false, 2+=error
 */
const DEFAULT_COMMAND_SEMANTICS: CommandSemanticConfig = {
  grep: {
    exitCodeMap: { 0: "success", 1: "no_matches", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "No matches found" },
  },
  rg: {
    exitCodeMap: { 0: "success", 1: "no_matches", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "No matches found" },
  },
  find: {
    exitCodeMap: { 0: "success", 1: "partial_success", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "Some directories were inaccessible" },
  },
  diff: {
    exitCodeMap: { 0: "success", 1: "files_differ", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "Files differ" },
  },
  test: {
    exitCodeMap: { 0: "success", 1: "condition_false", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "Condition is false" },
  },
  "[": {
    exitCodeMap: { 0: "success", 1: "condition_false", 2: "error" },
    defaultSemantic: "error",
    messages: { 1: "Condition is false" },
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * 提取命令基础名（第一个词）
 */
function extractBaseCommand(commandText: string): string {
  const trimmed = commandText.trim();
  if (!trimmed) return "";
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  return firstWord;
}

/**
 * 判断语义是否代表错误
 */
function isSemanticError(semantic: CommandSemanticResult["semantic"]): boolean {
  return semantic === "error";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * 解释命令退出码语义
 *
 * @param commandText 命令文本（如 "grep -R pattern src"）
 * @param exitCode 退出码
 * @param config 可选语义表 override
 * @returns 语义结果
 */
export function interpretCommandSemantic(
  commandText: string,
  exitCode: number,
  config?: CommandSemanticConfig,
): CommandSemanticResult {
  const semantics = config ?? DEFAULT_COMMAND_SEMANTICS;
  const baseCommand = extractBaseCommand(commandText);
  const rule = semantics[baseCommand];

  if (!rule) {
    // 未配置的命令：默认 0=success, 其他=error
    const isError = exitCode !== 0;
    return {
      isError,
      semantic: isError ? "error" : "success",
      message: isError ? `Command failed with exit code ${exitCode}` : undefined,
    };
  }

  const semantic = rule.exitCodeMap[exitCode] ?? rule.defaultSemantic;
  const message = rule.messages?.[exitCode];

  return {
    isError: isSemanticError(semantic),
    semantic,
    message,
  };
}

/**
 * 获取默认语义表（用于 config merge）
 * 返回深拷贝，避免修改影响模块默认值
 */
export function getDefaultCommandSemantics(): CommandSemanticConfig {
  const copy: CommandSemanticConfig = {};
  for (const [cmd, rule] of Object.entries(DEFAULT_COMMAND_SEMANTICS)) {
    copy[cmd] = {
      exitCodeMap: { ...rule.exitCodeMap },
      defaultSemantic: rule.defaultSemantic,
      messages: rule.messages ? { ...rule.messages } : undefined,
    };
  }
  return copy;
}

// ─── Re-export ──────────────────────────────────────────────────────────────

export { DEFAULT_COMMAND_SEMANTICS };