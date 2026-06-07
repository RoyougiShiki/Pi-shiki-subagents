import { createSubagentRunTreeViewFromSnapshots, type SubagentRunTreeView } from './subagent-run-view';
import {
  renderSubagentRunWidgetLines,
  type SubagentRunWidgetLineOptions,
} from './subagent-run-widget-lines';
import type { SubagentSessionSnapshot } from './subagent-session-contract';

export interface SubagentRunWidgetContext {
  ui: {
    setWidget(id: string, lines: string[] | undefined): void;
  };
}

export interface SubagentRunWidgetPool {
  getRunTreeView(options?: { now?: number }): SubagentRunTreeView;
  getSubagentSessionSnapshots?(): SubagentSessionSnapshot[];
  onRunStateChange(cb: () => void): () => void;
}

export interface SubagentRunWidgetOptions
  extends Omit<SubagentRunWidgetLineOptions, 'now'> {
  widgetId?: string;
  now?: () => number;
  refreshMs?: number | false;
}

export interface RegisteredSubagentRunWidget {
  refresh(): void;
  dispose(): void;
}

function sameLines(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

export function registerSubagentRunWidget(
  ctx: SubagentRunWidgetContext,
  pool: SubagentRunWidgetPool,
  options: SubagentRunWidgetOptions = {},
): RegisteredSubagentRunWidget {
  const widgetId = options.widgetId ?? 'omo-subagents';
  const now = options.now ?? (() => Date.now());
  let disposed = false;
  let lastLines: string[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const scheduleTimer = (visible: boolean) => {
    clearTimer();
    if (!visible || options.refreshMs === false || disposed) return;
    const refreshMs =
      typeof options.refreshMs === 'number' &&
      Number.isFinite(options.refreshMs)
        ? Math.max(250, Math.floor(options.refreshMs))
        : 1000;
    timer = setTimeout(render, refreshMs);
  };

  const getView = (timestamp: number): SubagentRunTreeView => {
    const snapshots = pool.getSubagentSessionSnapshots?.();
    if (snapshots)
      return createSubagentRunTreeViewFromSnapshots(snapshots, { now: timestamp });
    return pool.getRunTreeView({ now: timestamp });
  };
  const render = () => {
    if (disposed) return;
    const timestamp = now();
    const view = getView(timestamp);
    const lines = renderSubagentRunWidgetLines(view, {
      ...options,
      now: timestamp,
    });
    const nextLines = lines.length > 0 ? lines : undefined;
    const changed = !sameLines(lastLines, nextLines);
    if (changed) {
      lastLines = nextLines ? [...nextLines] : undefined;
      ctx.ui.setWidget(widgetId, nextLines);
    }
    scheduleTimer(Boolean(nextLines));
  };

  const unsubscribe = pool.onRunStateChange(render);
  render();

  return {
    refresh: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearTimer();
      if (lastLines) ctx.ui.setWidget(widgetId, undefined);
      lastLines = undefined;
    },
  };
}

let registeredSubagentRunWidget: RegisteredSubagentRunWidget | undefined;

export function ensureSubagentRunWidgetRegistered(
  ctx: SubagentRunWidgetContext,
  pool: SubagentRunWidgetPool,
  options: SubagentRunWidgetOptions & { force?: boolean } = {},
): RegisteredSubagentRunWidget {
  if (registeredSubagentRunWidget && !options.force) {
    registeredSubagentRunWidget.refresh();
    return registeredSubagentRunWidget;
  }
  registeredSubagentRunWidget?.dispose();
  const { force: _force, ...widgetOptions } = options;
  registeredSubagentRunWidget = registerSubagentRunWidget(
    ctx,
    pool,
    widgetOptions,
  );
  return registeredSubagentRunWidget;
}

export function disposeRegisteredSubagentRunWidget(): void {
  registeredSubagentRunWidget?.dispose();
  registeredSubagentRunWidget = undefined;
}
