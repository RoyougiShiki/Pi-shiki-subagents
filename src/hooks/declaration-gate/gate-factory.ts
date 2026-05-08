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
  let injected = false;
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

      // 没有助理消息 → 首回合，注入指令后免检
      const la = findLastAssistant(msgs);
      if (!la) {
        if (!injected) {
          const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
          if (tp && typeof tp.text === 'string') {
            tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
          }
          injected = true;
        }
        return;
      }

      const t = getTextFromMessage(la);

      if (cfg.oneShot) {
        if (/^\s*DONE:\s/m.test(t)) {
          gateOpened = false;
          gatePending = false;
          return;
        }
        if (cfg.checkPattern.test(t)) {
          gateOpened = true;
          gatePending = false;
          return;
        }
        if (cfg.notPattern?.test(t)) {
          gatePending = true;
          return;
        }
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
