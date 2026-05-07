import { createGate } from './gate-factory';

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
  // 单独的状态（clarify 逻辑与标准一次性门略有不同）
  const injected = new Set<string>();
  const opened = new Set<string>();    // 已就绪，永久开门
  const rounds = new Map<string, number>();  // 当前轮次
  const pending = new Set<string>();   // 等待确认中

  return {
    'experimental.chat.messages.transform': async (_i: any, o: any): Promise<void> => {
      const msgs = o.messages as MessageWithParts[];
      if (msgs.length < 2) return;
      const lu = findLastUser(msgs);
      if (!lu) return;
      if (lu.info.agent && lu.info.agent !== 'orchestrator') return;

      let sid = '';
      for (const m of msgs) { if (m.info.sessionID) { sid = m.info.sessionID; break; } }
      if (!sid) return;

      if (!injected.has(sid)) {
        const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
        if (tp && typeof tp.text === 'string') {
          tp.text += `\n\n<internal_reminder>\n${INSTRUCTION}\n</internal_reminder>`;
        }
        injected.add(sid);
        return;
      }

      const la = findLastAssistant(msgs);
      if (!la) return;
      const t = getTextFromMessage(la);

      // DONE: 重置门
      if (/^\s*DONE:\s/m.test(t)) {
        opened.delete(sid);
        rounds.delete(sid);
        pending.delete(sid);
        return;
      }

      // READY: confirmed → 永久开门
      if (/^\s*READY:\s+confirmed\b/m.test(t)) {
        opened.add(sid);
        rounds.delete(sid);
        pending.delete(sid);
        return;
      }

      // READY: need to check → 计数
      if (/^\s*READY:\s+need\s+to\s+check\b/m.test(t)) {
        const r = (rounds.get(sid) ?? 0) + 1;
        rounds.set(sid, r);
        pending.add(sid);
        if (r >= MAX_ROUNDS) {
          // 注入提醒
          const up = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
          if (up && typeof up.text === 'string' && !up.text.includes('ReadinessGate')) {
            up.text += `\n\n<internal_reminder>\n[ReadinessGate] 已超过${MAX_ROUNDS}轮，请确认后就绪。\n</internal_reminder>`;
          }
        }
        return;
      }

      // 其他声明 → 不改变状态
    },

    'tool.execute.before': async (i: any, o: any): Promise<void> => {
      if (options?.isRalphLoopActive?.()) return;
      const escapeT = new Set(['read', 'grep', 'glob', 'skill']);
      if (escapeT.has(i.tool)) return;
      const gated = new Set(['edit', 'Write', 'write', 'apply_patch']);
      if (!gated.has(i.tool)) return;

      const sid = i.sessionID;
      if (sid && opened.has(sid)) return;      // 已就绪
      if (!sid || !pending.has(sid)) return;     // 未激活

      // ≥3轮未就绪 → 拦截
      const r = rounds.get(sid) ?? 0;
      if (r >= MAX_ROUNDS) {
        o.args = undefined;
        throw new Error(BLOCK_MESSAGE);
      }
    },
  };
}

import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';
