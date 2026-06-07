import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  consumePipelineDelegationGrant,
  issuePipelineDelegationGrant,
  resetPipelineDelegationGrantsForTests,
} from '../pi/policy/pipeline-delegation-grants';
import { resetToolScope, setToolScope } from '../pi/policy/tool-scope-manager';
import {
  AgentPool,
  resolveDelegationCaller,
  resolveSubagentToolNamesForAgent,
} from '../pi/subagent/subagent-pool';
import type { AgentConfig } from './agent-discovery';

function makeAgent(name = 'worker'): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    model: `test/${name}`,
  };
}

function withIsolatedHome<T>(fn: () => T): T {
  const previousHome = process.env.HOME;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-subagent-tools-'));
  process.env.HOME = path.join(tempDir, 'home');
  try {
    return fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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
    get model() {
      return { provider: 'test', id: 'mock-model' };
    },
    get messages() {
      return latestMessages;
    },
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
    navigateTree: mock(() =>
      Promise.resolve({ editorText: undefined, cancelled: false }),
    ),
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
    _emitEvent(event: any) {
      for (const cb of listeners) cb(event);
    },
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

  const createSession = mock(async () => ({
    session,
    extensionsResult: {} as any,
    modelFallbackMessage: undefined,
  }));

  return { session, createSession };
}

/** Wait for the next pool event (completed or error). */
function onNextPoolEvent(pool: AgentPool): Promise<any> {
  return new Promise((resolve) => {
    const unsub = pool.onEvent((event) => {
      unsub();
      resolve(event);
    });
  });
}

function collectPoolEvents(pool: AgentPool, waitMs = 20): Promise<any[]> {
  const events: any[] = [];
  const unsubscribe = pool.onEvent((event) => {
    events.push(event);
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      unsubscribe();
      resolve(events);
    }, waitMs);
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
    expect(resolveSubagentToolNamesForAgent('worker')).toEqual([
      'read',
      'write',
      'edit',
    ]);
    const fixerTools = resolveSubagentToolNamesForAgent('fixer') ?? [];
    expect(fixerTools.includes('read')).toBe(true);
    expect(fixerTools.includes('write')).toBe(true);
    expect(fixerTools.includes('edit')).toBe(true);
    expect(fixerTools.includes('bash')).toBe(true);
  });

  test('expands default nested role groups and wildcard expressions with tool names', () => {
    withIsolatedHome(() => {
      const allToolNames = [
        'read',
        'write',
        'edit',
        'bash',
        'omo_subagent',
        'omo_council',
        'codebase_memory_search_graph',
        'context_mode_ctx_search',
      ];

      const dispatcherTools = resolveSubagentToolNamesForAgent(
        'dispatcher',
        process.cwd(),
        allToolNames,
      );
      expect(dispatcherTools).toEqual(['omo_subagent', 'omo_council']);
      expect(dispatcherTools).not.toContain('@子代理');

      const fixerTools = resolveSubagentToolNamesForAgent(
        'fixer',
        process.cwd(),
        allToolNames,
      ) ?? [];
      expect(fixerTools).toContain('codebase_memory_search_graph');
      expect(fixerTools).toContain('context_mode_ctx_search');
      expect(fixerTools).not.toContain('codebase_*');
    });
  });

  test('expands explicit tool group references from runtime config', () => {
    withIsolatedHome(() => {
      writeJson(
        path.join(
          process.env.HOME!,
          '.pi',
          'agent',
          'oh-my-opencode-slim.json',
        ),
        {
          agents: {
            custom: {
              type: 'subagent',
              tools: ['@管理'],
            },
          },
        },
      );

      expect(
        resolveSubagentToolNamesForAgent('custom', process.cwd(), [
          'omo_subagent',
          'omo_council',
        ]),
      ).toEqual(['omo_subagent', 'omo_council']);
    });
  });

  test('reads project tool groups from jsonc with comments and trailing commas', () => {
    withIsolatedHome(() => {
      const projectDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'omo-subagent-project-jsonc-'),
      );
      try {
        writeJson(
          path.join(
            process.env.HOME!,
            '.pi',
            'agent',
            'oh-my-opencode-slim.json',
          ),
          {
            agents: {
              custom: {
                type: 'subagent',
                tools: ['@customGroup'],
              },
            },
          },
        );
        fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, '.opencode', 'oh-my-opencode-slim.jsonc'),
          `{
            // project-local tool group
            "_tool_groups": {
              "customGroup": ["read", "write",],
            },
          }`,
        );

        expect(
          resolveSubagentToolNamesForAgent('custom', projectDir, [
            'read',
            'write',
            'edit',
          ]),
        ).toEqual(['read', 'write']);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  test('keeps roles priority over broader explicit tools', () => {
    withIsolatedHome(() => {
      writeJson(
        path.join(
          process.env.HOME!,
          '.pi',
          'agent',
          'oh-my-opencode-slim.json',
        ),
        {
          agents: {
            constrained: {
              type: 'subagent',
              roles: ['读'],
              tools: ['*'],
            },
          },
        },
      );

      expect(
        resolveSubagentToolNamesForAgent('constrained', process.cwd(), [
          'read',
          'write',
          'edit',
        ]),
      ).toEqual(['read']);
    });
  });

  test('expands role expressions with the shared agent resolver semantics', () => {
    withIsolatedHome(() => {
      writeJson(
        path.join(
          process.env.HOME!,
          '.pi',
          'agent',
          'oh-my-opencode-slim.json',
        ),
        {
          agents: {
            manager: {
              type: 'subagent',
              roles: ['@管理'],
            },
            codeSearch: {
              type: 'subagent',
              roles: ['codebase_*'],
            },
          },
        },
      );

      expect(
        resolveSubagentToolNamesForAgent('manager', process.cwd(), [
          'omo_subagent',
          'omo_council',
        ]),
      ).toEqual(['omo_subagent', 'omo_council']);
      expect(
        resolveSubagentToolNamesForAgent('codeSearch', process.cwd(), [
          'read',
          'codebase_memory_search_graph',
        ]),
      ).toEqual(['codebase_memory_search_graph']);
    });
  });

  test('pipeline stage primary grant is not issued when caller is missing', () => {
    issuePipelineDelegationGrant({
      caller: undefined,
      target: 'analyst',
      depth: 0,
      childAllowedSubagents: ['search'],
    });

    expect(
      consumePipelineDelegationGrant({
        caller: undefined,
        target: 'analyst',
        depth: 0,
      }),
    ).toBeUndefined();
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
    expect(createSession.mock.calls[0]?.[0]?.tools).toEqual([
      'read',
      'write',
      'edit',
    ]);
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0].id).toBe('test-agent');
    expect(pool.list()[0].status).toBe('idle');

    await pool.kill('test-agent');
    expect(pool.list()).toHaveLength(0);
  });

  test('initial prompt timeout emits exactly one pool error event', async () => {
    const { createSession } = mockCreateSession();
    const pool = new AgentPool({
      createSession: createSession as any,
      timeoutMs: 1,
    });
    const eventsPromise = collectPoolEvents(pool, 30);

    await pool.spawn({
      id: 'timeout-agent',
      name: 'timeout-agent',
      agent: makeAgent(),
      task: 'hang forever',
    });

    const events = await eventsPromise;
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.poolId).toBe('timeout-agent');
    expect(errors[0]?.error).toContain('timed out');
  });

  test('spawn uses discovered runtime agent model instead of re-reading stale config', async () => {
    const { session, createSession } = mockCreateSession();
    const resolvedModel = { provider: 'dmxapi-responses', id: 'gpt-5.5' };
    const resolveModel = mock((modelId: string) =>
      modelId === 'dmxapi-responses/gpt-5.5' ? resolvedModel : undefined,
    );
    const pool = new AgentPool({
      createSession: createSession as any,
      resolveModel,
    });
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
    await new Promise((r) => setTimeout(r, 10));
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
    const pool = new AgentPool({
      createSession: (() => {
        throw new Error('should not be called');
      }) as any,
    });
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
    const pool = new AgentPool({
      timeoutMs: 5,
      createSession: createSession as any,
    });

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

    await new Promise((r) => setTimeout(r, 10));

    // Listen for the error event (from sendPromise rejection)
    const eventPromise = onNextPoolEvent(pool);
    await pool.kill('kill-agent');
    const event = await eventPromise;

    expect(event.type).toBe('error');
    expect(event.error).toBe('Aborted');
    expect(pool.list()).toHaveLength(0);
  });

  test('run snapshot records spawn identity and explicit parent only', async () => {
    const { createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    await pool.spawn({
      id: 'child-run',
      name: 'Child Run',
      agent: makeAgent('oracle'),
      task: 'review architecture',
      parentAgent: 'coordinator',
      depth: 2,
    });

    let view = pool.getRunTreeView({ now: Date.now() });
    expect(view.roots.map((run) => run.runId)).toEqual(['child-run']);
    expect(view.roots[0]?.parentRunId).toBeUndefined();
    expect(view.roots[0]?.depth).toBe(2);

    await pool.kill('child-run');

    const { createSession: createSession2 } = mockCreateSession();
    const parentedPool = new AgentPool({
      createSession: createSession2 as any,
    });
    await parentedPool.spawn({
      id: 'parent-run',
      name: 'Parent Run',
      agent: makeAgent('coordinator'),
      task: 'parent task',
    });
    await parentedPool.spawn({
      id: 'nested-run',
      name: 'Nested Run',
      agent: makeAgent('oracle'),
      task: 'nested task',
      parentRunId: 'parent-run',
      depth: 1,
    });

    view = parentedPool.getRunTreeView({ now: Date.now() });
    expect(view.roots.map((run) => run.runId)).toEqual(['parent-run']);
    expect(view.roots[0]?.children[0]?.runId).toBe('nested-run');
    expect(view.roots[0]?.children[0]?.parentRunId).toBe('parent-run');
    await parentedPool.killAll();
  });

  test('run snapshot records session events and optional usage', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    await pool.spawn({
      id: 'observed-run',
      name: 'Observed Run',
      agent: makeAgent('oracle'),
      task: 'observe events',
    });
    session._emitEvent({ type: 'turn_start' });
    session._emitEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
        usage: { input: 100, output: 20, cost: 0.002 },
      },
    });
    session._emitEvent({ type: 'unknown', raw: { should: 'be ignored' } });

    const view = pool.getRunTreeView({ now: Date.now() });
    expect(view.roots[0]?.status).toBe('streaming');
    expect(view.roots[0]?.usageText).toBe('↑100 ↓20 $0.0020');
    expect(view.roots[0]?.recentLines).toContain('partial answer');

    await pool.kill('observed-run');
  });

  test('initial run completion is not corrupted by later send or kill', async () => {
    const { session, createSession } = mockCreateSession();
    const pool = new AgentPool({ createSession: createSession as any });

    await pool.spawn({
      id: 'persistent-run',
      name: 'Persistent Run',
      agent: makeAgent('worker'),
      task: 'initial',
    });
    const initEvent = onNextPoolEvent(pool);
    session._simulateResponse('initial done');
    await initEvent;

    expect(pool.getRunTreeView({ now: Date.now() }).roots[0]?.status).toBe(
      'completed',
    );

    const sendPromise = pool.sendPrompt('persistent-run', 'later');
    await new Promise((resolve) => setTimeout(resolve, 10));
    session._simulateResponse('later done');
    await sendPromise;

    expect(pool.getRunTreeView({ now: Date.now() }).roots[0]?.status).toBe(
      'completed',
    );

    await pool.kill('persistent-run');
    expect(pool.getRunTreeView({ now: Date.now() }).roots[0]?.status).toBe(
      'completed',
    );
  });
});
