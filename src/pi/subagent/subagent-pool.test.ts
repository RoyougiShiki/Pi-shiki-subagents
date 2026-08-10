import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentPool, type PoolEvent } from './subagent-pool';

interface FakeSessionBehavior {
  messageContent?: unknown;
  /** prompt() 永不 settle，直到 abort() 被调用（模拟 SDK 静默断流）。 */
  hang?: boolean;
  rejectWith?: Error;
  onAbort?: () => void;
}

function createFakeSession(behavior: FakeSessionBehavior = {}) {
  const listeners: Array<(event: any) => void> = [];
  let resolvePrompt: (() => void) | undefined;
  let aborted = false;
  return {
    emit(event: any) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(cb: (event: any) => void) {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt(_message: string) {
      if (behavior.rejectWith) throw behavior.rejectWith;
      if (behavior.hang) {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        // SDK 行为：abort() 后当前 prompt settle（以 aborted 状态结束）。
        return;
      }
      const message = { role: 'assistant', content: behavior.messageContent };
      for (const listener of [...listeners]) {
        listener({ type: 'message_end', message });
        listener({ type: 'agent_end', messages: [message] });
      }
    },
    async abort() {
      aborted = true;
      behavior.onAbort?.();
      const resolve = resolvePrompt;
      resolvePrompt = undefined;
      resolve?.();
    },
    dispose() {},
  };
}

interface PoolTestBehavior extends FakeSessionBehavior {
  stallTimeoutMs?: number;
  stallCheckIntervalMs?: number;
}

function createPool(behavior: PoolTestBehavior = {}): AgentPool {
  return new AgentPool({
    sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pool-test-')),
    stallTimeoutMs: behavior.stallTimeoutMs,
    stallCheckIntervalMs: behavior.stallCheckIntervalMs,
    createSessionManager: () => ({}),
    createSession: (async () => ({
      session: createFakeSession(behavior),
    })) as any,
  });
}

async function waitForCompletion(pool: AgentPool): Promise<PoolEvent> {
  return await new Promise((resolve) => {
    pool.onEvent((event) => {
      if (event.type === 'completed') resolve(event);
    });
  });
}

function waitForError(
  pool: AgentPool,
  timeoutMs = 2000,
): Promise<PoolEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for error event (${timeoutMs}ms)`));
    }, timeoutMs);
    const unsubscribe = pool.onEvent((event) => {
      if (event.type === 'error') {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

async function expectNoEvent(
  pool: AgentPool,
  type: PoolEvent['type'],
  waitMs: number,
): Promise<void> {
  let fired = false;
  const unsubscribe = pool.onEvent((event) => {
    if (event.type === type) fired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  unsubscribe();
  expect(fired).toBe(false);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnAgent(pool: AgentPool, id = 'agent') {
  return await pool.spawn({
    id,
    name: id,
    agent: { name: 'search' } as any,
    task: 'summarize',
  });
}

describe('AgentPool result capture', () => {
  test('captures assistant text when SDK message content is a string', async () => {
    const pool = createPool({ messageContent: '完成：字符串结果已捕获。' });
    const completion = waitForCompletion(pool);

    const spawned = await spawnAgent(pool, 'string-result');
    expect(spawned.error).toBeUndefined();

    const event = await completion;
    expect(event.response).toBe('完成：字符串结果已捕获。');
    expect(pool.getRegistryEntry('string-result')?.lastResponse).toBe(
      '完成：字符串结果已捕获。',
    );
  });

  test('stores a diagnostic result when no assistant text is captured', async () => {
    const pool = createPool({
      messageContent: [{ type: 'thinking', text: 'hidden only' }],
    });
    const completion = waitForCompletion(pool);

    const spawned = await spawnAgent(pool, 'empty-result');
    expect(spawned.error).toBeUndefined();

    const event = await completion;
    expect(event.response).toContain('no assistant text was captured');
    expect(pool.getRegistryEntry('empty-result')?.lastResponse).toContain(
      'no assistant text was captured',
    );
  });
});

describe('AgentPool stall detection', () => {
  const STALL = 60;
  const CHECK = 10;

  test('marks the run failed and aborts the session when the LLM stream stalls', async () => {
    let aborted = false;
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
      onAbort: () => {
        aborted = true;
      },
    });
    const errorPromise = waitForError(pool);

    const spawned = await spawnAgent(pool, 'stalled');
    expect(spawned.error).toBeUndefined();

    const event = await errorPromise;
    expect(event.error).toContain('stalled');
    expect(event.error).toContain('abort');
    expect(aborted).toBe(true);

    const record = pool.getRegistryEntry('stalled');
    expect(record?.status).toBe('failed');
    expect(record?.errorMessage).toContain('stalled');
    expect(pool.list()[0]?.status).toBe('failed');
  });

  test('does not trigger stall while a tool is executing', async () => {
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
    });
    await spawnAgent(pool, 'tool-phase');

    // 工具执行阶段：静默时间远超 stall 阈值也不触发
    (pool.getSession('tool-phase') as any)?.emit({
      type: 'tool_execution_start',
      toolName: 'bash',
    });
    await expectNoEvent(pool, 'error', STALL * 4);

    // 工具结束回到 LLM 流阶段，重新计时后应触发
    (pool.getSession('tool-phase') as any)?.emit({
      type: 'tool_execution_end',
      toolName: 'bash',
    });
    const errorPromise = waitForError(pool);
    const event = await errorPromise;
    expect(event.error).toContain('stalled');
  });

  test('session events reset the stall clock', async () => {
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
    });
    await spawnAgent(pool, 'eventful');
    const session = (pool.getSession('eventful') as any)!;
    // 持续有 LLM 流事件（慢思考间隔 < stall 阈值）→ 不触发
    const keepAlive = setInterval(() => {
      session.emit({ type: 'message_update' });
    }, 20);
    await expectNoEvent(pool, 'error', STALL * 4);
    clearInterval(keepAlive);

    // 事件停止后触发
    const errorPromise = waitForError(pool);
    const event = await errorPromise;
    expect(event.error).toContain('stalled');
  });

  test('stall abort is not misreported as completed when the prompt later settles', async () => {
    let completed = false;
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
    });
    pool.onEvent((event) => {
      if (event.type === 'completed') completed = true;
    });

    await spawnAgent(pool, 'stall-settle');
    const errorPromise = waitForError(pool);
    const event = await errorPromise;
    expect(event.error).toContain('stalled');

    // abort 后 prompt settle（fake 模拟 SDK），稍等让后续 settle 路径走完
    await sleep(50);
    expect(completed).toBe(false);
    expect(pool.getRegistryEntry('stall-settle')?.status).toBe('failed');
    expect(pool.list()[0]?.status).toBe('failed');
  });

  test('stallTimeoutMs=0 disables stall detection', async () => {
    const pool = createPool({
      hang: true,
      stallTimeoutMs: 0,
    });
    await spawnAgent(pool, 'no-stall');
    await expectNoEvent(pool, 'error', 150);
    expect(pool.list()[0]?.status).toBe('starting');
  });

  test('emits a stall_warn notice at half the timeout, once, before aborting', async () => {
    let aborted = false;
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
      onAbort: () => {
        aborted = true;
      },
    });

    const warnPromise = new Promise<PoolEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for stall_warn')),
        2000,
      );
      const unsub = pool.onEvent((event) => {
        if (event.type === 'stall_warn') {
          clearTimeout(timer);
          unsub();
          resolve(event);
        }
      });
    });
    const errorPromise = waitForError(pool);

    await spawnAgent(pool, 'warned');
    const warnEvent = await warnPromise;
    expect(warnEvent.error).toContain('silent');
    expect(warnEvent.error).toContain('will abort');

    const errEvent = await errorPromise;
    expect(errEvent.error).toContain('stalled');
    expect(aborted).toBe(true);
    expect(pool.getRegistryEntry('warned')?.status).toBe('failed');

    // 预警只发一次：abort 后再静默也不会重复 emit。
    let warnCount = 0;
    const unsub = pool.onEvent((event) => {
      if (event.type === 'stall_warn') warnCount += 1;
    });
    await sleep(STALL * 2);
    unsub();
    expect(warnCount).toBe(0);
  });

  test('does not abort after stall_warn when session events resume', async () => {
    let aborted = false;
    const pool = createPool({
      hang: true,
      stallTimeoutMs: STALL,
      stallCheckIntervalMs: CHECK,
      onAbort: () => {
        aborted = true;
      },
    });

    const warnPromise = new Promise<PoolEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for stall_warn')),
        2000,
      );
      const unsub = pool.onEvent((event) => {
        if (event.type === 'stall_warn') {
          clearTimeout(timer);
          unsub();
          resolve(event);
        }
      });
    });
    await spawnAgent(pool, 'resumed');
    await warnPromise;

    await spawnAgent(pool, 'resumed');
    await warnPromise;

    // 预警后事件恢复并持续活跃 → 时钟持续重置，不 abort。
    const entry = (pool as any).agents.get('resumed');
    const until = Date.now() + STALL * 3;
    while (Date.now() < until) {
      entry.session.emit({ type: 'turn_start' });
      await sleep(CHECK);
    }
    expect(aborted).toBe(false);
    expect(pool.list()[0]?.status).toBe('streaming');

    // 停止注入后再次静默超过阈值仍会 abort（预警标志已置位，不再重复预警）。
    const errorPromise = waitForError(pool);
    const errEvent = await errorPromise;
    expect(errEvent.error).toContain('stalled');
    expect(aborted).toBe(true);

  });

  test('sendPrompt failure syncs the in-memory entry status to failed', async () => {
    const pool = createPool({
      rejectWith: new Error('provider exploded'),
    });
    await spawnAgent(pool, 'rejecting');

    const result = await pool.sendPrompt('rejecting', 'second task');
    expect(result.error).toBe('provider exploded');
    expect(pool.list()[0]?.status).toBe('failed');
    expect(pool.getRegistryEntry('rejecting')?.status).toBe('failed');
  });

  test('follow-up send failure records run_finished so the run tree shows failed', async () => {
    const pool = createPool({
      messageContent: 'first turn ok',
      rejectWith: new Error('second turn broke'),
    });
    await spawnAgent(pool, 'followup-fail');
    await sleep(20);

    const result = await pool.sendPrompt('followup-fail', 'second task');
    expect(result.error).toBe('second turn broke');

    const view = pool.getRunTreeView();
    expect(view.counts.failed).toBe(1);
    const failedNode = view.roots.find((r) => r.runId === 'followup-fail');
    expect(failedNode?.status).toBe('failed');
  });
});

describe('AgentPool owner session routing', () => {
  test('completed event carries the owner session id', async () => {
    const pool = createPool();
    const eventPromise = waitForCompletion(pool);
    await pool.spawn({
      id: 'agent-a',
      name: 'agent-a',
      agent: { name: 'search' } as any,
      task: 'summarize',
      ownerSessionId: 'session-a',
    });
    const event = await eventPromise;
    expect(event.sessionId).toBe('session-a');
  });

  test('error event carries the owner session id', async () => {
    const pool = createPool({ rejectWith: new Error('boom') });
    const eventPromise = waitForError(pool);
    await pool.spawn({
      id: 'agent-fail',
      name: 'agent-fail',
      agent: { name: 'search' } as any,
      task: 'summarize',
      ownerSessionId: 'session-b',
    });
    const event = await eventPromise;
    expect(event.sessionId).toBe('session-b');
  });

  test('killAll(sessionId) only kills agents owned by that session', async () => {
    const pool = createPool();
    await pool.spawn({
      id: 'agent-a',
      name: 'agent-a',
      agent: { name: 'search' } as any,
      task: 'summarize',
      ownerSessionId: 'session-a',
    });
    await pool.spawn({
      id: 'agent-b',
      name: 'agent-b',
      agent: { name: 'search' } as any,
      task: 'summarize',
      ownerSessionId: 'session-b',
    });
    expect(pool.list().map((a) => a.id).sort()).toEqual(['agent-a', 'agent-b']);

    await pool.killAll('session-a');
    expect(pool.list().map((a) => a.id)).toEqual(['agent-b']);
  });
});
