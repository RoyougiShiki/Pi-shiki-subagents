/**
 * Approach Approval Gate.
 *
 * When the assistant proposes multiple design/implementation approaches
 * to the user, this gate blocks implementation tools (edit, write, etc.)
 * until the user explicitly approves one of the options.
 *
 * Does NOT block when no options were presented (single obvious approach).
 *
 * Combines two hooks:
 * 1. experimental.chat.messages.transform — detects "options presented"
 *    and "user approved" by scanning the message history.
 * 2. tool.execute.before — blocks edit/write until approval is granted.
 */

// Module-level state: sessionId → pending approval?
const pendingApproval = new Map<string, boolean>();

// Patterns that indicate the assistant presented options
const OPTIONS_PRESENTED_PATTERNS = [
  /\b(方案|option|approach|alternative)\b/i,
  /^[A-Z]\)\s/m,    // "A) ..." at start of line
  /^\d+\.\s/m,      // "1. ..." at start of line
  /\b(recommend|suggest|propose)\b/i,
];

// Patterns indicating user approval
const APPROVAL_PATTERNS = [
  /\b(选|用|就|好|ok|yes|approve|选\s*方案|选\s*第|选\s*[A-Z\d]|方案\s*[A-Z\d])\b/i,
  /^\s*(方案\s*)?[A-D]\)?\s*$/im,
  /^\s*\d+\s*$/m,
];

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

/** Check if a text contains any of the given patterns. */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

const BLOCK_MESSAGE =
  '[ApprovalGate] You proposed multiple design/implementation approaches but the user has not yet approved one.\n' +
  'Do not implement until the user selects an option or explicitly directs you to proceed.\n' +
  'If the user\'s response is unclear, ask for clarification.';

export function createApproachApprovalGateHook() {
  return {
    /**
     * Scan messages to detect:
     * - Assistant presented options → set pending flag
     * - User approved → clear pending flag
     */
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

      // Extract session ID — from any user message
      let sessionId = '';
      for (const m of messages) {
        if (m.info.sessionID) {
          sessionId = m.info.sessionID;
          break;
        }
      }
      if (!sessionId) {
        // Fallback: use a hash of the last user text
        sessionId = `session-${Math.random().toString(36).slice(2, 8)}`;
      }

      const lastAssistant = findLastAssistant(messages);
      const lastUserText = getTextFromMessage(lastUser);

      // Check: user approved? (clear pending)
      if (matchesAny(lastUserText, APPROVAL_PATTERNS)) {
        if (pendingApproval.get(sessionId)) {
          pendingApproval.delete(sessionId);
        }
        return;
      }

      // Check: did assistant present options in the last response?
      if (lastAssistant) {
        const asstText = getTextFromMessage(lastAssistant);
        if (matchesAny(asstText, OPTIONS_PRESENTED_PATTERNS)) {
          pendingApproval.set(sessionId, true);
        }
      }
    },

    /**
     * Block implementation tools when approval is pending.
     */
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      // Only gate significant implementation tools
      const gatedTools = new Set(['edit', 'Write', 'write', 'apply_patch']);
      if (!gatedTools.has(input.tool)) return;

      const sessionId = input.sessionID;
      if (!sessionId) return;

      // Check pending flag
      if (!pendingApproval.get(sessionId)) return; // Not pending → pass

      // Block: approach not yet approved
      output.args = undefined;

      // Throw an error the caller can handle
      throw new Error(BLOCK_MESSAGE);
    },
  };
}
