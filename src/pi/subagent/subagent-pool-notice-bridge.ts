import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface PoolNoticeEvent {
  type: 'error' | 'completed' | 'stall_warn';
  poolId: string;
  agentName: string;
  /** 发起会话标识：通知只回发给该会话（pi-web 多会话并存时事件必须带归属）。 */
  sessionId: string;
  error?: string;
  response?: string;
}

export interface PoolNoticeSource {
  onEvent(cb: (event: PoolNoticeEvent) => void): () => void;
}

export interface PoolNoticeBridgePi {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: 'followUp'; triggerTurn: boolean },
  ): void;
}

export interface PoolNoticeBridgeHarnessRuntime {
  ingestPoolCompleted(
    event: PoolNoticeEvent,
    ctx: ExtensionContext,
  ): Promise<void>;
}

// 每个会话的桥是独立订阅：同一会话重复注册（reload/restart）时先取消旧句柄避免重复处理，
// 跨会话之间共存互不干扰（pi-web 多会话并存的修复：不再用全局单例抢订阅）。
const bridgeSubscriptions = new Map<string, () => void>();

export function formatPoolEventLabel(event: {
  agentName: string;
  poolId?: string;
}): string {
  return event.poolId && event.poolId !== event.agentName
    ? `${event.agentName}/${event.poolId}`
    : event.agentName;
}

export function formatPoolCompletedContent(event: PoolNoticeEvent): string {
  const header = `[pool] ${formatPoolEventLabel(event)} completed`;
  const response = event.response?.trim();
  const preview = response
    ? response.replace(/\s+/g, ' ').slice(0, 280)
    : 'No response text captured.';
  const suffix =
    response && response.length > preview.length
      ? ' Use pool=result for the full response.'
      : ' Use pool=result for details.';
  return `${header}\n${preview}${suffix}`;
}

export function formatPoolErrorContent(event: PoolNoticeEvent): string {
  const header = `[pool] ${formatPoolEventLabel(event)} 已结束: failed`;
  const error = event.error?.trim() || 'unknown error';
  return [
    header,
    '',
    `error: ${error}`,
    '',
    '[decision] 该子代理不会再发送完成通知。请调用 pool=result 查看是否有部分结果；需要继续时使用 pool=resume 或重新 spawn。',
  ].join('\n');
}

export function formatPoolStallWarnContent(event: PoolNoticeEvent): string {
  const header = `[pool] ${formatPoolEventLabel(event)} 长时间无响应`;
  return [
    header,
    '',
    `${event.error ?? 'LLM 流阶段超过预警阈值仍无新事件。'}`,
    '',
    '[info] 尚未终止。可调用 pool=send 发送 nudge 或等待其自动恢复；到 stall 阈值仍无事件将自动 abort 并结算为 failed。',
  ].join('\n');
}

export function registerPoolNoticeBridge(options: {
  pool: PoolNoticeSource;
  pi: PoolNoticeBridgePi;
  ctx: ExtensionContext;
  harnessRuntime: PoolNoticeBridgeHarnessRuntime;
  /** 发起会话标识：只处理该会话 spawn 的子代理事件。 */
  sessionId: string;
}): () => void {
  const { pool, pi, ctx, harnessRuntime, sessionId } = options;

  // 同一会话重复注册（reload/restart）时取消旧句柄，避免重复投递；
  // 不同会话的桥保持共存（pi-web 多会话并存的修复：不再用全局单例抢订阅）。
  bridgeSubscriptions.get(sessionId)?.();

  const unsubscribe = pool.onEvent((event) => {
    // 多会话路由：只处理本会话 spawn 的子代理事件。
    if (event.sessionId !== sessionId) return;

    if (event.type === 'error') {
      try {
        ctx.ui.notify(
          `[pool] ${formatPoolEventLabel(event)}: ${event.error}`,
          'warning',
        );
      } catch {}
      try {
        pi.sendMessage(
          {
            customType: 'pool_failed',
            content: formatPoolErrorContent(event),
            display: true,
          },
          { deliverAs: 'followUp', triggerTurn: true },
        );
      } catch {}
    }
    // 预警：不终止、不触发新轮，仅提醒（父 agent 可 pool=send nudge 提前干预）。
    if (event.type === 'stall_warn') {
      try {
        ctx.ui.notify(
          `[pool] ${formatPoolEventLabel(event)} 长时间无响应，即将自动中止`,
          'warning',
        );
      } catch {}
      try {
        pi.sendMessage(
          {
            customType: 'pool_stall_warn',
            content: formatPoolStallWarnContent(event),
            display: true,
          },
          { deliverAs: 'followUp', triggerTurn: false },
        );
      } catch {}
    }
    // Deliver a compact completion notification before best-effort harness ingestion.
    if (event.type === 'completed') {
      try {
        ctx.ui.notify(
          `[pool] ${formatPoolEventLabel(event)} completed`,
          'info',
        );
      } catch {}
      try {
        pi.sendMessage(
          {
            customType: 'pool_completed',
            content: formatPoolCompletedContent(event),
            display: true,
          },
          { deliverAs: 'followUp', triggerTurn: true },
        );
      } catch {}
      void harnessRuntime
        .ingestPoolCompleted(event, ctx)
        .catch(() => undefined);
    }
  });

  bridgeSubscriptions.set(sessionId, unsubscribe);
  return () => {
    unsubscribe();
    if (bridgeSubscriptions.get(sessionId) === unsubscribe) {
      bridgeSubscriptions.delete(sessionId);
    }
  };
}

/** 会话销毁时清理该会话的桥（只影响本会话，不影响其他会话的桥）。 */
export function disposePoolNoticeBridge(sessionId: string): void {
  bridgeSubscriptions.get(sessionId)?.();
  bridgeSubscriptions.delete(sessionId);
}

export function resetPoolNoticeBridgeForTests(): void {
  for (const dispose of [...bridgeSubscriptions.values()]) {
    try {
      dispose();
    } catch {}
  }
  bridgeSubscriptions.clear();
}
