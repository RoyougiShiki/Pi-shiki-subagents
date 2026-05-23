import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


mock.module('typebox', () => ({
  Type: {
    String: (options?: any) => ({ type: 'string', ...options }),
    Number: (options?: any) => ({ type: 'number', ...options }),
    Integer: (options?: any) => ({ type: 'integer', ...options }),
    Boolean: (options?: any) => ({ type: 'boolean', ...options }),
    Array: (schema: any, options?: any) => ({ type: 'array', items: schema, ...options }),
    Object: (properties: any, options?: any) => ({ type: 'object', properties, ...options }),
    Optional: (schema: any) => ({ ...schema, optional: true }),
    Union: (schemas: any[]) => ({ anyOf: schemas }),
    Literal: (value: any) => ({ const: value }),
    Record: (key: any, value: any) => ({ type: 'record', key, value }),
  },
}));

let testPiAgentDir = '/tmp/omo-pi-test/agent';

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mock(async () => ({
    session: {
      prompt: mock(async () => {}),
      state: { messages: [] },
      subscribe: mock(() => () => {}),
      dispose: mock(() => {}),
      abort: mock(async () => {}),
      isStreaming: false,
    },
  })),
  getAgentDir: () => testPiAgentDir,
  DynamicBorder: class { constructor(_c?: any) {} invalidate() {} render(_w: number) { return ['']; } },
  SessionManager: {
    inMemory: () => ({ getBranch: () => [], getEntries: () => [], getLeafId: () => undefined, getSessionFile: () => undefined }),
  },
}));
mock.module("@earendil-works/pi-tui", () => {
  class MockInput {
    focused = false;
    onSubmit;
    onEscape;
    getValue() { return ""; }
    setValue(_v) {}
    handleInput(_d) {}
    invalidate() {}
    render(_w) { return [""]; }
  }
  class MockContainer {
    children = [];
    addChild(c) { this.children.push(c); }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    clear() { this.children = []; }
    invalidate() {}
    render(_w) { return [""]; }
  }
  class MockSpacer {
    constructor(_n) {}
    invalidate() {}
    render(_w) { return [""]; }
  }
  class MockText {
    constructor(_t, _x, _y) {}
    invalidate() {}
    render(_w) { return [""]; }
  }
  return {
    Input: MockInput,
    Container: MockContainer,
    Spacer: MockSpacer,
    Text: MockText,
    matchesKey: () => false,
    Key: { up: 'up', down: 'down', pageUp: 'pageUp', pageDown: 'pageDown' },
  };
});


