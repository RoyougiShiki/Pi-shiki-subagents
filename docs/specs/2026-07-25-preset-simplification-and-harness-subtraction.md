# Spec: Preset simplification and harness subtraction

Status: agreed in grill-with-docs; ready for implementation  
Glossary: `CONTEXT.md`  
ADRs: `docs/adr/0001-presets-only-override-subagent-models.md`, `docs/adr/0002-remove-completion-auditor.md`

## Problem Statement

PiWeb cannot reliably accept custom slash commands that need spaced arguments, so switching named model strategies via `/preset <name>` is painful. Maintaining a full copy of provider/model IDs for main and every role subagent is also tedious, especially as Pi’s available models change. Separately, with completion auditing enabled, almost every assistant turn can show a `[harness] 完成审计提醒` warning even when the user is mid-design or not finishing an implementation task. That warning does not act as a real stop/continue gate; it mostly adds noise. The user wants a thin runtime: main-model choice stays in Pi’s own UI, presets only optionally override role-subagent models, stale overrides are easy to see and fix in both TUI and PiWeb, and soft per-turn completion policing is removed while real mechanical boundaries stay.

## Solution

Keep a single argument-less `/preset` command. Opening it shows a selection UI (works in TUI and PiWeb via standard select dialogs, without modifying Pi Web). The first screen lists named Presets plus an edit entry. Stale overrides are detected automatically when the menu opens and shown inline—there is no separate “check” action. Choosing a healthy Preset only changes the active Preset name and how future Role Subagent spawns resolve models; it never changes the Main Model. Empty Presets mean all Role Subagents follow the current Main Model. Optional `subagent` and per-role overrides can be edited by picking a slot, then provider, then model from Pi’s currently available authenticated models. Old object-shaped preset entries are rejected by schema; the local config file is migrated once to empty named shells. The completion-auditor path is surgically removed; tool-result budgeting and other mechanical boundaries remain. Goal and acceptance work stay optional via skills/commands, not a default per-turn gate.

## User Stories

1. As a Pi user in PiWeb, I want to run `/preset` with no arguments, so that I do not have to type spaced preset names.
2. As a Pi user in TUI, I want the same `/preset` flow, so that desktop terminal and PiWeb stay consistent.
3. As a user, I want the first screen to list my named Presets, so that I can switch strategy in one select when nothing is stale.
4. As a user, I want the active Preset marked in the list, so that I know which strategy is current.
5. As a user, I want empty Presets summarized as “follow main model”, so that I understand they do not force a different subagent model.
6. As a user, I want non-empty Presets summarized with their subagent/role overrides, so that I can compare strategies at a glance.
7. As a user, I want stale overrides flagged automatically when `/preset` opens, so that I do not need a separate check command.
8. As a user, I want a stale Preset to offer clear or reselect actions, so that I am not forced into a blind switch that will fail later.
9. As a user, I want switching a healthy Preset to leave my Main Model alone, so that Pi’s model UI remains the only place that changes the foreground model.
10. As a user, I want new Role Subagent spawns after a switch to use the newly active Preset’s overrides, so that strategy changes affect future work.
11. As a user, I want already running pool subagents to keep their original models, so that in-flight work is not rewritten mid-task.
12. As a user, I want an “edit overrides” entry on the first screen, so that I can change strategy models without hand-editing JSON most of the time.
13. As a user, I want to choose which Preset I am editing, so that I can prepare a non-active strategy before switching.
14. As a user, I want to choose a slot among subagent default and role overrides, so that I only configure differences I care about.
15. As a user, I want to clear a slot back to “follow main / follow subagent default”, so that I can undo a special case.
16. As a user, I want model choices drawn from Pi’s available authenticated models, so that I never type a raw `provider/model` string in the happy path.
17. As a user, I want model picking to be provider first, then model, so that long model lists stay usable in PiWeb’s simple button dialogs.
18. As a user, I want edits written only to my Pi-native config, so that project git repos are not polluted with personal model prefs.
19. As a user, I want named empty shells such as cost and performance modes kept, so that I can hang overrides on them later without inventing names again.
20. As a user who only uses the Main Model UI, I want both empty Presets to behave the same for subagents, so that cost vs performance is expressed by changing the main model until I add overrides.
21. As a developer spawning a Role Subagent without a model argument, I want resolution to use role override, then subagent override, then current Main Model, so that the common path needs no extra parameters.
22. As a developer spawning with an explicit model argument, I want that one-shot model to win, so that rare exceptions remain possible.
23. As a developer, I want a stale resolved override to hard-fail spawn with a clear message, so that I am not silently put on the wrong model.
24. As a developer, I want unavailable explicit spawn models to hard-fail too, so that bad one-shot overrides are visible.
25. As a user, I want old preset shapes with nested agent objects and main/council keys rejected, so that invalid strategy packs cannot silently partially apply.
26. As a user upgrading, I want my local Pi-native file migrated once to empty named Presets, so that I am not stuck on an ignored invalid config.
27. As a user, I want documentation and schema examples to show only the new preset shape, so that I am not taught dead fields.
28. As a user, I want `council` configuration to remain under the separate council settings, so that multi-participant review is not confused with Preset overrides.
29. As a user, I want no more routine `[harness] 完成审计提醒` after ordinary assistant turns, so that design and coding sessions stay readable.
30. As a user, I want large tool results still budgeted/persisted, so that context does not blow up when completion auditing goes away.
31. As a user, I want dangerous bash blocking and role tool scopes kept, so that mechanical safety is unchanged.
32. As a user, I want acceptance and goal alignment to remain optional skills/commands, so that strong models are not herded by soft per-turn gates.
33. As a user without UI, I want `/preset` to fail safely with a short message, so that print/rpc-without-dialog modes do not crash.
34. As a user editing overrides for the active Preset, I want subsequent spawns to see the new values immediately, so that I do not need to restart Pi after every edit.
35. As a user, I want notify feedback after switch/edit/clear, so that I know what changed.
36. As a maintainer, I want static default models like hardcoded OpenAI fallbacks removed from role-subagent resolution, so that “follow main” is real.
37. As a maintainer, I want custom user-defined subagents to still require their own model when discovered as custom agents, so that built-in follow-main rules do not silently invent models for ad-hoc agents that expect explicit config.
38. As a maintainer, I want tests at high seams for schema, resolution, command orchestration, and harness subtraction, so that regressions are caught without browser drivers.
39. As a user of oracle/council tools, I want those tools to remain explicitly invokable, so that second opinions are opt-in rather than forced by completion auditing.
40. As a user mid-session, I want changing the Main Model in Pi’s UI to affect later follow-main spawns without editing Presets, so that temporary main-model changes stay simple.

