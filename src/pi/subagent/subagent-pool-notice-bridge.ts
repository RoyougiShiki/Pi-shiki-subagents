import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface PoolNoticeEvent {
  type: 'error' | 'completed';
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
  ingestPoolCompleted(event: PoolNoticeEvent, ctx: ExtensionContext): Promise<void>;
}

export interface PoolReviewLoopDecision {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  round: number;
  maxReviewRounds: number;
  exhausted: boolean;
}

export interface PoolReviewLoopRuntime {
  recordPoolCompletedReview(event: PoolNoticeEvent): PoolReviewLoopDecision | undefined;
}

interface PoolNoticeBridgeState {
  unsubscribe?: () => void;
  generation?: number;
}

const GLOBAL_KEY = Symbol.for('oh-my-opencode-slim.pool-notice-bridge');

function bridgeState(): PoolNoticeBridgeState {
  const globalRecord = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: PoolNoticeBridgeState;
  };
  globalRecord[GLOBAL_KEY] ??= {};
  return globalRecord[GLOBAL_KEY];
}

export function formatPoolEventLabel(event: { agentName: string; poolId?: string }): string {
  return event.poolId && event.poolId !== event.agentName
    ? `${event.agentName}/${event.poolId}`
    : event.agentName;
}

export function formatPoolCompletedContent(
  event: PoolNoticeEvent,
  reviewLoop?: PoolReviewLoopDecision,
): string {
  const header = `[pool] ${formatPoolEventLabel(event)} 已完成`;
  const base = event.response
    ? `${header}\n\n${event.response}\n\n[decision] 请选择下一步: 返工继续 / 提问用户 / 调用下一阶段子代理`
    : `${header}\n\n[decision] 请选择下一步: 返工继续 / 提问用户 / 调用下一阶段子代理`;
  if (!reviewLoop) return base;
  const verdictLine = `[review-loop] VERDICT: ${reviewLoop.verdict}; round ${reviewLoop.round}/${reviewLoop.maxReviewRounds}.`;
  if (reviewLoop.verdict === "PASS") {
    return `${base}\n\n${verdictLine} 审查已通过，可以按 workflow 门禁进入下一步。`;
  }
  if (reviewLoop.exhausted) {
    return `${base}\n\n${verdictLine} 已达到本阶段 MAX_REVIEW_ROUNDS；停止继续返工/复审，向用户汇报分歧和剩余风险，由用户裁决。`;
  }
  return `${base}\n\n${verdictLine} 未通过但仍在轮次预算内；把 oracle 的具体问题交还同一实现会话返工，然后再次审查。`;
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

function isCurrentGeneration(generation: number): boolean {
  return bridgeState().generation === generation;
}

function createGenerationGuardedContext(ctx: ExtensionContext, generation: number): ExtensionContext {
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
  reviewLoopRuntime?: PoolReviewLoopRuntime;
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
    // Deliver the user-visible completion promptly; verifier ingestion is best-effort and must not block the follow-up turn.
    if (event.type === 'completed') {
      const guardedCtx = createGenerationGuardedContext(options.ctx, generation);
      const reviewLoop = options.reviewLoopRuntime?.recordPoolCompletedReview(event);
      if (isCurrentGeneration(generation)) {
        try {
          options.ctx.ui.notify(
            `[pool] ${formatPoolEventLabel(event)} completed`,
            'success',
          );
        } catch {}
        try {
          options.pi.sendMessage(
            {
              customType: 'pool_completed',
              content: formatPoolCompletedContent(event, reviewLoop),
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
