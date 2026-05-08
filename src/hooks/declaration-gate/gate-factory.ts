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
  let lastMessages: MessageWithParts[] | null = null;

  const ct = (t: string): 'pass' | 'reject' | 'block' => {
    if (cfg.notPattern?.test(t)) return 'reject';
    if (cfg.checkPattern.test(t)) return 'pass';
    return 'block';
  };

  const getAsst = (msgs: MessageWithParts[]): string | null => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.info.role === 'assistant') {
        const text = getTextFromMessage(m);
        if (!text || text.startsWith('<Role>')) continue;
        return text;
      }
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

      const la = findLastAssistant(msgs);
      if (!la) {
        gateOpened = false;
        gatePending = false;
        if (!injected) {
          const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
          if (tp && typeof tp.text === 'string') {
            tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
          }
          injected = true;
        }
        return;
      }

      if (!cfg.oneShot) return;

      const t = getTextFromMessage(la);
      if (noB(t)) { gateOpened = false; gatePending = false; }
      else if (yes(t)) { gateOpened = true; gatePending = false; }
      else if (act(t)) { gatePending = true; }
      else if (cfg.startActive && !gateOpened) { gatePending = true; }
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
