import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

const MAX_ROUNDS = 3;

const INSTRUCTION = `[ReadinessGate]
开始实现前，必须确认已掌握足够上下文。
在回复文本开头写：
"READY: confirmed" — 已完全理解需求、涉及文件、依赖关系，可以开始实现
"READY: need to check <具体内容>" — 还需要确认某些信息
也可以委托子代理（explorer/oracle）帮助分析代码和影响面。

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[ReadinessGate] 声明必须写在回复文本中，不是思考或代码块里。\n' +
  `已超过 ${MAX_ROUNDS} 轮仍未确认就绪。\n` +
  '请确认已完全理解需求后再写 "READY: confirmed"。';

export function createClarifyGateHook(options?: {
  isRalphLoopActive?: () => boolean;
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
          tp.text += `\n\n<internal_reminder>\n${INSTRUCTION}\n</internal_reminder>`;
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

      if (/^\s*READY:\s+confirmed\b/m.test(t)) {
        gateOpened = true;
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
        throw new Error(BLOCK_MESSAGE);
      }
    },
  };
}
