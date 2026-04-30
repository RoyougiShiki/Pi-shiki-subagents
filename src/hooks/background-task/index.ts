/**
 * Background Task Hook
 *
 * Integrates the SlimBackgroundManager into the plugin system, exposing
 * task/background_output/background_cancel tools for the orchestrator.
 * Mirrors OMO's background task capabilities in a lightweight form.
 */

import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import { log } from '../../utils/logger'
import {
  type BackgroundTask,
  SlimBackgroundManager,
} from '../../utils/background-task'

const HOOK_NAME = 'background-task'

const z = tool.schema

/** Default agent when subagent_type is not specified. */
const DEFAULT_AGENT = 'explorer'

interface TaskToolArgs {
  description?: string
  prompt?: string
  category?: string
  subagent_type?: string
  load_skills?: string[]
  run_in_background?: boolean
  session_id?: string
}

interface BackgroundOutputArgs {
  task_id: string
  full_session?: boolean
  message_limit?: number
  since_message_id?: string
  include_tool_results?: boolean
  incremental?: boolean
}

interface BackgroundCancelArgs {
  taskId?: string
  all?: boolean
}

/**
 * Creates the background-task hook, providing tools for launching and
 * managing background sub-agent tasks.
 *
 * @param ctx - Plugin input context with client access.
 * @returns Hook with event handler, tool definitions, and message transform.
 */
