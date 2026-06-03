/**
 * Tool Result Budget State — 状态管理
 *
 * 设计原则（cc-haha 设计）：
 * - seenIds：已发送给模型的 tool_use_id，保证不被重新处理
 * - replacements：已替换的内容映射
 * - Prompt cache 稳定性：已发送内容冻结，保证 cache 一致性
 * - 恢复支持：从 transcript 记录重建状态
 *
 * 模块解耦：
 * - 独立的状态模块，不依赖具体存储实现
 * - 提供 serialize/deserialize 用于持久化
 */

export interface ToolResultReplacementRecord {
  kind: "tool-result";
  toolUseId: string;
  toolName: string;
  originalSize: number;
  replacement: string;
  filepath: string;
  createdAt: number;
}

export interface ToolResultBudgetState {
  /** 已发送给模型的 tool_use_id（冻结状态） */
  seenIds: Set<string>;
  /** 已替换的内容映射（tool_use_id -> replacement content） */
  replacements: Map<string, string>;
  /** 替换记录（用于 transcript 持久化） */
  records: ToolResultReplacementRecord[];
}

/**
 * 创建初始状态
 */
export function createToolResultBudgetState(): ToolResultBudgetState {
  return {
    seenIds: new Set<string>(),
    replacements: new Map<string, string>(),
    records: [],
  };
}

/**
 * 检查 tool_use_id 是否已发送给模型
 */
export function isSeenId(state: ToolResultBudgetState, toolUseId: string): boolean {
  return state.seenIds.has(toolUseId);
}

/**
 * 标记 tool_use_id 为已发送
 */
export function markSeenId(state: ToolResultBudgetState, toolUseId: string): void {
  state.seenIds.add(toolUseId);
}

/**
 * 获取已替换的内容
 */
export function getReplacement(state: ToolResultBudgetState, toolUseId: string): string | undefined {
  return state.replacements.get(toolUseId);
}

/**
 * 记录替换
 */
export function recordReplacement(
  state: ToolResultBudgetState,
  record: ToolResultReplacementRecord,
): void {
  state.seenIds.add(record.toolUseId);
  state.replacements.set(record.toolUseId, record.replacement);
  state.records.push(record);
}

/**
 * 批量标记已发送
 */
export function markSeenIds(state: ToolResultBudgetState, toolUseIds: readonly string[]): void {
  for (const id of toolUseIds) {
    state.seenIds.add(id);
  }
}

/**
 * 分区：根据 prior decision 划分候选
 * 
 * - mustReapply: 已有替换记录，需要重新应用
 * - frozen: 已发送但未替换，保持原样
 * - fresh: 新的候选，需要评估
 */
export interface ToolResultCandidate {
  toolUseId: string;
  toolName: string;
  size: number;
  content: string;
}

export interface PartitionedCandidates {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
}

/**
 * 分区候选列表
 */
export function partitionCandidates(
  candidates: readonly ToolResultCandidate[],
  state: ToolResultBudgetState,
): PartitionedCandidates {
  const mustReapply: PartitionedCandidates["mustReapply"] = [];
  const frozen: ToolResultCandidate[] = [];
  const fresh: ToolResultCandidate[] = [];

  for (const candidate of candidates) {
    const replacement = getReplacement(state, candidate.toolUseId);
    if (replacement) {
      // 已有替换记录，重新应用
      mustReapply.push({ ...candidate, replacement });
    } else if (isSeenId(state, candidate.toolUseId)) {
      // 已发送但未替换，冻结
      frozen.push(candidate);
    } else {
      // 新的候选
      fresh.push(candidate);
    }
  }

  return { mustReapply, frozen, fresh };
}

/**
 * 序列化状态（用于 transcript 持久化）
 */
export function serializeToolResultBudgetState(
  state: ToolResultBudgetState,
): ToolResultReplacementRecord[] {
  return [...state.records];
}

/**
 * 从记录重建状态（用于恢复）
 */
export function reconstructToolResultBudgetState(
  records: readonly ToolResultReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ToolResultBudgetState {
  const state = createToolResultBudgetState();

  // 从记录恢复
  for (const record of records) {
    recordReplacement(state, record);
  }

  // 继承父 agent 的替换（用于 fork-subagent resume）
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (!state.replacements.has(id)) {
        state.replacements.set(id, replacement);
      }
    }
  }

  return state;
}

/**
 * 合并状态（用于 subagent resume gap-fill）
 */
export function mergeToolResultBudgetState(
  state: ToolResultBudgetState,
  inherited: ReadonlyMap<string, string>,
): void {
  for (const [id, replacement] of inherited) {
    if (!state.replacements.has(id)) {
      state.replacements.set(id, replacement);
    }
  }
}