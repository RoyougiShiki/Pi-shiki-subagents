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
  test('stage response is used directly as output, transition approval works', async () => {
    const pool = new FakePool();
    const events: StageEvent[] = [];
    pool.spawnResponses.push(
      { response: 'stage one complete: found key files' },
      { response: 'stage two done' },
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
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(2);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(true);
    expect(pool.killCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('clears lastError when a new workflow starts', async () => {
    const pool = new FakePool();
    pool.spawnResponses.push(
      { response: 'plain text only' },
      { response: 'stage ok' },
    );
    const manager = makeManager(pool);
    const wf: WorkflowDefinition = {
      name: 'wf',
      description: 'test workflow',
      stages: [{ id: 'one', agent: 'worker' }],
    };

    await manager.runWorkflow(wf, 'input');
    expect(manager.status().lastError).toBeNull();

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
    pool.spawnResponses.push({ response: 'done' });
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
