import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRuntimeAgentDefinitions,
  loadRuntimeToolGroups,
} from './agent-runtime-config';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('runtime agent config', () => {
  let tempDir: string;
  let homeDir: string;
  let projectDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-runtime-agent-config-'));
    homeDir = path.join(tempDir, 'home');
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.HOME = homeDir;
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

  test('does not expose known internal config keys as runtime agents', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      agents: {
        _tool_groups: {
          custom: ['read'],
        },
        _private_reviewer: {
          model: 'custom/private-reviewer',
          tools: ['read'],
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs._tool_groups).toBeUndefined();
    expect(Object.keys(defs)).not.toContain('_tool_groups');
    expect(defs._private_reviewer?.model).toBe('custom/private-reviewer');
    expect(defs._private_reviewer?.tools).toEqual(['read']);
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
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
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
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
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

  test('parses Pi native runtime .jsonc config with comments and trailing commas', () => {
    fs.mkdirSync(path.join(homeDir, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.jsonc'),
      `{
        // native config comment
        "agents": {
          "oracle": { "model": "pi-native/jsonc-model", },
        },
      }`,
    );

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('pi-native/jsonc-model');
  });

  test('loads runtime tool groups from defaults, Pi native config, and shared config', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      _tool_groups: {
        custom: ['read'],
        shared: ['grep'],
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      _tool_groups: {
        shared: ['write'],
        projectOnly: ['edit'],
      },
    });

    const groups = loadRuntimeToolGroups(projectDir);

    const defaultSubagentGroupName = '子代理';
    const subagentToolGroup = groups[defaultSubagentGroupName];
    expect(subagentToolGroup).toContain('omo_subagent');
    expect(groups.custom).toEqual(['read']);
    expect(groups.shared).toEqual(['write']);
    expect(groups.projectOnly).toEqual(['edit']);
  });

  test('empty runtime tool groups override lower-priority groups', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      _tool_groups: {
        shared: ['grep'],
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      _tool_groups: {
        shared: [],
      },
    });

    const groups = loadRuntimeToolGroups(projectDir);

    expect(groups.shared).toEqual([]);
  });

  test('accepts roles from shared JSON agent config', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        customReviewer: {
          type: 'subagent',
          roles: ['review'],
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.customReviewer?.roles).toEqual(['review']);
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

});
