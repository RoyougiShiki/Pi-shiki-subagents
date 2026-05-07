/**
 * 声明门框架。每个门包含两个钩子：
 *   - messages.transform: 注入指令 + 更新状态
 *   - tool.execute.before: 检查状态 + 拦截
 *
 * 每个门独立实例，独立状态。
 */

import {
  findLastAssistant,
  findLastUser,
  getTextFromMessage,
  type MessageWithParts,
} from '../shared-message-types';

export interface GateConfig {
  name: string;
  checkPattern: RegExp;
  notPattern?: RegExp;
  instruction: string;
  gatedTools: string[];
  blockMessage: string;
  /**
   * true = 一次性门。APPROVED/READY/PROCEEDING 后永久开门。
   * false = 每轮检查门。每个回复都需要声明。
   */
  oneShot: boolean;
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
  // 一次性门的状态
  const opened = new Set<string>();   // 已永久开门
  const pending = new Set<string>();  // 等待批准/就绪
  // 每轮检查门的状态
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

      // 首次注入指令
      if (!injected.has(sid)) {
        const tp = lu.parts.find((p: any) => p.type === 'text' && typeof p.text === 'string');
        if (tp && typeof tp.text === 'string') {
          tp.text += `\n\n<internal_reminder>\n${cfg.instruction}\n</internal_reminder>`;
        }
        injected.add(sid);
        return; // 首回合免检
      }

      if (cfg.oneShot) {
        // 一次性门：检查 LLM 声明
        const la = findLastAssistant(msgs);
        if (!la) return;
        const t = getTextFromMessage(la);

        // DONE: 重置门（重新关闭）
        if (/^\s*DONE:\s/m.test(t)) {
          opened.delete(sid);
          pending.delete(sid);
          return;
        }

        // 批准/就绪 → 永久开门
        if (cfg.checkPattern.test(t)) {
          opened.add(sid);
          pending.delete(sid);
          return;
        }

        // 等待（激活门）
        if (cfg.notPattern?.test(t)) {
          pending.add(sid);
          return;
        }
      } else {
        // 每轮检查门：存上一条助理文本
        const la = findLastAssistant(msgs);
        if (!la) return;
        lastAsstText = getTextFromMessage(la);
      }
    },

    'tool.execute.before': async (i: BI, o: BO): Promise<void> => {
      if (cfg.isRalphLoopActive?.()) return;

      // 逃生通道：read/grep/glob/skill 不拦截
      const escapeTools = new Set(['read', 'grep', 'glob', 'skill']);
      if (escapeTools.has(i.tool)) return;

      if (!cfg.gatedTools.includes(i.tool)) return;

      const sid = i.sessionID;

      if (cfg.oneShot) {
        // 已开门 → 放行
        if (sid && opened.has(sid)) return;
        // 未激活 → 放行
        if (!sid || !pending.has(sid)) return;
        // 等待中 → 拦截
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      } else {
        // 每轮检查门
        if (!lastAsstText) return;
        const r = checkText(lastAsstText);
        if (r === 'pass') return;
        o.args = undefined;
        throw new Error(cfg.blockMessage);
      }
    },
  };
}
