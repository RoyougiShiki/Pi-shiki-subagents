# skills/simplify

## Responsibility

- Provide a behavior-preserving refactoring skill contract focused on clarity and low-risk cleanup.
- Define quality gates: understand before edit, preserve behavior, simplify incrementally, keep diffs rollback-friendly.
- Ship prompt/documentation metadata only; no local runtime state machine is kept in this directory.

## Design

- Contract layer: `SKILL.md` is the executable prompt specification with explicit phases:
  - pre-change understanding;
  - simplification candidate selection;
  - incremental transformation and verification;
  - final review checklist.
- Documentation layer: `README.md` explains intent and usage.
- Policy model is declarative and consumed by the host skill runtime.

## Flow

- Agent or host skill discovery resolves `src/skills/simplify` and reads `SKILL.md`.
- The workflow is context-driven: simplify instructions require understanding callers, edge cases, and tests before mutation.
- The skill is intended for local, scoped refactors with validation.

## Integration

- Installed by CLI skill helpers through `src/cli/install.ts`.
- Release integrity: `scripts/verify-release-artifact.ts` checks for `src/skills/simplify/SKILL.md` in package tarballs.
