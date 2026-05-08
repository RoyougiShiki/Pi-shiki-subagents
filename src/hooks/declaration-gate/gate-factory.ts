import { findLastAssistant, findLastUser, getTextFromMessage, type MessageWithParts } from '../shared-message-types';

export interface GateConfig {
  name: string;
  checkPattern: RegExp;
  notPattern?: RegExp;
  instruction: string;
  gatedTools: string[];
  blockMessage: string;
  oneShot: boolean;
  startActive?: boolean;
  isRalphLoopActive?: () => boolean;
}

type TI = Record<string, never>;
interface TO { messages: unknown[]; }
interface BI { tool: string; sessionID?: string; callID?: string; [key: string]: unknown; }
interface BO { args?: Record<string, unknown>; [key: string]: unknown; }
export interface GateHooks {
  'experimental.chat.messages.transform': (i: TI, o: TO) => Promise<void>;
  'tool.execute.before': (i: BI, o: BO) => Promise<void>;
}

export function createGate(cfg: GateConfig): GateHooks {
  const injected = new Set<string>();
  // 模块级状态（不使用 session ID key，避免 m.info.sessionID 和 input.sessionID 不一致）
  let gateOpened = false;
  let gatePending = false;
  let lastAsstText: string | null = null;

  const checkText = (t: string): 'pass' | 'reject' | 'block' => {
    if (cfg.notPattern?.test(t)) return 'reject';
    if (cfg.checkPattern.test(t)) return 'pass';
    return 'block';
  };

  return {
    'experimental.chat.messages.transform': async (_i: TI, o: TO): Promise<void> => {
      const msgs = o.messages as MessageWithParts[];
      if (msgs.length < 2) return;
      const lu = findLastUser(msgs);
      if (!lu) return;
      if (lu.info.agent && lu.info.agent !== 'orchestrator') return;

      let sid = '';
      for (const m of msgs) { if (m.info.sessionID) { sid = m.info.sessionID; break; } }
      if (!sid) return;

      // 首次注入指令：使用 session ID 判断，避免重复注入
      if (!injected.has(sid)) {
        const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
        if (tp && typeof tp.text === 'string') {
          tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
        }
        injected.add(sid);
        return; // 首回合免检
      }

      // 检查 LLM 声明
      const la = findLastAssistant(msgs);
      if (!la) return;
      const t = getTextFromMessage(la);

      if (cfg.oneShot) {
        // DONE: 重置
        if (/^\s*DONE:\s/m.test(t)) {
          gateOpened = false;
          gatePending = false;
          return;
        }
        // checkPattern 匹配 → 开门
        if (cfg.checkPattern.test(t)) {
          gateOpened = true;
          gatePending = false;
          return;
        }
        // notPattern 匹配 → 激活等待
        if (cfg.notPattern?.test(t)) {
          gatePending = true;
          return;
        }
        // startActive 且未开门 → 激活
        if (cfg.startActive && !gateOpened) {
          gatePending = true;
          return;
        }
      } else {
        lastAsstText = t;
      }
    },

    'tool.execute.before': async (i: BI, o: BO): Promise<void> => {
      if (cfg.isRalphLoopActive?.()) return;

      const escapeTools = new Set(['read', 'grep', 'glob', 'skill']);
      if (escapeTools.has(i.tool)) return;
      if (!cfg.gatedTools.includes(i.tool)) return;

      if (cfg.oneShot) {
        if (gateOpened) return;
        if (!gatePending) return;
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      } else {
        if (!lastAsstText) return;
        const r = checkText(lastAsstText);
        if (r === 'pass') return;
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      }
    },
  };
}
