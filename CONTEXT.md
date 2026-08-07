# pi-shiki-subagents

Thin Pi runtime for role-scoped subagent pooling, mechanical safety boundaries, and optional subagent model overrides.

## Language

**Preset**:
A named pack of optional subagent model overrides. It does not own or switch the main session model.
_Avoid_: Mode, workflow, profile, full runtime config bundle, main-model profile

**Main Session**:
The single foreground Pi session that owns user-facing work and may delegate to role subagents.
_Avoid_: Dispatcher, standard-dev, primary agent, worker

**Role Subagent**:
A leaf pool agent with a fixed role (`search`, `fixer`, `oracle`) that the main session may spawn.
_Avoid_: Worker, stage, pipeline step

**Council**:
An explicit multi-participant review tool with its own participant model configuration, independent of presets.
_Avoid_: Preset council model, workflow review stage

**Main Model**:
The model currently selected for the main session through Pi's own model controls.
_Avoid_: Preset main, primary model owned by preset

**Subagent Model**:
An optional preset-level default model for role subagents. When absent, role subagents use the current main model.
_Avoid_: Worker model, child model, secondary model

**Role Model Override**:
An optional per-role model on a preset that replaces the subagent model for one role only.
_Avoid_: Agent-specific preset, special case model

**Stale Override**:
A preset model override that no longer matches any model currently available in Pi.
_Avoid_: Broken model, missing model, invalid preset

**Mechanical Boundary**:
A hard runtime limit on safety or resources that does not depend on model judgment, such as tool scope, dangerous-command blocking, pool depth, or tool-result size budgeting.
_Avoid_: Guard, completion audit, workflow policy, soft prompt rule

**Acceptance Check**:
An optional, user- or skill-triggered review of goals, specs, or verification. It is not a per-turn runtime gate.
_Avoid_: Completion auditor, stop hook by default, mandatory verify every turn


**Resident Widget**:
A bounded, host-rendered status surface for one capability, projected as plain text lines into the Main Session chrome and kept current while that capability has visible work.
_Avoid_: Unified session chrome, shared dashboard, transcript card, notify toast, merged status panel

**Widget Producer**:
The single extension that owns one Resident Widget key and is the only writer of that key's lines. Producers do not depend on other extensions' code or state.
_Avoid_: Shared display extension, cross-extension status bus, bundle-owned chrome

**Display Contract**:
The host-facing rule that a Widget Producer may only publish bounded plain text lines (or clear them), never host-private UI factories, when it needs the same resident surface on both TUI and Web.
_Avoid_: Component factory widget, TUI-only overlay, piweb-specific renderer API

**Host Chrome**:
The Main Session shell surface owned by the host (TUI or piweb) that places and refreshes Resident Widgets. Extensions publish lines into it; they do not own layout across capabilities.
_Avoid_: Extension-owned dashboard, bundle chrome, cross-producer layout manager

**Input-Adjacent Chrome**:
The host slot next to the message editor where Resident Widgets stay visible while the user works. On current Pi hosts this is the below-editor placement shared by TUI and Web.
_Avoid_: Transcript-top strip, floating overlay, shell-specific placement fork

**Conversation Side Dock**:
A host-owned slot inside the same conversation view, to the left or right of the transcript/editor column, for Resident Widgets. It is not a separate page and not the session-list sidebar.
_Avoid_: Session list sidebar, separate tool window, producer-owned side panel

**Host Stack Order**:
The host-determined visual order of multiple Resident Widgets in one chrome slot. Widget Producers do not coordinate order with each other.
_Avoid_: Cross-extension stack convention, key-name collusion, update-timing order hacks

**Bounded Projection**:
The finite plain-text lines a Widget Producer publishes for one Resident Widget. When items exceed the budget, the producer keeps a short summary and ends with an explicit remainder line such as `+N more` rather than silently dropping work.
_Avoid_: Full list dump, middle ellipsis only, relying on host truncation as the primary UX

**Idle Compact Form**:
The count-only one-line Resident Widget shape used when Role Subagents are only idle (pooled for reuse, not starting/streaming), e.g. `Subagents: 2 idle`. It is UI density only; it does not replace tool list/result or completion notices as the Main Session's source of pool truth.
_Avoid_: Idle id roster in the widget, hiding the pool from the model, treating the widget as agent state, full idle multi-line dump

**Visible Work**:
The condition under which a Resident Widget may occupy Host Chrome. For Role Subagents: `starting`/`streaming` use the full Bounded Projection; idle-only pool sessions still count as Visible Work but only as Idle Compact Form; briefly post-completion rows may remain via producer-local TTL; when no live sessions and no TTL-visible rows remain, the widget is cleared. For todos: incomplete or still-shown tasks.
_Avoid_: Session-long empty placeholder, always-on chrome, per-tool-turn-only flash, treating idle as model-invisible pool state