/**
 * mode-widget — TUI view layer for current agent mode indicator.
 *
 * initModeWidget renders the initial mode. The view update is wired
 * by pi.ts via closure (no module-level context state).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "mode-indicator";

export function initModeWidget(ctx: ExtensionContext, initialMode: string): void {
  setWidget(ctx, initialMode);
}

export function destroyModeWidget(ctx: ExtensionContext): void {
  try {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {}
}

function setWidget(ctx: ExtensionContext, mode: string): void {
  try {
    ctx.ui.setWidget(WIDGET_KEY, [`Mode: ${mode}`]);
  } catch {}
}
