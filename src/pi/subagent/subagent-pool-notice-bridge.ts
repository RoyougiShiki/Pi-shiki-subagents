import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface PoolNoticeEvent {
  type: 'error' | 'completed' | 'stall_warn';
  poolId: string;
  agentName: string;
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

interface PoolNoticeBridgeState {
  unsubscribe?: () => void;
  generation?: number;
}

const GLOBAL_KEY = Symbol.for('pi-shiki-subagents.pool-notice-bridge');

function bridgeState(): PoolNoticeBridgeState {
  const globalRecord = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: PoolNoticeBridgeState;
  };
  globalRecord[GLOBAL_KEY] ??= {};
  return globalRecord[GLOBAL_KEY];
}

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

function isCurrentGeneration(generation: number): boolean {
  return bridgeState().generation === generation;
}

function createGenerationGuardedContext(
  ctx: ExtensionContext,
  generation: number,
): ExtensionContext {
  const rawCtx = ctx as ExtensionContext & { ui?: { notify?: unknown } };
  const rawUi = rawCtx.ui;
  if (!rawUi || typeof rawUi.notify !== 'function') return ctx;

  const guardedUi = {
    ...rawUi,
    notify: (...args: Parameters<typeof rawUi.notify>) => {
      if (!isCurrentGeneration(generation)) return;
      return rawUi.notify!(...args);
    },
  };

  return {
    ...(ctx as object),
    ui: guardedUi,
  } as ExtensionContext;
}

export function registerPoolNoticeBridge(options: {
  pool: PoolNoticeSource;
  pi: PoolNoticeBridgePi;
  ctx: ExtensionContext;
  harnessRuntime: PoolNoticeBridgeHarnessRuntime;
}): () => void {
  const state = bridgeState();
  try {
    state.unsubscribe?.();
  } catch {}
  const generation = (state.generation ?? 0) + 1;
  state.generation = generation;

  const unsubscribe = options.pool.onEvent((event) => {
    if (event.type === 'error') {
      try {
        options.ctx.ui.notify(
          `[pool] ${formatPoolEventLabel(event)}: ${event.error}`,
          'warning',
        );
      } catch {}
      if (isCurrentGeneration(generation)) {
        try {
          options.pi.sendMessage(
            {
              customType: 'pool_failed',
              content: formatPoolErrorContent(event),
              display: true,
            },
            { deliverAs: 'followUp', triggerTurn: true },
          );
        } catch {}
      }
    }
    // 预警：不终止、不触发新轮，仅提醒（父 agent 可 pool=send nudge 提前干预）。
    if (event.type === 'stall_warn') {
      try {
        options.ctx.ui.notify(
          `[pool] ${formatPoolEventLabel(event)} 长时间无响应，即将自动中止`,
          'warning',
        );
      } catch {}
      if (isCurrentGeneration(generation)) {
        try {
          options.pi.sendMessage(
            {
              customType: 'pool_stall_warn',
              content: formatPoolStallWarnContent(event),
              display: true,
            },
            { deliverAs: 'followUp', triggerTurn: false },
          );
        } catch {}
      }
    }
    // Deliver a compact completion notification before best-effort harness ingestion.
    if (event.type === 'completed') {
      const guardedCtx = createGenerationGuardedContext(
        options.ctx,
        generation,
      );
      if (isCurrentGeneration(generation)) {
        try {
          options.ctx.ui.notify(
            `[pool] ${formatPoolEventLabel(event)} completed`,
            'info',
          );
        } catch {}
        try {
          options.pi.sendMessage(
            {
              customType: 'pool_completed',
              content: formatPoolCompletedContent(event),
              display: true,
            },
            { deliverAs: 'followUp', triggerTurn: true },
          );
        } catch {}
      }
      void options.harnessRuntime
        .ingestPoolCompleted(event, guardedCtx)
        .catch(() => undefined);
    }
  });

  state.unsubscribe = unsubscribe;
  return unsubscribe;
}

export function resetPoolNoticeBridgeForTests(): void {
  const state = bridgeState();
  try {
    state.unsubscribe?.();
  } catch {}
  state.generation = (state.generation ?? 0) + 1;
  state.unsubscribe = undefined;
}
