# src/hooks/background-task/

Background task hook — integrates `SlimBackgroundManager` into the plugin,
exposing `task`, `background_output`, and `background_cancel` tools for
the orchestrator.

## Responsibility

- Provide async and sync sub-agent task launching via the `task` tool.
- Track running background tasks and their lifecycle (launch → running →
  completed/failed/cancelled).
- Retrieve task output via `background_output` with optional full-session
  message fetching.
- Cancel running tasks via `background_cancel` (single or all).
- Inject `<system-reminder>` into orchestrator messages when background
  tasks are pending, so the orchestrator stays aware.

## Files

- `index.ts` — `createBackgroundTaskHook(ctx)` factory, returns event
  handler, tools, and message transform handler.

## Design

- Factory pattern (`createBackgroundTaskHook`) matching todo-continuation
  and other hooks.
- `SlimBackgroundManager` owns all task state and session lifecycle;
  this hook is a thin integration layer.
- Three tools use `tool()` from `@opencode-ai/plugin/tool` with Zod schemas.
- Event handler delegates to `bgManager.handleEvent()` for
  `session.idle`/`session.deleted`/`session.created` processing.
- Message transform injects pending-task reminders into the last user
  message in orchestrator sessions.

## Tool Schemas

| Tool | Key Args | Returns |
|---|---|---|
| `task` | `prompt`, `run_in_background?`, `session_id?`, `subagent_type?` | `task_id` string |
| `background_output` | `task_id`, `full_session?`, `message_limit?` | Status or message content |
| `background_cancel` | `taskId?`, `all?` | Cancellation confirmation |

## Integration

- Exported via `src/hooks/index.ts` (not yet wired into `src/index.ts`).
- Depends on `../../utils/background-task` for `SlimBackgroundManager`.
- Uses `ctx.client.session.messages()` for output retrieval.
