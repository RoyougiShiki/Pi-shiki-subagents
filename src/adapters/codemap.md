# src/adapters/

## Responsibility

- `opencode.ts` keeps the original OpenCode plugin adapter isolated from Pi runtime work.
- `pi.ts` is the Pi extension entrypoint: it wires runtime config loading, managed agent markdown synchronization, mode/tool activation, gate reminders, workflow commands, subagent tooling, chat/hub integration, and extension-level event handling.
- `pi-modes.ts` applies runtime agent definitions and active tool sets for coordinator / fallback / subagent execution.
- `agent-runtime-config.ts` is the runtime authority bridge for Pi agents: defaults + Pi-native fallback + shared loader merge for `tools`, `delegates`, `model`, `thinking`, `blocked`, and related fields.
- `agent-discovery.ts` resolves real agent markdown prompts and merges runtime JSON config onto discovered agents.
- `workflow-manager.ts` drives workflow execution as real pool-backed stages with validated `StageOutput`, `needs_user` continuation, and observable `lastError` / `lastEvent` status.
- `workflow-commands.ts` exposes workflow control tools (`start_workflow`, `workflow_status`, `send_stage_message`, etc.).
- `workflow-chat-binding.ts` connects workflow stage events to Pi hub/private chat registration and overlay auto-open behavior.
- `subagent-pool.ts` owns one-shot and persistent Pi subagent execution, lifecycle control, timeout handling, and environment propagation.
- `delegation-rules.ts` enforces delegation matrix, max depth, and stage-level `allowedSubagents` narrowing.
- `pi-hub.ts` and `pi-chat-bridge.ts` implement chat/meeting registration, routing, and overlay presentation.
- `pi-agents.ts`, `pi-council.ts`, and `pi-meeting.ts` hold Pi-specific prompt/council/meeting helpers.

## Pi workflow architecture

- `WorkflowManager` executes stage nodes with `resolveAgent(...) + pool.spawn(...)`.
- Stage execution stays isolated inside pool-backed agent sessions.
- Stage outputs are parsed as `StageOutput`; invalid JSON gets one repair round on the same pool session.
- `needs_user` pauses the current stage and resumes via `send_stage_message` / `retry_stage` against the same pool session.
- `workflow_status` surfaces the current stage/choice plus `lastError` and `lastEvent` for fire-and-forget visibility.
- Workflow stage `allowedSubagents` is enforced at runtime through `OMO_ALLOWED_SUBAGENTS` + `delegation-rules.ts`.

## Key design decisions

- Workflow defines process order; agent prompts define role boundaries and output contracts.
- Agent markdown frontmatter is intentionally minimal: `name` + `description` only.
- Runtime JSON config is authoritative for tools/delegates/model/thinking; Pi native config is only a fallback beneath shared OpenCode/project config.
- Subagent depth is capped at 2 and enforced in tool/runtime logic, not only by prompts.
- Timeout lifecycle for pool agents is fail-safe: timeout resolves with error, kills the child, and removes the pool entry so late responses are ignored.
- Chat overlay registration uses `poolId` as the shared identity across workflow stage, pool process, and private chat meeting.

## Guardrails

- Keep `src/adapters/opencode.ts` isolated from Pi runtime migration work.
- Do not reintroduce workflow flow logic into agent prompts.
- Do not move runtime tool/model authority back into markdown frontmatter.
- OMO-managed Pi agent markdown uses `omo-managed` / `omo-source-hash`; stale managed files may update with `.bak`, old generated OMO prompts may migrate, in-memory `AGENT_PROMPTS` refreshes after sync, but unmanaged/custom files must not be overwritten.
- Treat completed plan state as living in `docs/oh-my-opencode-slim/plans/*.json`; this codemap is an architecture summary, not a task tracker.
