# Configuration Reference

Configuration applies to the maintained Pi runtime and its shared agent definitions.

## Config Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/oh-my-opencode-slim.jsonc` | Pi-native JSONC settings; preferred over `.json` |
| `~/.pi/agent/oh-my-opencode-slim.json` | Pi-native settings for presets, agents, tool groups, council, and harness |
| `~/.config/opencode/oh-my-opencode-slim.jsonc` | Shared user JSONC settings |
| `~/.config/opencode/oh-my-opencode-slim.json` | Shared user settings |
| `.opencode/oh-my-opencode-slim.jsonc` | Project JSONC overrides |
| `.opencode/oh-my-opencode-slim.json` | Project overrides |

JSONC supports comments and trailing commas. All configuration sources use the same strict schema. Removed workflow and mode fields are errors; they are not silently ignored. The optional `$schema` URL is supported for editor validation.

## Minimal Preset

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "省钱模式",
  "presets": {
    "省钱模式": {},
    "性能模式": {
      "subagent": "provider/model",
      "oracle": "provider/other-model"
    }
  }
}
```

A **Preset** is an optional Role Subagent model-override pack. It does **not** set the Main Model (use Pi `/model` or the model picker). Empty packs mean role subagents follow the current Main Model.

Allowed preset keys: `subagent` (default for all role subagents) and built-in roles such as `search`, `fixer`, `oracle`. Values are `provider/model` strings. `main` and `council` are invalid inside presets.

Use `/preset` with no arguments to switch or edit packs via selection dialogs (TUI and PiWeb).

## Agent Overrides

| Option | Type | Description |
|--------|------|-------------|
| `preset` | string | Active preset name |
| `presets.<name>.subagent` | string | Default model for role subagents under this preset |
| `presets.<name>.<role>` | string | Optional per-role model override (`search` / `fixer` / `oracle`) |
| `agents.<agent>.model` | string or array | Root-level agent definition model (custom agents; not the preset pack) |
| `agents.<agent>.displayName` | string | Root-level display name override |
| `disabled_agents` | string[] | Hide agent names from runtime discovery |

Built-in agent definitions live in `src/adapters/agents-default.json`; prompt files live in `src/adapters/agents/*.md`. Pi synchronizes managed prompt files into `~/.pi/agents/`. Tool access and delegation remain in JSON configuration, not prompt frontmatter.

## Tool Groups and Custom Roles

`roles` and `tools` define the concrete tool allowlist passed to each subagent Pi session. Named groups are declared under `_tool_groups`. Resolution order is built-in defaults, Pi-native config, then shared user/project config.

```jsonc
{
  "_tool_groups": {
    "review": ["read", "grep", "find"],
    "implementation": ["read", "write", "edit", "bash"]
  },
  "agents": {
    "custom-reviewer": {
      "type": "subagent",
      "model": "provider/model",
      "prompt": "Review the supplied change.",
      "roles": ["review"]
    },
    "custom-fixer": {
      "type": "subagent",
      "model": "provider/model",
      "prompt": "Implement and verify the requested change.",
      "tools": ["@implementation"]
    }
  }
}
```

A custom subagent needs both a `model` and a non-empty `prompt`. Custom agents without both are not discovered. Use `delegates` on an agent definition to narrow which roles it can create; the built-in `main` session delegates to `search`, `fixer`, and `oracle`, while built-in roles are leaves.

## Pool Sessions

Pool subagents run in Pi SDK sessions separate from the main session tree.

| Path | Purpose |
|------|---------|
| `~/.pi/agent/sessions/subagents/` | File-backed child sessions |
| `~/.pi/agent/sessions/subagents/pool-registry.json` | Recovery metadata for saved pool runs |

The registry records pool id, agent name, task, model, cwd, parent agent, depth, tool-delegation limits, session file, state, last response, error, completion time, and message count.

- `spawn` starts asynchronous work and returns immediately.
- Completion messages include only a compact preview. Use `pool=result` for the full result.
- `resume` opens an existing `sessionFile`; if unavailable, it restarts from the saved task context.
- `result` uses the live entry when available and falls back to the registry after restart.
- Failed resume/open attempts preserve the prior non-empty result and record a failed state.

## Council and Harness

`omo_council` is an explicit tool. Its participant models are configured only under `council.presets.<name>.<participant>.model`. Presets do not configure council.

Harness options, including `toolResultBudget`, remain independent of subagent workflow. The completion-auditor path has been removed; do not enable legacy `harness.completionAuditor` fields (they are ignored).

Sub-agent connection health is guarded by `harness.subagent`: `stallTimeoutMs` (default `120000`) treats the LLM stream phase as dead when no session events arrive — the session is aborted and the run is marked `failed` so the main agent receives a `pool_failed` notice instead of hanging forever. Tool-execution phases are excluded, so long-running tools are never aborted by this check. `0` disables it. `promptTimeoutMs` (default `600000`) is the per-prompt hard timeout; `0` disables.

## Fallback Models

```jsonc
{
  "fallback": {
    "enabled": true,
    "timeoutMs": 15000,
    "retryDelayMs": 500,
    "chains": {
      "oracle": ["provider/backup-model"]
    }
  }
}
```

## Startup Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showStartupToast` | boolean | `true` | Show startup activation toast |
| `autoUpdate` | boolean | `true` | Automatically install updates when supported |
