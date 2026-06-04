/**
 * EvidenceTracker — 证据闭环，降低幻觉
 *
 * 设计原则：
 * - 降低幻觉：声称完成时必须有 tool_result 支撑
 * - 证据链：记录每次工具调用和结果
 * - 完成性核验：message_end 时检查断言是否有证据
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface ToolEvidence {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  timestamp: number;
  success: boolean;
  /** Bash 退出码（仅 bash 工具有值） */
  exitCode?: number;
}

export interface CompletionClaim {
  /** 声称完成的内容 */
  claim: string;
  /** 支撑证据 */
  evidence: ToolEvidence[];
  /** 是否有足够证据 */
  hasEvidence: boolean;
  /** 缺失的证据类型 */
  missingEvidence?: string[];
}

export interface EvidenceAuditResult {
  /** 是否通过核验 */
  passed: boolean;
  /** 本次会话的所有证据 */
  evidences: ToolEvidence[];
  /** 完成性断言（如果有） */
  completionClaim?: CompletionClaim;
  /** 审计信息 */
  auditInfo: {
    totalToolCalls: number;
    successfulCalls: number;
    failedCalls: number;
    writeOperations: number;
  };
}

// ─── State ────────────────────────────────────────────────────────────────

let _evidences: ToolEvidence[] = [];

// ─── Evidence recording ───────────────────────────────────────────────────

/**
 * 记录工具调用证据
 */
export function recordEvidence(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  result?: unknown,
  success = true,
  exitCode?: number
): void {
  _evidences.push({
    toolName,
    toolCallId,
    args,
    result,
    timestamp: Date.now(),
    success,
    exitCode,
  });
}

/**
 * 获取所有证据
 */
export function getEvidences(): ToolEvidence[] {
  return [..._evidences];
}

/**
 * 获取特定工具的证据
 */
export function getEvidencesByTool(toolName: string): ToolEvidence[] {
  return _evidences.filter(e => e.toolName === toolName);
}

/**
 * 获取写操作的证据
 */
export function getWriteEvidences(): ToolEvidence[] {
  return _evidences.filter(e =>
    ["write", "edit", "bash"].includes(e.toolName) && e.success
  );
}

// ─── Completion verification ──────────────────────────────────────────────

/**
 * 检查完成性断言
 *
 * 当模型声称"已完成"时，检查是否有足够的证据支撑。
 */
export function verifyCompletion(
  claimText: string
): CompletionClaim {
  const evidence = getWriteEvidences();

  // 检查是否有写操作证据
  const hasWriteEvidence = evidence.length > 0;

  // 检查是否有文件操作证据
  const hasFileEvidence = evidence.some(e =>
    ["write", "edit"].includes(e.toolName)
  );

  // 检查是否有命令执行证据
  const hasCommandEvidence = evidence.some(e =>
    e.toolName === "bash"
  );

  const missingEvidence: string[] = [];
  if (!hasWriteEvidence) missingEvidence.push("write/edit operations");
  if (!hasFileEvidence) missingEvidence.push("file modifications");
  if (!hasCommandEvidence) missingEvidence.push("command execution");

  return {
    claim: claimText,
    evidence,
    hasEvidence: hasWriteEvidence,
    missingEvidence: missingEvidence.length > 0 ? missingEvidence : undefined,
  };
}

// ─── Audit ────────────────────────────────────────────────────────────────

/**
 * 生成证据审计报告
 */
export function auditEvidence(): EvidenceAuditResult {
  const evidences = getEvidences();
  const writeEvidences = getWriteEvidences();

  return {
    passed: writeEvidences.length > 0 || evidences.length === 0,
    evidences,
    auditInfo: {
      totalToolCalls: evidences.length,
      successfulCalls: evidences.filter(e => e.success).length,
      failedCalls: evidences.filter(e => !e.success).length,
      writeOperations: writeEvidences.length,
    },
  };
}

/**
 * 重置证据（会话结束或测试用）
 */
export function resetEvidence(): void {
  _evidences = [];
}
