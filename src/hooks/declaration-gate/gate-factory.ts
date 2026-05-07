import { findLastAssistant, findLastUser, getTextFromMessage, type MessageWithParts } from '../shared-message-types';

export interface DeclarationGateConfig {
  name: string;
  checkPattern: RegExp;
  notPattern?: RegExp;
  instruction: string;
  gatedTools: string[];
  blockMessage: string;
  isRalphLoopActive?: () => boolean;
  fetchCurrentAsstText?: (sessionId: string) => Promise<string | null>;
}

type TI = Record<string, never>;
export interface TO { messages: unknown[]; }
export interface BI { tool: string; sessionID?: string; callID?: string; [key: string]: unknown; }
export interface BO { args?: Record<string, unknown>; [key: string]: unknown; }
export interface DGR {
  'experimental.chat.messages.transform': (i: TI, o: TO) => Promise<void>;
  'tool.execute.before': (i: BI, o: BO) => Promise<void>;
}

export function createDeclarationGate(cfg: DeclarationGateConfig): DGR {
  let lastAsstText: string | null = null;
  const injected = new Set<string>();
  let cache: { sid: string; text: string | null } | null = null;

  const ct = (t: string): 'pass' | 'reject' | 'block' => {
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
      const fi = !injected.has(sid);
      if (fi) {
        const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
        if (tp && typeof tp.text === 'string') tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
        injected.add(sid);
      }
      const la = findLastAssistant(msgs);
      if (!la) { cache = null; return; }
      lastAsstText = getTextFromMessage(la);
      if (fi) { cache = { sid, text: lastAsstText }; return; }
      cache = null;
    },

    'tool.execute.before': async (i: BI, o: BO): Promise<void> => {
      if (cfg.isRalphLoopActive?.()) return;
      if (!cfg.gatedTools.includes(i.tool)) return;
      const sid = i.sessionID;

      if (cfg.fetchCurrentAsstText && sid) {
        if (!cache || cache.sid !== sid) {
          try { cache = { sid, text: await cfg.fetchCurrentAsstText(sid) ?? null }; }
          catch { cache = { sid, text: null }; }
        }
        if (cache.text !== null && cache.text !== undefined) {
          if (ct(cache.text) === 'pass') return;
          o.args = undefined;
          throw new Error(cfg.blockMessage);
        }
      }

      if (lastAsstText === null) return;
      if (ct(lastAsstText) === 'pass') return;
      o.args = undefined;
      throw new Error(cfg.blockMessage);
    },
  };
}
