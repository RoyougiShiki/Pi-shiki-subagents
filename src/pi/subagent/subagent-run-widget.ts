import {
  createSubagentRunTreeViewFromSnapshots,
  type SubagentRunTreeView,
} from './subagent-run-view';
import {
  renderSubagentRunWidgetLines,
  type SubagentRunWidgetLineOptions,
} from './subagent-run-widget-lines';
import type { SubagentSessionSnapshot } from './subagent-session-contract';

export interface SubagentRunWidgetContext {
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  ui: {
    setWidget(
      id: string,
      lines: string[] | undefined,
      options?: { placement?: 'aboveEditor' | 'belowEditor' },
    ): void;
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
  placement?: 'aboveEditor' | 'belowEditor';
  now?: () => number;
  refreshMs?: number | false;
  /** 面板归属会话：只显示该会话 spawn 的子代理。缺省 = 显示全部（单会话/兼容）。 */
  ownerSessionId?: string;
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
  const widgetId = options.widgetId ?? 'Subagents';
  const placement = options.placement ?? 'belowEditor';
  const includeTitle = options.includeTitle ?? ctx.mode !== 'rpc';
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
    if (snapshots) {
      // 多会话并存：每个会话的面板只显示自己 spawn 的子代理。
      const mine = options.ownerSessionId
        ? snapshots.filter((s) => s.ownerSessionId === options.ownerSessionId)
        : snapshots;
      return createSubagentRunTreeViewFromSnapshots(mine, {
        now: timestamp,
      });
    }
    return pool.getRunTreeView({ now: timestamp });
  };
  const render = () => {
    if (disposed) return;
    const timestamp = now();
    const view = getView(timestamp);
    const lines = renderSubagentRunWidgetLines(view, {
      ...options,
      now: timestamp,
      includeTitle,
    });
    const nextLines = lines.length > 0 ? lines : undefined;
    const changed = !sameLines(lastLines, nextLines);
    if (changed) {
      lastLines = nextLines ? [...nextLines] : undefined;
      ctx.ui.setWidget(widgetId, nextLines, { placement });
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
      if (lastLines) ctx.ui.setWidget(widgetId, undefined, { placement });
      lastLines = undefined;
    },
  };
}

// 每个会话一个面板：互不顶替（pi-web 多会话并存的修复）。
// 无 sessionId 时回退单例（TUI / 兼容路径）。
const registeredWidgets = new Map<string, RegisteredSubagentRunWidget>();

function widgetKey(sessionId: string | undefined): string {
  return sessionId ?? '__global__';
}

export function ensureSubagentRunWidgetRegistered(
  ctx: SubagentRunWidgetContext,
  pool: SubagentRunWidgetPool,
  options: SubagentRunWidgetOptions & { force?: boolean } = {},
): RegisteredSubagentRunWidget {
  const key = widgetKey(options.ownerSessionId);
  const existing = registeredWidgets.get(key);
  if (existing && !options.force) {
    existing.refresh();
    return existing;
  }
  existing?.dispose();
  const { force: _force, ...widgetOptions } = options;
  const widget = registerSubagentRunWidget(ctx, pool, widgetOptions);
  registeredWidgets.set(key, widget);
  return widget;
}

/** 会话销毁时清理该会话的面板；无参时清空全部。 */
export function disposeRegisteredSubagentRunWidget(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const widget of [...registeredWidgets.values()]) widget.dispose();
    registeredWidgets.clear();
    return;
  }
  registeredWidgets.get(widgetKey(sessionId))?.dispose();
  registeredWidgets.delete(widgetKey(sessionId));
}
