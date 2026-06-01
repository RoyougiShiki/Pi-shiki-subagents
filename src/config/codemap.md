# Config Module Codemap

## Responsibility

`src/config/` owns the shared configuration schema and load/merge pipeline used by the maintained Pi adapter and any future platform adapters.

This module is shared infrastructure, not Pi-only. It should not depend on platform-specific runtime code.

## Core Entry Points

- `schema.ts`
  - Defines `PluginConfigSchema` and related config types.
  - Provides `DEFAULT_WORKFLOWS` seed data for config initialization.
- `loader.ts`
  - Loads user/project config.
  - Merges presets and root agent overrides.
  - Applies environment preset override.
- `council-schema.ts`
  - Defines council/meeting configuration shapes.
- `constants.ts`
  - Shared agent names, aliases, defaults and config constants.
- `utils.ts`
  - Agent override helpers and custom-agent key discovery.
- `agent-mcps.ts`
  - MCP list parsing and defaults retained for configuration compatibility.

## Load Pipeline

`loadPluginConfig(directory)`:

1. Locates user config from OpenCode-compatible config directories.
2. Locates project config from `.opencode/oh-my-opencode-slim.(jsonc|json)`.
3. Parses JSON/JSONC and validates with `PluginConfigSchema`.
4. Merges user and project config, with project values taking precedence.
5. Applies `OH_MY_OPENCODE_SLIM_PRESET` override when present.
6. Merges selected preset agent overrides into root `agents`.
7. Returns the normalized config object.

## Current Consumers

- `src/pi/core/pi.ts`
  - Uses config loading and merge helpers.
- `src/pi/core/pi-modes.ts`
  - Uses `DEFAULT_WORKFLOWS` to seed config when missing.
- `scripts/generate-schema.ts`
  - Generates `oh-my-opencode-slim.schema.json` from `PluginConfigSchema`.
- `src/cli/**`
  - Uses config types and generated defaults during install/bootstrap flows.

## Compatibility Notes

- Some schema fields remain for config compatibility even if the old workflow runtime is no longer active.
- `DEFAULT_WORKFLOWS` is currently config seed data, not a runtime workflow engine.
- Shared config should not import `src/pi/**` or any platform adapter implementation.

## File Structure

- `index.ts` — exported config surface.
- `loader.ts` — load, merge, prompt resolution and compatibility migration.
- `schema.ts` — plugin config and agent override schemas.
- `council-schema.ts` — council-specific schema.
- `constants.ts` — shared names/defaults.
- `agent-mcps.ts` — MCP defaults and allow-list parsing.
- `utils.ts` — helper methods.