## Implementation Decisions

### Architecture

- Preset is only an optional Role Subagent model-override pack. It does not own Main Model selection or Council participant models.
- One custom command: argument-less `/preset`. No `/preset-next`, no per-preset alias commands, no `/preset model ...` typed path as the primary UX.
- UI must use portable dialog APIs (`select` / `confirm` / `notify`), not TUI-only custom components, so PiWeb works without forking Pi Web.
- Harness subtraction is surgical: remove completion-auditor behavior and config surface; keep tool-result budget and other mechanical boundaries.
- No runtime dual-read of legacy preset object shapes. Schema is strict; migration is a one-time config rewrite.

### Configuration shape

Agreed target shape:

```jsonc
{
  "preset": "省钱模式",
  "presets": {
    "省钱模式": {},
    "性能模式": {
      "subagent": "provider/model",
      "oracle": "provider/model"
    }
  }
}
```

- Allowed preset keys: `subagent` plus built-in role names that are Role Subagents.
- Values are model id strings (`provider/.../model` form already used by the project).
- Disallowed in a Preset: `main`, `council`, nested agent override objects, non-model agent fields.
- Active preset name remains the top-level `preset` string.
- Local Pi-native config is rewritten during implementation to keep the two named shells empty by default.

### Model resolution

Spawn-time resolution order:

1. Explicit model on the subagent tool call  
2. Active Preset Role Model Override for that role  
3. Active Preset Subagent Model  
4. Current Main Model from the main session context (`ctx.model`), passed explicitly into pool spawn  

Rules:

- Missing/unavailable Main Model after an empty chain → hard fail with a clear error.  
- Stale override encountered in steps 2–3 → hard fail; do not silently substitute Main Model.  
- No static library defaults such as hardcoded OpenAI mini/4.1 fallbacks for built-in roles.  
- Custom non-built-in agents may still require explicit model at definition/discovery time (existing custom-agent rule), distinct from built-in follow-main behavior.

### `/preset` interaction

First screen (auto-stale scan already done):

- One row per named Preset, with active mark and short summary  
- Inline stale markers on affected rows  
- One row: edit overrides  

Behaviors:

