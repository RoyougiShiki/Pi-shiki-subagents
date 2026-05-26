import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import {
  AgentOverrideConfigSchema,
  CouncilConfigSchema,
  DEFAULT_DISABLED_AGENTS,
  PluginConfigSchema,
  SUBAGENT_NAMES,
} from '../config';
import {
  createAgents,
  getAgentConfigs,
  getDisabledAgents,
  getEnabledAgentNames,
  isSubagent,
} from './index';

describe('agent alias backward compatibility', () => {
  test("applies 'frontend-ui-ux-engineer' config to 'designer' agent", () => {
    const config: PluginConfig = {
      agents: {
        'frontend-ui-ux-engineer': { model: 'test/old-frontend-model' },
      },
    };
    const agents = createAgents(config);
    const designer = agents.find((a) => a.name === 'designer');
    expect(designer).toBeDefined();
    expect(designer?.config.model).toBe('test/old-frontend-model');
  });

  test('new agent names work directly', () => {
    const config: PluginConfig = {
      agents: {
        designer: { model: 'direct-designer' },
      },
    };
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === 'designer')?.config.model).toBe(
      'direct-designer',
    );
  });

});

describe('fixer agent fallback', () => {
  test('fixer uses its own model when explicitly configured', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'librarian-model' },
        fixer: { model: 'fixer-specific-model' },
      },
    };
    const agents = createAgents(config);
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer?.config.model).toBe('fixer-specific-model');
  });
});

describe('orchestrator agent', () => {
  test('orchestrator is first in agents array', () => {
    const agents = createAgents();
    expect(agents[0].name).toBe('orchestrator');
  });

  test('orchestrator has question permission set to allow', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.permission).toBeDefined();
    expect((orchestrator?.config.permission as any).question).toBe('allow');
  });

  test('orchestrator is denied access to council_session', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect((orchestrator?.config.permission as any).council_session).toBe(
      'deny',
    );
  });

  test('orchestrator accepts overrides', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { model: 'custom-orchestrator-model', temperature: 0.3 },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.model).toBe('custom-orchestrator-model');
    expect(orchestrator?.config.temperature).toBe(0.3);
  });

  test('orchestrator accepts variant override', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { variant: 'high' },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.variant).toBe('high');
  });

  test('orchestrator stores model array with per-model variants in _modelArray', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: {
          model: [
            { id: 'google/gemini-3-pro', variant: 'high' },
            { id: 'github-copilot/claude-3.5-haiku' },
            'openai/gpt-4',
          ],
        },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?._modelArray).toEqual([
      { id: 'google/gemini-3-pro', variant: 'high' },
      { id: 'github-copilot/claude-3.5-haiku' },
      { id: 'openai/gpt-4' },
    ]);
    expect(orchestrator?.config.model).toBeUndefined();
  });
});

describe('per-model variant in array config', () => {
  test('subagent stores model array with per-model variants', () => {
    const config: PluginConfig = {
      agents: {
        search: {
          model: [
            { id: 'google/gemini-3-flash', variant: 'low' },
            'openai/gpt-4o-mini',
          ],
        },
      },
    };
    const agents = createAgents(config);
    const search = agents.find((a) => a.name === 'search');
    expect(search?._modelArray).toEqual([
      { id: 'google/gemini-3-flash', variant: 'low' },
      { id: 'openai/gpt-4o-mini' },
    ]);
    expect(search?.config.model).toBeUndefined();
  });

  test('top-level variant preserved alongside per-model variants', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: {
          model: [
            { id: 'google/gemini-3-pro', variant: 'high' },
            'openai/gpt-4',
          ],
          variant: 'low',
        },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    // top-level variant still set as default
    expect(orchestrator?.config.variant).toBe('low');
    // per-model variants stored in _modelArray
    expect(orchestrator?._modelArray?.[0]?.variant).toBe('high');
    expect(orchestrator?._modelArray?.[1]?.variant).toBeUndefined();
  });
});

describe('skill permissions', () => {
  test('orchestrator gets codemap skill allowed by default', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator).toBeDefined();
    const skillPerm = (
      orchestrator?.config.permission as Record<string, unknown>
    )?.skill as Record<string, string>;
    // orchestrator gets wildcard allow (from RECOMMENDED_SKILLS wildcard entry)
    expect(skillPerm?.['*']).toBe('allow');
    // CUSTOM_SKILLS loop must also add a named codemap entry for orchestrator
    expect(skillPerm?.codemap).toBe('allow');
  });

  test('fixer does not get codemap skill allowed by default', () => {
    const agents = createAgents();
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer).toBeDefined();
    const skillPerm = (fixer?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.codemap).not.toBe('allow');
  });

  test('oracle gets requesting-code-review skill allowed by default', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.['requesting-code-review']).toBe('allow');
  });

  test('oracle gets simplify skill allowed by default', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.simplify).toBe('allow');
  });
});

