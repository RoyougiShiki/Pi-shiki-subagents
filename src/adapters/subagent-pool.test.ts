import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentPool,
  resolveDelegationCaller,
  resolveSubagentToolNamesForAgent,
} from '../pi/subagent/subagent-pool';
import type { AgentConfig } from './agent-discovery';

function makeAgent(name = 'fixer'): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    model: `test/${name}`,
  };
}

function mockCreateSession() {
  const listeners: Array<(event: any) => void> = [];
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((error: Error) => void) | undefined;
  let messages: any[] = [];
  const session = {
    subscribe: mock((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
    abort: mock(() => {
      rejectPrompt?.(new Error('Aborted'));
      return Promise.resolve();
    }),
    dispose: mock(() => {}),
    prompt: mock(
      () =>
        new Promise<void>((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        }),
    ),
    get messages() {
      return messages;
    },
    get model() {
      return { provider: 'test', id: 'mock-model' };
    },
    _respond(text: string) {
      messages = [{ role: 'assistant', content: [{ type: 'text', text }] }];
      for (const listener of listeners)
        listener({ type: 'agent_end', messages });
      resolvePrompt?.();
      resolvePrompt = undefined;
      rejectPrompt = undefined;
    },
    _emit(event: any) {
      for (const listener of listeners) listener(event);
    },
  };
  return {
    session,
    createSession: mock(async () => ({ session, extensionsResult: {} as any })),
  };
}

function createPool(createSession: any, extra: Record<string, unknown> = {}) {
  return new AgentPool({
    createSession,
    createSessionManager: (cwd: string, sessionDir: string) => ({
      kind: 'create',
      cwd,
      sessionDir,
    }),
    openSessionManager: (sessionFile: string) => ({
      kind: 'open',
      sessionFile,
    }),
    ...extra,
  });
}

function nextEvent(pool: AgentPool): Promise<any> {
  return new Promise((resolve) => {
    const unsubscribe = pool.onEvent((event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

describe('subagent caller and tools', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('uses the subagent identity or the main session caller', () => {
    delete process.env.OMO_AGENT_NAME;
    expect(resolveDelegationCaller()).toBe('main');
    process.env.OMO_AGENT_NAME = 'oracle';
    expect(resolveDelegationCaller()).toBe('oracle');
  });

  test('resolves role-scoped tools for retained subagents', () => {
    const allTools = [
      'read',
      'write',
      'edit',
      'bash',
      'grep',
      'find',
      'omo_subagent',
    ];

    expect(
      resolveSubagentToolNamesForAgent('search', process.cwd(), allTools),
    ).toEqual(expect.arrayContaining(['read', 'grep', 'find']));
    expect(
      resolveSubagentToolNamesForAgent('fixer', process.cwd(), allTools),
    ).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']));
    expect(
      resolveSubagentToolNamesForAgent('oracle', process.cwd(), allTools),
    ).toEqual(expect.arrayContaining(['read', 'grep', 'find']));
  });
});

describe('AgentPool', () => {
  test('spawns a role-scoped session and captures its completion', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = createPool(createSession, {
      resolveAllToolNames: () => [
        'read',
        'write',
        'edit',
        'bash',
        'grep',
        'find',
      ],
    });

    const spawned = await pool.spawn({
      id: 'fix-1',
      name: 'Fix 1',
      agent: makeAgent(),
      task: 'fix the failure',
    });
    const eventPromise = nextEvent(pool);
    session._respond('fixed and tested');
    const event = await eventPromise;

    expect(spawned.response).toContain('已启动');
    expect(event).toMatchObject({
      type: 'completed',
      poolId: 'fix-1',
      response: 'fixed and tested',
    });
    expect(createSession.mock.calls[0]?.[0]?.tools).toEqual(
      expect.arrayContaining(['read', 'write', 'edit', 'bash']),
    );
    expect(pool.getRegistryEntry('fix-1')).toMatchObject({
      status: 'completed',
      lastResponse: 'fixed and tested',
    });
    await pool.killAll();
  });

  test('resumes a saved session and preserves its file reference', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pool-resume-'));
    const sessionFile = path.join(dir, 'child.jsonl');
    fs.writeFileSync(sessionFile, '{}\n');
    try {
      const { session, createSession } = mockCreateSession();
      const pool = createPool(createSession, { sessionDir: dir });
      await pool.spawn({
        id: 'resume-1',
        name: 'Resume 1',
        agent: makeAgent('oracle'),
        task: 'review',
        resumeSessionFile: sessionFile,
        resumeMessage: 'continue review',
      });
      const eventPromise = nextEvent(pool);
      session._respond('review complete');
      await eventPromise;

      expect(createSession.mock.calls[0]?.[0]?.sessionManager).toEqual({
        kind: 'open',
        sessionFile,
      });
      expect(session.prompt).toHaveBeenCalledWith('continue review');
      expect(pool.getRegistryEntry('resume-1')?.sessionFile).toBe(sessionFile);
      await pool.killAll();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('emits one failure and retains a timed-out pool entry', async () => {
    const { createSession } = mockCreateSession();
    const pool = createPool(createSession, { timeoutMs: 1 });
    const eventPromise = nextEvent(pool);
    await pool.spawn({
      id: 'slow-1',
      name: 'Slow 1',
      agent: makeAgent(),
      task: 'wait forever',
    });
    const event = await eventPromise;

    expect(event).toMatchObject({
      type: 'error',
      poolId: 'slow-1',
      agentName: 'fixer',
    });
    expect(event.error).toContain('timed out');
    expect(pool.list()).toHaveLength(1);
    await pool.killAll();
  });

  test('cleans up active sessions on shutdown', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = createPool(createSession);
    await pool.spawn({
      id: 'cleanup-1',
      name: 'Cleanup 1',
      agent: makeAgent('search'),
      task: 'search',
    });

    await pool.killAll();

    expect(session.abort).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(pool.list()).toEqual([]);
  });
});
