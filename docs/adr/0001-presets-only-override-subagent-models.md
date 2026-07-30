# Presets only override subagent models

Pi already owns main-session model selection through its own model controls, and PiWeb cannot reliably accept slash commands with spaced arguments. We therefore scoped Preset down to a named pack of optional subagent model overrides: it never sets or switches the Main Model, and `/preset` is the single argument-less command that opens selection dialogs for switching, editing, and repairing overrides.

## Considered Options

- **Full runtime config bundle** (models, thinking, tools, prompts, council participants), mirroring the upstream Pi `presets.json` example. Rejected: it duplicates Pi's own model UI, re-expands the runtime we deliberately thinned, and would need rich UI that PiWeb's `select` dialog cannot render.
- **Presets own both a main slot and a subagent slot.** Rejected after review: the main model already has a first-class Pi UI, and a preset-owned main slot makes `/preset` fight that UI.
- **Compatibility migration for the old `presets.<name>.<agent>.{model}` shape.** Rejected: a dual-shape reader would persist indefinitely; the config file is migrated once instead.

## Consequences

- Model resolution at spawn is: explicit call model, then role override, then preset subagent model, then the current Main Model passed explicitly as `ctx.model`.
- Static fallback models (for example `openai/gpt-4o-mini`) are removed; an unusable model is a hard spawn failure, not a silent substitution.
- `main` and `council` keys inside a preset are invalid. Council participants stay in `council.presets.<name>.<participant>.model`.
- Presets can be empty, which means role subagents follow the current Main Model.
- Overrides can go stale when Pi's model list changes, so `/preset` must surface unavailable overrides and offer clear/reselect actions in both TUI and PiWeb.
- `/preset` opens one mixed first screen: named presets plus an edit entry. Stale overrides are checked automatically on open and shown inline; there is no separate "check" menu item. A healthy preset switches in one select; a stale preset offers clear/reselect before or instead of a blind switch.
- Model pickers are two-level (`provider` then `model`) from `modelRegistry.getAvailable()`, so the same flow works in TUI and PiWeb without editing Pi Web.
- Writes go only to the Pi-native config file. Named empty presets such as cost/performance shells may exist with `{}` and still mean follow Main Model.
