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

    registerPoolNoticeBridge({
      pool, pi, ctx, harnessRuntime,
      sessionId: 'session-test',
    });
    pool.emit({
      type: 'stall_warn',
      agentName: 'worker',
      poolId: 'worker-1',
      error: 'silent for 30000ms',
      sessionId: 'session-test',
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

    registerPoolNoticeBridge({
      pool, pi, ctx, harnessRuntime,
      sessionId: 'session-test',
    });
    pool.emit({
      type: 'completed',
      agentName: 'oracle',
      poolId: 'review-1',
      response: 'review complete',
      sessionId: 'session-test',
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'pool_completed',
      content: expect.stringContaining('pool=result'),
    });
    expect(harnessRuntime.ingestPoolCompleted).toHaveBeenCalledTimes(1);
  });

  test('routes events only to the owning session bridge', () => {
    const pool = createPool();
    const piA = { sendMessage: mock(() => {}) };
    const piB = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({
      pool,
      pi: piA,
      ctx: createContext(),
      harnessRuntime,
      sessionId: 'session-a',
    });
    // 第二个会话注册后，A 的桥必须仍然存活（回归：不再踢旧订阅）。
    registerPoolNoticeBridge({
      pool,
      pi: piB,
      ctx: createContext(),
      harnessRuntime,
      sessionId: 'session-b',
    });

    pool.emit({
      type: 'completed',
      agentName: 'oracle',
      poolId: 'review-1',
      response: 'review complete',
      sessionId: 'session-a',
    });
    expect(piA.sendMessage).toHaveBeenCalledTimes(1);
    expect(piB.sendMessage).not.toHaveBeenCalled();

    pool.emit({
      type: 'completed',
      agentName: 'search',
      poolId: 'search-1',
      response: 'done',
      sessionId: 'session-b',
    });
    expect(piB.sendMessage).toHaveBeenCalledTimes(1);
    expect(piA.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('ignores events whose session id does not match', () => {
    const pool = createPool();
    const pi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({
      pool,
      pi,
      ctx: createContext(),
      harnessRuntime,
      sessionId: 'session-a',
    });
    pool.emit({
      type: 'completed',
      agentName: 'search',
      poolId: 'search-1',
      response: 'done',
      sessionId: 'session-other',
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  test('stops delivering after the bridge is disposed', () => {
    const pool = createPool();
    const pi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    const dispose = registerPoolNoticeBridge({
      pool,
      pi,
      ctx: createContext(),
      harnessRuntime,
      sessionId: 'session-a',
    });
    dispose();
    pool.emit({
      type: 'completed',
      agentName: 'search',
      poolId: 'search-1',
      response: 'done',
      sessionId: 'session-a',
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
