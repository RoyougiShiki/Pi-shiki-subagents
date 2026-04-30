# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

## apply_patch rescue

Slim only intercepts `apply_patch` before the native tool runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks `apply_patch` before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs.

---

## Web Fetch

Fetch remote pages with content extraction tuned for docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL, optionally prefer `llms.txt`, extract main content from HTML, include metadata, and optionally save binary responses |

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them, and it can fall back to the raw fetched content when secondary-model summarization is unavailable.

---

## Vision Analysis

Analyze images with a dedicated tool path used by Observer and Orchestrator.

| Tool | Description |
|------|-------------|
| `vision_analyze` | Read an image from disk and return a text description using the configured vision model (`visionModel`) |

`vision_analyze` is useful when the current reasoning model is text-only or unreliable on raw image parts. Configure its model with `visionModel` in `oh-my-opencode-slim.json`.

---

## Background Task Tools

Use async child-agent execution with explicit output retrieval.

| Tool | Description |
|------|-------------|
| `task` | Spawn/continue child-agent tasks (`run_in_background=true` for async) |
| `background_output` | Get task output; use `incremental=true` for new output since last check, `full_session=true` for full transcript |
| `background_cancel` | Cancel one or all running background tasks; returns continuation hints when available |

When a background task finishes, the system injects `<system-reminder>` in the parent session. Query output after reminder instead of polling aggressively.

---

## Code Search Tools

Fast, structural code search and refactoring — more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

---

## Formatters

OpenCode automatically formats files after they are written or edited, using language-specific formatters. No manual step needed.

Includes Prettier, Biome, `gofmt`, `rustfmt`, `ruff`, and 20+ others.

> See the [official OpenCode docs](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---

## Todo Continuation

Auto-continue has its own guide now:

- [Todo Continuation](todo-continuation.md) — controls, safety gates, behavior, and config
