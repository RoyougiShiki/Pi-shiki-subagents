import { MODEL_PLACEHOLDER, PRESET_CONFIGURABLE_AGENT_NAMES } from '../config/constants';
import type { InstallConfig } from './types';

const SCHEMA_URL =
  'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json';


function createPlaceholderPreset(): Record<string, { model: string }> {
  return Object.fromEntries(
    PRESET_CONFIGURABLE_AGENT_NAMES.map((agentName) => [
      agentName,
      { model: MODEL_PLACEHOLDER },
    ]),
  );
}

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    preset: '省钱模式',
    presets: {
      '省钱模式': createPlaceholderPreset(),
      '性能模式': createPlaceholderPreset(),
    },
  };

  void installConfig;
  return config;
}