- Healthy Preset row → switch active name, persist Pi-native, refresh future spawn resolution context, notify; do not call main-session setModel  
- Stale Preset row → offer clear stale slots and/or edit; do not pretend a broken strategy is fully applied  
- Edit → choose Preset → choose slot (subagent / roles / clear) → provider list from available models → model list for that provider → write Pi-native  
- No separate menu item whose only job is “check stale”

### Persistence

- Read may still merge config sources as today for effective view.  
- All `/preset` writes go only to Pi-native config.  
- Switching persists active preset name.  
- Editing/clearing persists override strings in the new shape only.

### Harness

- Remove completion-auditor enablement path and the message-end warning notify that produces `[harness] 完成审计提醒`.  
- Remove or stop shipping completion-auditor config as a supported user feature; docs should not recommend enabling it.  
- Keep tool-result budget behavior.  
- Keep dangerous command blocking, tool scope, pool limits.  
- Do not build a Claude Code-style Stop continuation gate in this change.  
- Do not add global “must verify before done” prompt iron laws in this change.

### Docs and glossary

- User-facing docs must drop examples where presets configure `main` or `council`.  
- Council docs must point only at council participant settings.  
- Domain terms follow `CONTEXT.md` (Preset, Main Session, Role Subagent, Main Model, Subagent Model, Role Model Override, Stale Override, Mechanical Boundary, Acceptance Check).

### Modules / interfaces (logical, not paths)

- Config schema validation for the new Preset record shape  
- Preset resolution helper used by spawn/delegation  
- Availability/stale helper using model registry available/find  
- Pi-native read/write helpers already used for preset persistence  
- `/preset` command handler orchestration (select flows)  
- Pool spawn path receiving explicit resolved model (including Main Model fallback)  
- Harness registration path without completion-auditor notify  
- Managed agent model sync must stop baking static defaults that fight follow-main  
- Release/schema artifact and configuration reference updates  

## Testing Decisions

Good tests assert external behavior at high seams: given config + available models + mocked UI choices + spawn inputs, assert persistence, resolution results, errors, and whether main-session model APIs were invoked. Avoid browser/PiWeb DOM tests and avoid snapshotting internal private helpers unless they are the seam.

### Seam 1 — Preset model strategy (primary)

Cover:

- schema accepts empty presets and string slots; rejects `main`/`council`/legacy object agent entries  
- resolution order including explicit model and follow-main  
- stale override detection against an available-model set  
- spawn hard-fail on stale/unavailable resolved model  
- switch plan does not require or apply main-session model change  
- Pi-native persistence of active name and new-shaped overrides  

Prior art: existing thin-runtime / runtime-config / preset-switch tests.

### Seam 2 — `/preset` orchestration (secondary)

Cover with mocked select/confirm/notify:

- first screen composition includes presets + edit, not a dedicated check item  
- auto stale annotation influences labels/actions  
- healthy switch path  
- edit path provider→model writeback  
- clear slot path  
- no-UI safe degradation  

Prior art: command-handler tests in the Pi adapter suite that mock extension UI.

### Seam 3 — Harness subtraction

Cover:

- completion-auditor warning path not active by default / removed  
- tool-result budget still applies under its config  
- remove or rewrite tests that encoded modification-without-verification notify as desired product behavior  

Prior art: harness registration and tool-result budget tests.

## Out of Scope

- Modifying Pi Web source or publishing a fork of Pi Web  
- Rebuilding Claude Code Stop-hook continuation enforcement  
- Council participant editor UX inside `/preset`  
- Making Presets control thinking levels, tool allowlists, or prompts  
- Runtime compatibility shims for legacy preset object shapes  
- Automatic rewrite of shared/project config layers outside Pi-native  
- Changing already-running pool sessions’ models on preset switch  
- New slash commands for cycle/status/numbered presets  
- Skill matcher or forced global verification iron laws  
- Full deletion of every harness module (budget stays)

## Further Notes

- Implementation order suggested by risk: (1) disable/remove completion-auditor noise, (2) schema + resolution + spawn follow-main, (3) `/preset` UI orchestration, (4) migrate local Pi-native config and docs/schema artifacts, (5) full test + typecheck + release checks.  
- PiWeb select dialogs are plain text option lists; provider→model two-step is mandatory for usability, not polish.  
- “省钱模式 / 性能模式” may both start as `{}`; product meaning of performance vs cost can later be expressed by Main Model choice and/or a future `subagent` override on one shell.  
- This spec intentionally prefers strong-model autonomy for acceptance, and mechanical boundaries for safety/resources only.
