# Agent Coding Guidelines

This document provides guidelines for AI agents operating in this repository.

## Project Overview

**oh-my-opencode-slim** - A lightweight agent orchestration plugin for OpenCode, a slimmed-down fork of oh-my-opencode. Built with TypeScript, Bun, and Biome.

## Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build TypeScript to `dist/` (both index.ts and cli/index.ts) |
| `bun run typecheck` | Run TypeScript type checking without emitting |
| `bun test` | Run all tests with Bun |
| `bun run lint` | Run Biome linter on entire codebase |
| `bun run format` | Format entire codebase with Biome |
| `bun run check` | Run Biome check with auto-fix (lint + format + organize imports) |
| `bun run check:ci` | Run Biome check without auto-fix (CI mode) |
| `bun run dev` | Build and run with OpenCode |

**Running a single test:** Use Bun's test filtering with the `-t` flag:
```bash
bun test -t "test-name-pattern"
```

## Code Style

### General Rules
- **Formatter/Linter:** Biome (configured in `biome.json`)
- **Line width:** 80 characters
- **Indentation:** 2 spaces
- **Line endings:** LF (Unix)
- **Quotes:** Single quotes in JavaScript/TypeScript
- **Trailing commas:** Always enabled

### TypeScript Guidelines
- **Strict mode:** Enabled in `tsconfig.json`
- **No explicit `any`:** Generates a linter warning (disabled for test files)
- **Module resolution:** `bundler` strategy
- **Declarations:** Generate `.d.ts` files in `dist/`

### Imports
- Biome auto-organizes imports on save (`organizeImports: "on"`)
- Let the formatter handle import sorting
- Use path aliases defined in TypeScript configuration if present

### Naming Conventions
- **Variables/functions:** camelCase
- **Classes/interfaces:** PascalCase
- **Constants:** SCREAMING_SNAKE_CASE
- **Files:** kebab-case for most, PascalCase for React components

### Error Handling
- Use typed errors with descriptive messages
- Let errors propagate appropriately rather than catching silently
- Use Zod for runtime validation (already a dependency)

### Git Integration
- Biome integrates with git (VCS enabled)
- Commits should pass `bun run check:ci` before pushing

## Project Structure

```
oh-my-opencode-slim/
├── src/
│   ├── agents/       # Agent factories (orchestrator, explorer, oracle, etc.)
│   ├── cli/          # CLI entry point
│   ├── config/       # Constants, schemas, MCP defaults
│   ├── council/      # Council manager (multi-LLM session orchestration)
│   ├── hooks/        # OpenCode lifecycle hooks
│   ├── mcp/          # MCP server definitions
│   ├── multiplexer/  # Tmux/Zellij pane integration for child sessions
│   ├── skills/       # Skill definitions (included in package publish)
│   ├── tools/        # Tool definitions (council, webfetch, AST-grep, etc.)
│   └── utils/        # Shared utilities (tmux, session helpers)
├── dist/             # Built JavaScript and declarations
├── docs/             # User-facing documentation
├── biome.json        # Biome configuration
├── tsconfig.json     # TypeScript configuration
└── package.json      # Project manifest and scripts
```

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@opencode-ai/sdk` - OpenCode AI SDK
- `zod` - Runtime validation

## Development Workflow

1. Make code changes
2. Update docs when behavior, commands, configuration, workflows, or user-facing output changes
   - Check `README.md` plus relevant files in `docs/`
   - Keep examples, command snippets, and feature lists in sync with the code
   - If no doc update is needed, explicitly confirm that in your final summary
3. Run `bun run check:ci` to verify linting and formatting
4. Run `bun run typecheck` to verify types
5. Run `bun test` to verify tests pass
6. Commit changes

## Common Patterns

- This is an OpenCode plugin - most functionality lives in `src/`
- The CLI entry point is `src/cli/index.ts`
- The main plugin export is `src/index.ts`
- Agent factories are in `src/agents/` — each agent has its own file + optional `.test.ts`
- Skills are located in `src/skills/` (included in package publish)
- Multiplexer session management is in `src/multiplexer/`
- Council manager (multi-LLM orchestration) is in `src/council/`
- Tmux utilities are in `src/utils/tmux.ts`
- 468 tests across 35 files — run `bun test` to verify

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **oh-my-opencode-slim** (4975 symbols, 9089 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/oh-my-opencode-slim/context` | Codebase overview, check index freshness |
| `gitnexus://repo/oh-my-opencode-slim/clusters` | All functional areas |
| `gitnexus://repo/oh-my-opencode-slim/processes` | All execution flows |
| `gitnexus://repo/oh-my-opencode-slim/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Apply-patch area (116 symbols) | `.claude/skills/generated/apply-patch/SKILL.md` |
| Work in the Interview area (111 symbols) | `.claude/skills/generated/interview/SKILL.md` |
| Work in the Smartfetch area (84 symbols) | `.claude/skills/generated/smartfetch/SKILL.md` |
| Work in the Cli area (59 symbols) | `.claude/skills/generated/cli/SKILL.md` |
| Work in the Tools area (51 symbols) | `.claude/skills/generated/tools/SKILL.md` |
| Work in the Auto-update-checker area (44 symbols) | `.claude/skills/generated/auto-update-checker/SKILL.md` |
| Work in the Scripts area (44 symbols) | `.claude/skills/generated/scripts/SKILL.md` |
| Work in the Todo-continuation area (36 symbols) | `.claude/skills/generated/todo-continuation/SKILL.md` |
| Work in the Agents area (30 symbols) | `.claude/skills/generated/agents/SKILL.md` |
| Work in the Task-session-manager area (28 symbols) | `.claude/skills/generated/task-session-manager/SKILL.md` |
| Work in the Ast-grep area (23 symbols) | `.claude/skills/generated/ast-grep/SKILL.md` |
| Work in the Council area (20 symbols) | `.claude/skills/generated/council/SKILL.md` |
| Work in the Multiplexer area (20 symbols) | `.claude/skills/generated/multiplexer/SKILL.md` |
| Work in the Zellij area (19 symbols) | `.claude/skills/generated/zellij/SKILL.md` |
| Work in the Declaration-gate area (17 symbols) | `.claude/skills/generated/declaration-gate/SKILL.md` |
| Work in the Background-task area (15 symbols) | `.claude/skills/generated/background-task/SKILL.md` |
| Work in the Config area (15 symbols) | `.claude/skills/generated/config/SKILL.md` |
| Work in the Cluster_32 area (12 symbols) | `.claude/skills/generated/cluster-32/SKILL.md` |
| Work in the Hooks area (12 symbols) | `.claude/skills/generated/hooks/SKILL.md` |
| Work in the Filter-available-skills area (10 symbols) | `.claude/skills/generated/filter-available-skills/SKILL.md` |

<!-- gitnexus:end -->
