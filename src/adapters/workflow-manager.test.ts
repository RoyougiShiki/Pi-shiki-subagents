import { describe, expect, test } from 'bun:test';
import { WorkflowManager, type WorkflowPool } from './workflow-manager';
import type { AgentConfig } from './agent-discovery';
import type { StageEvent, WorkflowDefinition } from '../core/workflow-types';

function json(value: unknown): string {
  return JSON.stringify(value);
}

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
  spawnCalls: any[] = [];
  sendCalls: Array<{ id: string; message: string }> = [];
  killCalls: string[] = [];

  async spawn(opts: any): Promise<{ response: string; error?: string }> {
    this.spawnCalls.push(opts);
    const next = this.spawnResponses.shift();
    if (!next) throw new Error('No fake spawn response queued');
    return next;
  }

  async sendPrompt(id: string, message: string): Promise<{ response: string; error?: string }> {
    this.sendCalls.push({ id, message });
    const next = this.sendResponses.shift();
    if (!next) throw new Error('No fake send response queued');
    return next;
  }

  kill(id: string): boolean {
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
  test('passes complete stage context to the next stage', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnResponses.push(
      { response: json({ status: 'complete', summary: 'one', context: 'ctx-one' }) },
      { response: json({ status: 'complete', summary: 'two', context: 'ctx-two' }) },
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

    await manager.runWorkflow(wf, 'initial input');

    expect(pool.spawnCalls).toHaveLength(2);
    expect(pool.spawnCalls[1].task).toContain('ctx-one');
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(2);
    expect(pool.killCalls).toHaveLength(2);
  });

  test('repairs invalid StageOutput JSON through the same pool', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push({ response: 'not json' });
    pool.sendResponses.push({ response: json({ status: 'complete', summary: 'repaired', context: 'ctx' }) });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await manager.runWorkflow(wf, 'input');

    expect(pool.sendCalls).toHaveLength(1);
    expect(pool.sendCalls[0].message).toContain('did not match the required StageOutput JSON contract');
    expect(pool.killCalls).toHaveLength(1);
  });

  test('fails workflow when invalid StageOutput repair also fails', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnResponses.push({ response: 'not json' });
    pool.sendResponses.push({ response: 'still not json' });
    const manager = makeManager(pool, events);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('Stage failed to return valid StageOutput JSON');

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(manager.status().lastError).toBe('Stage failed to return valid StageOutput JSON');
    expect(manager.status().lastEvent?.type).toBe('error');
    expect(pool.killCalls).toHaveLength(1);
  });

  test('clears lastError when a new workflow starts', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push(
      { response: 'not json' },
      { response: json({ status: 'complete', summary: 'ok', context: 'ctx' }) },
    );
    pool.sendResponses.push({ response: 'still not json' });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await expect(manager.runWorkflow(wf, 'input')).rejects.toThrow('Stage failed to return valid StageOutput JSON');
    expect(manager.status().lastError).toBe('Stage failed to return valid StageOutput JSON');

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
    pool.spawnResponses.push(
      { response: json({ status: 'needs_user', summary: 'need user', context: 'partial' }) },
      { response: json({ status: 'complete', summary: 'second', context: 'second ctx' }) },
    );
    pool.sendResponses.push({ response: json({ status: 'complete', summary: 'user complete', context: 'user ctx' }) });
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
    await run;

    expect(userResult.error).toBeUndefined();
    expect(pool.spawnCalls).toHaveLength(2);
    expect(pool.spawnCalls[1].task).toContain('user ctx');
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(2);
  });

  test('needs_user followed by failed user response errors and does not continue', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnResponses.push({ response: json({ status: 'needs_user', summary: 'need user', context: 'partial' }) });
    pool.sendResponses.push({ response: json({ status: 'failed', summary: 'user response failed', context: '' }) });
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
    await expect(run).rejects.toThrow('user response failed');
    expect(pool.spawnCalls).toHaveLength(1);
    expect(events.some((event) => event.type === 'error' && event.error === 'user response failed')).toBe(true);
    expect(pool.killCalls).toHaveLength(1);
  });

  test('retryStage while waiting uses current stage pool and does not spawn a detached stage', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push({ response: json({ status: 'needs_user', summary: 'need retry', context: 'partial' }) });
    pool.sendResponses.push({ response: json({ status: 'complete', summary: 'retried', context: 'retry ctx' }) });
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
    hold.resolve({ response: json({ status: 'complete', summary: 'done', context: 'ctx' }) });
    await run;

    expect(result.error).toBe('Current workflow stage is not waiting for user input');
    expect(pool.sendCalls).toHaveLength(0);
  });

  test('passes stage allowedSubagents to pool spawn', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push({ response: json({ status: 'complete', summary: 'done', context: 'ctx' }) });
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker', allowedSubagents: ['oracle'] }],
    };

    await manager.runWorkflow(wf, 'input');

    expect(pool.spawnCalls[0].allowedSubagents).toEqual(['oracle']);
  });

  test('invalid choice selection returns false and abort settles workflow', async () => {
    const pool = new FakePool();
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [
        {
          id: 'choose',
          type: 'choice',
          branches: [
            { label: 'A', description: 'branch A', stages: [{ id: 'a', agent: 'worker' }] },
          ],
        },
      ],
    };

    const run = manager.runWorkflow(wf, 'input');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.selectBranch(2)).toBe(false);
    manager.abort();
    await expect(run).rejects.toThrow('Workflow aborted');
    expect(manager.selectBranch(0)).toBe(false);
  });
});
