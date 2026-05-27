import { describe, expect, test } from 'bun:test';
import { WorkflowManager, type WorkflowPool } from '../pi/workflow/workflow-manager';
import type { AgentConfig } from './agent-discovery';
import type { StageEvent, WorkflowDefinition, WorkflowStageToolResult } from '../core/workflow-types';
import { setStageResult } from '../pi/workflow/stage-result-store';

function createAgent(name: string): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    model: `test/${name}`,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakePool implements WorkflowPool {
  spawnResponses: Array<{ response: string; error?: string }> = [];
  sendResponses: Array<{ response: string; error?: string }> = [];
  spawnStageResults: Array<WorkflowStageToolResult | undefined> = [];
  sendStageResults: Array<WorkflowStageToolResult | undefined> = [];
  spawnCalls: any[] = [];
  sendCalls: Array<{ id: string; message: string }> = [];
  killCalls: string[] = [];
  async spawn(opts: any): Promise<{ response: string; error?: string }> {
    this.spawnCalls.push(opts);
    const stageResult = this.spawnStageResults.shift();
    if (stageResult) {
      setStageResult(stageResult);
    }
    const next = this.spawnResponses.shift();
    if (!next) throw new Error('No fake spawn response queued');
    return next;
  }

  async sendPrompt(id: string, message: string, type?: string): Promise<{ response: string; error?: string }> {
    this.sendCalls.push({ id, message });
    const stageResult = this.sendStageResults.shift();
    if (stageResult) {
      setStageResult(stageResult);
    }
    const next = this.sendResponses.shift();
    if (!next) throw new Error('No fake send response queued');
    return next;
  }

  async kill(id: string): Promise<boolean> {
    this.killCalls.push(id);
    return true;
  }
}

function makeManager(pool: FakePool, events: StageEvent[] = []): WorkflowManager {
  const manager = new WorkflowManager({
    cwd: '/tmp/project',
    pool,
    resolveAgent: (_cwd, name) => createAgent(name),
  });
  manager.onEvent((event) => events.push(event));
  return manager;
}

