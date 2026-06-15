/**
 * ToolEvidence — 工具调用证据类型定义。
 * Type only; runtime state removed (see proposal-v2.md §2 H1).
 * 运行时记录由 harness/evidence-session-store.ts 负责（会话隔离）。
 */

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
