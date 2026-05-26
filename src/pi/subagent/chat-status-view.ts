export type ChatStatusState = "working" | "waiting" | "idle" | "failed" | "dead" | "done";
export type ChatStatusScope = "workflow" | "pool" | "standalone";

export interface ChatStatusInput {
  name: string;
  state: ChatStatusState;
  scope: ChatStatusScope;
  startedAt?: number;
  /**
   * Timestamp of the most recent activity.
   * When provided, elapsed = now - lastUpdate (shows time since last activity).
   * Falls back to startedAt when absent.
   */
  lastUpdate?: number;
  now?: number;
  fallbackRecommended?: boolean;
}

export interface ChatStatusView {
  name: string;
  state: ChatStatusState;
  scope: ChatStatusScope;
  elapsed?: string;
  fallbackRecommended: boolean;
  listRow: string;
  bottomLine: string;
}

export interface ChatStatusGroup {
  scope: ChatStatusScope;
  title: "Workflow" | "Pool" | "Standalone";
  items: ChatStatusView[];
}

const GROUP_TITLES: Record<ChatStatusScope, ChatStatusGroup["title"]> = {
  workflow: "Workflow",
  pool: "Pool",
  standalone: "Standalone",
};

const GROUP_ORDER: ChatStatusScope[] = ["workflow", "pool", "standalone"];

function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeName(name: string): string {
  return name.trim() || "(unnamed)";
}

export function createChatStatusView(input: ChatStatusInput): ChatStatusView {
  const name = normalizeName(input.name);
  const elapsed = typeof (input.lastUpdate ?? input.startedAt) === "number"
    ? formatElapsedMs((input.now ?? Date.now()) - (input.lastUpdate ?? input.startedAt!))
    : undefined;
  const fallbackRecommended = input.fallbackRecommended === true
    || input.state === "failed"
    || input.state === "dead";

  const listParts = [name, input.state];
  if (elapsed) listParts.push(elapsed);

  const bottomParts = [name, input.state, input.scope];
  if (fallbackRecommended) bottomParts.push("fallback?");

  return {
    name,
    state: input.state,
    scope: input.scope,
    elapsed,
    fallbackRecommended,
    listRow: listParts.join(" · "),
    bottomLine: bottomParts.join(" · "),
  };
}

export function groupChatStatusViews(items: ChatStatusView[]): ChatStatusGroup[] {
  return GROUP_ORDER
    .map((scope) => ({
      scope,
      title: GROUP_TITLES[scope],
      items: items.filter((item) => item.scope === scope),
    }))
    .filter((group) => group.items.length > 0);
}
