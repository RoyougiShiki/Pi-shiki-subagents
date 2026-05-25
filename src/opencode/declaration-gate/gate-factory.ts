
import { findLastUser, getTextFromMessage, type MessageWithParts } from '../../hooks/shared-message-types';

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
  let injected = false;
  let gateOpened = false;
  let gatePending = false;
  let lastMessages: MessageWithParts[] | null = null;

  const ct = (t: string): 'pass' | 'reject' | 'block' => {
    if (cfg.notPattern?.test(t)) return 'reject';
    if (cfg.checkPattern.test(t)) return 'pass';
    return 'block';
  };

  const getAsst = (msgs: MessageWithParts[]): string | null => {
    // 找第一条用户消息的索引（手动循环，避免 findIndex 在非标准 Array 上不可用）
    let firstUserIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i] as any)?.info?.role === 'user') { firstUserIdx = i; break; }
    }
    if (firstUserIdx < 0) return null;
    // 从后往前检查 firstUserIdx 之后的助理消息
    for (let i = msgs.length - 1; i >= firstUserIdx; i--) {
      const m = msgs[i];
      if (m.info?.role === 'assistant') return getTextFromMessage(m);
    }
    return null;
  };

  const noB = (t: string) => /^\s*DONE:\s/m.test(t);
  const yes = (t: string) => cfg.checkPattern.test(t);
  const act = (t: string) => cfg.notPattern?.test(t);

  return {
    'experimental.chat.messages.transform': async (_i: TI, o: TO): Promise<void> => {
      const msgs = o.messages as MessageWithParts[];
      lastMessages = msgs;
      if (msgs.length < 2) return;
      const lu = findLastUser(msgs);
      if (!lu) return;
      if (lu.info.agent && lu.info.agent !== 'orchestrator') return;

      // 注入门禁指令（首次且仅一次）
      if (!injected) {
        const tp = lu.parts.find(
          (p: any) => p.type === 'text' && typeof p.text === 'string',
        );
        if (tp && typeof tp.text === 'string') {
          tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
        }
        injected = true;
      }

      // 找最后一条助理消息
      let lastAsstIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if ((msgs[i] as any)?.info?.role === 'assistant') {
          lastAsstIdx = i;
          break;
        }
      }
      // 没有助理消息 → 无声明可检查，直接放行
      if (lastAsstIdx < 0) return;

      if (!cfg.oneShot) return;

      const t = getTextFromMessage(msgs[lastAsstIdx]);
      if (noB(t)) {
        gateOpened = false;
        gatePending = false;
      } else if (yes(t)) {
        gateOpened = true;
        gatePending = false;
      } else if (act(t)) {
        gatePending = true;
      } else if (cfg.startActive && !gateOpened) {
        gatePending = true;
      }
    },

    'tool.execute.before': async (i: BI, o: BO): Promise<void> => {
      if (cfg.isRalphLoopActive?.()) return;

      const escapeTools = new Set(['read', 'grep', 'glob', 'skill']);
      if (escapeTools.has(i.tool)) return;
      if (!cfg.gatedTools.includes(i.tool)) return;

      const asstText = lastMessages ? getAsst(lastMessages as MessageWithParts[]) : null;

      if (cfg.oneShot) {
        if (asstText !== null) {
          if (noB(asstText)) { gateOpened = false; gatePending = false; }
          else if (yes(asstText)) { gateOpened = true; gatePending = false; }
          else if (act(asstText)) { gatePending = true; }
        }
        if (gateOpened) return;
        if (!gatePending) return;
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      } else {
        if (asstText === null) return;
        const r = ct(asstText);
        if (r === 'pass') return;
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      }
    },
  };
}
