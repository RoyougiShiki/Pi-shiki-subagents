# src/adapters/

## Responsibility

- `opencode.ts` keeps the original OpenCode plugin adapter untouched.
- `pi.ts` is the Pi extension entrypoint: prompt injection, gate reminders/blocking, tool registration, preset command handling, config loading, agent file materialization, and test-facing re-exports.
- `pi-agents.ts` owns Pi specialist agent prompt material.
- `pi-council.ts` implements stable isolated council execution with independent `createAgentSession()` participants.
- `pi-meeting.ts` implements hidden meeting backends and result formatting helpers.

## Pi meeting backends

- `session` is the stable default hidden round-based backend. Each participant turn is a fresh `createAgentSession()` call; the runtime carries a digest forward and returns only the final chair report to the main context.
- `collaborating` is experimental. It uses real `pi-collaborating-agents` child processes and direct-message collection, currently as a round-spawn backend rather than a long-lived live chat.
- The collaborating backend deliberately sets `enableSessionControl: false` when spawning round participants because spawned children do not support `--session-control`. A live smoke after that change completed with `requestedBackend: collaborating` and `backendUsed: collaborating`.

## Guardrails

- Keep `src/adapters/opencode.ts` isolated from Pi runtime work.
- Treat gates as conservative reminders, not an expanding policy engine.
- Do not deepen the collaborating backend unless it can provide behavior the session backend cannot, such as long-lived participants, raw message visibility, participant-to-participant replies, or follow-up work coordination/reservations.
