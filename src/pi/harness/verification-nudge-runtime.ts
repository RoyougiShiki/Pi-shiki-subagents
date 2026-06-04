import type { TaskItem } from "./verification-nudge";

export interface RuntimeTaskItem extends TaskItem {
  id: string;
}

export interface TaskToolStateUpdateInput {
  toolName: string;
  rawInput: Record<string, unknown>;
  contentText?: string;
  taskToolNames?: readonly string[];
}

export interface TaskToolStateUpdateResult {
  changed: boolean;
  tasks: RuntimeTaskItem[];
}

const DEFAULT_TASK_TOOL_NAMES = new Set(["todo"]);

function isTaskTool(toolName: string, configured?: readonly string[]): boolean {
  const names = configured ? new Set(configured) : DEFAULT_TASK_TOOL_NAMES;
  return names.has(toolName);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusField(value: unknown): TaskItem["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
}

function idField(rawInput: Record<string, unknown>, contentText?: string): string | undefined {
  const direct = rawInput.id;
  if (typeof direct === "number") return String(direct);
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const match = contentText?.match(/#(\d+)/);
  return match?.[1];
}

function contentField(rawInput: Record<string, unknown>, previous?: RuntimeTaskItem): string {
  return stringField(rawInput.subject) ?? stringField(rawInput.description) ?? previous?.content ?? "task";
}

function replaceTask(tasks: readonly RuntimeTaskItem[], next: RuntimeTaskItem): RuntimeTaskItem[] {
  const index = tasks.findIndex((task) => task.id === next.id);
  if (index < 0) return [...tasks, next];
  return tasks.map((task, i) => i === index ? next : task);
}

export function updateTaskStateFromToolResult(
  previousTasks: readonly RuntimeTaskItem[],
  input: TaskToolStateUpdateInput,
): TaskToolStateUpdateResult {
  if (!isTaskTool(input.toolName, input.taskToolNames)) {
    return { changed: false, tasks: [...previousTasks] };
  }

  const action = stringField(input.rawInput.action);
  if (!action) return { changed: false, tasks: [...previousTasks] };

  if (action === "clear") {
    return { changed: previousTasks.length > 0, tasks: [] };
  }

  const id = idField(input.rawInput, input.contentText);
  if (!id) return { changed: false, tasks: [...previousTasks] };

  if (action === "delete") {
    const tasks = previousTasks.filter((task) => task.id !== id);
    return { changed: tasks.length !== previousTasks.length, tasks };
  }

  if (action !== "create" && action !== "update") {
    return { changed: false, tasks: [...previousTasks] };
  }

  const previous = previousTasks.find((task) => task.id === id);
  const status = statusField(input.rawInput.status) ?? previous?.status ?? "pending";
  const next: RuntimeTaskItem = {
    id,
    content: contentField(input.rawInput, previous),
    status,
  };

  const tasks = replaceTask(previousTasks, next);
  const changed = !previous || previous.content !== next.content || previous.status !== next.status;
  return { changed, tasks };
}
