/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { readDefaultAgentDefinitions } from '../adapters/default-agent-assets';
import {
  PRESET_MODEL_SLOT_NAMES,
  PRIMARY_AGENT_NAME,
} from '../config/constants';
import { generateLiteConfig } from './providers';

describe('providers', () => {
  test('generates empty named preset shells for follow-main defaults', () => {
    const config = generateLiteConfig({ installSkills: false, reset: false });
    const economy = (config.presets as any)['省钱模式'];
    const performance = (config.presets as any)['性能模式'];

    expect(config.preset).toBe('省钱模式');
    expect(economy).toEqual({});
    expect(performance).toEqual({});
    expect(readDefaultAgentDefinitions()[PRIMARY_AGENT_NAME]?.type).toBe(
      'main',
    );
    expect(PRESET_MODEL_SLOT_NAMES).toEqual(
      expect.arrayContaining(['subagent', 'fixer', 'oracle', 'search']),
    );
    expect(PRESET_MODEL_SLOT_NAMES).not.toEqual(
      expect.arrayContaining(['main', 'council']),
    );
  });
});
