# oh-my-opencode-slim

A lightweight agent orchestration package focused on the Pi coding agent runtime.

The maintained runtime is the Pi adapter declared in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./src/pi/core/pi.ts"
    ]
  }
}
```

## Current Architecture

The repository is split into two maintained layers:

- **Platform adapter**: `src/pi/**`
  - mode switching
  - tool-scope enforcement
  - subagent pool integration
  - council / meeting helpers
  - Pi runtime event wiring

- **Shared layer**:
  - `src/adapters/**` — agent prompts, agent definitions, discovery, delegation rules
  - `src/config/**` — config schema, loader, presets, council schema, workflow config types
  - `src/cli/**` — installer and generated config helpers

Legacy OpenCode adapter code has been removed. The package keeps a lightweight `src/index.ts` only so the npm `main` entry remains importable while the maintained runtime is loaded through Pi extensions.

## Built-in Agent Boundaries

- `coordinator` — main mode; clarifies with the user, delegates work, receives subagent results, and decides whether to pause or proceed.
- `analyst` — non-questioning analysis support; analyzes known materials, identifies unknowns, risks, and options.
- `oracle` — evidence-driven adversarial reviewer; reviews human text, AI output, implementation plans, code, docs, config, and test expectations.
- `search` — read/search fact gathering.
- `designer` — technical design after requirements are clear.
- `fixer` / `worker` / `dispatcher` — implementation paths with scoped responsibilities.
- `fallback` — explicit user-driven rescue mode with broad tools.

## Control Model

The current runtime relies on:

- tool-scope allowlists;
- mode switching boundaries;
- coordinator-controlled subagent delegation;
- prompt-defined role boundaries;
- informational mode/session notifications.

It does **not** use per-edit/per-write/per-command approval gates. Those were removed because low-level repeated approvals made normal implementation work inefficient. High-level control remains at the mode/tool-scope and coordinator delegation layers.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run verify:release
```

## Package Contents

The npm package is expected to include:

- `src/pi/**`
- `src/adapters/**`
- `src/config/**`
- `src/cli/**`
- `dist/**`
- `oh-my-opencode-slim.schema.json`

## Notes

- Shared code is intentionally not moved under `src/pi`; future platform adapters may reuse it.
- Old OpenCode-specific implementation and tests were removed as legacy code.
- Historical cleanup rationale is documented in `docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md`.
