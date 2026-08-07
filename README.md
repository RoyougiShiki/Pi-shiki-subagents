# pi-shiki-subagents

A thin subagent runtime for the Pi coding agent.

The maintained runtime is the Pi extension declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/pi/core/pi.ts"]
  }
}
```

## Runtime Model

The main Pi session has the complete available tool set and remains responsible for deciding how to work. The runtime supplies mechanical boundaries rather than a workflow engine:

- role-scoped pool subagents via `omo_subagent`;
- a bounded delegation matrix and nesting depth;
- per-session tool allowlists for subagents;
- dangerous Bash command blocking;
- bounded tool-result budgeting and pool cleanup;
- compact pool completion notices, with full output retrieved through `pool=result`;
- explicit `omo_council`, `/preset`, `/pool-status`, and `/pi-sync` utilities.

There are no modes, stage gates, workflow state machines, or work-package approval chains. Use skills and direct user instructions when a task needs a particular process.

## Built-in Roles

- `main` is the single foreground session and can delegate to `search`, `fixer`, or `oracle`.
- `search` gathers evidence with read and search tools.
- `fixer` implements and verifies changes with read, write, edit, Bash, and code-search tools.
- `oracle` performs independent read-only review and research.

Custom subagents must provide a model and prompt. Their tool access is defined in configuration, never in markdown frontmatter.


## Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run verify:release
```

## Package Contents

The npm package includes `src/pi`, `src/adapters`, `src/config`, `src/cli`, `dist`, the generated JSON schema, and this README.

Shared code stays outside `src/pi` so future platform adapters can reuse agent discovery, configuration, and delegation logic.
