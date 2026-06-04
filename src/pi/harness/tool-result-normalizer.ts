/**
 * Tool Result Normalizer — 统一处理 raw tool result
 *
 * 设计原则：
 * - 纯函数，无 Pi API 依赖
 * - 统一处理两个投影：internal evidence + model-facing message
 * - 命令退出码语义复用 policy/command-semantics（唯一真源）
 *
 * Sprint 1 最小版本：
 * - 接收 tool_result hook 的原始数据
 * - 输出 StructuredToolResult（给 evidence-session-store）
 * - 输出 model-facing message（返回给模型）
 */

import { interpretCommandSemantic, type CommandSemanticResult } from "../policy/command-semantics";

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Session artifact 引用（替代 cc-haha 的 transcript_path）
 */
export interface SessionArtifactRef {
  kind: "session_file" | "session_entries";
  sessionId: string;
  path?: string;
}

/**
 * Normalizer 输入（来自 tool_result hook）
 */
export interface ToolResultNormalizeInput {
  toolName: string;
  toolCallId: string;
  rawInput: Record<string, unknown>;
  /** model-facing content，不是完整 rawResponse */
  modelFacingContent: unknown;
  isError: boolean;
  /** 从 content 解析，或 undefined */
  exitCode?: number;
  sessionArtifactRef?: SessionArtifactRef;
}

/**
 * 结构化工具结果（给 evidence-session-store）
 */
export interface StructuredToolResult {
  toolName: string;
  toolCallId: string;
  rawInput: Record<string, unknown>;
  /** model-facing content，不是完整 rawResponse */
  rawResponse?: unknown;
  timestamp: number;
  success: boolean;
  exitCode?: number;
  /** 语义化标记；普通 success 不额外记录 */
  semantic?: CommandSemanticResult["semantic"];
  /** session artifact 引用 */
  sessionArtifactRef?: SessionArtifactRef;
}

/**
 * Normalizer 输出
 */
export interface ToolResultNormalizeOutput {
  /** 给 evidence-session-store */
  evidence: StructuredToolResult;
  /** 返回给模型的消息（可能被修改） */
  modelFacingMessage: unknown;
  /** 是否修改了原始消息 */
  messageModified: boolean;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * 标准化工具结果
 *
 * @param input 来自 tool_result hook 的原始数据
 * @returns 标准化结果（evidence + model-facing message）
 */
export function normalizeToolResult(input: ToolResultNormalizeInput): ToolResultNormalizeOutput {
  const timestamp = Date.now();
  let modelFacingMessage = input.modelFacingContent;
  let messageModified = false;
  let semantic: StructuredToolResult["semantic"] | undefined;
  let success = !input.isError;

  // ── Bash 命令语义化 ─────────────────────────────────────────────────────
  if (input.toolName === "bash" && input.exitCode !== undefined && typeof input.rawInput.command === "string") {
    const commandSemantic = interpretCommandSemantic(input.rawInput.command, input.exitCode);

    // 普通 success 对 evidence 没有额外信息量；特殊语义和 error 才记录。
    semantic = commandSemantic.semantic === "success" ? undefined : commandSemantic.semantic;
    success = !commandSemantic.isError;

    if (!commandSemantic.isError && commandSemantic.message) {
      const contentText = extractTextFromContent(input.modelFacingContent);
      const isOnlyExitMessage = /^\s*\(no output\)\s*\n?\s*Command exited with code \d+\s*$/.test(contentText) ||
                                 /^\s*Command exited with code \d+\s*$/.test(contentText) ||
                                 /^\s*\(no output\)\s*$/.test(contentText);

      if ((!contentText.trim() || isOnlyExitMessage) && commandSemantic.message) {
        modelFacingMessage = { type: "text", text: commandSemantic.message };
        messageModified = true;
      }
    }
  }

  const evidence: StructuredToolResult = {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    rawInput: input.rawInput,
    rawResponse: input.modelFacingContent,
    timestamp,
    success,
    exitCode: input.exitCode,
    semantic,
    sessionArtifactRef: input.sessionArtifactRef,
  };

  return {
    evidence,
    modelFacingMessage,
    messageModified,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * 从 content 提取文本
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    return texts.join("\n");
  }
  // 单个 TextContent object
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      return obj.text;
    }
  }
  return "";
}
