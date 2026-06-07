# Configuration Reference

Complete reference for the maintained Pi adapter and shared configuration surface.

## Config Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/oh-my-opencode-slim.jsonc` | Pi adapter runtime settings; JSONC variant; takes precedence over `.json` |
| `~/.pi/agent/oh-my-opencode-slim.json` | Pi adapter runtime settings — agents, modes, tool groups, workflows seed data, council |
| `~/.config/opencode/oh-my-opencode-slim.jsonc` | Legacy-compatible user config JSONC path still read by the shared loader; takes precedence over `.json` |
| `~/.config/opencode/oh-my-opencode-slim.json` | Legacy-compatible user config path still read by the shared loader |
| `.opencode/oh-my-opencode-slim.jsonc` | Project-local JSONC overrides; takes precedence over `.json` |
| `.opencode/oh-my-opencode-slim.json` | Project-local overrides |

JSONC supports comments and trailing commas.

## Minimal Preset Example

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "default",
  "presets": {
    "default": {
      "coordinator": { "model": "provider/model" },
      "analyst": { "model": "provider/model" },
      "oracle": { "model": "provider/model", "variant": "high" },
      "search": { "model": "provider/model" },
      "designer": { "model": "provider/model" },
      "fixer": { "model": "provider/model" },
      "worker": { "model": "provider/model" },
      "dispatcher": { "model": "provider/model" },
      "observer": { "model": "provider/model" },
      "council": { "model": "provider/model" }
    }
  }
}
```

## Agent Model Overrides

| Option | Type | Description |
|--------|------|-------------|
| `preset` | string | Active preset name |
| `presets.<name>.<agent>.model` | string \| array | Model ID or ordered fallback model list |
| `presets.<name>.<agent>.temperature` | number | Temperature, when provider supports it |
| `presets.<name>.<agent>.variant` | string | Reasoning effort such as `low`, `medium`, `high` |
| `presets.<name>.<agent>.displayName` | string | User-facing alias for an agent |
| `presets.<name>.<agent>.options` | object | Provider-specific options |
| `agents.<agent>.model` | string \| array | Root-level agent override |
| `agents.<agent>.displayName` | string | Root-level display name override |
| `disabled_agents` | string[] | Agent names to disable |

Current built-in agents include:

```text
coordinator, analyst, search, oracle, designer, fixer, worker, dispatcher, observer, council, fallback
```

## Agent Definitions and Prompts

Built-in agent definitions live in:

```text
src/adapters/agents-default.json
src/adapters/agents/*.md
```

At runtime, Pi syncs managed markdown prompts into `~/.pi/agents/`.

Prompt files should describe role boundaries and behavior. Tool access and delegates should remain in `agents-default.json` / runtime config, not duplicated in markdown.

## Workflow Config

`workflows` remains as configuration seed/template data. The old workflow runtime is no longer active.

```jsonc
{
  "workflows": {
    "default": "standard-dev",
    "list": [
      {
        "name": "standard-dev",
        "description": "标准开发流程：分析 → 计划 → 标准实施",
        "stages": [
          { "id": "analyst", "agent": "analyst", "description": "分析需求边界、影响范围、方案和风险" }
        ]
      }
    ]
  }
}
```

The coordinator chooses the shortest safe path dynamically; it does not receive an injected current workflow step.

## Council

Council configuration is split between:

- `presets.<name>.council.model` — model for the council agent entry.
- `council.presets.<name>.<councillor>.model` — models for individual councillors.

Deprecated `council.master*` fields should not be used in new configs.

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

## Startup and Update Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showStartupToast` | boolean | `true` | Show startup activation toast |
| `autoUpdate` | boolean | `true` | Automatically install updates when supported |

## Custom Agents

Unknown keys under `agents` are treated as custom subagents when they provide a model and prompt.

```jsonc
{
  "agents": {
    "janitor": {
      "model": "provider/model",
      "prompt": "You are Janitor. Audit codebase entropy, dead code, docs drift, naming inconsistencies, and unnecessary complexity."
    }
  }
}
```

Notes:

- Custom agent names must be safe identifiers such as `janitor` or `security-reviewer`.
- Custom agents without a `model` are skipped with a warning.
- Disabled custom agents are not registered.

## Deprecated / Compatibility Fields

Some schema fields remain for compatibility with older configs and may be ignored by the current Pi runtime. Prefer current agent names and Pi adapter behavior for new configuration.