describe('Pi adapter agent prompt sync', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pi-agent-sync-'));
    originalEnv = { ...process.env };
    process.env.HOME = path.join(tempDir, 'home');
    testPiAgentDir = path.join(tempDir, 'pi', 'agent');
    fs.rmSync(path.dirname(testPiAgentDir), { recursive: true, force: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(testPiAgentDir), { recursive: true, force: true });
  });

  test('writes workflow stage result IPC file', async () => {
    const { writeWorkflowStageResult } = await import('./pi');
    const resultPath = path.join(tempDir, 'stage-result.json');

    const ok = writeWorkflowStageResult({ type: 'complete', summary: 'done', context: 'ctx' }, resultPath);

    expect(ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toEqual({ type: 'complete', summary: 'done', context: 'ctx' });
  });

  test('generates managed agent markdown in Pi agents dir without model/tool frontmatter', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');

    ensureAgentFiles();

    const oraclePath = path.join(getPiAgentsDirForSync(), 'oracle.md');
    const content = fs.readFileSync(oraclePath, 'utf-8');
    expect(content).toContain('name: oracle');
    expect(content).toContain('description: Strategic technical advisor and code reviewer');
    expect(content).toContain('omo-managed: true');
    expect(content).toContain('omo-source-hash:');
    expect(content).not.toContain('model:');
    expect(content).not.toContain('thinking:');
    expect(content).not.toContain('tools:');
  });

  test('updates stale managed agent markdown and writes a backup', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');

    ensureAgentFiles();
    const oraclePath = path.join(getPiAgentsDirForSync(), 'oracle.md');
    const original = fs.readFileSync(oraclePath, 'utf-8');
    fs.writeFileSync(oraclePath, original.replace('# 角色', '# stale role'), 'utf-8');

    ensureAgentFiles();

    const updated = fs.readFileSync(oraclePath, 'utf-8');
    const backup = fs.readFileSync(`${oraclePath}.bak`, 'utf-8');
    expect(updated).toContain('# 角色');
    expect(updated).not.toContain('# stale role');
    expect(backup).toContain('# stale role');
  });

  test('does not overwrite unmanaged legacy or custom agent markdown', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');
    const agentsDir = getPiAgentsDirForSync();
    fs.mkdirSync(agentsDir, { recursive: true });
    const oraclePath = path.join(agentsDir, 'oracle.md');
    const customContent = ['---', 'name: oracle', 'description: Custom Oracle', '---', '', '# custom prompt'].join('\n');
    fs.writeFileSync(oraclePath, customContent, 'utf-8');

    ensureAgentFiles();

    expect(fs.readFileSync(oraclePath, 'utf-8')).toBe(customContent);
    expect(fs.existsSync(`${oraclePath}.bak`)).toBe(false);
  });

  test('migrates old OMO-generated markdown with obsolete model frontmatter', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');
    const agentsDir = getPiAgentsDirForSync();
    fs.mkdirSync(agentsDir, { recursive: true });
    const sourcePath = path.join(import.meta.dir, 'agents', 'oracle.md');
    const oraclePath = path.join(agentsDir, 'oracle.md');
    const legacyContent = fs.readFileSync(sourcePath, 'utf-8').replace('description: Strategic technical advisor and code reviewer', 'description: Strategic technical advisor and code reviewer\nmodel: openai/gpt-4.1\nthinking: low');
    fs.writeFileSync(oraclePath, legacyContent, 'utf-8');

    ensureAgentFiles();

    const migrated = fs.readFileSync(oraclePath, 'utf-8');
    const backup = fs.readFileSync(`${oraclePath}.bak`, 'utf-8');
    expect(migrated).toContain('omo-managed: true');
    expect(migrated).toContain('omo-source-hash:');
    expect(migrated).not.toContain('model:');
    expect(migrated).not.toContain('thinking:');
    expect(backup).toBe(legacyContent);
  });

  test('does not migrate custom prompt that keeps the default description', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');
    const agentsDir = getPiAgentsDirForSync();
    fs.mkdirSync(agentsDir, { recursive: true });
    const oraclePath = path.join(agentsDir, 'oracle.md');
    const customContent = [
      '---',
      'name: oracle',
      'description: Strategic technical advisor and code reviewer',
      '---',
      '',
      '# My custom Oracle prompt',
      'This keeps the stock description but changes the body.',
    ].join('\n');
    fs.writeFileSync(oraclePath, customContent, 'utf-8');

    ensureAgentFiles();

    expect(fs.readFileSync(oraclePath, 'utf-8')).toBe(customContent);
    expect(fs.existsSync(`${oraclePath}.bak`)).toBe(false);
  });

  test('migrates old English OMO-generated oracle markdown after reload', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');
    const agentsDir = getPiAgentsDirForSync();
    fs.mkdirSync(agentsDir, { recursive: true });
    const oraclePath = path.join(agentsDir, 'oracle.md');
    const legacyContent = [
      '---',
      'name: oracle',
      'description: Strategic technical advisor and code reviewer',
      'thinking: low',
      '---',
      '',
      'You are Oracle - a strategic technical advisor and code reviewer.',
      '',
      '**Role**: High-IQ debugging, architecture decisions, code review, simplification, and engineering guidance.',
    ].join('\n');
    fs.writeFileSync(oraclePath, legacyContent, 'utf-8');

    ensureAgentFiles();

    const migrated = fs.readFileSync(oraclePath, 'utf-8');
    const backup = fs.readFileSync(`${oraclePath}.bak`, 'utf-8');
    expect(migrated).toContain('omo-managed: true');
    expect(migrated).toContain('# 角色');
    expect(migrated).not.toContain('You are Oracle -');
    expect(migrated).not.toContain('thinking:');
    expect(backup).toBe(legacyContent);
  });

  test('reloads in-memory AGENT_PROMPTS after migrating files', async () => {
    const { ensureAgentFiles, getPiAgentsDirForSync } = await import('./pi');
    const { AGENT_PROMPTS } = await import('./pi-agents');
    const agentsDir = getPiAgentsDirForSync();
    fs.mkdirSync(agentsDir, { recursive: true });
    const oraclePath = path.join(agentsDir, 'oracle.md');
    const legacyContent = [
      '---',
      'name: oracle',
      'description: Strategic technical advisor and code reviewer',
      'thinking: low',
      '---',
      '',
      'You are Oracle - a strategic technical advisor and code reviewer.',
    ].join('\n');
    fs.writeFileSync(oraclePath, legacyContent, 'utf-8');

    ensureAgentFiles();

    expect(AGENT_PROMPTS.oracle?.prompt).toContain('# 角色');
    expect(AGENT_PROMPTS.oracle?.prompt).not.toContain('You are Oracle -');
  });
});

