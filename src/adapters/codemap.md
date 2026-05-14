# src/adapters/

## Responsibility

- `opencode.ts` keeps the original OpenCode plugin adapter untouched.
- `pi.ts` is the Pi extension entrypoint: prompt injection, gate reminders/blocking, tool registration, preset command handling, config loading, agent file materialization, and test-facing re-exports.
- `pi-agents.ts` owns Pi specialist agent prompt material.
- `pi-council.ts` implements stable isolated council execution with independent `createAgentSession()` participants.
- `pi-meeting.ts` implements hidden meeting backends and result formatting helpers.
- `persistent-join.js`, `persistent-poll.js`, `persistent-send.js` are standalone Node scripts loaded by the collaborating backend's spawned participants.

## Pi meeting backends

- `session` is the stable default hidden round-based backend. Each participant turn is a fresh `createAgentSession()` call; the runtime carries a digest forward and returns only the final chair report to the main context.
- `collaborating` spawns each participant ONCE with an LLM-driven polling loop. Participants read raw messages from the shared message log, generate content via their own LLM, and respond directly to the chair (not broadcast). Participants see and reference each other's original messages (not a chair-compiled digest).
  - Round-spawn was removed in favor of this single-spawn polling approach.

## Key design decisions

- `enableSessionControl: false` — spawned children don't support `--session-control`.
- All participant messages go direct-to-chair, not broadcast, to avoid disturbing other active Pi sessions.
- Node scripts are extracted to standalone `.js` files for maintainability, loaded at module init via `import.meta.url`.

## Guardrails

- Keep `src/adapters/opencode.ts` isolated from Pi runtime work.
- Treat gates as conservative reminders, not an expanding policy engine.
- `"persistent"` is a deprecated config alias for `"collaborating"`.
