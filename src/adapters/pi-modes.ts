/**
 * Pi Mode Switching — thinker / designer / worker 模式管理
 *
 * 每个模式定义：
 * - 允许的工具列表
 * - 注入的系统提示词
 * - 停止标记（用于自动切换下一阶段）
 *
 * 独立 pi 扩展入口，自动注册 /mode 命令和 agent_end 自动切换。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ── 模式定义 ──────────────────────────────────────────────────────────────

interface ModeDefinition {
  label: string;
  tools: string[];
  instructions?: string;
}

const MODES: Record<string, ModeDefinition> = {
  "thinker-clarify": {
    label: "需求澄清",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
  },
  "thinker-analysis": {
    label: "需求分析",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
  },
  thinker: {
    label: "需求分析",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
  },
  designer: {
    label: "技术设计",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
  },
  worker: {
    label: "快速实施",
    tools: ["read", "grep", "find", "ls", "omo_delegate"],
  },
  batch: {
    label: "批次执行",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "omo_delegate"],
  },
  // 兜底模式：仅用户手动切换，agent 不可自选、不可见
  fallback: {
    label: "兜底模式",
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "omo_delegate"],
  },
};

// ── 从外部文件加载提示词（覆盖内置默认值）───────────────────────────────
// 用户可编辑 ~/.pi/agent/modes/{name}.md 自定义模式提示词

const MODES_DIR = path.join(homedir(), ".pi", "agent", "modes");

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const result: Record<string, any> = {};
  if (!content.startsWith("---")) return { frontmatter: result, body: content };

  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: result, body: content };

  const block = content.slice(4, end);
  const body = content.slice(end + 4).trim();

  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let value: any = m[2].trim();
    // Parse JSON arrays like [read, grep, find]
    if (value.startsWith("[") && value.endsWith("]")) {
      try { value = JSON.parse(value); } catch { value = value; }
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    result[m[1]] = value;
  }
  return { frontmatter: result, body };
}

function loadModeFile(name: string): { instructions: string; tools?: string[] } | null {
  const filePath = path.join(MODES_DIR, `${name}.md`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools };
    }
  } catch {
    // ignore
  }
  return null;
}

// 启动时从文件加载：tools 来自 frontmatter，instructions 来自 body
for (const name of Object.keys(MODES)) {
  const file = loadModeFile(name);
  if (file) {
    MODES[name].instructions = file.instructions;
    if (file.tools && Array.isArray(file.tools) && file.tools.length > 0) {
      MODES[name].tools = file.tools;
    }
  }
}

// ── 配置持久化 ────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
}

function saveMode(name: string): void {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    cfg.active_mode = name;
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch {
    // config not exists, skip persistence
  }
}

function loadActiveMode(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    const mode: string = cfg.active_mode ?? "worker";
    return MODES[mode] ? mode : "worker";
  } catch {
    return "worker";
  }
}

// ── 模式应用 ──────────────────────────────────────────────────────────────

/** 获取模式定义（只读） */
function getMode(name: string): ModeDefinition | undefined {
  return MODES[name];
}

/** 获取当前模式名 */
function getActiveMode(): string {
  return loadActiveMode();
}

/** 应用模式到当前会话 */
function applyMode(pi: ExtensionAPI, name: string): boolean {
  const mode = MODES[name];
  if (!mode) return false;

  try {
    const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
    const allow = new Set([...mode.tools, "activate_tools", "describe_tool", "switch_mode"]);
    // 始终隐藏 broken 的 subagent
    allow.delete("subagent");
    pi.setActiveTools(all.filter((n: string) => allow.has(n)));
    saveMode(name);
  } catch {
    // best effort
  }
  return true;
}

/** 获取当前模式的注入提示词（附加到已有系统提示词） */
export function getModeInstructions(name: string): string | undefined {
  return MODES[name]?.instructions;
}

// ── 注册 pi 命令和事件 ────────────────────────────────────────────────────

function registerModeCommands(pi: ExtensionAPI): void {
  // 公开给用户手动切换的模式（designer/batch 是自动流转的内部模式）
  const PUBLIC_MODES = ["thinker-clarify", "thinker-analysis", "designer", "worker"];

  // /mode 命令：交互选择或直接切换
  pi.registerCommand("mode", {
    description: "Switch mode: thinker-clarify (clarify requirements), thinker-analysis (analyze & propose), designer (plan), worker (implement). Usage: /mode <name>",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();

      if (trimmed) {
        if (!PUBLIC_MODES.includes(trimmed)) {
          ctx.ui.notify(`Unknown mode: "${trimmed}". Available: thinker-clarify, thinker-analysis, designer, worker`, "error");
          return;
        }
        applyMode(pi, trimmed);
        ctx.ui.notify(`Switched to: ${trimmed} (${MODES[trimmed].label})`, "success");
        return;
      }

      // 交互选择
      const current = loadActiveMode();
      const options = PUBLIC_MODES.map((k) =>
        `${k === current ? "● " : "○ "}${k} — ${MODES[k].label}`
      );
      const selected = await ctx.ui.select(`Current: ${current}. Select mode:`, options);
      if (!selected) return;

      const picked = PUBLIC_MODES[options.indexOf(selected)];
      if (!picked || picked === current) return;

      applyMode(pi, picked);
      ctx.ui.notify(`Switched to: ${picked} (${MODES[picked].label})`, "success");
    },
  });
}

function registerModeHooks(pi: ExtensionAPI): void {
  // session_start: 恢复上次保存的模式
  pi.on("session_start", async () => {
    const mode = loadActiveMode();
    applyMode(pi, mode);
  });

  // before_agent_start: 注入当前模式的 instructions（置顶）
  pi.on("before_agent_start", async (event) => {
    const mode = loadActiveMode();
    const def = MODES[mode];
    if (def?.instructions) {
      return {
        systemPrompt: `${def.instructions}\n\n---\n\n${event.systemPrompt}`,
      };
    }
  });

  /* agent_end auto-switch removed - markers are text-only now */
}

// ── 独立扩展入口 ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  registerModeCommands(pi);
  registerModeHooks(pi);

  // 注册 switch_mode 工具，供 LLM 在用户确认后调用
  pi.registerTool({
    name: "switch_mode",
    label: "Switch Mode",
    description: `Switch to another working mode. Only call this after the user has explicitly confirmed they want to proceed.
Modes: thinker-clarify (clarify requirements), thinker-analysis (analyze & propose), designer (plan writing), worker (fast implementation), batch (batch execution).`,
    parameters: Type.Object({
      mode: Type.String({ description: "Target mode: thinker, designer, worker, or batch" }),
    }),
    async execute(_toolCallId: string, params: { mode: string }) {
      const name = params.mode?.trim().toLowerCase();
      if (!MODES[name]) {
        return {
          content: [{ type: "text" as const, text: `Unknown mode: "${name}". Available: ${Object.keys(MODES).join(", ")}` }],
          isError: true,
          details: {} as any,
        };
      }
      applyMode(pi, name);
      return {
        content: [{ type: "text" as const, text: `Switched to: ${name} (${MODES[name].label})` }],
        details: { mode: name },
      };
    },
  });
}