describe('Pi adapter config helpers', () => {
  let tempDir: string;
  let projectDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;

  function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pi-adapter-config-'));
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    process.env.HOME = path.join(tempDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    testPiAgentDir = path.join(tempDir, 'pi', 'agent');
    fs.rmSync(path.dirname(testPiAgentDir), { recursive: true, force: true });
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(testPiAgentDir), { recursive: true, force: true });
  });

  test('strips JSON comments without breaking URLs inside strings', async () => {
    const { stripJsonCommentsSafely } = await import('./pi');

    const raw = `{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/schema.json", // trailing comment
  /* block comment */
  "council": {
    "meeting_backend": "collaborating"
  }
}`;

    const cleaned = stripJsonCommentsSafely(raw);
    const parsed = JSON.parse(cleaned);

    expect(parsed.$schema).toBe('https://unpkg.com/oh-my-opencode-slim@latest/schema.json');
    expect(parsed.council.meeting_backend).toBe('collaborating');
    expect(cleaned).not.toContain('trailing comment');
    expect(cleaned).not.toContain('block comment');
  });

  test('loads Pi adapter config through shared OpenCode search paths', async () => {
    const opencodeDir = path.join(tempDir, 'custom-opencode');
    process.env.OPENCODE_CONFIG_DIR = opencodeDir;
    writeJson(path.join(opencodeDir, 'oh-my-opencode-slim.json'), {
      agents: { oracle: { model: 'runtime/review-oracle' } },
      council: {
        presets: { default: { alpha: { model: 'openai/gpt-4o' } } },
        meeting_backend: 'collaborating',
      },
      workflows: {
        default: 'review-only',
        list: [{ name: 'review-only', description: 'Review', stages: [{ agent: 'oracle' }] }],
      },
    });

    const { getConfigSearchDirs } = await import('../cli/paths');
    const { loadPluginConfig } = await import('../config/loader');
    const { loadOmniMoConfig } = await import('./pi');
    const searchDirs = getConfigSearchDirs();
    const sharedConfig = loadPluginConfig(projectDir);
    const config = loadOmniMoConfig(projectDir);

    expect(searchDirs).toContain(opencodeDir);
    expect(sharedConfig.agents?.oracle?.model).toBe('runtime/review-oracle');
    expect(config?.agents?.oracle?.model).toBe('runtime/review-oracle');
    expect(config?.council?.meeting_backend).toBe('collaborating');
    expect(config?.workflows?.default).toBe('review-only');
  });

  test('merges Pi native config as fallback and project config as override', async () => {
    const piAgentDir = testPiAgentDir;
    writeJson(path.join(piAgentDir, 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'pi-native/oracle-model',
          options: { textVerbosity: 'low', reasoningEffort: 'medium' },
        },
      },
      disabled_agents: ['observer'],
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'project/oracle-model',
          options: { textVerbosity: 'high' },
        },
      },
    });

    const piModule = await import('./pi');
    expect(piModule.getPiAgentDirForConfig()).toBe(piAgentDir);
    expect(fs.existsSync(path.join(piAgentDir, 'oh-my-opencode-slim.json'))).toBe(true);
    const config = piModule.loadOmniMoConfig(projectDir);

    expect(config?.agents?.oracle?.model).toBe('project/oracle-model');
    expect(config?.agents?.oracle?.options).toEqual({
      textVerbosity: 'high',
      reasoningEffort: 'medium',
    });
    expect(config?.disabled_agents).toEqual(['observer']);
  });

  test('merges Pi native, OpenCode user, and project config in precedence order', async () => {
    const piAgentDir = testPiAgentDir;
    const opencodeDir = path.join(tempDir, 'custom-opencode');
    process.env.OPENCODE_CONFIG_DIR = opencodeDir;

    writeJson(path.join(piAgentDir, 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'pi-native/oracle-model',
          options: {
            reasoningEffort: 'low',
            textVerbosity: 'low',
            piOnly: true,
          },
        },
        explorer: { model: 'pi-native/explorer-model' },
      },
      disabled_agents: ['observer'],
    });
    writeJson(path.join(opencodeDir, 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'opencode/oracle-model',
          options: {
            reasoningEffort: 'medium',
            userOnly: true,
          },
        },
        fixer: { model: 'opencode/fixer-model' },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'project/oracle-model',
          options: {
            textVerbosity: 'high',
          },
        },
      },
    });

    const { loadOmniMoConfig } = await import('./pi');
    const config = loadOmniMoConfig(projectDir);

    expect(config?.agents?.oracle?.model).toBe('project/oracle-model');
    expect(config?.agents?.oracle?.options).toEqual({
      reasoningEffort: 'medium',
      textVerbosity: 'high',
      piOnly: true,
      userOnly: true,
    });
    expect(config?.agents?.explorer?.model).toBe('pi-native/explorer-model');
    expect(config?.agents?.fixer?.model).toBe('opencode/fixer-model');
    expect(config?.disabled_agents).toEqual(['observer']);
  });
});

