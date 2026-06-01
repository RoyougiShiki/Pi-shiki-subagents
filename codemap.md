# Repository Atlas: oh-my-opencode-slim

## Responsibility

`oh-my-opencode-slim` maintains a Pi adapter plus shared agent/config infrastructure for lightweight multi-agent orchestration.

The current runtime focus is Pi. Shared modules remain platform-neutral where practical so future platform adapters can reuse them.

## System Entry Points

| Path | Role |
|---|---|
| `package.json` | Package manifest, Pi extension declaration, release scripts, published file list. |
| `src/pi/core/pi.ts` | Pi extension entrypoint: prompt sync, tool registration, subagent pool, runtime gates, notifications. |
| `src/pi/core/pi-modes.ts` | Pi mode switching, agent definitions, tool-scope activation, mode/session notifications. |
| `src/index.ts` | Lightweight package main compatibility entry; legacy OpenCode adapter has been removed. |
| `src/cli/index.ts` | CLI entrypoint for installation/bootstrap workflows. |
| `src/config/schema.ts` | Source-of-truth runtime config schema and default workflow seed data. |
| `scripts/generate-schema.ts` | Generates `oh-my-opencode-slim.schema.json` from the Zod config schema. |

## Directory Map

| Directory | Responsibility |
|---|---|
| `src/pi/` | Maintained Pi platform adapter. |
| `src/pi/core/` | Pi extension composition roots and mode engine. |
| `src/pi/meeting/` | Pi council/meeting helpers and managed prompt cache. |
| `src/pi/policy/` | Pi runtime policies: tool scope, clarification, subagent contracts, evidence, audit. |
| `src/pi/subagent/` | Subagent pool implementation and `omo_subagent` tool integration. |
| `src/adapters/` | Shared adapter definitions: agent prompts, runtime config, discovery, delegation rules. |
| `src/adapters/agents/` | Managed agent markdown prompts synchronized into `~/.pi/agents/`. |
| `src/config/` | Shared config schema, loader, constants, council config and helpers. |
| `src/core/` | Shared workflow/config types retained for config compatibility. |
| `src/cli/` | Installer/config bootstrap CLI, retained for package setup. |
| `src/skills/` | Bundled install-time skill payloads. |
| `scripts/` | Schema generation and release/package verification. |
| `docs/oh-my-opencode-slim/plans/` | Design records for recent architecture cleanup work. |

## Runtime Control Flow

1. Pi loads extensions declared in `package.json#pi.extensions`.
2. `src/pi/core/pi-modes.ts` loads agent definitions from shared adapter config and applies the active tool scope.
3. `src/pi/core/pi.ts` syncs managed agent markdown, injects coordinator/mode instructions, registers tools, and wires subagent pool events.
4. Coordinator delegates to subagents according to runtime `<AvailableAgents>` and tool-scope constraints.
5. Tool execution is controlled primarily by tool-scope allowlists, mode boundaries, subagent contracts, and prompt-defined responsibilities.

## Current Agent Boundary

- `coordinator`: user-facing mode for clarification, delegation, result intake, and pause/proceed decisions.
- `analyst`: non-questioning analysis support over known materials.
- `oracle`: evidence-driven adversarial review.
- `search`: fact gathering.
- `designer`: technical design after requirements are clear.
- `fixer` / `worker` / `dispatcher`: implementation paths.
- `fallback`: explicit broad-tool fallback mode.

## Legacy Cleanup Status

Legacy OpenCode adapter implementation has been removed from source. The package main remains importable through `src/index.ts`, but the maintained runtime is the Pi adapter.

Historical rationale and staged cleanup notes are in:

```text
docs/oh-my-opencode-slim/plans/platform-adapter-cleanup/proposal.md
```

## Recommended Reading Order

1. `README.md`
2. `src/pi/core/pi.ts`
3. `src/pi/core/pi-modes.ts`
4. `src/adapters/agents-default.json`
5. `src/adapters/agents/coordinator.md`
6. `src/config/schema.ts`
