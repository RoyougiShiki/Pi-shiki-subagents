/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig } from './providers';
import { PRESET_CONFIGURABLE_AGENT_NAMES } from '../config/constants';

describe('providers', () => {

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