describe('Pi adapter council helpers', () => {
  test('resolves explicit participants with fallback names and agents', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({
      config: null,
      participants: [
        { name: 'architect', model: 'openai/gpt-4o' },
        { agent: 'oracle', prompt: 'Review risks' },
        { model: 'google/gemini-pro' },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.participants).toEqual([
      { name: 'architect', agent: 'architect', model: 'openai/gpt-4o', variant: undefined, prompt: undefined },
      { name: 'oracle', agent: 'oracle', model: undefined, variant: undefined, prompt: 'Review risks' },
      { name: 'participant-3', agent: 'participant-3', model: 'google/gemini-pro', variant: undefined, prompt: undefined },
    ]);
  });

  test('resolves configured preset participants and skips legacy master', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({
      config: {
        council: {
          default_preset: 'design',
          presets: {
            design: {
              alpha: { agent: 'oracle', model: 'openai/gpt-4o', prompt: 'Architecture review' },
              beta: { agent: 'fixer' },
              master: { model: 'openai/ignored' },
            },
          },
        },
      } as any,
    });

    expect(result.error).toBeUndefined();
    expect(result.participants.map((p: any) => p.name)).toEqual(['alpha', 'beta']);
    expect(result.participants[0]).toMatchObject({ name: 'alpha', agent: 'oracle', model: 'openai/gpt-4o' });
  });

  test('reports missing council configuration with actionable message', async () => {
    const { resolvePiCouncilParticipants } = await import('./pi');

    const result = resolvePiCouncilParticipants({ config: null });

    expect(result.participants).toEqual([]);
    expect(result.error).toContain('Council is not configured');
  });

  test('formats isolated council results preserving failures and completion count', async () => {
    const { formatPiCouncilResults } = await import('./pi');

    const output = formatPiCouncilResults('Choose an architecture', [
      { name: 'alpha', agent: 'oracle', model: 'openai/gpt-4o', status: 'completed', result: 'Use A' },
      { name: 'beta', agent: 'fixer', status: 'failed', error: 'Provider unavailable' },
    ]);

    expect(output).toContain('## Isolated Council Results');
    expect(output).toContain('Completed: 1/2');
    expect(output).toContain('### alpha (openai/gpt-4o)');
    expect(output).toContain('Use A');
    expect(output).toContain('### beta');
    expect(output).toContain('Provider unavailable');
    expect(output).toContain('Preserve disagreements');
  });
});

