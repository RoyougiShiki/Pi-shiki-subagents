import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentPrompt, loadPluginConfig } from './loader';

// Test deepMerge indirectly through loadPluginConfig behavior
// since deepMerge is not exported

describe('loadPluginConfig', () => {
  let tempDir: string;
  let userConfigDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
    userConfigDir = path.join(tempDir, 'user-config');
    originalEnv = { ...process.env };
    // Isolate from real user config
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = userConfigDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('returns empty config when no config files exist', () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const config = loadPluginConfig(projectDir);
    expect(config).toEqual({});
  });

  test('loads project config from .opencode directory', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'test/model' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test/model');
  });

  test('loads scoringEngineVersion flag when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        scoringEngineVersion: 'v2-shadow',
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.scoringEngineVersion).toBe('v2-shadow');
  });

  test('loads balanceProviderUsage flag when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        balanceProviderUsage: true,
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.balanceProviderUsage).toBe(true);
  });

  test('loads showStartupToast flag when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        showStartupToast: false,
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.showStartupToast).toBe(false);
  });

  test('loads autoUpdate flag when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: false,
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.autoUpdate).toBe(false);
  });

  test('loads manual plan structure when configured', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        manualPlan: {
          main: {
            primary: 'openai/gpt-5.5',
            fallback1: 'anthropic/claude-opus-4-6',
            fallback2: 'chutes/kimi-k2.5',
            fallback3: 'opencode/gpt-5-nano',
          },
          oracle: {
            primary: 'openai/gpt-5.5',
            fallback1: 'anthropic/claude-opus-4-6',
            fallback2: 'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
            fallback3: 'opencode/gpt-5-nano',
          },
          'project-planner': {
            primary: 'openai/gpt-5.5',
            fallback1: 'anthropic/claude-opus-4-6',
            fallback2: 'chutes/kimi-k2.5',
            fallback3: 'opencode/gpt-5-nano',
          },
          observer: {
            primary: 'openai/gpt-5.5',
            fallback1: 'anthropic/claude-opus-4-6',
            fallback2: 'chutes/kimi-k2.5',
            fallback3: 'opencode/gpt-5-nano',
          },
          fixer: {
            primary: 'openai/gpt-5.5',
            fallback1: 'anthropic/claude-opus-4-6',
            fallback2: 'chutes/kimi-k2.5',
            fallback3: 'opencode/gpt-5-nano',
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.manualPlan?.oracle?.fallback2).toBe(
      'chutes/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8-TEE',
    );
  });

  test('loads and merges tool groups from user and project config', () => {
    const defaultConfigDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(defaultConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        _tool_groups: {
          shared: ['read'],
          userOnly: ['grep'],
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        _tool_groups: {
          shared: ['write'],
          projectOnly: ['edit'],
        },
      }),
    );

    const config = loadPluginConfig(projectDir);

    expect(config._tool_groups).toEqual({
      shared: ['write'],
      userOnly: ['grep'],
      projectOnly: ['edit'],
    });
  });

  test('ignores invalid config (schema violation or malformed JSON)', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Test 1: Invalid temperature (out of range)
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
    );
    expect(loadPluginConfig(projectDir)).toEqual({});

    // Test 2: Malformed JSON
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );
    expect(loadPluginConfig(projectDir)).toEqual({});
  });

  test('quiet mode suppresses invalid config warnings', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
    );

    const consoleWarnSpy = spyOn(console, 'warn');
    try {
      expect(loadPluginConfig(projectDir, { quiet: true })).toEqual({});
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  test('rejects custom-only prompt fields on built-in agents in config files', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: {
            model: 'openai/gpt-5.5',
            prompt: 'This should be rejected for built-in agents.',
          },
        },
      }),
    );

    expect(loadPluginConfig(projectDir)).toEqual({});
  });

  test('respects OPENCODE_CONFIG_DIR for user config location', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-opencode-config-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    // Write plugin config in the custom directory
    fs.writeFileSync(
      path.join(customDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'custom/model-from-opencode-config-dir' } },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe(
      'custom/model-from-opencode-config-dir',
    );

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  test('falls back to default user config dir when OPENCODE_CONFIG_DIR has no config', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-opencode-config-empty-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const defaultConfigDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(defaultConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'fallback/default-config' } },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('fallback/default-config');

    fs.rmSync(customDir, { recursive: true, force: true });
  });
});

