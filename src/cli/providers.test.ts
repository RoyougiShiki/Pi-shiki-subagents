/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('MODEL_MAPPINGS has exactly 4 providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual(['copilot', 'kimi', 'openai', 'zai-plan']);
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
    expect(economy['thinker-clarify'].model).toBe('<YOUR_MODEL>');
    expect(economy['thinker-analysis'].model).toBe('<YOUR_MODEL>');
    expect(economy.worker.model).toBe('<YOUR_MODEL>');
    expect(economy.oracle.model).toBe('<YOUR_MODEL>');
  });
});