describe('tool permissions', () => {
  test('council agent is allowed to invoke council_session', () => {
    const agents = createAgents();
    const council = agents.find((a) => a.name === 'council');
    expect((council?.config.permission as any).council_session).toBe('allow');
  });

  test('oracle is denied access to council_session', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect((oracle?.config.permission as any).council_session).toBe('deny');
  });



  test('councillor is denied access to council_session', () => {
    const agents = createAgents();
    const councillor = agents.find((a) => a.name === 'councillor');
    expect((councillor?.config.permission as any).council_session).toBe('deny');
  });
});

describe('isSubagent type guard', () => {
  test('returns true for valid subagent names', () => {
    expect(isSubagent('oracle')).toBe(true);
    expect(isSubagent('designer')).toBe(true);
    expect(isSubagent('fixer')).toBe(true);
  });

  test('returns false for orchestrator', () => {
    expect(isSubagent('orchestrator')).toBe(false);
  });

  test('returns false for invalid agent names', () => {
    expect(isSubagent('invalid-agent')).toBe(false);
    expect(isSubagent('')).toBe(false);

  });
});

describe('agent classification', () => {
  test('SUBAGENT_NAMES excludes orchestrator', () => {
    expect(SUBAGENT_NAMES).not.toContain('orchestrator');
    expect(SUBAGENT_NAMES).toContain('search');
    expect(SUBAGENT_NAMES).toContain('fixer');
  });

  test('getAgentConfigs applies correct classification visibility and mode', () => {
    // Enable all agents (including observer) for classification testing
    const configs = getAgentConfigs({ disabled_agents: [] });

    // Primary agent
    expect(configs.orchestrator.mode).toBe('primary');

    // Subagents
    for (const name of SUBAGENT_NAMES) {
      // Council is a dual-mode agent ("all"), rest are subagents
      if (name === 'council') {
        expect(configs[name].mode).toBe('all');
      } else {
        expect(configs[name].mode).toBe('subagent');
      }
    }
  });
});

describe('createAgents', () => {
  test('creates all agents without config', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('designer');
    expect(names).toContain('oracle');
    expect(names).toContain('fixer');
  });

  test('creates exactly 8 agents by default (1 orchestrator + 7 subagents, all enabled)', () => {
    const agents = createAgents();
    expect(agents.length).toBe(8);
  });
});

describe('getAgentConfigs', () => {
  test('returns config record keyed by agent name', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator).toBeDefined();
    expect(configs.search).toBeDefined();
    expect(configs.search.model).toBeDefined();
  });

  test('includes description in SDK config', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator.description).toBeDefined();
    expect(configs.search.description).toBeDefined();
  });
});

describe('council agent model resolution', () => {
  test('council agent uses default model', () => {
    const agents = createAgents();
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('openai/gpt-4o-mini');
  });

  test('councillor agent uses default model', () => {
    const agents = createAgents();
    const councillor = agents.find((a) => a.name === 'councillor');
    expect(councillor?.config.model).toBe('openai/gpt-4o-mini');
  });

  test('council uses default model when no preset override', () => {
    const config: PluginConfig = {
      council: {
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
        },
      },
    };
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('openai/gpt-4o-mini');
  });

  test('council preset override takes precedence', () => {
    const config: PluginConfig = {
      agents: {
        council: { model: 'google/gemini-3-pro' },
      },
      council: {
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
        },
        _legacyMasterModel: 'anthropic/claude-opus-4-6',
      },
    };
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('google/gemini-3-pro');
  });

  test('council uses default when no legacy master and no preset override', () => {
    // No legacy master, no preset override → standard default
    const config: PluginConfig = {
      council: {
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
        },
      },
    };
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('openai/gpt-4o-mini');
  });

  test('council uses default model when no preset override', () => {
    const config: PluginConfig = {
      council: {
        _legacyMasterModel: undefined,
        presets: { default: { alpha: { model: 'openai/gpt-5.4-mini' } } },
      },
    };
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('openai/gpt-4o-mini');
  });
});

describe('options passthrough', () => {
  test('options are applied to agent config via overrides', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          options: { textVerbosity: 'low' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toEqual({ textVerbosity: 'low' });
  });

  test('options with nested objects are passed through', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'anthropic/claude-sonnet-4-6',
          options: {
            thinking: { type: 'enabled', budgetTokens: 16000 },
          },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16000 },
    });
  });

  test('options work with other overrides', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          variant: 'high',
          temperature: 0.7,
          options: { textVerbosity: 'low', reasoningEffort: 'medium' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.model).toBe('openai/gpt-5.5');
    expect(oracle?.config.variant).toBe('high');
    expect(oracle?.config.temperature).toBe(0.7);
    expect(oracle?.config.options).toEqual({
      textVerbosity: 'low',
      reasoningEffort: 'medium',
    });
  });

  test('options are absent when not configured', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { model: 'openai/gpt-5.5' },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toBeUndefined();
  });

  test('options flow through getAgentConfigs to SDK output', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          options: { textVerbosity: 'low' },
        },
      },
    };
    const configs = getAgentConfigs(config);
    expect(configs.oracle.options).toEqual({ textVerbosity: 'low' });
  });

  test('options are shallow-merged with existing agent config options', () => {
    // Simulate an agent factory setting default options
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          options: { reasoningEffort: 'medium' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    // Override options should merge with (not replace) any factory defaults
    expect(oracle?.config.options).toEqual({ reasoningEffort: 'medium' });
  });
});

