# Configuration Reference

Complete reference for the maintained Pi adapter and shared configuration surface.

## Config Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/oh-my-opencode-slim.jsonc` | Pi adapter runtime settings; JSONC variant; takes precedence over `.json` |
| `~/.pi/agent/oh-my-opencode-slim.json` | Pi adapter runtime settings — agents, modes, tool groups, workflow definitions, council |
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
      "standard-dev": { "model": "provider/model" },
      "quick-fix": { "model": "provider/model" },
      "research-only": { "model": "provider/model" },
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
standard-dev, quick-fix, research-only, coordinator, analyst, search, oracle, designer, fixer, worker, dispatcher, observer, council, fallback
```

The user-facing pipeline modes are `standard-dev`, `quick-fix`, and
`research-only`. `coordinator` is retained as a hidden compatibility/template
entry for older configs and sessions; new configs should bind models to
`standard-dev` as the primary mode.

## Agent Definitions and Prompts

Built-in agent definitions live in:

```text
src/adapters/agents-default.json
src/adapters/agents/*.md
```

At runtime, Pi syncs managed markdown prompts into `~/.pi/agents/`.

Prompt files should describe role boundaries and behavior. Tool access and delegates should remain in `agents-default.json` / runtime config, not duplicated in markdown.

## Tool Groups

Tool permissions are configured on agent definitions with `roles` and `tools`.
Named groups live in the root-level `_tool_groups` map and are shared by modes
and subagents. Resolution order is built-in defaults, then Pi native config,
then shared OpenCode user/project config.

```jsonc
{
  "_tool_groups": {
    "review": ["read", "grep", "find"],
    "implementation": ["read", "write", "edit", "bash"]
  },
  "agents": {
    "custom-reviewer": {
      "type": "subagent",
      "roles": ["review"]
    },
    "custom-fixer": {
      "type": "subagent",
      "tools": ["@implementation"]
    }
  }
}
```

Markdown prompt files should not duplicate these permissions. They can describe
how an agent should behave, but the active tool allowlist comes from runtime
config and the tool-scope snapshot.

## Workflow Config

Mode is the user-facing entry point. A pipeline mode binds one workflow internally with
`agents.<mode>.workflow`; runtime does not read `workflows.default` and there is no runtime
workflow switch command.

`pipelineMode: true` modes must set `workflow` to a known workflow definition. Custom
definitions live in `workflows.list`; if the list is missing or empty, Pi seeds the built-in
workflow definitions. Non-pipeline modes do not need a workflow and bypass workflow stage
gates.

Modes with `requiresUserCommand: true` can only be activated by user-driven mode changes
such as `/mode` or restored session state. Model-initiated `switch_mode` requests to those
modes are rejected before the approval prompt.
Use this for explicit rescue modes that should not be entered by model initiative.

```jsonc
{
  "agents": {
    "standard-dev": {
      "type": "mode",
      "pipelineMode": true,
      "workflow": "standard-dev"
    },
    "quick-fix": {
      "type": "mode",
      "pipelineMode": true,
      "workflow": "quick-fix"
    },
    "research-only": {
      "type": "mode",
      "pipelineMode": true,
      "workflow": "research-only"
    },
    "fallback": {
      "type": "mode",
      "pipelineMode": false,
      "requiresUserCommand": true
    }
  },
  "workflows": {
    "list": [
      {
        "name": "standard-dev",
        "description": "标准受控开发流程：分析 → 计划 → 调度实现与审查",
        "stages": [
          {
            "id": "analysis",
            "agent": "analyst",
            "description": "分析需求边界、影响范围、证据缺口和风险",
            "allowedSubagents": ["search"]
          },
          {
            "id": "plan",
            "agent": "designer",
            "description": "生成实施计划、TDD/验证路径和分步任务",
            "allowedSubagents": ["search", "oracle"]
          },
          {
            "id": "implement",
            "agent": "dispatcher",
            "description": "调度 fixer 实现和 oracle 审查；不通过则继续同一 fixer 会话返工",
            "allowedSubagents": ["fixer", "oracle"]
          }
        ]
      }
    ]
  }
}
```

`workflows.default` is a deprecated compatibility field. It may still be accepted by the
schema for older configs, but the Pi runtime ignores it.

Pipeline notices and the injected `<ModeWorkflows>` prompt summarize the active
mode's bound workflow. Treat that summary as runtime guidance; the gate itself
still reads the structured config.

## Subagent Pool Sessions

Pool subagents use Pi SDK sessions that are separate from the main agent session tree.

| Path | Purpose |
|------|---------|
| `~/.pi/agent/sessions/subagents/` | File-backed Pi sessions for pool subagents |
| `~/.pi/agent/sessions/subagents/pool-registry.json` | Pool registry metadata for saved subagent runs |

The registry stores bounded recovery metadata such as:

- pool id, agent name, task, model, cwd, parent agent, depth, and allowed subagents;
- `sessionFile`, when the Pi SDK provides a persisted child session file;
- `status`, `lastResponse`, `errorMessage`, `completedAt`, and `messageCount`.

Pool recovery behavior:

- `resume` opens the saved `sessionFile` when it exists, then sends the optional resume message into that saved session context.
- If the saved session file is missing, `resume` falls back to restarting from the saved task context and says so in the tool result.
- `result` returns the latest available result. A live pool entry is treated as the freshest source; the registry is the fallback after restart.
- Failed resume/open attempts keep the previous non-empty result and mark the registry entry as failed instead of leaving stale running state.

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