describe('WorkflowManager', () => {
  test('stage complete stops at transition approval until continueWorkflow is called', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnStageResults.push(
      { type: 'complete', summary: 'one', context: 'ctx-one' },
      { type: 'complete', summary: 'two', context: 'ctx-two' },
    );
    pool.spawnResponses.push(
      { response: 'stage_complete recorded' },
      { response: 'stage_complete recorded' },
    );
    const manager = makeManager(pool, events);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [
        { id: 'one', agent: 'worker' },
        { id: 'two', agent: 'oracle' },
      ],
    };

    const run = manager.runWorkflow(wf, 'initial input');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pool.spawnCalls).toHaveLength(1);
    expect(manager.status().transition?.nextStage).toBe('oracle');
    expect(events.some((event) => event.type === 'transition_approval')).toBe(true);
    expect(pool.killCalls).toHaveLength(0);
    expect(manager.continueWorkflow()).toBe(true);
    await run;

    expect(pool.spawnCalls).toHaveLength(2);
    expect(pool.spawnCalls[1].task).toContain('ctx-one');
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(2);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(true);
    expect(pool.killCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('fails workflow when stage does not call stage tools', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push({ response: 'plain text only' });
    // 10 retries until stageError
    for (let i = 0; i < 10; i++) pool.sendResponses.push({ response: 'still plain text' });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('after 10 attempts');
    expect(pool.killCalls).toHaveLength(1);
  });

  test('fails workflow when stage result file has unsupported shape', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnStageResults.push(undefined as any);
    pool.spawnResponses.push({ response: 'plain text only' });
    // 10 retries until stageError
    for (let i = 0; i < 10; i++) pool.sendResponses.push({ response: 'still plain text' });
    const manager = makeManager(pool, events);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('after 10 attempts');

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(manager.status().lastError).toContain('after 10 attempts');
    expect(manager.status().lastEvent?.type).toBe('error');
    expect(pool.killCalls).toHaveLength(1);
  });


  test('clears lastError when a new workflow starts', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push(
      { response: 'plain text only' },
      { response: 'stage_complete recorded' },
    );
    pool.spawnStageResults.push(
      undefined,
      { type: 'complete', summary: 'ok', context: 'ctx' },
    );
    // 10 retries until stageError
    for (let i = 0; i < 10; i++) pool.sendResponses.push({ response: 'still plain text' });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('after 10 attempts');
    expect(manager.status().lastError).toContain('after 10 attempts');

    await manager.runWorkflow(wf, 'input');

    expect(manager.status().lastError).toBeNull();
  });

  test('records lastError when pool spawn throws before an error event is emitted', async () => {
    const pool = new FakePool();
    pool.spawn = async () => {
      throw new Error('spawn exploded');
    };
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('spawn exploded');

    expect(manager.status().lastError).toBe('spawn exploded');
  });

  test('needs_user followed by complete user response continues workflow', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnStageResults.push(
      { type: 'ask_user', summary: 'need user', question: 'question?' },
      { type: 'complete', summary: 'second', context: 'second ctx' },
    );
    pool.spawnResponses.push(
      { response: 'stage_ask_user recorded' },
      { response: 'stage_complete recorded' },
    );
    pool.sendStageResults.push({ type: 'complete', summary: 'user complete', context: 'user ctx' });
    pool.sendResponses.push({ response: 'stage_complete recorded' });
    const manager = makeManager(pool, events);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [
        { id: 'one', agent: 'worker' },
        { id: 'two', agent: 'oracle' },
      ],
    };

    const waiting = deferred<void>();
    manager.onEvent((event) => {
      if (event.type === 'waiting_user') waiting.resolve();
    });

    const run = manager.runWorkflow(wf, 'input');
    await waiting.promise;
    const userResult = await manager.sendUserMessage('additional info');

    expect(userResult.error).toBeUndefined();
    expect(manager.status().transition?.nextStage).toBe('oracle');
    expect(manager.continueWorkflow()).toBe(true);
    await run;

    expect(pool.spawnCalls).toHaveLength(2);
    expect(pool.spawnCalls[1].task).toContain('user ctx');
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(2);
  });

  test('needs_user followed by two consecutive tool failures notifies on second attempt', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnStageResults.push({ type: 'ask_user', summary: 'need user', question: 'question?' });
    pool.spawnResponses.push({ response: 'stage_ask_user recorded' });
    // First send + retry: no tool called
    pool.sendStageResults.push(undefined);
    pool.sendResponses.push({ response: 'no stage tool used' });
    pool.sendStageResults.push(undefined);
    pool.sendResponses.push({ response: 'still no stage tool' });
    // Second send + retry: still no tool
    pool.sendStageResults.push(undefined);
    pool.sendResponses.push({ response: 'second attempt text' });
    pool.sendStageResults.push(undefined);
    pool.sendResponses.push({ response: 'second retry text' });
    const manager = makeManager(pool, events);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [
        { id: 'one', agent: 'worker' },
        { id: 'two', agent: 'oracle' },
      ],
    };

    const waiting = deferred<void>();
    manager.onEvent((event) => {
      if (event.type === 'waiting_user') waiting.resolve();
    });

    manager.runWorkflow(wf, 'input');
    await waiting.promise;
    // First attempt: no error event (counter increments to 1)
    const firstResult = await manager.sendUserMessage('first try');
    expect(firstResult.error).toBe('Stage agent stopped responding with a tool call. You can retry or abort.');
    expect(events.some(e => e.type === 'error')).toBe(false);

    // Second attempt: now counter >= 2, error event fires
    const secondResult = await manager.sendUserMessage('second try');
    expect(secondResult.error).toBe('Stage agent stopped responding with a tool call. You can retry or abort.');
    expect(pool.spawnCalls).toHaveLength(1);
    expect(pool.killCalls).toHaveLength(0);
    expect(manager.status().stage).toBeTruthy();
    expect(events.some(e => e.type === 'error')).toBe(true);
  });

  test('retryStage while waiting uses current stage pool and does not spawn a detached stage', async () => {
    const pool = new FakePool();
    pool.spawnStageResults.push({ type: 'ask_user', summary: 'need retry', question: 'retry?' });
    pool.spawnResponses.push({ response: 'stage_ask_user recorded' });
    pool.sendStageResults.push({ type: 'complete', summary: 'retried', context: 'retry ctx' });
    pool.sendResponses.push({ response: 'stage_complete recorded' });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    const waiting = deferred<void>();
    manager.onEvent((event) => {
      if (event.type === 'waiting_user') waiting.resolve();
    });

    const run = manager.runWorkflow(wf, 'input');
    await waiting.promise;
    const retry = await manager.retryStage('retry now');
    await run;

    expect(retry).toEqual({ ok: true });
    expect(pool.spawnCalls).toHaveLength(1);
    expect(pool.sendCalls).toHaveLength(1);
    expect(pool.sendCalls[0].message).toBe('retry now');
  });

  test('sendUserMessage is rejected when the stage is not waiting for user input', async () => {
    const pool = new FakePool();
    const hold = deferred<{ response: string; error?: string }>();
    pool.spawn = async (opts: any) => {
      pool.spawnCalls.push(opts);
      return hold.promise;
    };
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    const run = manager.runWorkflow(wf, 'input');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await manager.sendUserMessage('too early');
    setStageResult({ type: 'complete', summary: 'done', context: 'ctx' });
    hold.resolve({ response: 'stage_complete recorded' });
    await run;

    expect(result.error).toBe('Current workflow stage is not waiting for user input');
    expect(pool.sendCalls).toHaveLength(0);
  });

  test('passes stage allowedSubagents to pool spawn', async () => {
    const pool = new FakePool();
    pool.spawnStageResults.push({ type: 'complete', summary: 'done', context: 'ctx' });
    pool.spawnResponses.push({ response: 'stage_complete recorded' });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker', allowedSubagents: ['oracle'] }],
    };

    await manager.runWorkflow(wf, 'input');

    expect(pool.spawnCalls[0].allowedSubagents).toEqual(['oracle']);
  });

});
