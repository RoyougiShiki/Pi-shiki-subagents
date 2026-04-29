/**
 * Background Task Manager (Slim)
 *
 * Manages asynchronous background tasks that run in separate sessions.
 * Each task creates a child session via the OpenCode client, sends a
 * prompt via promptAsync, and tracks lifecycle state transitions
 * through session events.
 */

import type { PluginInput } from '@opencode-ai/plugin'
import { log } from './logger'

type OpencodeClient = PluginInput['client']

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle status of a background task. */
export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'interrupt'

/** Tracked state for a single background task. */
export interface BackgroundTask {
  /** Unique task identifier (prefixed `bg_`). */
  id: string
  /** Current lifecycle status. */
  status: BackgroundTaskStatus
  /** OpenCode session ID once the session has been created. */
  sessionID?: string
  /** Session that spawned this task. */
  parentSessionID: string
  /** Message ID in the parent session that triggered the task. */
  parentMessageID: string
  /** Agent name used for the prompt. */
  agent: string
  /** Short human-readable description. */
  description: string
  /** Full prompt text sent to the agent. */
  prompt: string
  /** Optional model override. */
  model?: { providerID: string; modelID: string }
  /** Timestamp when the task was queued. */
  queuedAt?: Date
  /** Timestamp when the session started processing. */
  startedAt?: Date
  /** Timestamp when the task reached a terminal state. */
  completedAt?: Date
  /** Error message if the task failed. */
  error?: string
  /** Number of tool-use calls observed via events. */
  toolCalls: number
  /** Timestamp of the last status update. */
  lastUpdate: Date
}

/** Input for launching a new background task. */
export interface LaunchInput {
  /** Short human-readable description. */
  description: string
  /** Full prompt text to send to the agent. */
  prompt: string
  /** Agent name to use. */
  agent: string
  /** Parent session ID that owns this task. */
  parentSessionID: string
  /** Message ID in the parent session (optional — generated if omitted). */
  parentMessageID?: string
  /** Optional model override. */
  model?: { providerID: string; modelID: string }
}

/** Shape of an OpenCode plugin event passed to {@link SlimBackgroundManager.handleEvent}. */
interface PluginEvent {
  type: string
  properties?: {
    sessionID?: string
    info?: { id?: string; parentID?: string }
    status?: { type?: string }
    part?: { type?: string; sessionID?: string }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a task ID: `bg_` + 8 hex characters. */
function generateTaskId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `bg_${hex}`
}

// ---------------------------------------------------------------------------
// SlimBackgroundManager
// ---------------------------------------------------------------------------

/**
 * Lightweight background task manager.
 *
 * Creates child sessions, sends prompts via `promptAsync`, and tracks
 * task lifecycle through OpenCode session events. Designed as a
 * simplified alternative to the full OMO BackgroundManager.
 *
 * @example
 * ```ts
 * const bg = new SlimBackgroundManager(ctx)
 * const task = await bg.launch({
 *   description: 'Search docs',
 *   prompt: '...',
 *   agent: 'explorer',
 *   parentSessionID: '...',
 * })
 * // Feed events from the plugin's event hook:
 * bg.handleEvent(event)
 * // Cancel if needed:
 * await bg.cancelTask(task.id)
 * ```
 */
export class SlimBackgroundManager {
  private client: OpencodeClient
  private directory: string
  private tasks = new Map<string, BackgroundTask>()
  private sessionIndex = new Map<string, string>() // sessionID → taskID
  private pollingTimer: ReturnType<typeof setInterval> | null = null
  private onComplete?: (task: BackgroundTask) => void

