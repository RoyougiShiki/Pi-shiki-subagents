/**
 * ClarificationPolicy — 信息不足时阻止盲目执行
 *
 * 设计原则：
 * - 减少猜测：信息不足时不执行高风险操作
 * - 不做文本格式警察：不要求 Intent: 前缀等格式
 * - 轻量判断：基于工具类型和参数特征，不依赖复杂推理
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface ClarificationDecision {
  ready: boolean;
  reason?: string;
  missingFields?: string[];
}

// ─── Risk classification ──────────────────────────────────────────────────

/** 需要明确信息才能执行的工具 */
const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

/** 参数中包含路径类字段的工具 */
const PATH_FIELDS = ["path", "file", "filePath", "target", "destination"];

/** 参数中包含内容类字段的工具 */
const CONTENT_FIELDS = ["content", "data", "text", "command", "code"];

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * 判断当前动作是否可以执行
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @param context - 上下文信息（可选）
 * @returns ClarificationDecision
 */
export function checkClarification(
  toolName: string,
  args: Record<string, unknown>,
  context?: {
    /** 用户最近的请求摘要 */
    userRequest?: string;
    /** 当前对话轮次 */
    turnCount?: number;
    /** 是否已有相关 tool_result */
    hasEvidence?: boolean;
  }
): ClarificationDecision {
  // 非写入工具直接放行
  if (!WRITE_TOOLS.has(toolName)) {
    return { ready: true };
  }

  const missingFields: string[] = [];

  // 检查路径字段（至少需要一个）
  const hasPath = PATH_FIELDS.some(field => {
    const val = args[field];
    return val !== undefined && val !== null && val !== "";
  });
  if (!hasPath) {
    missingFields.push("path (any of: path, file, filePath, target, destination)");
  }

  // 检查内容字段（write/edit 必须有内容）
  if (toolName === "write" || toolName === "edit") {
    const hasContent = CONTENT_FIELDS.some(field => {
      const val = args[field];
      return val !== undefined && val !== null && val !== "";
    });
    if (!hasContent) {
      missingFields.push("content (any of: content, data, text, code)");
    }
  }

  // bash 工具：检查 command 是否为空
  if (toolName === "bash") {
    const cmd = args["command"];
    if (cmd === undefined || cmd === null || cmd === "") {
      missingFields.push("command");
    }
  }

  if (missingFields.length > 0) {
    return {
      ready: false,
      reason: `缺少必要参数: ${missingFields.join(", ")}`,
      missingFields,
    };
  }

  return { ready: true };
}

/**
 * 快速判断：是否应该阻止执行
 *
 * 用于 tool_call gate 的快速路径。
 */
export function shouldBlockForClarification(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  const decision = checkClarification(toolName, args);
  return !decision.ready;
}
