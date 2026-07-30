# Independent Resident Widgets with host-owned chrome

We need Subagent and Todo progress visible and updating on both TUI and piweb without coupling those extensions. We rejected a unified multi-capability panel (it forces cross-extension dependency, a merge/bundle, or a shared display owner we do not want). Each capability is its own Widget Producer and writes only its Resident Widget key as bounded plain text lines under the Display Contract; factory widgets stay TUI-only and are not the dual-shell path.

We also rejected "fix display only inside the two extensions and never touch piweb." Producers can emit correct lines, but only Host Chrome can make those lines truly resident (placement, stacking, sticky dock, refresh). So work splits: extensions own producer correctness; minimal piweb/host changes are allowed only for chrome gaps the Display Contract already exposes (for example string[] widgets that render but do not stay usefully resident). Do not invent a shared status bus, do not merge repos just for UI, and do not make a pi bundle the display strategy unless product explicitly chooses that later.


## Placement

Dual-shell Resident Widgets default to Input-Adjacent Chrome (`belowEditor`). That matched the placement prototype (variant C): closest to Pi TUI todo and to other agents' in-progress chrome, and still expressible with today's Pi RPC / piweb contract (`aboveEditor` | `belowEditor` only).

A Conversation Side Dock (left/right of the transcript inside the same conversation view, not the session-list sidebar) is a reasonable Web target, but current piweb does not expose it: widgets only stack in the main column via `aboveEditor` / `belowEditor`. Getting a Codex-like in-conversation side dock requires Host Chrome work in piweb, not producer layout forks.

Host Stack Order is owned by the host, not by producers. Independent Widget Producers must not invent a cross-extension stacking convention; that would reintroduce coupling. Today TUI Map updates keep first-insert order, while piweb re-appends a key on every `setWidget`, so refresh can reshuffle. Accept that jitter until/unless the host sorts stably (for example by key). Crowding is controlled by each producer's own line budget and clear-when-empty behavior.

## Space without coupling

Dual-shell space control is producer line budgets plus host hard caps, not interactive chrome inside the widget slot. Current Pi RPC `setWidget` carries only `widgetKey`, `widgetLines`, and `aboveEditor|belowEditor`. piweb renders each widget as a static key header plus a full `pre` of lines—no collapse control, no per-widget scroll region, no tabs across keys. TUI string widgets are plain text lines with a host truncate at `MAX_WIDGET_LINES` (10) and an ellipsis line.

Producers may fake density with bounded summaries (counts, current item, `+N more`) and must clear when empty. Real collapse, scroll panes, below-slot tabs, or a Conversation Side Dock require Host Chrome changes and must not be assumed by Widget Producers. TUI-only component factories can be richer but are out of the dual-shell Display Contract.

## Line budget

Each Widget Producer targets a Bounded Projection of about 6-8 lines for dual-shell Resident Widgets, ending with an explicit `+N more` (or equivalent) when items do not fit. Silent hard truncation is not the primary UX. TUI may still apply a host safety cap around 10 lines plus `... (widget truncated)`; piweb currently does not cap line count, so producer budgets matter more on Web. Producers do not coordinate stack order or shared collapse/scroll/tab chrome.

## Lifecycle

A Resident Widget is shown only while its producer has Visible Work, refreshed when that work changes, and cleared as soon as nothing policy-visible remains. Empty session-long placeholders are rejected. Hiding on every tool-turn end is also rejected because background role subagents would disappear while still running. A short post-completion TTL may keep a just-finished run readable, then clear; that TTL is producer-local, not a cross-extension rule.

## First implementation slice

The first code change is this repo's Subagent Widget Producer only: publish Bounded Projections on Input-Adjacent Chrome (`belowEditor`), keep the Visible Work lifecycle, and leave Todo producers and piweb Host Chrome enhancements to separate work. No cross-extension dependency and no piweb prerequisite for this slice.

## Idle density vs agent reuse

Main Session pool reuse does not read the Resident Widget. It uses `omo_subagent` tool results (`list` / spawn / send), busy guards, and completion notify/follow-up. Changing widget density for idle agents is therefore UI-only and must not be treated as a control plane for reuse.

For this repo's Subagent producer we use density C: `starting` / `streaming` get the normal multi-line Bounded Projection; when the only live sessions are `idle`, show Idle Compact Form (about one summary line) instead of a full idle list; terminal runs may remain briefly via producer-local TTL; clear the widget when no live pool sessions and no TTL-visible rows remain. Full idle multi-line listing and widget-as-agent-state are rejected.

## Idle Compact Form content

Idle Compact Form is count-only, e.g. `Subagents: 2 idle`. No idle id/role roster in the widget. Identity for reuse stays on `omo_subagent list` and related tool results.