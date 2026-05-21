import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRuntimeBlockedAgents, loadRuntimeAgentDefinitions } from './agent-runtime-config';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('runtime agent config', () => {
  let tempDir: string;
  let projectDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-runtime-agent-config-'));
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.HOME = path.join(tempDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads agent overrides from OPENCODE_CONFIG_DIR via the shared config loader', () => {
    const opencodeDir = path.join(tempDir, 'custom-opencode');
    process.env.OPENCODE_CONFIG_DIR = opencodeDir;
    writeJson(path.join(opencodeDir, 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'custom/oracle-from-opencode-config-dir',
          tools: ['read'],
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('custom/oracle-from-opencode-config-dir');
    expect(defs.oracle?.tools).toEqual(['read']);
  });

  test('merges active preset agent overrides into runtime definitions', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      preset: 'review',
      presets: {
        review: {
          oracle: {
            model: 'preset/oracle-model',
            tools: ['read', 'grep'],
          },
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('preset/oracle-model');
    expect(defs.oracle?.tools).toEqual(['read', 'grep']);
    expect(defs.oracle?.type).toBe('subagent');
  });

  test('uses root agent overrides according to shared loader merge semantics', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      preset: 'review',
      presets: {
        review: {
          oracle: {
            model: 'preset/oracle-model',
            options: { textVerbosity: 'low', reasoningEffort: 'medium' },
          },
        },
      },
      agents: {
        oracle: {
          model: 'root/oracle-model',
          options: { textVerbosity: 'high' },
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('root/oracle-model');
    expect(defs.oracle?.options).toEqual({
      textVerbosity: 'high',
      reasoningEffort: 'medium',
    });
  });

  test('keeps Pi native config as a fallback runtime source', () => {
    writeJson(path.join(process.env.HOME!, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'pi-native/oracle-model',
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('pi-native/oracle-model');
  });

  test('merges active preset from Pi native config fallback', () => {
    writeJson(path.join(process.env.HOME!, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      preset: 'native-review',
      presets: {
        'native-review': {
          oracle: {
            model: 'pi-native-preset/oracle-model',
            tools: ['read', 'grep'],
          },
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('pi-native-preset/oracle-model');
    expect(defs.oracle?.tools).toEqual(['read', 'grep']);
  });

  test('accepts thinking from shared JSON agent config', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        oracle: {
          model: 'runtime/oracle-model',
          thinking: 'high',
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('runtime/oracle-model');
    expect(defs.oracle?.thinking).toBe('high');
  });

  test('reads blocked agents from merged runtime config', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        fallback: {
          blocked: ['oracle'],
        },
      },
    });

    expect(getRuntimeBlockedAgents('fallback', projectDir)).toEqual(['oracle']);
  });
});