describe('deepMerge behavior', () => {
  let tempDir: string;
  let userConfigDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
    userConfigDir = path.join(tempDir, 'user-config');
    originalEnv = { ...process.env };

    // Set XDG_CONFIG_HOME to control user config location
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = userConfigDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('merges nested agent configs from user and project', () => {
    // Create user config
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'user/oracle-model', temperature: 0.5 },
          observer: { model: 'user/observer-model' },
        },
      }),
    );

    // Create project config (should override/merge with user)
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { temperature: 0.8 }, // Override temperature only
          'project-planner': { model: 'project/planner-model' }, // Add new agent
        },
      }),
    );

    const config = loadPluginConfig(projectDir);

    // oracle: model from user, temperature from project
    expect(config.agents?.oracle?.model).toBe('user/oracle-model');
    expect(config.agents?.oracle?.temperature).toBe(0.8);

    // observer: from user only
    expect(config.agents?.observer?.model).toBe('user/observer-model');

    // project-planner: from project only
    expect(config.agents?.['project-planner']?.model).toBe(
      'project/planner-model',
    );
  });

  test('project config overrides top-level arrays', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: ['websearch'],
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        disabled_mcps: ['context7'],
      }),
    );

    const config = loadPluginConfig(projectDir);

    // disabled_mcps should be from project (overwrites, not merges)
    expect(config.disabled_mcps).toEqual(['context7']);
  });

  test('handles missing user config gracefully', () => {
    // Don't create user config, only project
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'project/model' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('project/model');
  });

  test('handles missing project config gracefully', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'user/model' },
        },
      }),
    );

    // No project config
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('user/model');
  });

  test('merges fallback timeout and chains from user and project', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          timeoutMs: 15000,
          chains: {
            oracle: ['openai/gpt-5.5', 'opencode/glm-4.7-free'],
          },
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          chains: {
            observer: ['google/antigravity-gemini-3-flash'],
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.fallback?.timeoutMs).toBe(15000);
    expect(config.fallback?.chains.oracle).toEqual([
      'openai/gpt-5.5',
      'opencode/glm-4.7-free',
    ]);
    expect(config.fallback?.chains.observer).toEqual([
      'google/antigravity-gemini-3-flash',
    ]);
  });

  test('preserves fallback chains with current agent keys', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        fallback: {
          chains: {
            search: ['openai/gpt-5.5'],
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.fallback?.chains.search).toEqual(['openai/gpt-5.5']);
  });

  test('merges harness config from user and project', () => {
    const userOpencodeDir = path.join(userConfigDir, 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        harness: {
          // legacy field should not break loading
          completionAuditor: {
            blockOnUnverifiedModification: true,
          },
          toolResultBudget: {
            thresholds: {
              default: 1000,
              byTool: { bash: 2000 },
            },
          },
          messages: {
            verificationEvidence: {
              toolFailedWithoutRecovery: 'USER_TOOL_FAIL',
            },
          },
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        harness: {
          toolResultBudget: {
            thresholds: {
              byTool: { grep: 3000 },
            },
            previewChars: 120,
          },
          messages: {
            verificationEvidence: {
              subagentPending: 'PROJECT_SUBAGENT',
            },
          },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.harness?.toolResultBudget?.thresholds?.default).toBe(1000);
    expect(config.harness?.toolResultBudget?.thresholds?.byTool?.bash).toBe(
      2000,
    );
    expect(config.harness?.toolResultBudget?.thresholds?.byTool?.grep).toBe(
      3000,
    );
    expect(config.harness?.toolResultBudget?.previewChars).toBe(120);
    expect(
      config.harness?.messages?.verificationEvidence?.toolFailedWithoutRecovery,
    ).toBe('USER_TOOL_FAIL');
    expect(
      config.harness?.messages?.verificationEvidence?.subagentPending,
    ).toBe('PROJECT_SUBAGENT');
  });
});

