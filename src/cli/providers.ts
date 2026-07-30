import type { InstallConfig } from './types';

const SCHEMA_URL =
  'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json';

/** Empty preset packs: role subagents follow the current main model. */
function createEmptyPreset(): Record<string, never> {
  return {};
}

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    preset: '省钱模式',
    presets: {
      省钱模式: createEmptyPreset(),
      性能模式: createEmptyPreset(),
    },
  };

  void installConfig;
  return config;
}