describe('Pi adapter meeting helpers', () => {
  test('normalizes meeting objective with decision fallback', async () => {
    const { normalizePiMeetingObjective } = await import('./pi');

    expect(normalizePiMeetingObjective(undefined)).toBe('decision');
    expect(normalizePiMeetingObjective('review')).toBe('review');
    expect(normalizePiMeetingObjective('not-real')).toBe('decision');
  });

  test('normalizes meeting max rounds into supported range', async () => {
    const { normalizePiMeetingMaxRounds } = await import('./pi');

    expect(normalizePiMeetingMaxRounds(undefined)).toBe(2);
    expect(normalizePiMeetingMaxRounds(0)).toBe(0);
    expect(normalizePiMeetingMaxRounds(3.8)).toBe(3);
    expect(normalizePiMeetingMaxRounds(99)).toBe(5);
  });

  test('normalizes meeting backend with session fallback', async () => {
    const { normalizePiMeetingBackend } = await import('./pi');

    expect(normalizePiMeetingBackend(undefined)).toBe('session');
    expect(normalizePiMeetingBackend('session')).toBe('session');
    expect(normalizePiMeetingBackend('collaborating')).toBe('pool');
    expect(normalizePiMeetingBackend('internal-store')).toBe('session');
  });

  test('resolves meeting backend selection before runtime fallback', async () => {
    const { resolvePiMeetingBackend } = await import('./pi-meeting');

    const sessionResolution = resolvePiMeetingBackend(undefined);
    expect(sessionResolution.requestedBackend).toBe('session');
    expect(sessionResolution.backendUsed).toBe('session');
    expect(sessionResolution.fallbackReason).toBeUndefined();

    const collaboratingResolution = resolvePiMeetingBackend('collaborating');
    // collaborating 已被 pool 替代
    expect(collaboratingResolution.requestedBackend).toBe('pool');
    expect(collaboratingResolution.backendUsed).toBe('pool');
    expect(collaboratingResolution.fallbackReason).toBeUndefined();
  });



  test('formats completed collaborating backend metadata from live-smoke path', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'omo-meet-smoke',
      question: 'Can collaborating meeting participants reply?',
      objective: 'debug',
      status: 'completed',
      roundsCompleted: 1,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'completed', finalPosition: 'Participant replied.' },
        { name: 'fixer', agent: 'fixer', status: 'completed', finalPosition: 'Participant replied.' },
      ],
      report: '## Realtime Meeting Result\n\n### Status\ncompleted',
      keySignals: ['Participants returned responses via agent_message.'],
      requestedBackend: 'collaborating',
      backendUsed: 'collaborating',
    });

    expect(output).toContain('requestedBackend: collaborating');
    expect(output).toContain('backendUsed: collaborating');
    expect(output).toContain('transcript omitted: yes');
    expect(output).not.toContain('fallbackReason:');
  });

  test('formats meeting result without leaking transcript by default', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-1',
      question: 'Pick an approach',
      objective: 'decision',
      status: 'completed',
      roundsCompleted: 2,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'completed', finalPosition: 'Use A' },
      ],
      report: '## Realtime Meeting Result\n\n### Question\nPick an approach\n\n### Key Signals From Discussion\n- Oracle changed view after implementation risk was clarified.',
      keySignals: ['Oracle changed view after implementation risk was clarified.'],
      requestedBackend: 'session',
      backendUsed: 'session',
    });

    expect(output).toContain('## Realtime Meeting Result');
    expect(output).toContain('Key Signals From Discussion');
    expect(output).toContain('requestedBackend: session');
    expect(output).toContain('backendUsed: session');
    expect(output).toContain('transcript omitted: yes');
    expect(output).not.toContain('raw hidden noise');
  });

  test('formats meeting transcript only when explicitly present', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-2',
      question: 'Pick an approach',
      objective: 'review',
      status: 'completed',
      roundsCompleted: 1,
      participants: [
        { name: 'fixer', agent: 'fixer', status: 'completed', finalPosition: 'Use B' },
      ],
      report: '## Realtime Meeting Result\n\n### Key Signals From Discussion\n- Fixer found lower-risk implementation.',
      keySignals: ['Fixer found lower-risk implementation.'],
      requestedBackend: 'collaborating',
      backendUsed: 'session',
      fallbackReason: 'spawn failed, fell back to session backend',
      transcript: [
        {
          id: 'm1',
          meetingId: 'test-meeting-2',
          round: 0,
          phase: 'opening',
          from: 'fixer',
          role: 'fixer',
          content: 'raw hidden noise',
          timestamp: 1,
        },
      ],
    });

    expect(output).toContain('## Transcript Appendix');
    expect(output).toContain('includeTranscript=true');
    expect(output).toContain('requestedBackend: collaborating');
    expect(output).toContain('backendUsed: session');
    expect(output).toContain('fallbackReason: spawn failed, fell back to session backend');
    expect(output).toContain('raw hidden noise');
  });

  test('formats failed participant errors into final report output', async () => {
    const { formatPiMeetingResult } = await import('./pi');

    const output = formatPiMeetingResult({
      meetingId: 'test-meeting-3',
      question: 'Pick an approach',
      objective: 'decision',
      status: 'failed',
      roundsCompleted: 1,
      participants: [
        { name: 'oracle', agent: 'oracle', status: 'failed', error: 'agent_message send failed' },
        { name: 'fixer', agent: 'fixer', status: 'failed', error: 'subagent exited before sending response' },
      ],
      report: '## Realtime Meeting Result\n\n### Participants\n- oracle (oracle, failed) — agent_message send failed\n- fixer (fixer, failed) — subagent exited before sending response',
      keySignals: ['No discussion content was available.'],
      requestedBackend: 'collaborating',
      backendUsed: 'collaborating',
    });

    expect(output).toContain('agent_message send failed');
    expect(output).toContain('subagent exited before sending response');
  });
});