describe('preset resolution', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('backward compatibility: config with only agents works unchanged', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { model: 'direct-model' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('direct-model');
    expect(config.preset).toBeUndefined();
  });

  test('loads string preset packs without merging into agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'fast',
        presets: {
          fast: { oracle: 'fast-model/x', subagent: 'sub/model' },
        },
        agents: { oracle: { temperature: 0.2 } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('fast');
    expect(config.presets?.fast).toEqual({
      oracle: 'fast-model/x',
      subagent: 'sub/model',
    });
    expect(config.agents?.oracle?.model).toBeUndefined();
    expect(config.agents?.oracle?.temperature).toBe(0.2);
  });

  test('rejects legacy object-shaped preset agent entries', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'fast',
        presets: {
          fast: { oracle: { model: 'fast-model' } },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.presets).toBeUndefined();
    expect(config.agents?.oracle?.model).toBeUndefined();
  });

  test('rejects main/council keys inside presets', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          bad: { main: 'a/b', council: 'c/d' },
        },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.presets).toBeUndefined();
  });

  test('missing preset name warns and keeps root agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: {
          other: { oracle: 'other/model' },
        },
        agents: { oracle: { model: 'root/model' } },
      }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('nonexistent');
    expect(config.agents?.oracle?.model).toBe('root/model');
    expect(config.presets?.other?.oracle).toBe('other/model');
  });
});

describe('environment variable preset override', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-env-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('Env var overrides preset name from config file without merging agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'file-preset',
        presets: {
          'file-preset': { subagent: 'file/model' },
          'env-preset': { subagent: 'env/model' },
        },
        agents: { oracle: { model: 'root/model' } },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-preset';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('env-preset');
    expect(config.presets?.['env-preset']?.subagent).toBe('env/model');
    expect(config.agents?.oracle?.model).toBe('root/model');
  });

  test('Env var works when config has no preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          'env-preset': { oracle: 'env/oracle' },
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-preset';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('env-preset');
    expect(config.presets?.['env-preset']?.oracle).toBe('env/oracle');
  });

  test('Env var is ignored if empty string', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'file-preset',
        presets: {
          'file-preset': {},
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = '';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('file-preset');
  });

  test('Env var with nonexistent preset warns and keeps agents', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          other: { subagent: 'other/model' },
        },
        agents: { fixer: { model: 'root/fixer' } },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'missing';
    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('missing');
    expect(config.agents?.fixer?.model).toBe('root/fixer');
  });
});

