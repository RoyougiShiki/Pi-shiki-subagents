import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../../hooks/shared-message-types';
import {
  CLARIFY_GATE_BLOCK_MESSAGE,
  CLARIFY_GATE_INSTRUCTION,
} from '../../opencode/workflow-templates';

const MAX_ROUNDS = 3;

export function createClarifyGateHook(options?: {
  isRalphLoopActive?: () => boolean;
  instruction?: string;
  blockMessage?: string;
}) {
  // 完全不用 session ID
  let firstTurn = true;
  let gateOpened = false;
  let gatePending = false;
  let needToCheckRounds = 0;

  return {
    'experimental.chat.messages.transform': async (_i: any, o: any): Promise<void> => {
      const msgs = o.messages as MessageWithParts[];
      if (msgs.length < 2) return;
      const lu = findLastUser(msgs);
      if (!lu) return;
      if (lu.info.agent && lu.info.agent !== 'orchestrator') return;

      if (firstTurn) {
        const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
        if (tp && typeof tp.text === 'string') {
          tp.text += `\n\n<internal_reminder>\n${options?.instruction ?? CLARIFY_GATE_INSTRUCTION}\n</internal_reminder>`;
        }
        firstTurn = false;
        return;
      }

      const la = findLastAssistant(msgs);
      if (!la) return;
      const t = getTextFromMessage(la);

      if (/^\s*DONE:\s/m.test(t)) {
        gateOpened = false;
        gatePending = false;
        needToCheckRounds = 0;
        return;
      }

      if (/^\s*READY:\s+need\s+to\s+check\b/m.test(t)) {
        needToCheckRounds++;
        gatePending = true;
        if (needToCheckRounds >= MAX_ROUNDS) {
          const up = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
          if (up && typeof up.text === 'string' && !up.text.includes('ReadinessGate')) {
            up.text += `\n\n<internal_reminder>\n[ReadinessGate] 已超过${MAX_ROUNDS}轮，请确认后就绪。\n</internal_reminder>`;
          }
        }
        return;
      }

      // catch-all: any READY: <描述> opens the gate (includes "confirmed", "检查完毕", etc.)
      if (/^\s*READY:\s/m.test(t)) {
        gateOpened = true;
        gatePending = false;
        needToCheckRounds = 0;
        return;
      }
    },

    'tool.execute.before': async (i: any, o: any): Promise<void> => {
      if (options?.isRalphLoopActive?.()) return;
      const escapeT = new Set(['read', 'grep', 'glob', 'skill']);
      if (escapeT.has(i.tool)) return;
      const gated = new Set(['edit', 'Write', 'write', 'apply_patch']);
      if (!gated.has(i.tool)) return;

      if (gateOpened) return;
      if (!gatePending) return;
      if (needToCheckRounds >= MAX_ROUNDS) {
        o.args = undefined;
        throw new Error(options?.blockMessage ?? CLARIFY_GATE_BLOCK_MESSAGE);
      }
    },
  };
}
