import { describe, expect, mock, test, beforeEach } from 'bun:test';
import {
  formatPoolCompletedContent,
  formatPoolEventLabel,
  registerPoolNoticeBridge,
  resetPoolNoticeBridgeForTests,
  type PoolNoticeEvent,
} from './subagent-pool-notice-bridge';

function createPool() {
  const listeners: Array<(event: PoolNoticeEvent) => void> = [];
  return {
    onEvent: mock((cb: (event: PoolNoticeEvent) => void) => {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    emit(event: PoolNoticeEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

function createCtx() {
  return {
    ui: {
      notify: mock(() => {}),
    },
  } as any;
}

describe('subagent pool notice bridge', () => {
  beforeEach(() => {
    resetPoolNoticeBridgeForTests();
  });

  test('formats labels with pool id when it differs from agent name', () => {
    expect(formatPoolEventLabel({ agentName: 'fixer', poolId: 'run-1' })).toBe(
      'fixer/run-1',
    );
    expect(formatPoolEventLabel({ agentName: 'fixer', poolId: 'fixer' })).toBe(
      'fixer',
    );
  });

  test('formats completion follow-up with pool identity and custom flow content', () => {
    expect(
      formatPoolCompletedContent({
        type: 'completed',
        agentName: 'fixer',
        poolId: 'run-1',
        response: 'OK',
      }),
    ).toContain('[pool] fixer/run-1 已完成\n\nOK');
  });

  test('replaces previous listener so old ctx does not receive delayed completion', async () => {
    const pool = createPool();
    const oldCtx = createCtx();
    const newCtx = createCtx();
    const oldPi = { sendMessage: mock(() => {}) };
    const newPi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({ pool, pi: oldPi, ctx: oldCtx, harnessRuntime });
    registerPoolNoticeBridge({ pool, pi: newPi, ctx: newCtx, harnessRuntime });

    expect(pool.listenerCount()).toBe(1);

    pool.emit({
      type: 'completed',
      agentName: 'fixer',
      poolId: 'run-1',
      response: 'done',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(oldPi.sendMessage).not.toHaveBeenCalled();
    expect(newPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(newPi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'pool_completed',
      display: true,
    });
    expect(newPi.sendMessage.mock.calls[0]?.[0]?.content).toContain(
      '[pool] fixer/run-1 已完成',
    );
    expect(newPi.sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: 'followUp',
      triggerTurn: true,
    });
  });


  test('does not delay completion follow-up behind harness ingestion', () => {
    const pool = createPool();
    const ctx = createCtx();
    const pi = { sendMessage: mock(() => {}) };
    const harnessRuntime = {
      ingestPoolCompleted: mock(() => new Promise<void>(() => {})),
    };

    registerPoolNoticeBridge({ pool, pi, ctx, harnessRuntime });
    pool.emit({
      type: 'completed',
      agentName: 'fixer',
      poolId: 'run-1',
      response: 'done',
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain(
      '[pool] fixer/run-1 已完成',
    );
    expect(harnessRuntime.ingestPoolCompleted).toHaveBeenCalledTimes(1);
  });

  test('suppresses stale harness notifications after bridge re-registration without retracting delivered completion', async () => {
    const pool = createPool();
    const oldCtx = createCtx();
    const newCtx = createCtx();
    const oldPi = { sendMessage: mock(() => {}) };
    const newPi = { sendMessage: mock(() => {}) };
    let resolveOldIngest: (() => void) | undefined;
    const oldHarnessRuntime = {
      ingestPoolCompleted: mock(
        (_event: PoolNoticeEvent, ctx: any) =>
          new Promise<void>((resolve) => {
            resolveOldIngest = () => {
              ctx.ui.notify('[harness] stale verifier verdict captured', 'warning');
              resolve();
            };
          }),
      ),
    };
    const newHarnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({
      pool,
      pi: oldPi,
      ctx: oldCtx,
      harnessRuntime: oldHarnessRuntime,
    });
    pool.emit({
      type: 'completed',
      agentName: 'fixer',
      poolId: 'old-run',
      response: 'old done',
    });

    expect(oldPi.sendMessage).toHaveBeenCalledTimes(1);

    registerPoolNoticeBridge({
      pool,
      pi: newPi,
      ctx: newCtx,
      harnessRuntime: newHarnessRuntime,
    });
    resolveOldIngest?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldCtx.ui.notify).not.toHaveBeenCalled();
    expect(newPi.sendMessage).not.toHaveBeenCalled();
    expect(pool.listenerCount()).toBe(1);
  });

  test('delivers each completed event once with matching pool identity', () => {
    const pool = createPool();
    const ctx = createCtx();
    const pi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({ pool, pi, ctx, harnessRuntime });
    pool.emit({
      type: 'completed',
      agentName: 'fixer',
      poolId: 'run-1',
      response: 'one',
    });
    pool.emit({
      type: 'completed',
      agentName: 'oracle',
      poolId: 'run-2',
      response: 'two',
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain(
      '[pool] fixer/run-1 已完成',
    );
    expect(pi.sendMessage.mock.calls[1]?.[0]?.content).toContain(
      '[pool] oracle/run-2 已完成',
    );
    expect(harnessRuntime.ingestPoolCompleted).toHaveBeenCalledTimes(2);
  });
  test('error notice uses latest ctx and includes pool identity', () => {
    const pool = createPool();
    const oldCtx = createCtx();
    const newCtx = createCtx();
    const pi = { sendMessage: mock(() => {}) };
    const harnessRuntime = { ingestPoolCompleted: mock(async () => {}) };

    registerPoolNoticeBridge({ pool, pi, ctx: oldCtx, harnessRuntime });
    registerPoolNoticeBridge({ pool, pi, ctx: newCtx, harnessRuntime });

    pool.emit({
      type: 'error',
      agentName: 'oracle',
      poolId: 'review-1',
      error: 'failed',
    });

    expect(oldCtx.ui.notify).not.toHaveBeenCalled();
    expect(newCtx.ui.notify).toHaveBeenCalledWith(
      '[pool] oracle/review-1: failed',
      'warning',
    );
  });
});