describe('JSONC config support', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonc-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('loads .jsonc file with single-line comments', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // This is a comment
        "agents": {
          "oracle": { "model": "test/model" } // inline comment
        }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test/model');
  });

  test('loads .jsonc file with multi-line comments', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        /* Multi-line
           comment block */
        "agents": {
          "observer": { "model": "observer-model" }
        }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.observer?.model).toBe('observer-model');
  });

  test('loads .jsonc file with trailing commas', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        "agents": {
          "oracle": { "model": "test-model", },
        },
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('test-model');
  });

  test('prefers .jsonc over .json when both exist', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Create both files
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'json-model' } } }),
    );
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // JSONC version
        "agents": { "oracle": { "model": "jsonc-model" } }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('jsonc-model');
  });

  test('falls back to .json when .jsonc does not exist', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });

    // Only create .json file
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'json-model' } } }),
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('json-model');
  });

  test('loads user config from .jsonc', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // User config with comments
        "agents": { "fixer": { "model": "user-fixer" } }
      }`,
    );

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.fixer?.model).toBe('user-fixer');
  });

  test('merges user .jsonc with project .jsonc', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // User config
        "agents": {
          "oracle": { "model": "user-oracle", "temperature": 0.5 }
        }
      }`,
    );

    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Project config
        "agents": { "oracle": { "temperature": 0.8 } }
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.agents?.oracle?.model).toBe('user-oracle');
    expect(config.agents?.oracle?.temperature).toBe(0.8);
  });

  test('handles complex JSONC with mixed comments and trailing commas', () => {
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Main configuration
        "preset": "dev",
        /* Presets definition */
        "presets": {
          "dev": {
            // Optional role-subagent model overrides
            "subagent": "provider/dev-sub",
            "oracle": "provider/dev-oracle",
          },
        },
        "agents": {
          "oracle": { "temperature": 0.1 },
        },
      }`,
    );

    const config = loadPluginConfig(projectDir);
    expect(config.preset).toBe('dev');
    expect(config.presets?.dev?.subagent).toBe('provider/dev-sub');
    expect(config.presets?.dev?.oracle).toBe('provider/dev-oracle');
    expect(config.agents?.oracle?.temperature).toBe(0.1);
    expect(config.agents?.oracle?.model).toBeUndefined();
  });
});

describe('loadAgentPrompt', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('returns empty object when no prompt files exist', () => {
    const result = loadAgentPrompt('oracle');
    expect(result).toEqual({});
  });

  test('loads replacement prompt from {agent}.md', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'replacement prompt');

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('replacement prompt');
    expect(result.appendPrompt).toBeUndefined();
  });

  test('loads append prompt from {agent}_append.md', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'append prompt',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBeUndefined();
    expect(result.appendPrompt).toBe('append prompt');
  });

  test('loads both replacement and append prompts', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'replacement prompt');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'append prompt',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('replacement prompt');
    expect(result.appendPrompt).toBe('append prompt');
  });

  test('handles file read errors gracefully', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    const promptPath = path.join(promptsDir, 'error-agent.md');
    fs.writeFileSync(promptPath, 'content');

    const consoleWarnSpy = spyOn(console, 'warn');

    // Use a unique agent name and check for it specifically
    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const [p] = args;
      if (typeof p === 'string' && p.includes('error-agent.md')) {
        throw new Error('Read error');
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const result = loadAgentPrompt('error-agent');
      expect(result.prompt).toBeUndefined();

      const warningFound = consoleWarnSpy.mock.calls.some((call) =>
        (call[0] as string).includes('Error reading prompt file'),
      );
      expect(warningFound).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('prefers preset prompt files over root prompts', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');
    fs.writeFileSync(path.join(presetDir, 'oracle.md'), 'preset replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );
    fs.writeFileSync(
      path.join(presetDir, 'oracle_append.md'),
      'preset append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('preset replacement');
    expect(result.appendPrompt).toBe('preset append prompt');
  });

  test('falls back to root prompt files when preset files are missing', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('root replacement');
    expect(result.appendPrompt).toBe('root append prompt');
  });

  test('falls back independently between preset and root files', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });

    fs.writeFileSync(path.join(presetDir, 'oracle.md'), 'preset replacement');
    fs.writeFileSync(
      path.join(promptsDir, 'oracle_append.md'),
      'root append prompt',
    );

    const result = loadAgentPrompt('oracle', 'test');
    expect(result.prompt).toBe('preset replacement');
    expect(result.appendPrompt).toBe('root append prompt');
  });

  test('ignores unsafe preset names for prompt lookup', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');

    const result = loadAgentPrompt('oracle', '../test');
    expect(result.prompt).toBe('root replacement');
    expect(result.appendPrompt).toBeUndefined();
  });

  test('falls back to root when preset prompt file read fails', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    const presetDir = path.join(promptsDir, 'test');
    fs.mkdirSync(presetDir, { recursive: true });
    const presetPromptPath = path.join(presetDir, 'oracle.md');
    fs.writeFileSync(presetPromptPath, 'preset replacement');
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'root replacement');

    const consoleWarnSpy = spyOn(console, 'warn');
    const originalReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const [p] = args;
      if (typeof p === 'string' && p === presetPromptPath) {
        throw new Error('Preset read error');
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const result = loadAgentPrompt('oracle', 'test');
      expect(result.prompt).toBe('root replacement');
      expect(consoleWarnSpy).toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test('works with XDG_CONFIG_HOME environment variable', () => {
    const customConfigHome = path.join(tempDir, 'custom-xdg');
    process.env.XDG_CONFIG_HOME = customConfigHome;

    const promptsDir = path.join(
      customConfigHome,
      'opencode',
      'oh-my-opencode-slim',
    );
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'xdg-agent.md'), 'xdg prompt');

    const result = loadAgentPrompt('xdg-agent');
    expect(result.prompt).toBe('xdg prompt');
  });

  test('respects OPENCODE_CONFIG_DIR for prompt location', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-prompt-config-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(customDir, 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'oracle.md'),
      'prompt from OPENCODE_CONFIG_DIR dir',
    );

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('prompt from OPENCODE_CONFIG_DIR dir');

    fs.rmSync(customDir, { recursive: true, force: true });
  });

  test('falls back to default prompt dir when OPENCODE_CONFIG_DIR has no prompt', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omc-prompt-config-empty-'),
    );
    process.env.OPENCODE_CONFIG_DIR = customDir;

    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'oracle.md'), 'fallback prompt');

    const result = loadAgentPrompt('oracle');
    expect(result.prompt).toBe('fallback prompt');

    fs.rmSync(customDir, { recursive: true, force: true });
  });
});
