/**
 * DeniedToolMemory — 防止模型重复调用被拒工具
 *
 * 设计原则：
 * - 记录被拒绝的工具调用（toolName + normalizedInputHash）
 * - 下次相同调用时 block 并注入 guard message
 * - 过期自动清理（默认 5 分钟）
 *
 * 与 cc-haha 对应：
 * - src/constants/prompts.ts: user denied tool call rule
 * - src/hooks/useCanUseTool.tsx: deny branch
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface DeniedToolCallRecord {
  toolName: string;
  inputHash: string;
  displayInput: string;
  reason: string;
  timestamp: number;
  expiresAt: number;
}

export interface DeniedToolMemoryState {
  records: DeniedToolCallRecord[];
}

export interface DeniedToolMemoryOptions {
  ttlMs?: number; // 过期时间，默认 5 分钟
  maxRecords?: number; // 最大记录数，默认 100
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DEFAULT_MAX_RECORDS = 100;

// ─── State ────────────────────────────────────────────────────────────────

let _state: DeniedToolMemoryState = { records: [] };

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * 计算输入的标准化 hash
 * 只保留关键字段，忽略次要字段，减少误判
 */
function computeInputHash(toolName: string, input: Record<string, unknown>): string {
  // 不同工具的关键字段
  const keyFieldsByTool: Record<string, string[]> = {
    bash: ["command"],
    read: ["path"],
    write: ["path"],
    edit: ["path", "oldText", "newText"],
    grep: ["pattern", "path"],
    find: ["pattern", "path"],
    ls: ["path"],
  };

  const keyFields = keyFieldsByTool[toolName] ?? Object.keys(input).sort();
  const keyValues: Record<string, unknown> = {};

  for (const field of keyFields) {
    if (input[field] !== undefined) {
      keyValues[field] = input[field];
    }
  }

  // 简单 hash：JSON.stringify + 截取
  const json = JSON.stringify(keyValues);
  return `${toolName}:${json.length}:${json.slice(0, 200)}`;
}

/**
 * 清理过期记录
 */
function cleanExpiredRecords(now: number): void {
  _state.records = _state.records.filter((r) => r.expiresAt > now);
}

/**
 * 限制记录数量
 */
function enforceMaxRecords(max: number): void {
  if (_state.records.length > max) {
    _state.records = _state.records.slice(-max);
  }
}

// ─── Core Functions ───────────────────────────────────────────────────────

/**
 * 记录被拒绝的工具调用
 */
export function recordDeniedToolCall(
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
  options: DeniedToolMemoryOptions = {},
): void {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const now = Date.now();

  cleanExpiredRecords(now);

  const inputHash = computeInputHash(toolName, input);
  const displayInput = JSON.stringify(input).slice(0, 100);

  // 检查是否已存在相同记录
  const existing = _state.records.find(
    (r) => r.toolName === toolName && r.inputHash === inputHash,
  );

  if (existing) {
    // 更新时间戳
    existing.timestamp = now;
    existing.expiresAt = now + ttlMs;
    existing.reason = reason;
    return;
  }

  _state.records.push({
    toolName,
    inputHash,
    displayInput,
    reason,
    timestamp: now,
    expiresAt: now + ttlMs,
  });

  enforceMaxRecords(maxRecords);
}

/**
 * 检查是否是重复的被拒调用
 */
export function isDeniedToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: DeniedToolMemoryOptions = {},
): DeniedToolCallRecord | null {
  const now = Date.now();
  cleanExpiredRecords(now);

  const inputHash = computeInputHash(toolName, input);
  const record = _state.records.find(
    (r) => r.toolName === toolName && r.inputHash === inputHash && r.expiresAt > now,
  );

  return record ?? null;
}

/**
 * 获取所有有效记录
 */
export function getDeniedToolCalls(): DeniedToolCallRecord[] {
  cleanExpiredRecords(Date.now());
  return [..._state.records];
}

/**
 * 清除所有记录
 */
export function resetDeniedToolMemory(): void {
  _state = { records: [] };
}

/**
 * 生成 guard message
 */
export function buildDeniedToolGuardMessage(record: DeniedToolCallRecord): string {
  return `[guard] 该调用 (${record.toolName}) 之前已被拒绝：${record.reason}\n请勿重复相同调用，考虑其他方案或询问用户。`;
}
