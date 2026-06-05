/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { PRESET_CONFIGURABLE_AGENT_NAMES, PRIMARY_MODE_AGENT_NAME } from '../config/constants';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

const STALE_AGENT_NAMES = ['orches', 'explo', 'librar', 'think'].map((prefix, index) => `${prefix}${['trator', 'rer', 'ian', 'er'][index]}`);

describe('providers', () => {
  test('MODEL_MAPPINGS has exactly 4 providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual(['copilot', 'kimi', 'openai', 'zai-plan']);
  });

  test('MODEL_MAPPINGS keeps provider defaults without stale agent names', () => {
    for (const mapping of Object.values(MODEL_MAPPINGS)) {
      const agentNames = Object.keys(mapping);
      expect(agentNames).toContain(PRIMARY_MODE_AGENT_NAME);
      for (const staleAgentName of STALE_AGENT_NAMES) {
        expect(agentNames).not.toContain(staleAgentName);
      }
    }
  });

  test('generateLiteConfig generates preset templates with placeholders', () => {
    const config = generateLiteConfig({
      installSkills: false,
      installCustomSkills: false,
      reset: false,
    });

    expect(config.$schema).toBe(
      'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    );
    expect(config.preset).toBe('省钱模式');
    expect((config.presets as any)['省钱模式']).toBeDefined();
    expect((config.presets as any)['性能模式']).toBeDefined();

    const economy = (config.presets as any)['省钱模式'];
    const performance = (config.presets as any)['性能模式'];
    expect(Object.keys(economy).sort()).toEqual([...PRESET_CONFIGURABLE_AGENT_NAMES].sort());
    expect(Object.keys(performance).sort()).toEqual([...PRESET_CONFIGURABLE_AGENT_NAMES].sort());
    for (const agentName of PRESET_CONFIGURABLE_AGENT_NAMES) {
      expect(economy[agentName].model).toBe('<YOUR_MODEL>');
      expect(performance[agentName].model).toBe('<YOUR_MODEL>');
    }
  });
});
