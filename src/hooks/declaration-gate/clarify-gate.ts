import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

const MAX_ROUNDS = 3;

const INSTRUCTION = `[ReadinessGate]
开始实现前，先说明自己是否已掌握足够上下文。
如果需求模糊、信息不足，就应该：
- 问用户要更多信息
- 查代码/查文档
- 调用工具搜索
- 派子代理去调研
这一步是为了避免在信息不足时直接实现。
确认充分后，在回复文本开头写：
"READY: <你已掌握的信息>" — 已完全理解，可以开始实现
"READY: need to check <具体内容>" — 还需要确认某些信息

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[ReadinessGate] 你还没有先说明自己是否已经掌握足够上下文。\n' +
  `已超过 ${MAX_ROUNDS} 轮仍未确认就绪；如果现在直接实现，容易返工或做错。\n` +
  '请先补充调查、提问或搜索，并在回复开头写 "READY: <你已掌握的信息>" 后再继续。';

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
        throw new Error(BLOCK_MESSAGE);
      }
    },
  };
}
