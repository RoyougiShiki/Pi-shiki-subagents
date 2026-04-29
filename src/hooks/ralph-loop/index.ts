/**
 * Ralph Loop — Hook Integration (Slim)
 *
 * Integrates the Ralph Loop self-referencing mechanism into OpenCode's
 * plugin event system. Watches `session.idle` events for completion
 * promise tags and injects continuation prompts when tasks are not done.
 */

import type { PluginInput } from '@opencode-ai/plugin'
import {
  createRalphLoopManager,
  HOOK_NAME,
  type RalphLoopState,
  type StartLoopOptions,
} from '../../utils/ralph-loop'
import { log } from '../../utils/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of an OpenCode plugin event. */
interface PluginEvent {
  type: string
  properties?: Record<string, unknown>
}

/** Input shape for the `event` hook. */
interface EventInput {
  event: PluginEvent
}

/** Shape of the plugin command input. */
interface CommandInput {
  command: string
  sessionID: string
  arguments: string
}

/** Shape of the plugin command output. */
interface CommandOutput {
  parts: Array<{ type: string; text?: string }>
}

/** Result returned by {@link createRalphLoopHook}. */
export interface RalphLoopHook {
  event: (input: EventInput) => Promise<void>
  startLoop: (sessionID: string, prompt: string, options?: StartLoopOptions) => boolean
  cancelLoop: (sessionID: string) => boolean
  getState: () => RalphLoopState | null
  handleCommand: (command: string, args: string, sessionID: string, output?: CommandOutput) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create the Ralph Loop hook that integrates with OpenCode's event system.
 *
 * @param ctx - Plugin context (provides `directory` and `client`).
 * @returns Hook object with `event` handler and control methods.
 */
export function createRalphLoopHook(ctx: PluginInput): RalphLoopHook {
  const manager = createRalphLoopManager(ctx)

  // Extract last assistant text from session messages
  function extractLastAssistantText(
    messages?: Array<{
      info?: { role?: string }
      parts?: Array<{ type?: string; text?: string }>
    }>,
  ): string | null {
    if (!messages || messages.length === 0) return null

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.info?.role !== 'assistant') continue

      const parts = msg.parts ?? []
      const textParts: string[] = []
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text)
        }
      }

      if (textParts.length > 0) {
        return textParts.join('\n')
      }
    }

    return null
  }

  // -----------------------------------------------------------------------
  // Event handler
  // -----------------------------------------------------------------------

  async function event(input: EventInput): Promise<void> {
    const event = input.event
    if (event.type !== 'session.status') return
    const props = event.properties as Record<string, unknown> | undefined
    const status = props?.status as { type?: string } | undefined
    if (status?.type !== 'idle') return

    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    const state = manager.getState()
    if (!state || !state.active) return
    if (state.session_id && state.session_id !== sessionID) return

    const messages = props?.messages as Array<{
      info?: { role?: string }
      parts?: Array<{ type?: string; text?: string }>
    }> | undefined
    const lastText = extractLastAssistantText(messages)

    if (!lastText) {
      log(`[${HOOK_NAME}] Session idle but no assistant text found`, {
        sessionID,
      })
      return
    }

    const completedPromise = manager.detectCompletion(lastText)

    if (completedPromise) {
      log(`[${HOOK_NAME}] Completion promise detected`, {
        sessionID,
        promise: completedPromise,
        iteration: state.iteration,
      })
      manager.clearState()
      return
    }

    log(`[${HOOK_NAME}] No completion promise — continuing loop`, {
      sessionID,
      iteration: state.iteration,
      maxIterations: state.max_iterations,
    })

    const updatedState = manager.incrementIteration()
    if (!updatedState) {
      log(`[${HOOK_NAME}] Loop ended (max iterations or inactive)`, {
        sessionID,
      })
      return
    }

    // Inject continuation prompt
    const continuationPrompt = manager.buildContinuationPrompt(updatedState)

    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: false,
          parts: [{ type: 'text', text: continuationPrompt }],
        },
      })
      log(`[${HOOK_NAME}] Continuation prompt injected`, {
        sessionID,
        iteration: updatedState.iteration,
      })
    } catch (err) {
      log(`[${HOOK_NAME}] Failed to inject continuation prompt`, {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -----------------------------------------------------------------------
  // Control methods
  // -----------------------------------------------------------------------

  function startLoop(
    sessionID: string,
    prompt: string,
    options?: StartLoopOptions,
  ): boolean {
    return manager.startLoop(sessionID, prompt, options)
  }

  function cancelLoop(sessionID: string): boolean {
    return manager.cancelLoop(sessionID)
  }

  function getState(): RalphLoopState | null {
    return manager.getState()
  }

  // -----------------------------------------------------------------------
  // Command handling
  // -----------------------------------------------------------------------

  async function handleCommand(
    command: string,
    args: string,
    sessionID: string,
    _output?: CommandOutput,
  ): Promise<boolean> {
    switch (command) {
      case 'ralph-loop': {
        if (!args.trim()) {
          log(`[${HOOK_NAME}] /ralph-loop requires a prompt argument`, {
            sessionID,
          })
          return false
        }
        return startLoop(sessionID, args.trim())
      }

      case 'ulw-loop': {
        if (!args.trim()) {
          log(`[${HOOK_NAME}] /ulw-loop requires a prompt argument`, {
            sessionID,
          })
          return false
        }
        return startLoop(sessionID, args.trim(), { ultrawork: true })
      }

      case 'cancel-ralph': {
        return cancelLoop(sessionID)
      }

      default:
        return false
    }
  }

  return {
    event,
    startLoop,
    cancelLoop,
    getState,
    handleCommand,
  }
}