  constructor(
    ctx: PluginInput,
    options?: { onComplete?: (task: BackgroundTask) => void },
  ) {
    this.client = ctx.client
    this.directory = ctx.directory
    this.onComplete = options?.onComplete
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Launch a new background task.
   *
   * Creates a child session, records the task, and dispatches the prompt
   * via `promptAsync`. If the prompt call fails the task is marked as
   * `error` immediately.
   */
  async launch(input: LaunchInput): Promise<BackgroundTask> {
    const taskId = generateTaskId()
    const now = new Date()

    const task: BackgroundTask = {
      id: taskId,
      status: 'pending',
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID ?? taskId,
      agent: input.agent,
      description: input.description,
      prompt: input.prompt,
      model: input.model,
      queuedAt: now,
      toolCalls: 0,
      lastUpdate: now,
    }

    this.tasks.set(taskId, task)

    log('[background-task] Launching task', {
      taskId,
      agent: input.agent,
      description: input.description,
    })

    try {
      // Create child session
      const session = await this.client.session.create({
        body: {
          parentID: input.parentSessionID,
          title: `${input.description} (@${input.agent})`,
        },
        query: { directory: this.directory },
      })

      if (!session.data?.id) {
        throw new Error('Failed to create session: no session ID returned')
      }

      const sessionID = session.data.id
      task.sessionID = sessionID
      this.sessionIndex.set(sessionID, taskId)

      task.status = 'running'
      task.startedAt = new Date()
      task.lastUpdate = new Date()

      log('[background-task] Session created', { taskId, sessionID })

      // Dispatch prompt — fire-and-forget, but await the initial
      // call so we can catch immediate errors (e.g. invalid agent).
      // promptAsync is not in the plugin TypeScript types — cast at
      // runtime (same pattern as foreground-fallback/index.ts).
      const sessionClient = this.client.session as unknown as {
        promptAsync: (args: unknown) => Promise<unknown>
      }

      await sessionClient
        .promptAsync({
          path: { id: sessionID },
          body: {
            agent: input.agent,
            ...(input.model ? { model: input.model } : {}),
            parts: [{ type: 'text', text: input.prompt }],
          },
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          task.status = 'error'
          task.error = msg
          task.completedAt = new Date()
          task.lastUpdate = new Date()
          log('[background-task] promptAsync failed', {
            taskId,
            sessionID,
            error: msg,
          })
        })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      task.status = 'error'
      task.error = msg
      task.completedAt = new Date()
      task.lastUpdate = new Date()
      log('[background-task] Launch failed', { taskId, error: msg })
    }

    return task
  }

  /**
   * Retrieve a task by its ID.
   * Returns `undefined` if the task does not exist.
   */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * Find a task by its OpenCode session ID.
   * Returns `undefined` if no task matches.
   */
  findBySession(sessionID: string): BackgroundTask | undefined {
    const taskId = this.sessionIndex.get(sessionID)
    return taskId ? this.tasks.get(taskId) : undefined
  }

  /**
   * Cancel a running task by aborting its session.
   * Returns `true` if the task was successfully cancelled,
   * `false` if the task was not found or not in a cancellable state.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) {
      log('[background-task] Cancel failed — task not found', { taskId })
      return false
    }

    if (
      task.status === 'completed' ||
      task.status === 'error' ||
      task.status === 'cancelled'
    ) {
      log('[background-task] Cancel skipped — already terminal', {
        taskId,
        status: task.status,
      })
      return false
    }

    if (!task.sessionID) {
      // No session yet — mark cancelled directly
      task.status = 'cancelled'
      task.completedAt = new Date()
      task.lastUpdate = new Date()
      log('[background-task] Cancelled (no session)', { taskId })
      return true
    }

    try {
      await this.client.session.abort({ path: { id: task.sessionID } })
    } catch (err: unknown) {
      log('[background-task] Abort call failed (proceeding)', {
        taskId,
        sessionID: task.sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    task.status = 'cancelled'
    task.completedAt = new Date()
    task.lastUpdate = new Date()
    log('[background-task] Cancelled', { taskId, sessionID: task.sessionID })
    return true
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  /**
   * Process an OpenCode event and update task state accordingly.
   *
   * Recognised events:
   * - `session.status` (idle) → task completed
   * - `session.deleted` → task completed
   * - `message.part.updated` with `type: 'tool_use'` → increment toolCalls
   *
   * @param event - The raw event from the plugin's `event` hook.
   */
  handleEvent(event: PluginEvent): void {
    if (!event?.type) return

    // Resolve session ID — OpenCode uses two shapes:
    //   { properties: { sessionID } }   — subagent / task sessions
    //   { properties: { info: { id } } } — top-level session events
    const sessionID =
      event.properties?.sessionID ?? event.properties?.info?.id
    if (!sessionID) return

    const taskId = this.sessionIndex.get(sessionID)
    if (!taskId) return

    const task = this.tasks.get(taskId)
    if (!task) return

    // Ignore events after terminal state
    if (
      task.status === 'completed' ||
      task.status === 'error' ||
      task.status === 'cancelled'
    ) {
      return
    }

    const now = new Date()

    switch (event.type) {
      // Session became idle — task finished successfully
      case 'session.status': {
        if (event.properties?.status?.type === 'idle') {
          task.status = 'completed'
          task.completedAt = now
          task.lastUpdate = now
          log('[background-task] Completed (session idle)', {
            taskId,
            sessionID,
          })
          if (this.onComplete) {
            this.onComplete(task)
          }
        }
        break
      }

      // Session deleted — treat as completed
      case 'session.deleted': {
        task.status = 'completed'
        task.completedAt = now
        task.lastUpdate = now
        log('[background-task] Completed (session deleted)', {
          taskId,
          sessionID,
          status: task.status,
        })
        if (this.onComplete) {
          this.onComplete(task)
        }
        break
      }

      // Tool-use observed — increment counter
      case 'message.part.updated': {
        const partType = event.properties?.part?.type
        if (partType === 'tool_use' || partType === 'tool-result') {
          task.toolCalls += 1
          task.lastUpdate = now
        }
        break
      }
    }
  }

  /**
   * Resume a task by its session ID — returns the existing task if found.
   * Used when a tool receives `session_id` to continue an existing session.
   */
  resume(sessionID: string): BackgroundTask | undefined {
    return this.findBySession(sessionID)
  }

  /**
   * Return all tracked tasks (for inspection / UI display).
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
  }

  /**
   * Return only tasks in a non-terminal state.
   */
  getActiveTasks(): BackgroundTask[] {
    return this.getAllTasks().filter(
      (t) =>
        t.status === 'pending' ||
        t.status === 'running' ||
        t.status === 'interrupt',
    )
  }

  /**
   * Remove completed/errored/cancelled tasks older than `maxAgeMs`.
   * Returns the number of tasks pruned.
   */
  prune(maxAgeMs: number): number {
    const now = Date.now()
    let pruned = 0

    for (const [id, task] of this.tasks) {
      if (
        task.status !== 'completed' &&
        task.status !== 'error' &&
        task.status !== 'cancelled'
      ) {
        continue
      }

      const completedAt =
        task.completedAt?.getTime() ?? task.lastUpdate.getTime()
      if (now - completedAt > maxAgeMs) {
        if (task.sessionID) {
          this.sessionIndex.delete(task.sessionID)
        }
        this.tasks.delete(id)
        pruned++
      }
    }

    return pruned
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  /**
   * Start periodic polling of running task sessions.
   * Checks every `intervalMs` (default 8s) for completed/errored tasks
   * that were not caught by events.
   */
  startPolling(intervalMs = 8_000): void {
    if (this.pollingTimer) return

    this.pollingTimer = setInterval(() => {
      this.pollRunningTasks().catch((err) => {
        log('[background-task] Poll error', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      this.prune(30 * 60 * 1000) // prune tasks older than 30 min
    }, intervalMs)

    // Prevent the timer from keeping the process alive
    if (this.pollingTimer && typeof this.pollingTimer === 'object' && 'unref' in this.pollingTimer) {
      this.pollingTimer.unref()
    }

    log('[background-task] Polling started', { intervalMs })
  }

  /**
   * Stop the polling timer.
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer)
      this.pollingTimer = null
      log('[background-task] Polling stopped')
    }
  }

  /**
   * Check running tasks by querying their session status.
   * If a session is idle and no completion was detected, mark it completed.
   */
  private async pollRunningTasks(): Promise<void> {
    const running = this.getActiveTasks()
    if (running.length === 0) return

    const statusResult = await this.client.session.status().catch(() => null)
    if (!statusResult?.data) return

    const sessionStatusMap = new Map<string, string>()
    for (const [sid, status] of Object.entries(statusResult.data as Record<string, { type?: string }>)) {
      sessionStatusMap.set(sid, status?.type ?? 'unknown')
    }

    for (const task of running) {
      if (!task.sessionID) continue

      const sessionType = sessionStatusMap.get(task.sessionID)
      if (sessionType === 'idle') {
        // Session idle but no event caught it — complete now
        const now = new Date()
        task.status = 'completed'
        task.completedAt = now
        task.lastUpdate = now
        log('[background-task] Completed (poll detected idle)', {
          taskId: task.id,
          sessionID: task.sessionID,
        })
        if (this.onComplete) {
          this.onComplete(task)
        }
      } else if (!sessionType || sessionType === 'unknown') {
        // Session no longer exists — treat as completed
        const now = new Date()
        task.status = 'completed'
        task.completedAt = now
        task.lastUpdate = now
        log('[background-task] Completed (poll: session gone)', {
          taskId: task.id,
          sessionID: task.sessionID,
        })
        if (this.onComplete) {
          this.onComplete(task)
        }
      }
    }
  }
}
