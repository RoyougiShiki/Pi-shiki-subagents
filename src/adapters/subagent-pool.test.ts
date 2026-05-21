import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { AgentPool, buildSubagentEnv } from './subagent-pool';
import type { AgentConfig } from './agent-discovery';

class FakeStream extends EventEmitter {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStream();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
}

function makeAgent(name = 'worker'): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    model: `test/${name}`,
  };
}

function agentEnd(text: string): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'agent_end',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
  }) + '\n');
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('subagent pool env', () => {
  test('builds agent identity and allowedSubagents env', () => {
    const env = buildSubagentEnv({
      baseEnv: { KEEP: 'yes' },
      agentName: 'worker',
      depth: 1,
      parentAgent: 'coordinator',
      allowedSubagents: ['oracle'],
    });

    expect(env.KEEP).toBe('yes');
    expect(env.OMO_SUB_AGENT).toBe('1');
    expect(env.OMO_AGENT_NAME).toBe('worker');
    expect(env.OMO_SUBAGENT_DEPTH).toBe('1');
    expect(env.OMO_PARENT_AGENT_NAME).toBe('coordinator');
    expect(env.OMO_ALLOWED_SUBAGENTS).toBe('oracle');
  });

  test('omits optional env values when absent', () => {
    const env = buildSubagentEnv({
      baseEnv: {},
      agentName: 'oracle',
    });

    expect(env.OMO_SUB_AGENT).toBe('1');
    expect(env.OMO_AGENT_NAME).toBe('oracle');
    expect(env.OMO_SUBAGENT_DEPTH).toBe('1');
    expect(env.OMO_PARENT_AGENT_NAME).toBeUndefined();
    expect(env.OMO_ALLOWED_SUBAGENTS).toBeUndefined();
  });

  test('preserves empty allowedSubagents as an explicit no-delegation env', () => {
    const env = buildSubagentEnv({
      baseEnv: {},
      agentName: 'worker',
      allowedSubagents: [],
    });

    expect(env.OMO_ALLOWED_SUBAGENTS).toBe('');
  });
});

describe('AgentPool lifecycle', () => {
  test('rejects concurrent sends while an agent is busy', async () => {
    const child = new FakeChildProcess();
    const pool = new AgentPool({
      timeoutMs: 1000,
      spawnProcess: () => child as any,
      sessionDir: '/tmp/omo-subagent-test-sessions',
    });

    const spawnPromise = pool.spawn({
      id: 'busy-agent',
      name: 'busy-agent',
      agent: makeAgent(),
      task: 'initial',
    });
    await tick();

    const busy = await pool.sendPrompt('busy-agent', 'second prompt');
    child.stdout.emit('data', agentEnd('done'));
    const first = await spawnPromise;

    expect(busy.error).toBe('Agent "busy-agent" is busy');
    expect(first.response).toBe('done');
    expect(child.stdin.writes).toHaveLength(1);
  });

  test('timeout kills the agent and removes it from the pool', async () => {
    const child = new FakeChildProcess();
    const pool = new AgentPool({
      timeoutMs: 5,
      spawnProcess: () => child as any,
      sessionDir: '/tmp/omo-subagent-test-sessions',
    });

    const result = await pool.spawn({
      id: 'timeout-agent',
      name: 'timeout-agent',
      agent: makeAgent(),
      task: 'initial',
    });

    expect(result.error).toBe('Agent "timeout-agent" timed out');
    expect(child.killed).toBe(true);
    expect(pool.list()).toHaveLength(0);
    expect(await pool.sendPrompt('timeout-agent', 'late')).toEqual({
      response: '',
      error: 'Agent "timeout-agent" not found in pool',
    });
  });

  test('late agent_end after timeout is ignored', async () => {
    const child = new FakeChildProcess();
    const pool = new AgentPool({
      timeoutMs: 5,
      spawnProcess: () => child as any,
      sessionDir: '/tmp/omo-subagent-test-sessions',
    });

    const result = await pool.spawn({
      id: 'late-agent',
      name: 'late-agent',
      agent: makeAgent(),
      task: 'initial',
    });
    child.stdout.emit('data', agentEnd('late response'));

    expect(result.error).toBe('Agent "late-agent" timed out');
    expect(pool.list()).toHaveLength(0);
    expect(await pool.sendPrompt('late-agent', 'after late response')).toEqual({
      response: '',
      error: 'Agent "late-agent" not found in pool',
    });
  });

  test('kill resolves a pending prompt and removes the agent', async () => {
    const child = new FakeChildProcess();
    const pool = new AgentPool({
      timeoutMs: 1000,
      spawnProcess: () => child as any,
      sessionDir: '/tmp/omo-subagent-test-sessions',
    });

    const pending = pool.spawn({
      id: 'kill-agent',
      name: 'kill-agent',
      agent: makeAgent(),
      task: 'initial',
    });
    await tick();
    const killed = pool.kill('kill-agent');
    const result = await pending;

    expect(killed).toBe(true);
    expect(result.error).toBe('Killed');
    expect(child.killed).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });
});
