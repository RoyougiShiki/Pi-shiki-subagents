import { describe, expect, test, mock, afterEach } from 'bun:test';
import { AgentPool, resolveDelegationCaller, resolveSubagentToolNamesForAgent } from '../pi/subagent/subagent-pool';
import type { AgentConfig } from './agent-discovery';
import { resetToolScope, setToolScope } from '../pi/policy/tool-scope-manager';
import { consumePipelineDelegationGrant, issuePipelineDelegationGrant, resetPipelineDelegationGrantsForTests } from '../pi/policy/pipeline-delegation-grants';

function makeAgent(name = 'worker'): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    model: `test/${name}`,
  };
}

/**
 * Create a mock createAgentSession that returns a controllable session.
 * prompt() resolves when _simulateAgentEnd() is called.
 * messages() returns the last simulated assistant response.
 */
function mockCreateSession() {
  const listeners: Array<(event: any) => void> = [];
  let resolvePrompt: ((value: unknown) => void) | null = null;
  let rejectPrompt: ((reason: any) => void) | null = null;
  let latestMessages: any[] = [];

  const session = {
    steer: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
    subscribe: mock((cb: (event: any) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    abort: mock(() => {
      // Simulate SDK behavior: abort rejects pending prompt
      if (rejectPrompt) {
        const rj = rejectPrompt;
        rejectPrompt = null;
        resolvePrompt = null;
        rj(new Error('Aborted'));
      }
      return Promise.resolve();
    }),
    dispose: mock(() => {}),
    isStreaming: false,
    get model() { return { provider: 'test', id: 'mock-model' }; },
    get messages() { return latestMessages; },
    agent: {
      waitForIdle: mock(() => Promise.resolve()),
      state: { messages: [] },
    },
    sessionFile: undefined,
    sessionId: 'mock-session',
    setModel: mock(() => Promise.resolve()),
    setThinkingLevel: mock(() => {}),
    cycleModel: mock(() => Promise.resolve(undefined)),
    cycleThinkingLevel: mock(() => undefined),
    compact: mock(() => Promise.resolve({} as any)),
    abortCompaction: mock(() => {}),
    navigateTree: mock(() => Promise.resolve({ editorText: undefined, cancelled: false })),
    prompt: mock(async (_text: string) => {
      return new Promise((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });
    }),
    setSteeringMode: mock(() => {}),
    setFollowUpMode: mock(() => {}),
    setAutoCompactionEnabled: mock(() => {}),
    setAutoRetryEnabled: mock(() => {}),
    getSessionStats: mock(() => ({})),
    getActiveToolNames: mock(() => []),
    getAllTools: mock(() => []),
    _simulateResponse(text: string) {
      latestMessages = [
        { role: 'assistant', content: [{ type: 'text', text }] },
      ];
      for (const cb of listeners) {
        cb({ type: 'agent_end', messages: latestMessages });
      }
      if (resolvePrompt) {
        const rp = resolvePrompt;
        resolvePrompt = null;
        rejectPrompt = null;
        rp(undefined);
      }
    },
  };

  const createSession = mock(async () => ({ session, extensionsResult: {} as any, modelFallbackMessage: undefined }));

  return { session, createSession };
}

/** Wait for the next pool event (completed or error). */
function onNextPoolEvent(pool: AgentPool): Promise<any> {
  return new Promise(resolve => {
    const unsub = pool.onEvent(event => {
      unsub();
      resolve(event);
    });
  });
}

describe('resolveDelegationCaller', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetToolScope();
    resetPipelineDelegationGrantsForTests();
  });

  test('prefers OMO_AGENT_NAME from subagent env', () => {
    process.env.OMO_AGENT_NAME = 'worker';
    setToolScope(['omo_subagent'], 'mode', 'coordinator');
    expect(resolveDelegationCaller()).toBe('worker');
  });

  test('falls back to tool scope source name for top-level calls', () => {
    delete process.env.OMO_AGENT_NAME;
    setToolScope(['omo_subagent'], 'mode', 'coordinator');
    expect(resolveDelegationCaller()).toBe('coordinator');
  });

  test('does not guess active mode when env and tool scope are absent', () => {
    delete process.env.OMO_AGENT_NAME;
    resetToolScope();
    expect(resolveDelegationCaller()).toBeUndefined();
  });

  test('treats blank env and blank tool scope source as missing', () => {
    process.env.OMO_AGENT_NAME = '   ';
    setToolScope(['omo_subagent'], 'mode', '   ');
    expect(resolveDelegationCaller()).toBeUndefined();
  });

  test('uses fallback tool scope as delegation caller for rescue mode', () => {
    delete process.env.OMO_AGENT_NAME;
    setToolScope(['omo_subagent'], 'mode', 'fallback');
    expect(resolveDelegationCaller()).toBe('fallback');
  });

  test('resolves subagent tools from explicit tools and default role groups', () => {
    expect(resolveSubagentToolNamesForAgent('worker')).toEqual(['read', 'write', 'edit']);
    const fixerTools = resolveSubagentToolNamesForAgent('fixer') ?? [];
    expect(fixerTools.includes('read')).toBe(true);
    expect(fixerTools.includes('write')).toBe(true);
    expect(fixerTools.includes('edit')).toBe(true);
    expect(fixerTools.includes('bash')).toBe(true);
  });

  test('pipeline stage primary grant is not issued when caller is missing', () => {
    issuePipelineDelegationGrant({
      caller: undefined,
      target: 'analyst',
      depth: 0,
      childAllowedSubagents: ['search'],
    });

    expect(consumePipelineDelegationGrant({ caller: undefined, target: 'analyst', depth: 0 })).toBeUndefined();
  });
});

