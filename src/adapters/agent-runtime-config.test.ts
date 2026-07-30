import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDelegationRulesFromConfig,
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
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omo-runtime-agent-config-'),
    );
    homeDir = path.join(tempDir, 'home');
    projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.OPENCODE_CONFIG_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads shared config overrides for built-in subagents', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: { oracle: { model: 'custom/oracle', tools: ['read'] } },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.oracle?.model).toBe('custom/oracle');
    expect(defs.oracle?.tools).toEqual(['read']);
    expect(defs.oracle?.type).toBe('subagent');
  });

  test('does not merge preset model packs into role definitions', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      preset: 'review',
      presets: {
        review: { oracle: 'preset/oracle', subagent: 'preset/sub' },
      },
      agents: {
        oracle: { tools: ['read'] },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    // Presets no longer supply agent.model/tools via merge.
    expect(defs.oracle?.model).toBeUndefined();
    expect(defs.oracle?.tools).toEqual(['read']);
  });

  test('keeps valid Pi-native config as a fallback source', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      agents: { fixer: { model: 'native/fixer' } },
    });

    expect(loadRuntimeAgentDefinitions(projectDir).fixer?.model).toBe(
      'native/fixer',
    );
  });

  test('rejects removed mode and workflow configuration from Pi-native config', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      workflows: { list: [] },
      agents: { legacy: { type: 'mode', pipelineMode: true } },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.legacy).toBeUndefined();
    expect(defs.main?.type).toBe('main');
  });

  test('preserves custom subagents with an explicit prompt and model', () => {
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        reviewer: {
          type: 'subagent',
          model: 'custom/reviewer',
          prompt: 'Review the supplied patch.',
          tools: ['read'],
        },
      },
    });

    const defs = loadRuntimeAgentDefinitions(projectDir);

    expect(defs.reviewer).toMatchObject({
      type: 'subagent',
      model: 'custom/reviewer',
      tools: ['read'],
    });
  });

  test('loads and overrides named tool groups from all config sources', () => {
    writeJson(path.join(homeDir, '.pi', 'agent', 'oh-my-opencode-slim.json'), {
      _tool_groups: { shared: ['grep'], nativeOnly: ['read'] },
    });
    writeJson(path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'), {
      _tool_groups: { shared: ['write'], projectOnly: ['edit'] },
    });

    const groups = loadRuntimeToolGroups(projectDir);

    expect(groups.shared).toEqual(['write']);
    expect(groups.nativeOnly).toEqual(['read']);
    expect(groups.projectOnly).toEqual(['edit']);
  });

  test('builds delegate rules from the main session definition', () => {
    const rules = getDelegationRulesFromConfig(projectDir);

    expect(rules.main).toEqual(['search', 'fixer', 'oracle']);
    expect(rules.oracle).toEqual([]);
  });
});
