/**
 * Shared factory for creating "declaration gates" — hard script-side
 * enforcement that LLM responses contain a required declaration prefix
 * before tool execution.
 *
 * @module declaration-gate/gate-factory
 */

import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DeclarationGateConfig {
  /** Human-readable label for logging / debugging. */
  name: string;

  /**
   * RegExp that the declaration MUST match (checked against the last assistant
   * message text). Typically anchored at line-start with the `m` flag:
   *
   *   /^APPROVED:/m
   */
  checkPattern: RegExp;

  /**
   * Optional RegExp that, if matched, explicitly sets state to `false`.
   * Useful for negative markers like `NOT_APPROVED`.
   */
  notPattern?: RegExp;

  /**
   * Instruction text injected into the last user message (once per session)
   * as an `<internal_reminder>` block.
   */
  instruction: string;

  /** Tool names that should be blocked when the gate is closed. */
  gatedTools: string[];

  /** Error message thrown when a gated tool is called while the gate is closed. */
  blockMessage: string;

  /**
   * If `true`, the very first assistant message of the session is also
   * required to contain the declaration prefix.  When `false` (the default)
   * the first assistant turn is given a pass — common for approval gates
   * where the first response proposes options without a declaration.
   *
   * @default false
   */
  requirePrefixFromFirstMessage?: boolean;

  /**
   * Optional callback.  When it returns `true`, the gate is bypassed
   * (all tool executions proceed without checking).  Useful for
   * suppressing the gate during internal loops (e.g. the Ralph
   * sub-agent validation loop).
   */
  isRalphLoopActive?: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type TransformInput = Record<string, never>;

export interface TransformOutput {
  messages: unknown[];
}

export interface BeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
  [key: string]: unknown;
}

export interface BeforeOutput {
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeclarationGateReturn {
  'experimental.chat.messages.transform': (
    input: TransformInput,
    output: TransformOutput,
  ) => Promise<void>;
  'tool.execute.before': (
    input: BeforeInput,
    output: BeforeOutput,
  ) => Promise<void>;
}

export function createDeclarationGate(
  config: DeclarationGateConfig,
): DeclarationGateReturn {
  const stateMap = new Map<string, boolean>();
  const injected = new Set<string>();

  return {
    /**
     * Hook: `experimental.chat.messages.transform`
     *
     * 1. Extracts a session ID from message info blocks.
     * 2. Injects the declaration instruction into the last user message
     *    (once per session).
     * 3. Checks the last assistant message for the declaration pattern
     *    and updates the per-session boolean state accordingly.
     */
    'experimental.chat.messages.transform': async (
      _input: TransformInput,
      output: TransformOutput,
    ): Promise<void> => {
      const messages = output.messages as MessageWithParts[];
      if (messages.length < 2) return;

      const lastUser = findLastUser(messages);
      if (!lastUser) return;

      // Only process orchestrator messages
      if (lastUser.info.agent && lastUser.info.agent !== 'orchestrator') return;

      // --- extract session ID ---
      let sessionId = '';
      for (const m of messages) {
        if (m.info.sessionID) {
          sessionId = m.info.sessionID;
          break;
        }
      }
      if (!sessionId) return;

      // --- inject instruction once per session ---
      if (!injected.has(sessionId)) {
        const textPart = lastUser.parts.find(
          (p) => p.type === 'text' && typeof p.text === 'string',
        );
        if (textPart && typeof textPart.text === 'string') {
          textPart.text += `\n\n<internal_reminder>\n${config.instruction}\n</internal_reminder>`;
        }
        injected.add(sessionId);
      }

      // --- check last assistant message for declaration ---
      const lastAssistant = findLastAssistant(messages);
      if (!lastAssistant) return;

      const asstText = getTextFromMessage(lastAssistant);

      // 1. Negative pattern (explicit rejection) takes priority.
      if (config.notPattern?.test(asstText)) {
        stateMap.set(sessionId, false);
        return;
      }

      // 2. Check for the required declaration.
      if (config.checkPattern.test(asstText)) {
        stateMap.set(sessionId, true);
        return;
      }

      // 3. No pattern matched.
      // The instruction was already injected into the user message BEFORE
      // the last assistant response was generated. The LLM has seen it.
      // If the response still lacks the declaration, it's a violation.
      stateMap.set(sessionId, false);
    },

    /**
     * Hook: `tool.execute.before`
     *
     * Blocks execution of gated tools when the per-session state is `false`.
     * Optionally bypasses the gate when a Ralph loop is active.
     */
    'tool.execute.before': async (
      input: BeforeInput,
      output: BeforeOutput,
    ): Promise<void> => {
      // Skip when the Ralph sub-agent validation loop is running.
      if (config.isRalphLoopActive?.()) return;

      // Only gate the configured tools.
      if (!config.gatedTools.includes(input.tool)) return;

      const sessionId = input.sessionID;
      if (!sessionId) return;

      if (stateMap.get(sessionId) === false) {
        output.args = undefined;
        throw new Error(config.blockMessage);
      }
    },
  };
}