describe('AgentPool basic operations', () => {
  test('spawn creates agent and sends initial prompt', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    // Spawn returns immediately with a startup message
    const spawnResult = await pool.spawn({
      id: 'test-agent',
      name: 'test-agent',
      agent: makeAgent(),
      task: 'do something',
    });
    expect(spawnResult.response).toContain('已启动');

    // Wait for the async internal sendPrompt to complete
    const eventPromise = onNextPoolEvent(pool);
    session._simulateResponse('task done');
    const event = await eventPromise;

    expect(event.type).toBe('completed');
    expect(event.response).toBe('task done');
    expect(createSession.mock.calls[0]?.[0]?.tools).toEqual(['read', 'write', 'edit']);
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0].id).toBe('test-agent');
    expect(pool.list()[0].status).toBe('idle');

    await pool.kill('test-agent');
    expect(pool.list()).toHaveLength(0);
  });

  test('spawn uses discovered runtime agent model instead of re-reading stale config', async () => {
    const { session, createSession } = mockCreateSession();
    const resolvedModel = { provider: 'dmxapi-responses', id: 'gpt-5.5' };
    const resolveModel = mock((modelId: string) => modelId === 'dmxapi-responses/gpt-5.5' ? resolvedModel : undefined);
    const pool = new AgentPool({ createSession: createSession as any, resolveModel });
    const agent = { ...makeAgent('oracle'), model: 'dmxapi-responses/gpt-5.5' };

    const spawnResult = await pool.spawn({
      id: 'oracle-review',
      name: 'oracle-review',
      agent,
      task: 'review',
    });

    expect(spawnResult.response).toContain('已启动');
    expect(resolveModel).toHaveBeenCalledWith('dmxapi-responses/gpt-5.5');
    expect(createSession.mock.calls[0]?.[0]?.model).toBe(resolvedModel);

    const eventPromise = onNextPoolEvent(pool);
    session._simulateResponse('review done');
    await eventPromise;
    await pool.kill('oracle-review');
  });

  test('sendPrompt sends to an existing agent', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    // Spawn returns immediately
    const spawnResult = await pool.spawn({
      id: 'agent-send',
      name: 'agent-send',
      agent: makeAgent('analyst'),
      task: 'initial task',
    });
    expect(spawnResult.response).toContain('已启动');

    // Resolve the spawn's internal async sendPrompt
    const initEvent = onNextPoolEvent(pool);
    session._simulateResponse('initial done');
    await initEvent;

    // Now send a follow-up prompt directly
    const sendPromise = pool.sendPrompt('agent-send', 'follow-up');
    await new Promise(r => setTimeout(r, 10));
    session._simulateResponse('follow-up done');

    const result = await sendPromise;
    expect(result.error).toBeUndefined();
    expect(result.response).toBe('follow-up done');

    await pool.kill('agent-send');
  });

  test('list returns agent info', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    await pool.spawn({
      id: 'list-agent',
      name: 'list-agent',
      agent: makeAgent(),
      task: 'task',
    });

    // Resolve the async prompt to get status='idle'
    const event = onNextPoolEvent(pool);
    session._simulateResponse('ok');
    await event;

    const agents = pool.list();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe('list-agent');
    expect(agents[0].status).toBe('idle');
    expect(agents[0].model).toContain('mock');
    expect(agents[0].startedAt).toBeGreaterThan(0);

    await pool.killAll();
    expect(pool.list()).toHaveLength(0);
  });

  test('kill removes agent from pool', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    await pool.spawn({
      id: 'kill-test',
      name: 'kill-test',
      agent: makeAgent(),
      task: 'task',
    });

    // Resolve the async prompt
    const event = onNextPoolEvent(pool);
    session._simulateResponse('ok');
    await event;

    expect(pool.list()).toHaveLength(1);
    const killed = await pool.kill('kill-test');
    expect(killed).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  test('sendPrompt to non-existent agent returns error', async () => {
    const pool = new AgentPool({ createSession: (() => { throw new Error('should not be called'); }) as any });
    const result = await pool.sendPrompt('nonexistent', 'hello');
    expect(result.error).toContain('not found');
  });

  test('registry persists across pool instances', () => {
    const dir = '/tmp/omo-subagent-test-registry';
    const { createSession: cs1 } = mockCreateSession();
    const pool1 = new AgentPool({ sessionDir: dir, createSession: cs1 as any });

    // Write directly to registry
    pool1['saveToRegistry']({
      id: 'persist-agent',
      name: 'persist-agent',
      agentName: 'worker',
      task: 'persist task',
      spawnedAt: Date.now(),
    });

    const entries = pool1.listRegistryEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('persist-agent');

    const pool2 = new AgentPool({ sessionDir: dir });
    const entries2 = pool2.listRegistryEntries();
    expect(entries2.length).toBe(1);
    expect(entries2[0].id).toBe('persist-agent');
  });

  test('timeout does not kill the agent, agent remains in pool', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ timeoutMs: 5, createSession: createSession as any });

    // Spawn returns immediately
    const spawnResult = await pool.spawn({
      id: 'timeout-agent',
      name: 'timeout-agent',
      agent: makeAgent(),
      task: 'initial',
    });
    expect(spawnResult.response).toContain('已启动');

    // Don't simulate response — let timeout fire; listen for the error event
    const event = await onNextPoolEvent(pool);

    expect(event.type).toBe('error');
    expect(event.error).toContain('timed out');
    expect(pool.list()).toHaveLength(1);
    expect(await pool.sendPrompt('timeout-agent', 'late')).toEqual({
      response: '',
      error: 'Agent "timeout-agent" timed out',
    });
  });

  test('kill during pending prompt resolves with error', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    // Spawn returns immediately
    const spawnResult = await pool.spawn({
      id: 'kill-agent',
      name: 'kill-agent',
      agent: makeAgent(),
      task: 'initial',
    });
    expect(spawnResult.response).toContain('已启动');

    await new Promise(r => setTimeout(r, 10));

    // Listen for the error event (from sendPromise rejection)
    const eventPromise = onNextPoolEvent(pool);
    await pool.kill('kill-agent');
    const event = await eventPromise;

    expect(event.type).toBe('error');
    expect(event.error).toBe('Aborted');
    expect(pool.list()).toHaveLength(0);
  });
});
