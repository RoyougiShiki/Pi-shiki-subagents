/**
 * IntentGate compliance hook.
 *
 * Checks whether the assistant's previous response declared intent
 * ("Intent: [classification] → [routing]") before taking action.
 * Injects a reminder into the current user message if the declaration
 * is missing.
 *
 * Runs as experimental.chat.messages.transform so the model sees the
 * reminder before generating its next response.
 */

import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

const INTENT_PATTERN = /Intent:\s*\[/;

const REMINDER =
  '\n\n<internal_reminder>\n' +
  '[IntentGate] Your last response did not include an intent declaration.\n' +
  "Before your next action, analyze the user's true intent and output:\n" +
  '> "Intent: [classification] → [routing decision]"\n' +
  'Keep it one line. Then act accordingly.\n' +
  '</internal_reminder>';

export function createIntentGuardHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      const messages = output.messages as MessageWithParts[];
      if (messages.length < 2) return;

      // Find the last assistant message
      const lastAssistant = findLastAssistant(messages);
      if (!lastAssistant) return;

      // Check if it already has an Intent declaration
      const lastText = getTextFromMessage(lastAssistant);
      if (INTENT_PATTERN.test(lastText)) return; // Compliant — skip

      // Only inject for orchestrator
      const lastUser = findLastUser(messages);
      if (!lastUser) return;
      if (lastUser.info.agent && lastUser.info.agent !== 'orchestrator') return;

      // Append reminder to the last user message
      const textPart = lastUser.parts.find(
        (p) => p.type === 'text' && typeof p.text === 'string',
      );
      if (!textPart || typeof textPart.text !== 'string') return;
      if (textPart.text.includes(REMINDER.trim().slice(0, 40))) return; // Already injected

      textPart.text += REMINDER;
    },
  };
}
