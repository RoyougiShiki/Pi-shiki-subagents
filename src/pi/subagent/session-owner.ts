import { createHash } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * 解析当前扩展上下文的会话唯一标识。
 *
 * pi-web 多会话并存时，每个 RPC session 有独立 sessionId；TUI 单会话时
 * sessionId 同样存在。兜底用会话文件路径的 hash（文件是每会话唯一的）。
 *
 * 该标识用于 pool 子代理的归属路由：完成/失败/预警事件只回发给
 * spawn 它的会话（subagent-pool / pool-notice-bridge 的 ownerSessionId）。
 */
export function resolveOwnerSessionId(ctx: ExtensionContext): string {
  // 嵌套子代理：继承根发起会话的归属（由 pool.spawn 注入）。
  const inherited = process.env.OMO_OWNER_SESSION_ID;
  if (typeof inherited === 'string' && inherited.trim()) return inherited;
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager as
    | { getSessionId?: () => unknown; getSessionFile?: () => unknown }
    | undefined;
  const sessionId = sessionManager?.getSessionId?.();
  if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
  const sessionFile = sessionManager?.getSessionFile?.();
  if (typeof sessionFile === 'string' && sessionFile.trim()) {
    return `file-${createHash('sha256').update(sessionFile).digest('hex').slice(0, 16)}`;
  }
  return 'unknown';
}
