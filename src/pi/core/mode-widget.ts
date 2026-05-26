/**
 * mode-widget — TUI view layer for current agent mode indicator.
 *
 * Registers a callback that the logic layer (pi-modes.ts) calls
 * whenever the mode changes. Completely independent of the mode-switching logic.
 *
 * Architecture:
 *   pi-modes.ts (logic)  ──call──→  setModeChangeHandler (this file)
 *                                      ↓
 *                                   ctx.ui.setWidget()  (pi TUI API)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "mode-indicator";

// Module-level state: the view context is set once at session start.
let _viewCtx: ExtensionContext | null = null;

/**
 * Set the view context at session start and render the initial mode.
 * Must be called once per session from pi.ts session_start.
 */
export function initModeWidget(ctx: ExtensionContext, initialMode: string): void {
  _viewCtx = ctx;
  renderWidget(initialMode);
}

/**
 * Called by the logic layer when mode changes.
 * Pure view update — no logic, no state management.
 */
export function updateModeWidget(mode: string): void {
  renderWidget(mode);
}

function renderWidget(mode: string): void {
  if (!_viewCtx) return;
  try {
    _viewCtx.ui.setWidget(WIDGET_KEY, [`Mode: ${mode}`]);
  } catch {
    // Widget rendering is non-critical
  }
}

/**
 * Cleanup on session shutdown.
 */
export function destroyModeWidget(): void {
  if (!_viewCtx) return;
  try {
    _viewCtx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {}
  _viewCtx = null;
}
