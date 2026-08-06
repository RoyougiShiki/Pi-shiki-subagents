import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  formatPoolCompletedContent,
  formatPoolErrorContent,
  formatPoolEventLabel,
  formatPoolStallWarnContent,
  type PoolNoticeEvent,
  registerPoolNoticeBridge,
  resetPoolNoticeBridgeForTests,
} from './subagent-pool-notice-bridge';

function createPool() {
  const listeners: Array<(event: PoolNoticeEvent) => void> = [];
  return {
    onEvent: mock((listener: (event: PoolNoticeEvent) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
    emit(event: PoolNoticeEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function createContext() {
  return { ui: { notify: mock(() => {}) } } as any;
}

describe('subagent pool notices', () => {
  beforeEach(() => resetPoolNoticeBridgeForTests());

  test('keeps completion notifications short and points to pool=result', () => {
    const response = 'x'.repeat(400);
    const content = formatPoolCompletedContent({
      type: 'completed',
      agentName: 'fixer',
      poolId: 'fix-1',
      response,
    });

    expect(formatPoolEventLabel({ agentName: 'fixer', poolId: 'fix-1' })).toBe(
      'fixer/fix-1',
    );
    expect(content).toContain('[pool] fixer/fix-1 completed');
    expect(content).toContain('pool=result');
    expect(content.length).toBeLessThan(response.length);
  });

  test('formats failures with recovery actions', () => {
    const content = formatPoolErrorContent({
      type: 'error',
      agentName: 'search',
      poolId: 'search-1',
      error: 'timed out',
    });

    expect(content).toContain('search/search-1');
    expect(content).toContain('pool=result');
    expect(content).toContain('pool=resume');
  });

  test('formats stall warnings without implying termination', () => {
    const content = formatPoolStallWarnContent({
      type: 'stall_warn',
      agentName: 'worker',
      poolId: 'worker-1',
      error: 'silent for 30000ms',
    });

    expect(content).toContain('worker/worker-1');
    expect(content).toContain('silent for 30000ms');
    expect(content).toContain('尚未终止');
    expect(content).toContain('pool=send');
  });

  test('delivers stall warnings as low-interference followups', () => {
    const pool = createPool();
    const pi = { sendMessage: mock(() => {}) };
    const ctx = createContext();
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({ pool, pi, ctx, harnessRuntime });
    pool.emit({
      type: 'stall_warn',
      agentName: 'worker',
      poolId: 'worker-1',
      error: 'silent for 30000ms',
    });

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'pool_stall_warn',
      display: true,
    });
    // 低干扰：只追加消息、不触发新的 LLM 轮。
    expect(pi.sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: 'followUp',
      triggerTurn: false,
    });
    // 预警不视为结束：不触发 harness 完成摄取。
    expect(harnessRuntime.ingestPoolCompleted).not.toHaveBeenCalled();
  });

  test('delivers completion before asynchronous harness ingestion', () => {
    const pool = createPool();
    const pi = { sendMessage: mock(() => {}) };
    const ctx = createContext();
    const harnessRuntime = {
      ingestPoolCompleted: mock(() => new Promise<void>(() => {})),
    };

    registerPoolNoticeBridge({ pool, pi, ctx, harnessRuntime });
    pool.emit({
      type: 'completed',
      agentName: 'oracle',
      poolId: 'review-1',
      response: 'review complete',
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'pool_completed',
      content: expect.stringContaining('pool=result'),
    });
    expect(harnessRuntime.ingestPoolCompleted).toHaveBeenCalledTimes(1);
  });

  test('replaces stale bridge listeners on session restart', () => {
    const pool = createPool();
    const oldPi = { sendMessage: mock(() => {}) };
    const newPi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({
      pool,
      pi: oldPi,
      ctx: createContext(),
      harnessRuntime,
    });
    registerPoolNoticeBridge({
      pool,
      pi: newPi,
      ctx: createContext(),
      harnessRuntime,
    });
    pool.emit({
      type: 'completed',
      agentName: 'search',
      poolId: 'search-1',
      response: 'done',
    });

    expect(oldPi.sendMessage).not.toHaveBeenCalled();
    expect(newPi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
