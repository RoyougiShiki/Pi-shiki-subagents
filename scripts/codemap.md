# scripts/

## Responsibility

Repository-level maintenance scripts for schema generation, packaging checks and release validation.

## Scripts

### `generate-schema.ts`

- Imports `PluginConfigSchema` from `src/config/schema.ts`.
- Emits `oh-my-opencode-slim.schema.json` via Zod JSON Schema generation.
- Used by `bun run generate-schema` and `bun run build`.

### `verify-release-artifact.ts`

- Runs `npm pack --json --ignore-scripts`.
- Verifies the package contains the maintained Pi adapter and shared files:
  - `src/pi/**`
  - `src/adapters/**`
  - `src/config/**`
  - `src/core/**`
  - CLI and skill payloads
  - schema, README and LICENSE
- Scans built artifacts for leaked repository-local source paths.
- Installs the packed artifact into a temporary project.
- Verifies the package main remains importable.
- Verifies the Pi extension source is present in the installed package.

## Notes

- The old OpenCode host smoke script is legacy. It is no longer part of the maintained release gate.
- Release verification still expects `dist/index.js` and `dist/cli/index.js` while package main/bin remain present.
- Future cleanup may further reduce `dist` once package entry strategy changes.
