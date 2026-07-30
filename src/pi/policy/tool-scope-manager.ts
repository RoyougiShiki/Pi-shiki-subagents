/**
 * ToolScopeManager — 工具真值的唯一决策源
 *
 * The main session writes a broad scope once. Each subagent is mechanically
 * constrained through its own Pi SDK session tool list.
 */
// ─── Types ────────────────────────────────────────────────────────────────

export interface ToolScopeSnapshot {
  /** 当前生效的工具列表 */
  tools: Set<string>;
  /** Scope owner. */
  source: 'main' | 'subagent';
  /** Scope owner name. */
  sourceName: string;
  /** 写入时间戳 */
  timestamp: number;
  /** 关联的 agent 配置（用于审计追溯） */
  agentConfig?: {
    roles?: string[];
    tools?: string[];
  };
}

export interface ToolScopeAuditResult {
  consistent: boolean;
  snapshotTools: string[];
  payloadTools: string[];
  missingInPayload: string[];
  extraInPayload: string[];
}

// ─── State ────────────────────────────────────────────────────────────────

let _snapshot: ToolScopeSnapshot | null = null;

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * Record the active main-session scope after setActiveTools().
 */
export function setToolScope(
  activeTools: string[],
  source: ToolScopeSnapshot['source'],
  sourceName: string,
  agentConfig?: ToolScopeSnapshot['agentConfig'],
): void {
  _snapshot = {
    tools: new Set(activeTools),
    source,
    sourceName,
    timestamp: Date.now(),
    agentConfig,
  };
}

/**
 * 获取当前工具真值快照（唯一读取点）
 *
 * tool_call gate 只用这个，不重新计算。
 */
export function getToolScope(): ToolScopeSnapshot | null {
  return _snapshot;
}

/**
 * 检查工具是否在当前真值中
 *
 * tool_call gate 的核心判断。
 */
export function isToolAllowed(toolName: string): boolean {
  if (!_snapshot) return false;
  return _snapshot.tools.has(toolName);
}

/**
 * 审计对比：payload.tools vs snapshot
 *
 * before_provider_request 中调用，只做 diff，不参与决策。
 */
export function auditPayloadTools(
  payloadTools: string[],
): ToolScopeAuditResult {
  if (!_snapshot) {
    return {
      consistent: false,
      snapshotTools: [],
      payloadTools,
      missingInPayload: [],
      extraInPayload: payloadTools,
    };
  }

  const snapshotList = [..._snapshot.tools];
  const payloadSet = new Set(payloadTools);
  const snapshotSet = _snapshot.tools;

  const missingInPayload = snapshotList.filter((t) => !payloadSet.has(t));
  const extraInPayload = payloadTools.filter((t) => !snapshotSet.has(t));

  return {
    consistent: missingInPayload.length === 0 && extraInPayload.length === 0,
    snapshotTools: snapshotList,
    payloadTools,
    missingInPayload,
    extraInPayload,
  };
}

/**
 * 重置快照（会话结束或测试用）
 */
export function resetToolScope(): void {
  _snapshot = null;
}
