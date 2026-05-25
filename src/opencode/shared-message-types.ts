/**
 * Shared message types and helpers for hooks that manipulate
 * the message stream via experimental.chat.messages.transform.
 */
export interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

export function getTextFromMessage(msg: MessageWithParts): string {
  return (msg.parts ?? [])
    .filter(
      (p): p is MessagePart & { text: string } =>
        p.type === 'text' && typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
}

export function findLastAssistant(
  messages: MessageWithParts[],
): MessageWithParts | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'assistant') {
      return messages[i];
    }
  }
  return null;
}

export function findLastUser(
  messages: MessageWithParts[],
): MessageWithParts | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'user') {
      return messages[i];
    }
  }
  return null;
}
