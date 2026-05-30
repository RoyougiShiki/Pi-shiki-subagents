/**
 * RuntimeAudit — 结构化审计输出
 *
 * 设计原则：
 * - 可观测性：所有决策都有审计记录
 * - 不污染用户：审计输出到 stderr 或 jsonl，不进聊天流
 * - 开关控制：默认关闭，按需开启
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type AuditEvent =
  | ToolScopeEvent
  | ClarificationEvent
  | ApprovalEvent
  | EvidenceEvent
  | ViolationEvent;

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

export interface EvidenceEvent {
  type: "evidence";
  action: "recorded" | "verified" | "failed";
  toolName: string;
  toolCallId?: string;
  hasEvidence?: boolean;
  timestamp: number;
}

export interface ViolationEvent {
  type: "violation";
  action: "blocked" | "logged";
  toolName: string;
  reason: string;
  timestamp: number;
}

// ─── State ────────────────────────────────────────────────────────────────

let _auditEnabled = false;
let _auditLog: AuditEvent[] = [];

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * 启用/禁用审计
 */
export function setAuditEnabled(enabled: boolean): void {
  _auditEnabled = enabled;
}

/**
 * 获取审计状态
 */
export function isAuditEnabled(): boolean {
  return _auditEnabled;
}

/**
 * 清空审计日志
 */
export function clearAuditLog(): void {
  _auditLog = [];
}

/**
 * 获取审计日志
 */
export function getAuditLog(): AuditEvent[] {
  return [..._auditLog];
}

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * 记录审计事件
 */
export function recordAudit(event: AuditEvent): void {
  if (!_auditEnabled) return;

  _auditLog.push(event);

  // 输出到 stderr（不污染聊天流）
  if (process.env.OMO_DEBUG_TOOLS === "1" || process.env.OMO_AUDIT === "1") {
    console.error(`[audit] ${JSON.stringify(event)}`);
  }
}

/**
 * 记录工具真值事件
 */
export function auditToolScope(
  action: "set" | "audit",
  source: string,
  sourceName: string,
  tools: string[]
): void {
  recordAudit({
    type: "tool_scope",
    action,
    source,
    sourceName,
    tools,
    timestamp: Date.now(),
  });
}

/**
 * 记录澄清事件
 */
export function auditClarification(
  action: "blocked" | "passed",
  toolName: string,
  reason?: string
): void {
  recordAudit({
    type: "clarification",
    action,
    toolName,
    reason,
    timestamp: Date.now(),
  });
}

/**
 * 记录审批事件
 */
export function auditApproval(
  action: "required" | "approved" | "denied" | "passed",
  toolName: string,
  riskLevel?: string,
  reason?: string
): void {
  recordAudit({
    type: "approval",
    action,
    toolName,
    riskLevel,
    reason,
    timestamp: Date.now(),
  });
}

/**
 * 记录证据事件
 */
export function auditEvidence(
  action: "recorded" | "verified" | "failed",
  toolName: string,
  toolCallId?: string,
  hasEvidence?: boolean
): void {
  recordAudit({
    type: "evidence",
    action,
    toolName,
    toolCallId,
    hasEvidence,
    timestamp: Date.now(),
  });
}

/**
 * 记录违规事件
 */
export function auditViolation(
  action: "blocked" | "logged",
  toolName: string,
  reason: string
): void {
  recordAudit({
    type: "violation",
    action,
    toolName,
    reason,
    timestamp: Date.now(),
  });
}