export function createBackgroundTaskHook(ctx: PluginInput): {
  event: (input: {
    event: { type: string; properties?: Record<string, unknown> }
  }) => Promise<void>
  tools: {
    task: ToolDefinition
    background_output: ToolDefinition
    background_cancel: ToolDefinition
  }
  handleMessagesTransform: (output: {
    messages: Array<{
      info: { role?: string; sessionID?: string; agent?: string }
      parts: Array<{ type: string; text?: string }>
    }>
  }) => Promise<void>
} {
  const pendingNotifications: string[] = []
  const lastConsumedMessageByTask = new Map<string, string>()
  const bgManager = new SlimBackgroundManager(ctx, {
    onComplete: (task) => {
      const label = task.description || task.id

      // Actively inject notification into parent session (like OMO)
      // so the orchestrator sees it without waiting for user input.
      const notificationText = `[BG DONE] Task ${task.id} (${label}) finished with status: ${task.status}. Use background_output(task_id="${task.id}") to retrieve results.`
      const parentSessionID = task.parentSessionID

      const sessionClient = ctx.client.session as unknown as {
        promptAsync: (args: unknown) => Promise<unknown>
      }

      sessionClient
        .promptAsync({
          path: { id: parentSessionID },
          body: {
            parts: [{ type: 'text', text: `<system-reminder>\n${notificationText}\n</system-reminder>` }],
          },
        })
        .catch((err: unknown) => {
          log(`[${HOOK_NAME}] Active notification failed, falling back to passive injection`, {
            taskId: task.id,
            parentSessionID,
            error: err instanceof Error ? err.message : String(err),
          })
          // Fallback: queue for passive injection via handleMessagesTransform
          pendingNotifications.push(`${task.id} (${label})`)
        })
    },
  })
  bgManager.startPolling(8_000)

  // ── task tool ────────────────────────────────────────────────────

  const taskTool = tool({
    description: `Spawn a sub-agent task. Use run_in_background=true for async execution.

Returns task_id for background tasks. Use background_output to check results.`,
    args: {
      description: z
        .string()
        .optional()
        .describe('Short description of the task'),
      prompt: z.string().describe('The task prompt / instructions'),
      category: z
        .string()
        .optional()
        .describe('Task category (quick, visual-engineering, etc.)'),
      subagent_type: z
        .string()
        .optional()
        .describe(
          'Agent type to use (explore, librarian, oracle, hephaestus, metis, momus, custom)',
        ),
      load_skills: z
        .array(z.string())
        .optional()
        .describe('Skills to load for the sub-agent'),
      run_in_background: z
        .boolean()
        .optional()
        .describe('Run asynchronously (default: false)'),
      session_id: z
        .string()
        .optional()
        .describe('Continue an existing session by ID'),
    },
    async execute(args: TaskToolArgs, toolContext?: unknown) {
      const ctx_ = toolContext as { sessionID?: string } | undefined
      const parentSessionId = ctx_?.sessionID

      if (!parentSessionId) {
        return 'Error: no parent session ID available in tool context.'
      }

      // Resume an existing session by re-sending a prompt to it
      if (args.session_id) {
        const existingTask = bgManager.getTask(args.session_id)
        if (!existingTask) {
          // Not a tracked background task — try to find by session ID
          const bySession = bgManager.findBySession(args.session_id)
          if (!bySession) {
            return `Task ${args.session_id} not found or already completed.`
          }
        }

        // Re-prompt the existing session
        try {
          await ctx.client.session.prompt({
            path: { id: args.session_id },
            body: {
              parts: [{ type: 'text', text: args.prompt ?? '' }],
            },
          })
          log(`[${HOOK_NAME}] Resumed session`, {
            sessionId: args.session_id,
          })
          return [
            'Task resumed.',
            '',
            `session_id: ${args.session_id}`,
            '',
            'Continuation strategy: reusing the existing child session so prior context stays intact.',
          ].join('\n')
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          log(`[${HOOK_NAME}] Resume failed`, {
            sessionId: args.session_id,
            error: msg,
          })
          return [
            `Failed to resume session ${args.session_id}: ${msg}`,
            '',
            'Recommended next step: retry with the same session_id after fixing the issue so you keep existing sub-agent context.',
          ].join('\n')
        }
      }

      const agent = args.subagent_type ?? DEFAULT_AGENT

      // Launch a background (async) task
      if (args.run_in_background === true) {
        const launched = await bgManager.launch({
          description: args.description ?? '',
          prompt: args.prompt ?? '',
          agent,
          parentSessionID: parentSessionId,
        })

        log(`[${HOOK_NAME}] Launched background task`, {
          taskId: launched.id,
          description: args.description,
        })

        return [
          'Task created.',
          '',
          `task_id: ${launched.id}`,
          `session_id: ${launched.sessionID ?? 'pending'}`,
          '',
          'This is a background child session. When it finishes, use background_output(task_id="...", incremental=true) for new output only, or full_session=true for the full transcript.',
        ].join('\n')
      }

      // Foreground (synchronous) task — still goes through the manager
      // for tracking, but the caller blocks on the result.
      const launched = await bgManager.launch({
        description: args.description ?? '',
        prompt: args.prompt ?? '',
        agent,
        parentSessionID: parentSessionId,
      })

      log(`[${HOOK_NAME}] Launched foreground task`, {
        taskId: launched.id,
        description: args.description,
      })

      return [
        'Task created.',
        '',
        `task_id: ${launched.id}`,
        `session_id: ${launched.sessionID ?? 'pending'}`,
        '',
        `[This is a synchronous task — results will appear when complete. Use background_output(task_id="${launched.id}") to check status.]`,
        'If you want the same child agent to continue later, reuse session_id rather than creating a fresh task.',
      ].join('\n')
    },
  })

  // ── background_output tool ───────────────────────────────────────

  const background_output = tool({
    description:
      'Get output from background task. Use incremental=true for new output since last check, or full_session=true for full transcript. System notifies on completion via <system-reminder>.',
    args: {
      task_id: z.string().describe('Task ID to get output from'),
      full_session: z
        .boolean()
        .optional()
        .describe('Return full session messages (default: false)'),
      message_limit: z
        .number()
        .optional()
        .describe('Max messages to return (capped at 100)'),
      since_message_id: z
        .string()
        .optional()
        .describe('Return messages after this message ID (exclusive)'),
      include_tool_results: z
        .boolean()
        .optional()
        .describe('Include tool results in full session output'),
      incremental: z
        .boolean()
        .optional()
        .describe(
          'When true, return only new messages since the last background_output call for this task (recommended for follow-up checks)',
        ),
    },
    async execute(args: BackgroundOutputArgs) {
      const bgTask: BackgroundTask | undefined = bgManager.getTask(
        args.task_id,
      )

      if (!bgTask) {
        return `Task ${args.task_id} not found`
      }

      if (bgTask.status === 'running' || bgTask.status === 'pending') {
        return `Task is still running (${bgTask.toolCalls} tool calls so far). No final output yet. Check back later.`
      }

      if (
        bgTask.status === 'completed' ||
        bgTask.status === 'error' ||
        bgTask.status === 'interrupt'
      ) {
        if (!bgTask.sessionID) {
          return `Task ${args.task_id} ${bgTask.status} but no session ID recorded.`
        }

        // Return error message directly for errored tasks
        if (bgTask.status === 'error' && bgTask.error) {
          return [
            `Task ${args.task_id} failed: ${bgTask.error}`,
            '',
            bgTask.sessionID
              ? `Continuation available: task(session_id="${bgTask.sessionID}", prompt="Continue: <your follow-up>")`
              : 'No continuation session was recorded for this task.',
          ].join('\n')
        }

        try {
          const messages = await ctx.client.session.messages({
            path: { id: bgTask.sessionID },
          })

          const messageList = messages.data as Array<{
            info?: { role?: string; id?: string }
            parts?: Array<{ type?: string; text?: string }>
          }>

          const limit = Math.min(args.message_limit ?? 100, 100)
          let filtered = messageList

          const explicitSinceId = args.since_message_id
          const consumedSinceId = args.incremental
            ? lastConsumedMessageByTask.get(args.task_id)
            : undefined
          const effectiveSinceId = explicitSinceId ?? consumedSinceId

          if (effectiveSinceId) {
            const idx = filtered.findIndex((m) => m.info?.id === effectiveSinceId)
            if (idx >= 0) {
              filtered = filtered.slice(idx + 1)
            }
          }

          if (args.full_session) {
            filtered = filtered.slice(-limit)

            const lastId = filtered.at(-1)?.info?.id
            if (args.incremental && lastId) {
              lastConsumedMessageByTask.set(args.task_id, lastId)
            }

            const result = filtered
              .map((m) => {
                const role = m.info?.role ?? 'unknown'
                const text = (m.parts ?? [])
                  .filter((p) => p.type === 'text')
                  .map((p) => p.text ?? '')
                  .join('')
                return `[${role}] ${text}`
              })
              .join('\n\n')

            if (!result) {
              return args.incremental
                ? `No new output since last check for task ${args.task_id}.`
                : `(No messages in session ${bgTask.sessionID})`
            }

            const header = args.incremental
              ? `New session output since last check for task ${args.task_id}:`
              : `Full session output for task ${args.task_id}:`

            return `${header}\n\n${result}`
          }

          // Default: extract last assistant message
          const assistantMessages = filtered.filter(
            (m) => m.info?.role === 'assistant',
          )

          const lastAssistant = assistantMessages
            .slice()
            .reverse()
            .at(0)

          if (lastAssistant?.parts) {
            const text = lastAssistant.parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .join('')

            if (args.incremental && lastAssistant.info?.id) {
              lastConsumedMessageByTask.set(args.task_id, lastAssistant.info.id)
            }

            if (!text) {
              return args.incremental
                ? `No new assistant text output since last check for task ${args.task_id}.`
                : `(No assistant output in session ${bgTask.sessionID})`
            }

            return args.incremental
              ? `New assistant output since last check for task ${args.task_id}:\n\n${text}`
              : text
          }

          return args.incremental
            ? `No new assistant output since last check for task ${args.task_id}.`
            : `(No assistant output in session ${bgTask.sessionID})`
        } catch (error) {
          log(`[${HOOK_NAME}] Failed to fetch messages`, {
            taskId: args.task_id,
            sessionID: bgTask.sessionID,
            error: error instanceof Error ? error.message : String(error),
          })
          return `Failed to retrieve task output: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      return `Task ${args.task_id} status: ${bgTask.status}`
    },
  })

  // ── background_cancel tool ───────────────────────────────────────

  const background_cancel = tool({
    description: 'Cancel running background task(s).',
    args: {
      taskId: z
        .string()
        .optional()
        .describe('Specific task ID to cancel'),
      all: z
        .boolean()
        .optional()
        .describe('Cancel all running tasks (default: false)'),
    },
    async execute(args: BackgroundCancelArgs) {
      if (args.all) {
        const active = bgManager.getActiveTasks()
        if (active.length === 0) {
          return 'No running tasks to cancel.'
        }

        for (const t of active) {
          await bgManager.cancelTask(t.id)
          log(`[${HOOK_NAME}] Cancelled task`, { taskId: t.id })
        }

        const resumable = active
          .filter((t) => t.sessionID)
          .map(
            (t) =>
              `- ${t.id}: reuse session_id="${t.sessionID}" with task(prompt="Continue: ...") if you want to continue from the same child-session context.`,
          )
          .join('\n')

        return [
          `Cancelled ${active.length} task(s): ${active.map((t) => t.id).join(', ')}`,
          '',
          resumable ? `Continuation options:\n${resumable}` : 'No resumable child sessions were recorded.',
        ].join('\n')
      }

      if (args.taskId) {
        const cancelled = await bgManager.cancelTask(args.taskId)
        if (!cancelled) {
          return `Task ${args.taskId} not found or already completed.`
        }
        log(`[${HOOK_NAME}] Cancelled task`, { taskId: args.taskId })
        const cancelledTask = bgManager.getTask(args.taskId)
        return [
          `Task ${args.taskId} cancelled.`,
          '',
          cancelledTask?.sessionID
            ? `Continuation available: task(session_id="${cancelledTask.sessionID}", prompt="Continue: <your follow-up>")`
            : 'No continuation session was recorded for this task.',
        ].join('\n')
      }

      return 'No task specified. Provide taskId or set all=true.'
    },
  })

  // ── event handler ────────────────────────────────────────────────

  async function handleEvent(input: {
    event: { type: string; properties?: Record<string, unknown> }
  }): Promise<void> {
    bgManager.handleEvent(input.event)
  }

  // ── passive fallback injection ──────────────────────────────────
  // Only used when active promptAsync injection fails.
  // Primary notification is handled by onComplete → promptAsync.

  async function handleMessagesTransform(output: {
    messages: Array<{
      info: { role?: string; sessionID?: string; agent?: string }
      parts: Array<{ type: string; text?: string }>
    }>
  }): Promise<void> {
    if (pendingNotifications.length === 0) return

    for (let i = output.messages.length - 1; i >= 0; i -= 1) {
      const message = output.messages[i]
      if (message.info.role !== 'user') continue
      if (message.info.agent && message.info.agent !== 'orchestrator') return

      const textPart = message.parts.find(
        (part) => part.type === 'text' && typeof part.text === 'string',
      )
      if (!textPart || typeof textPart.text !== 'string') return
      if (textPart.text.includes('<system-reminder>')) return

      const done = pendingNotifications.splice(0)
      textPart.text = `${textPart.text}\n\n<system-reminder>\n[BG DONE] ${done.length} task(s) finished: ${done.join('; ')}. Use background_output(task_id="...") to retrieve results.\n</system-reminder>`
      return
    }
  }

  return {
    event: handleEvent,
    tools: {
      task: taskTool,
      background_output,
      background_cancel,
    },
    handleMessagesTransform,
  }
}
