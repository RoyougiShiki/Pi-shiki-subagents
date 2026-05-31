/**
 * ClarificationPolicy — 信息不足时阻止盲目执行
 *
 * 设计原则：
 * - 减少猜测：信息不足时不执行高风险操作
 * - 不做文本格式警察：不要求 Intent: 前缀等格式
 * - 轻量判断：仅对明确写入工具做最小检查，不覆盖工具 schema
 */

export interface ClarificationDecision {
  ready: boolean;
  reason?: string;
  missingFields?: string[];
}

/** 参数中包含路径类字段的工具 */
const PATH_FIELDS = ["path", "file", "filePath", "target", "destination"];

export function checkClarification(
  toolName: string,
  args: Record<string, unknown>,
  context?: {
    userRequest?: string;
    turnCount?: number;
    hasEvidence?: boolean;
  }
): ClarificationDecision {
  const missingFields: string[] = [];

  const hasPath = PATH_FIELDS.some((field) => {
    const val = args[field];
    return val !== undefined && val !== null && val !== "";
  });

  if (toolName === "write") {
    if (!hasPath) {
      missingFields.push("path (any of: path, file, filePath, target, destination)");
    }
    const hasContent = ["content", "data", "text", "code"].some((field) => {
      const val = args[field];
      return val !== undefined && val !== null && val !== "";
    });
    if (!hasContent) {
      missingFields.push("content (any of: content, data, text, code)");
    }
  } else if (toolName === "edit") {
    if (!hasPath) {
      missingFields.push("path (any of: path, file, filePath, target, destination)");
    }
    const hasEditsArray = Array.isArray(args["edits"]) && (args["edits"] as unknown[]).length > 0;
    const hasOldNew = args["oldText"] !== undefined && args["oldText"] !== "" && args["newText"] !== undefined;
    if (!hasEditsArray && !hasOldNew) {
      missingFields.push("edits (or oldText + newText)");
    }
  } else if (toolName === "bash") {
    const cmd = args["command"];
    if (cmd === undefined || cmd === null || cmd === "") {
      missingFields.push("command");
    }
  } else {
    return { ready: true };
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

export function shouldBlockForClarification(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  const decision = checkClarification(toolName, args);
  return !decision.ready;
}