describe('AgentOverrideConfigSchema options validation', () => {
  test('accepts valid options object', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: { textVerbosity: 'low' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts empty options object', () => {
    const result = AgentOverrideConfigSchema.safeParse({ options: {} });
    expect(result.success).toBe(true);
  });

  test('accepts nested values in options', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: {
        thinking: { type: 'enabled', budgetTokens: 16000 },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts options alongside other fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      variant: 'high',
      temperature: 0.7,
      options: { textVerbosity: 'low' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual({ textVerbosity: 'low' });
    }
  });

  test('config without options is valid', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toBeUndefined();
    }
  });

  test('rejects non-object options', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: 'not-an-object',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty model arrays', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: [],
    });
    expect(result.success).toBe(false);
  });

  test('accepts prompt and orchestratorPrompt override fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      prompt: 'You are a specialized reviewer.',
      orchestratorPrompt: '@reviewer\n- Role: Specialized reviewer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBe('You are a specialized reviewer.');
      expect(result.data.orchestratorPrompt).toBe(
        '@reviewer\n- Role: Specialized reviewer',
      );
    }
  });

  test('rejects empty prompt fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      prompt: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty orchestratorPrompt fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      orchestratorPrompt: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects description field on overrides', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      description: 'not supported for custom agents',
    } as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('PluginConfigSchema custom-agent-only prompt fields', () => {
  test('rejects prompt on built-in top-level agent overrides', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          prompt: 'ignored built-in prompt override',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects orchestratorPrompt on built-in top-level agent overrides', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        search: {
          model: 'openai/gpt-5.4-mini',
          orchestratorPrompt: '@fixer\n- Role: should be invalid here',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects custom-only prompt fields on built-in preset agents', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        openai: {
          oracle: {
            model: 'openai/gpt-5.5',
            prompt: 'ignored preset built-in prompt override',
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('allows prompt fields on custom agents', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        janitor: {
          model: 'openai/gpt-5.4-mini',
          prompt: 'You are Janitor.',
          orchestratorPrompt: '@janitor\n- Role: Cleanup specialist',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('accepts sessionManager config', () => {
    const result = PluginConfigSchema.safeParse({
      sessionManager: {
        maxSessionsPerAgent: 2,
        readContextMinLines: 10,
        readContextMaxFiles: 8,
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('disabled_agents', () => {
  test('disabled agents are not created', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer', 'fixer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('designer');
    expect(names).not.toContain('fixer');
    expect(names).toContain('orchestrator');
    expect(names).toContain('oracle');
  });

  test('protected agents cannot be disabled', () => {
    const config: PluginConfig = {
      disabled_agents: ['orchestrator', 'councillor'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('councillor');
  });

  test('disabling council disables council agent', () => {
    const config: PluginConfig = {
      disabled_agents: ['council'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('council');
    // councillor is protected, it stays
    expect(names).toContain('councillor');
  });

  test('agent count decreases when agents are disabled', () => {
    const agents = createAgents();
    expect(agents.length).toBe(8); // 1 + 7 (all enabled by default)

    const disabledConfig: PluginConfig = {
      disabled_agents: ['observer', 'designer'],
    };
    const disabledAgents = createAgents(disabledConfig);
    expect(disabledAgents.length).toBe(6);
  });

  test('getDisabledAgents respects protection rules', () => {
    const config: PluginConfig = {
      disabled_agents: ['orchestrator', 'designer', 'councillor'],
    };
    const disabled = getDisabledAgents(config);
    expect(disabled.has('designer')).toBe(true);
    expect(disabled.has('orchestrator')).toBe(false);
    expect(disabled.has('councillor')).toBe(false);
  });

  test('getEnabledAgentNames filters correctly', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer', 'fixer'],
    };
    const enabled = getEnabledAgentNames(config);
    expect(enabled).not.toContain('designer');
    expect(enabled).not.toContain('fixer');
    expect(enabled).toContain('orchestrator');
  });

  test('getEnabledAgentNames includes enabled custom agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['janitor'],
      agents: {
        janitor: { model: 'openai/gpt-5.4-mini' },
        reviewer: { model: 'openai/gpt-5.4-mini' },
      },
    };

    const enabled = getEnabledAgentNames(config);
    expect(enabled).toContain('reviewer');
    expect(enabled).not.toContain('janitor');
  });

  test('empty disabled_agents creates all agents including observer', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(config);
    expect(agents.length).toBe(8);
    expect(agents.map((a) => a.name)).toContain('observer');
  });
});

describe('observer agent', () => {
  test('observer is enabled by default', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
  });

  test('observer is enabled when empty disabled_agents', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
  });

  test('observer is disabled when explicitly listed', () => {
    const config: PluginConfig = {
      disabled_agents: ['observer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('observer');
  });

  test('observer can be enabled alongside other disabled agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
    expect(names).not.toContain('designer');
  });

  test('DEFAULT_DISABLED_AGENTS is empty', () => {
    expect(DEFAULT_DISABLED_AGENTS).toEqual([]);
  });
});