describe('Pi adapter preset helpers', () => {
  test('parses provider/model IDs', async () => {
    const { parsePiModelId } = await import('./pi');

    expect(parsePiModelId('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parsePiModelId('dmxapi/gpt-5.5')).toEqual({ provider: 'dmxapi', model: 'gpt-5.5' });
    expect(parsePiModelId('missing-slash')).toBeUndefined();
    expect(parsePiModelId('/missing-provider')).toBeUndefined();
    expect(parsePiModelId('missing-model/')).toBeUndefined();
  });

  test('resolves preset switch plan with orchestrator model and thinking', async () => {
    const { resolvePresetSwitchPlan } = await import('./pi');

    const plan = resolvePresetSwitchPlan({
      presets: {
        powerful: {
          orchestrator: { model: 'openai/gpt-4o', thinking: 'high' },
          explorer: { model: 'openai/gpt-4o-mini' },
        },
      },
    } as any, 'powerful');

    expect(plan).toEqual({ model: 'openai/gpt-4o', thinking: 'high' });
  });

  test('reports missing preset with available names', async () => {
    const { resolvePresetSwitchPlan } = await import('./pi');

    const plan = resolvePresetSwitchPlan({ presets: { cheap: {} } } as any, 'powerful');

    expect(plan.error).toContain('Preset "powerful" not found');
    expect(plan.error).toContain('cheap');
  });
});
