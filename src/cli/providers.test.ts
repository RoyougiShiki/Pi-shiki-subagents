/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { readDefaultAgentDefinitions } from '../adapters/default-agent-assets';
import {
  MODEL_PLACEHOLDER,
  PRESET_CONFIGURABLE_AGENT_NAMES,
  PRIMARY_MODE_AGENT_NAME,
} from '../config/constants';
import { generateLiteConfig } from './providers';

describe('providers', () => {
  test('generateLiteConfig generates preset templates with placeholders', () => {
    const config = generateLiteConfig({
      installSkills: false,
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
    const primaryModes = Object.entries(readDefaultAgentDefinitions())
      .filter(
        ([, definition]) =>
          definition?.presetPrimary === true &&
          (definition?.type === 'mode' || definition?.type === 'both'),
      )
      .map(([name]) => name);

    expect(primaryModes).toEqual([PRIMARY_MODE_AGENT_NAME]);
    expect(PRESET_CONFIGURABLE_AGENT_NAMES).toContain(PRIMARY_MODE_AGENT_NAME);
    expect(PRESET_CONFIGURABLE_AGENT_NAMES).toContain('fixer');
    expect(PRESET_CONFIGURABLE_AGENT_NAMES).toContain('oracle');
    const nonPrimaryModes = Object.entries(readDefaultAgentDefinitions())
      .filter(([name, definition]) => definition?.type === 'mode' && name !== PRIMARY_MODE_AGENT_NAME)
      .map(([name]) => name);
    for (const modeName of nonPrimaryModes) {
      expect(PRESET_CONFIGURABLE_AGENT_NAMES).not.toContain(modeName);
      expect(Object.keys(economy)).not.toContain(modeName);
      expect(Object.keys(performance)).not.toContain(modeName);
    }
    for (const agentName of PRESET_CONFIGURABLE_AGENT_NAMES) {
      expect(economy[agentName].model).toBe(MODEL_PLACEHOLDER);
      expect(performance[agentName].model).toBe(MODEL_PLACEHOLDER);
    }
  });
});
