# skills/codemap

## Responsibility

- Provide a command-style skill package that standardizes repository mapping workflows for unfamiliar codebases.
- Define the task contract used by agents via `SKILL.md` and operational guidance via `README.md`.
- Generate and evolve change-aware codemap state artifacts (`.slim/codemap.json`) and scaffold placeholders (`codemap.md`).

## Design

- Contract layer: `SKILL.md` (machine prompt contract) + `README.md` (human-facing operation notes).
- Execution layer: `scripts/codemap.mjs` exports deterministic helper functions:
  - `parseArgs(argv)`
  - `cmdInit`, `cmdChanges`, `cmdUpdate`
  - `selectFiles`, `computeFileHash`, `computeFolderHash`, `createEmptyCodemap`
  - `loadState`, `saveState`, `migrateLegacyState`
- Persistence model: JSON state at `.slim/codemap.json` with `metadata`, `file_hashes`, and `folder_hashes`.
- Testing layer: `scripts/codemap.test.ts` validates pattern matching, hash determinism, and migration behavior.
- The script intentionally avoids network and mutates only filesystem-local state and codemap templates.

## Flow

- Entry point `main(argv)` parses command and arguments (`init|changes|update`, `--root`, `--include`, `--exclude`, `--exception`) and dispatches via strict branches.
- `cmdInit()` computes include/exclude candidate sets using `selectFiles()` and writes:
  1. `.slim/codemap.json` via `saveState()`.
  2. one `codemap.md` per discovered folder via `createEmptyCodemap()`.
- `cmdChanges()` reloads state, migrates legacy cartography state if present, recomputes current hashes, emits diffs and affected folders.
- `cmdUpdate()` recomputes full state from existing metadata and persists it after map updates.

## Integration

- Installed through CLI skill helpers as `name: 'codemap'`, `sourcePath: 'src/skills/codemap'`.
- `src/cli/install.ts` copies this directory into the user skill directory.
- `scripts/verify-release-artifact.ts` checks codemap skill metadata as required packaged files.
