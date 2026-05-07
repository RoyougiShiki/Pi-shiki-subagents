/**
 * Clarify Gate.
 *
 * Requires the LLM to declare "PROCEEDING:" or "CLARIFYING:" at the start
 * of a line when in a clarification loop. Tracks rounds via CLARIFYING
 * declarations and blocks edit/write tools when rounds exceed 3 without a
 * PROCEEDING declaration.
 *
 * This replaces the old clarify-loop that counted question marks with a
 * more reliable LLM-declaration-based approach.
 */

import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

const MAX_CLARIFY_ROUNDS = 3;

const INSTRUCTION = `[ClarifyGate]
If you have enough information to begin implementing, start your response with:
> "PROCEEDING: <brief description>"

If you still need more information from the user, start your response with:
> "CLARIFYING: <what you need>"

You have a maximum of ${MAX_CLARIFY_ROUNDS} CLARIFYING rounds. After that, edit/write tools will be blocked
until you declare PROCEEDING. Make your clarifying questions targeted and efficient.`;

const BLOCK_MESSAGE =
  '[ClarifyGate] You have exceeded the maximum clarify rounds without declaring PROCEEDING.\n' +
  'Synthesize what you know and declare "PROCEEDING: <description>", or ask a final\n' +
  'targeted question. Edit/write tools are blocked until you declare PROCEEDING.';

export function createClarifyGateHook(options?: {
  isRalphLoopActive?: () => boolean;
}) {
  // SessionId → clarify round count
  const clarifyRounds = new Map<string, number>();
  const injected = new Set<string>();

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      const messages = output.messages as MessageWithParts[];
      if (messages.length < 2) return;

      // Only process orchestrator messages
      const lastUser = findLastUser(messages);
      if (!lastUser) return;
      if (lastUser.info.agent && lastUser.info.agent !== 'orchestrator') return;

      // Extract session ID
      let sessionId = '';
      for (const m of messages) {
        if (m.info.sessionID) {
          sessionId = m.info.sessionID;
          break;
        }
      }
      if (!sessionId) return;

      // Inject instruction once per session
      if (!injected.has(sessionId)) {
        const textPart = lastUser.parts.find(
          (p) => p.type === 'text' && typeof p.text === 'string',
        );
        if (textPart && typeof textPart.text === 'string') {
          textPart.text += `\n\n<internal_reminder>\n${INSTRUCTION}\n</internal_reminder>`;
        }
        injected.add(sessionId);
      }

      // Check last assistant for declaration
      const lastAssistant = findLastAssistant(messages);
      if (!lastAssistant) return;

      const asstText = getTextFromMessage(lastAssistant);

      if (/^\s*PROCEEDING:\s/m.test(asstText)) {
        // LLM has enough info — reset clarify counter
        clarifyRounds.delete(sessionId);
        return;
      }

      if (/^\s*CLARIFYING:\s/m.test(asstText)) {
        // LLM needs more info — increment round counter
        const current = clarifyRounds.get(sessionId) ?? 0;
        const next = current + 1;
        clarifyRounds.set(sessionId, next);

        if (next >= MAX_CLARIFY_ROUNDS) {
          // Inject cap reminder into the last user message
          const userTextPart = lastUser.parts.find(
            (p) => p.type === 'text' && typeof p.text === 'string',
          );
          if (
            userTextPart &&
            typeof userTextPart.text === 'string' &&
            !userTextPart.text.includes('ClarifyGate] You have exceeded')
          ) {
            userTextPart.text +=
              '\n\n<internal_reminder>\n' +
              `[ClarifyGate] You have exceeded ${MAX_CLARIFY_ROUNDS} clarify rounds.\n` +
              'Synthesize what you know and declare PROCEEDING, or ask one final targeted question.\n' +
              '</internal_reminder>';
          }
        }
        return;
      }

      // Neither PROCEEDING nor CLARIFYING declared
      // If LLM has been clarifying, this is ambiguous — keep state as-was
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      // Skip blocking if Ralph loop active
      if (options?.isRalphLoopActive?.()) return;

      // Only gate significant implementation tools
      const gatedTools = new Set(['edit', 'Write', 'write', 'apply_patch']);
      if (!gatedTools.has(input.tool)) return;

      const sessionId = input.sessionID;
      if (!sessionId) return;

      // Block if rounds >= 3 (LLM stuck clarifying without proceeding)
      const rounds = clarifyRounds.get(sessionId) ?? 0;
      if (rounds >= MAX_CLARIFY_ROUNDS) {
        output.args = undefined;
        throw new Error(BLOCK_MESSAGE);
      }
    },
  };
}
