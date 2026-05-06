import { PHASE_REMINDER_TEXT } from '../../config/constants';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import type { MessageWithParts } from '../shared-message-types';

export const PHASE_REMINDER = `<internal_reminder>${PHASE_REMINDER_TEXT}</internal_reminder>`;

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;

      if (messages.length === 0) {
        return;
      }

      let lastUserMessageIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex === -1) {
        return;
      }

      const lastUserMessage = messages[lastUserMessageIndex];
      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const textPartIndex = lastUserMessage.parts.findIndex(
        (p) => p.type === 'text' && p.text !== undefined,
      );

      if (textPartIndex === -1) {
        return;
      }

      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      if (originalText.includes(SLIM_INTERNAL_INITIATOR_MARKER)) {
        return;
      }
      if (originalText.includes(PHASE_REMINDER)) {
        return;
      }

      lastUserMessage.parts[textPartIndex].text =
        `${originalText}\n\n---\n\n${PHASE_REMINDER}`;
    },
  };
}
