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
