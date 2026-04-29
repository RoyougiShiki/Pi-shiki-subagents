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
  const bgManager = new SlimBackgroundManager(ctx)

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
          return `Task resumed.\n\ntask_id: ${args.session_id}`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          log(`[${HOOK_NAME}] Resume failed`, {
            sessionId: args.session_id,
            error: msg,
          })
          return `Failed to resume task ${args.session_id}: ${msg}`
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

        return `Task created.\n\ntask_id: ${launched.id}`
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

      return `Task created.\n\ntask_id: ${launched.id}\n\n[This is a synchronous task — results will appear when complete. Use background_output(task_id="${launched.id}") to check status.]`
    },
  })

  // ── background_output tool ───────────────────────────────────────

  const background_output = tool({
    description:
      'Get output from background task. Use full_session=true to fetch session messages with filters. System notifies on completion, so block=true rarely needed.',
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
    },
    async execute(args: BackgroundOutputArgs) {
      const bgTask: BackgroundTask | undefined = bgManager.getTask(
        args.task_id,
      )

      if (!bgTask) {
        return `Task ${args.task_id} not found`
      }

      if (bgTask.status === 'running' || bgTask.status === 'pending') {
        return `Task is still running (${bgTask.toolCalls} tool calls so far). Check back later.`
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
          return `Task ${args.task_id} failed: ${bgTask.error}`
        }

        try {
          const messages = await ctx.client.session.messages({
            path: { id: bgTask.sessionID },
          })

          const messageList = messages.data as Array<{
            info?: { role?: string; id?: string }
            parts?: Array<{ type?: string; text?: string }>
          }>

          if (args.full_session) {
            const limit = Math.min(args.message_limit ?? 100, 100)
            let filtered = messageList

            if (args.since_message_id) {
              const idx = filtered.findIndex(
                (m) => m.info?.id === args.since_message_id,
              )
              if (idx >= 0) {
                filtered = filtered.slice(idx + 1)
              }
            }

            filtered = filtered.slice(-limit)

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

            return result || `(No messages in session ${bgTask.sessionID})`
          }

          // Default: extract last assistant message
          const lastAssistant = messageList
            .slice()
            .reverse()
            .find((m) => m.info?.role === 'assistant')

          if (lastAssistant?.parts) {
            return lastAssistant.parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .join('')
          }

          return `(No assistant output in session ${bgTask.sessionID})`
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

        return `Cancelled ${active.length} task(s): ${active.map((t) => t.id).join(', ')}`
      }

      if (args.taskId) {
        const cancelled = await bgManager.cancelTask(args.taskId)
        if (!cancelled) {
          return `Task ${args.taskId} not found or already completed.`
        }
        log(`[${HOOK_NAME}] Cancelled task`, { taskId: args.taskId })
        return `Task ${args.taskId} cancelled.`
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

  // ── system reminder injection for pending background tasks ───────

  async function handleMessagesTransform(output: {
    messages: Array<{
      info: { role?: string; sessionID?: string; agent?: string }
      parts: Array<{ type: string; text?: string }>
    }>
  }): Promise<void> {
    // Find the last user message in the orchestrator session
    for (let i = output.messages.length - 1; i >= 0; i -= 1) {
      const message = output.messages[i]
      if (message.info.role !== 'user') continue
      if (message.info.agent && message.info.agent !== 'orchestrator') return

      const activeTasks = bgManager.getActiveTasks()
      if (activeTasks.length === 0) return

      // Build reminder for pending tasks
      const reminders = activeTasks
        .map(
          (t) =>
            `  - task_id: ${t.id} | ${t.description || '(no description)'} [${t.status}]`,
        )
        .join('\n')

      const reminder = [
        '<system-reminder>',
        `Background tasks still running (${activeTasks.length}):`,
        reminders,
        'Use background_output(task_id="...") to check results.',
        '</system-reminder>',
      ].join('\n')

      // Append to the last user message's text part
      const textPart = message.parts.find(
        (part) => part.type === 'text' && typeof part.text === 'string',
      )
      if (textPart && typeof textPart.text === 'string') {
        // Don't duplicate injection
        if (textPart.text.includes('<system-reminder>')) return
        textPart.text = `${textPart.text}\n\n${reminder}`
      }
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
