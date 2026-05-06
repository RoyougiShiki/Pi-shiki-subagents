/**
 * Clarify Loop Hook.
 *
 * Injects a reminder when the model appears to be acting on insufficient
 * context. Tracks clarification rounds per session and caps at 3 rounds
 * to prevent infinite loops.
 *
 * The hook does NOT try to detect "missing information" with NLP — that
 * is the model's job. Instead it:
 * - Detects when the assistant asked questions (contains "?")
 * - Tracks rounds to prevent infinite clarify loops
 * - Injects a "synthesize" cap reminder at round 3+
 */

const MAX_CLARIFY_ROUNDS = 3;

// Module-level state: sessionId → clarify round counter
const clarifyRounds = new Map<string, number>();

interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

function getTextFromMessage(msg: MessageWithParts): string {
  return (msg.parts ?? [])
    .filter((p): p is MessagePart & { text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function findLastAssistant(messages: MessageWithParts[]): MessageWithParts | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'assistant') {
      return messages[i];
    }
  }
  return null;
}

function findLastUser(messages: MessageWithParts[]): MessageWithParts | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'user') {
      return messages[i];
    }
  }
  return null;
}

/** Count question marks in a text (rough heuristic for "asked questions"). */
function hasQuestions(text: string): boolean {
  return text.includes('?');
}

/** Estimate if a text is substantive enough (rough proxy for "answered the question"). */
function isSubstantive(text: string): boolean {
  // Very short responses likely didn't provide enough context
  if (text.length < 30) return false;
  return true;
}

const CLARIFY_REMINDER =
  '\n\n<internal_reminder>\n' +
  '[Clarify Needed] The request may lack critical context (requirements, constraints, target users).\n' +
  'Consider asking targeted clarifying question(s) before implementing.\n' +
  'If the user\'s response remains vague, summarize what you know and proceed with best assumptions.\n' +
  '</internal_reminder>';

const CAP_REMINDER =
  '\n\n<internal_reminder>\n' +
  '[Clarify Cap] You have asked several clarifying questions. If the user has provided essential information,\n' +
  'synthesize what you know and proceed. Do not ask another round unless the user\'s latest response\n' +
  'introduces new ambiguity.\n' +
  '</internal_reminder>';

export function createClarifyLoopHook() {
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

      const lastAssistant = findLastAssistant(messages);
      const lastUserText = getTextFromMessage(lastUser);

      // Check: did assistant ask questions in the last response?
      if (lastAssistant) {
        const asstText = getTextFromMessage(lastAssistant);

        if (hasQuestions(asstText)) {
          // Assistant asked questions — this is a clarify round
          const currentRounds = clarifyRounds.get(sessionId) ?? 0;
          const newRounds = currentRounds + 1;
          clarifyRounds.set(sessionId, newRounds);

          if (newRounds >= MAX_CLARIFY_ROUNDS) {
            // Cap reached — inject synthesize reminder
            // Only inject if the user answered (has content)
            if (isSubstantive(lastUserText)) {
              const textPart = lastUser.parts.find(
                (p) => p.type === 'text' && typeof p.text === 'string',
              );
              if (textPart && typeof textPart.text === 'string' && !textPart.text.includes(CAP_REMINDER.trim().slice(0, 30))) {
                textPart.text += CAP_REMINDER;
              }
            }
          }
          // Otherwise: assistant asked questions, user should answer — no injection needed
          return;
        }
      }

      // Assistant did NOT ask questions.
      // If user message is short/vague and we haven't clarified much, inject reminder.
      if (!isSubstantive(lastUserText)) {
        const currentRounds = clarifyRounds.get(sessionId) ?? 0;
        if (currentRounds < MAX_CLARIFY_ROUNDS) {
          const textPart = lastUser.parts.find(
            (p) => p.type === 'text' && typeof p.text === 'string',
          );
          if (textPart && typeof textPart.text === 'string' && !textPart.text.includes(CLARIFY_REMINDER.trim().slice(0, 30))) {
            textPart.text += CLARIFY_REMINDER;
          }
        }
      } else {
        // User provided substantive response — reset clarify rounds
        clarifyRounds.delete(sessionId);
      }
    },
  };
}
