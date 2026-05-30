/**
 * ApprovalPolicy — 高风险操作需审批
 *
 * 设计原则：
 * - 阻止冲动调用：高风险操作需用户确认
 * - 审批仅针对风险动作：edit/write/bash 变更
 * - 不做过度审批：读操作、查询操作不需要审批
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type ApprovalDecision =
  | { action: "allow" }
  | { action: "require_approval"; reason: string; riskLevel: RiskLevel }
  | { action: "deny"; reason: string };

export type RiskLevel = "low" | "medium" | "high" | "critical";

// ─── Risk classification ──────────────────────────────────────────────────

/** 高风险工具：需要审批 */
const HIGH_RISK_TOOLS = new Set(["write", "edit", "bash"]);

/** 中风险工具：可能需要审批（取决于参数） */
const MEDIUM_RISK_TOOLS = new Set(["omo_subagent", "switch_mode"]);

/** bash 命令危险前缀 */
const DANGEROUS_BASH_PREFIXES = [
  "rm ", "rm\t",
  "sudo ", "su ",
  "chmod ", "chown ",
  "mkfs ", "fdisk ",
  "dd ",
  "> /dev/", ">> /dev/",
  "shutdown ", "reboot ", "halt ",
  "kill ", "killall ",
  "pkill ",
];

// ─── Risk assessment ──────────────────────────────────────────────────────

function assessBashRisk(command: string): RiskLevel {
  const trimmed = command.trim().toLowerCase();
  for (const prefix of DANGEROUS_BASH_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return "critical";
    }
  }
  // 写文件操作
  if (trimmed.includes(" > ") || trimmed.includes(" >> ") || trimmed.includes(" tee ")) {
    return "high";
  }
  // 安装/修改系统
  if (trimmed.includes("npm install") || trimmed.includes("yarn add") || trimmed.includes("pip install")) {
    return "medium";
  }
  return "low";
}

function assessWriteRisk(filePath: string): RiskLevel {
  // 系统文件
  if (filePath.startsWith("/etc/") || filePath.startsWith("/usr/")) {
    return "critical";
  }
  // 配置文件
  if (filePath.includes("config") || filePath.includes(".json") || filePath.includes(".yaml")) {
    return "high";
  }
  return "medium";
}

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * 评估工具调用的风险等级
 */
export function assessRisk(
  toolName: string,
  args: Record<string, unknown>
): RiskLevel {
  if (HIGH_RISK_TOOLS.has(toolName)) {
    if (toolName === "bash") {
      const cmd = typeof args["command"] === "string" ? args["command"] : "";
      return assessBashRisk(cmd);
    }
    if (toolName === "write" || toolName === "edit") {
      const path = typeof args["path"] === "string" ? args["path"] : "";
      return assessWriteRisk(path);
    }
    return "high";
  }

  if (MEDIUM_RISK_TOOLS.has(toolName)) {
    return "medium";
  }

  return "low";
}

/**
 * 判断是否需要审批
 *
 * @param toolName - 工具名称
 * @param args - 工具参数
 * @returns ApprovalDecision
 */
export function checkApproval(
  toolName: string,
  args: Record<string, unknown>
): ApprovalDecision {
  const risk = assessRisk(toolName, args);

  switch (risk) {
    case "critical":
      return {
        action: "require_approval",
        reason: `高风险操作: ${toolName}`,
        riskLevel: risk,
      };
    case "high":
      return {
        action: "require_approval",
        reason: `写入操作: ${toolName}`,
        riskLevel: risk,
      };
    case "medium":
      // 中风险操作默认允许，但记录日志
      return { action: "allow" };
    case "low":
    default:
      return { action: "allow" };
  }
}

/**
 * 快速判断：是否需要审批
 *
 * 用于 tool_call gate 的快速路径。
 */
export function requiresApproval(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  const decision = checkApproval(toolName, args);
  return decision.action === "require_approval";
}
