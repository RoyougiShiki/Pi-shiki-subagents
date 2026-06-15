/**
 * RuntimeAudit — 轻量可观测日志（无全局状态）
 *
 * 设计原则：
 * - 可观测性：harness 决策有结构化日志输出（stderr，不污染聊天流）
 * - 无状态：不维护全局数组，避免内存泄漏和跨会话污染
 * - 开关控制：OMO_AUDIT=1 或 OMO_DEBUG_TOOLS=1 时输出
 *
 * 降级说明：原实现维护全局 _auditLog 数组 + _auditEnabled 状态，
 * 属于未被消费的可变状态（内存泄漏源）。降级为纯函数日志，
 * 保留函数签名以兼容调用方（pi.ts）。详见 proposal-v2.md §2 H2。
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type AuditEvent =
  | ToolScopeEvent
  | ClarificationEvent
  | ApprovalEvent;

export interface ToolScopeEvent {
  type: "tool_scope";
  action: "set" | "audit";
  source: string;
  sourceName: string;
  tools: string[];
  timestamp: number;
}

export interface ClarificationEvent {
  type: "clarification";
  action: "blocked" | "passed";
  toolName: string;
  reason?: string;
  timestamp: number;
}

export interface ApprovalEvent {
  type: "approval";
  action: "required" | "approved" | "denied" | "passed";
  toolName: string;
  riskLevel?: string;
  reason?: string;
  timestamp: number;
}

// ─── Switch (环境变量驱动，无全局可变状态) ─────────────────────────────────

function isAuditEnabled(): boolean {
  return process.env.OMO_AUDIT === "1" || process.env.OMO_DEBUG_TOOLS === "1";
}

/**
 * 兼容旧调用方（pi.ts 在 session_start 调用）。
 * 降级后为 no-op：开关由环境变量驱动，无需运行时设置。
 */
export function setAuditEnabled(_enabled: boolean): void {}

// ─── Core API ─────────────────────────────────────────────────────────────

function logEvent(event: AuditEvent): void {
  if (!isAuditEnabled()) return;
  // 输出到 stderr（不污染聊天流）
  console.error(`[audit] ${JSON.stringify(event)}`);
}

// ─── Convenience wrappers（签名不变，兼容 pi.ts） ──────────────────────────

export function auditToolScope(
  action: "set" | "audit",
  source: string,
  sourceName: string,
  tools: string[]
): void {
  logEvent({ type: "tool_scope", action, source, sourceName, tools, timestamp: Date.now() });
}

export function auditClarification(
  action: "blocked" | "passed",
  toolName: string,
  reason?: string
): void {
  logEvent({ type: "clarification", action, toolName, reason, timestamp: Date.now() });
}

export function auditApproval(
  action: "required" | "approved" | "denied" | "passed",
  toolName: string,
  riskLevel?: string,
  reason?: string
): void {
  logEvent({ type: "approval", action, toolName, riskLevel, reason, timestamp: Date.now() });
}