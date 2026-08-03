import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let testPiAgentDir = '/tmp/omo-pi-test/agent';

mock.module('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => testPiAgentDir,
  createAgentSession: mock(async () => ({
    session: {
      prompt: mock(async () => {}),
      subscribe: mock(() => () => {}),
      abort: mock(async () => {}),
      dispose: mock(() => {}),
      state: { messages: [] },
      agent: { state: { messages: [] }, waitForIdle: mock(async () => {}) },
    },
  })),
  SessionManager: {
    inMemory: () => ({}),
    create: () => ({}),
    open: () => ({}),
  },
  DynamicBorder: class {
    invalidate() {}
    render() {
      return [''];
    }
  },
}));

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createPi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const pi = {
    getAllTools: mock(() => [
      { name: 'read' },
      { name: 'write' },
      { name: 'edit' },
      { name: 'bash' },
      { name: 'omo_subagent' },
      { name: 'omo_council' },
    ]),
    setActiveTools: mock(() => {}),
    on: mock((name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    registerTool: mock((tool: any) => tools.push(tool)),
    registerCommand: mock((name: string, command: any) =>
      commands.set(name, command),
    ),
    setModel: mock(async () => true),
    setThinkingLevel: mock(() => {}),
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: mock(() => {}) },
    modelRegistry: { find: mock(() => ({ provider: 'test', id: 'main' })) },
  };
  return { pi, ctx, handlers, tools, commands };
}

describe('Pi runtime configuration', () => {
  let tempDir: string;
  let projectDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pi-runtime-'));
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.HOME = path.join(tempDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.OPENCODE_CONFIG_DIR;
    testPiAgentDir = path.join(tempDir, 'pi', 'agent');
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('strips JSONC comments without changing URLs in string values', async () => {
    const { stripJsonCommentsSafely } = await import('../pi/core/pi');
    const parsed = JSON.parse(
      stripJsonCommentsSafely(`{
      "$schema": "https://example.test/schema.json", // comment
      /* block */ "council": { "meeting_backend": "session" }
    }`),
    );

    expect(parsed.$schema).toBe('https://example.test/schema.json');
    expect(parsed.council.meeting_backend).toBe('session');
  });

  test('merges Pi-native config as a fallback and project config as an override', async () => {
    writeJson(path.join(testPiAgentDir, 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: { model: 'native/oracle', options: { verbosity: 'low' } },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: { model: 'project/oracle', options: { reasoning: 'high' } },
      },
    });

    const { loadOmniMoConfig } = await import('../pi/core/pi');
    const config = loadOmniMoConfig(projectDir);

    expect(config?.agents?.oracle?.model).toBe('project/oracle');
    expect(config?.agents?.oracle?.options).toEqual({
      verbosity: 'low',
      reasoning: 'high',
    });
  });

  test('persists the selected preset to Pi-native config', async () => {
    writeJson(path.join(testPiAgentDir, 'oh-my-opencode-slim.json'), {
      preset: 'economy',
      presets: { economy: {} },
    });

    const { persistPresetSelectionToPiNativeConfig } = await import(
      '../pi/core/pi'
    );
    persistPresetSelectionToPiNativeConfig('quality', {
      presets: { quality: { subagent: 'test/quality-sub' } },
    } as any);

    const saved = JSON.parse(
      fs.readFileSync(
        path.join(testPiAgentDir, 'oh-my-opencode-slim.json'),
        'utf8',
      ),
    );
    expect(saved.preset).toBe('quality');
    expect(saved.presets.quality.subagent).toBe('test/quality-sub');
    expect(saved.presets.economy).toEqual({});
  });
});

describe('Pi thin runtime', () => {
  test('initializes the broad main tool scope and keeps role tools registered', async () => {
    const { default: extension } = await import('../pi/core/pi');
    const { getToolScope } = await import('../pi/policy/tool-scope-manager');
    const { pi, ctx, handlers, tools, commands } = createPi();

    extension(pi as any);
    for (const handler of handlers.get('session_start') ?? [])
      await handler({}, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith([
      'read',
      'write',
      'edit',
      'bash',
      'omo_subagent',
      'omo_council',
    ]);
    expect(getToolScope()).toMatchObject({
      source: 'main',
      sourceName: 'main',
    });
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['omo_council', 'omo_subagent']),
    );
    const subagentTool = tools.find((tool) => tool.name === 'omo_subagent');
    const councilTool = tools.find((tool) => tool.name === 'omo_council');
    expect(subagentTool?.promptSnippet).toEqual(expect.any(String));
    expect(subagentTool?.promptSnippet.length).toBeGreaterThan(0);
    expect(councilTool?.promptSnippet).toEqual(expect.any(String));
    expect(councilTool?.promptSnippet.length).toBeGreaterThan(0);
    expect(subagentTool?.promptGuidelines?.length).toBeGreaterThan(0);
    expect(councilTool?.promptGuidelines?.length).toBeGreaterThan(0);
    expect([...commands.keys()]).toEqual(
      expect.arrayContaining(['preset', 'pi-sync', 'pool-status']),
    );
    for (const handler of handlers.get('session_shutdown') ?? [])
      await handler({}, ctx);
    expect(getToolScope()).toBeNull();
  });

  test('blocks tools outside the main scope and dangerous bash commands', async () => {
    const { default: extension } = await import('../pi/core/pi');
    const { pi, ctx, handlers } = createPi();

    extension(pi as any);
    for (const handler of handlers.get('session_start') ?? [])
      await handler({}, ctx);
    const gate = handlers.get('tool_call')?.[0];
    if (!gate) throw new Error('Tool call gate was not registered.');

    await expect(
      gate({ toolName: 'unknown_tool', input: {} }, ctx),
    ).resolves.toMatchObject({ block: true });
    await expect(
      gate(
        { toolName: 'bash', input: { command: 'sudo rm -rf /tmp/test' } },
        ctx,
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('Blocked dangerous bash command'),
    });
    await expect(
      gate({ toolName: 'bash', input: { command: 'git status' } }, ctx),
    ).resolves.toBeUndefined();
  });

  test('resolves role subagent models from preset slots then main model', async () => {
    const {
      resolveRoleSubagentModelId,
      findStalePresetSlots,
    } = await import('../pi/preset/preset-model-resolution');

    expect(
      resolveRoleSubagentModelId({
        role: 'fixer',
        pack: { subagent: 'provider/sub', fixer: 'provider/fixer' },
        mainModelId: 'provider/main',
      }),
    ).toEqual({ modelId: 'provider/fixer', source: 'role' });

    expect(
      resolveRoleSubagentModelId({
        role: 'search',
        pack: { subagent: 'provider/sub' },
        mainModelId: 'provider/main',
      }),
    ).toEqual({ modelId: 'provider/sub', source: 'subagent' });

    expect(
      resolveRoleSubagentModelId({
        role: 'oracle',
        pack: {},
        mainModelId: 'provider/main',
      }),
    ).toEqual({ modelId: 'provider/main', source: 'main' });

    expect(
      findStalePresetSlots(
        { subagent: 'gone/model', oracle: 'ok/model' },
        [{ provider: 'ok', id: 'model' }],
      ),
    ).toEqual([{ slot: 'subagent', modelId: 'gone/model' }]);
  });
});
