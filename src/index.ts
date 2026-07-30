export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  PluginConfig,
} from './config';

/**
 * Legacy OpenCode plugin entrypoint.
 *
 * The maintained runtime is now exposed through package.json `pi.extensions`.
 * This default export remains only to keep the package main importable while
 * the legacy OpenCode adapter is being removed.
 */
export default function legacyOpenCodeAdapterRemoved(): Record<string, never> {
  console.warn(
    '[oh-my-opencode-slim] Legacy OpenCode adapter has been removed. Use the Pi extensions declared in package.json.',
  );
  return {};
}
