/**
 * Pi Mode Switching — 模式由 JSON 配置定义，代码只提供加载和执行机制
 *
 * 模式定义来源（优先级从高到低）：
 * 1. ~/.pi/agent/modes/{name}.md — 覆盖 instructions 和 tools
 * 2. oh-my-opencode-slim.json → modes 字段 — 所有模式定义
 * 3. src/adapters/modes-default.json — 内置默认值
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────

interface ModeDefinition {
  label: string;
  tools: string[];
  instructions?: string;
  next?: string[];
  hidden?: boolean;
}

// ── 常量 ──────────────────────────────────────────────────────────────────

const MODES_DIR = path.join(homedir(), ".pi", "agent", "modes");
const DEFAULTS_PATH = path.join(__dirname, "modes-default.json");

function getConfigPath(): string {
  return path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
}

// ── .md 文件解析 ──────────────────────────────────────────────────────────

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
    if (value.startsWith("[") && value.endsWith("]")) {
      try { value = JSON.parse(value); } catch { value = value; }
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    result[m[1]] = value;
  }
  return { frontmatter: result, body };
}

function loadModeFile(name: string): { instructions: string; tools?: string[]; hidden?: boolean } | null {
  const filePath = path.join(MODES_DIR, `${name}.md`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools, hidden: frontmatter.hidden };
    }
  } catch { /* ignore */ }
  return null;
}

// ── 从 JSON 配置加载模式定义 ──────────────────────────────────────────────

let _modeDefs: Record<string, ModeDefinition> | null = null;

function loadModeDefinitions(): Record<string, ModeDefinition> {
  // 1. 从 oh-my-opencode-slim.json 的 modes 字段读取
  let raw: Record<string, any> = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    raw = cfg.modes ?? {};
  } catch {}

  // 2. 如果配置中没有 modes，尝试从内置默认文件加载
  if (Object.keys(raw).length === 0) {
    try {
      if (fs.existsSync(DEFAULTS_PATH)) {
        raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf-8"));
      }
    } catch {}
  }

  // 3. 如果还是空，给一个最小兜底
  if (Object.keys(raw).length === 0) {
    raw = { worker: { label: "Worker", tools: ["read", "grep", "find", "ls", "omo_delegate"] } };
  }

  // 4. 合并 .md 文件覆盖（instructions + tools + hidden）
  for (const name of Object.keys(raw)) {
    const file = loadModeFile(name);
    if (file) {
      raw[name].instructions = file.instructions;
      if (file.tools && Array.isArray(file.tools) && file.tools.length > 0) {
        raw[name].tools = file.tools;
      }
      if (file.hidden !== undefined) {
        raw[name].hidden = file.hidden;
      }
    }
  }

  _modeDefs = raw as Record<string, ModeDefinition>;
  return _modeDefs;
}

function getMode(name: string): ModeDefinition | undefined {
  return (loadModeDefinitions())[name];
}

function getAllModeNames(): string[] {
  return Object.keys(loadModeDefinitions());
}

function getPublicModes(): string[] {
  const defs = loadModeDefinitions();
  return Object.entries(defs).filter(([, v]) => !v.hidden).map(([k]) => k);
}

function getHiddenModes(): string[] {
  const defs = loadModeDefinitions();
  return Object.entries(defs).filter(([, v]) => v.hidden).map(([k]) => k);
}

// ── 配置持久化 ──────────────────────────────────────────────────────────

function saveMode(name: string): void {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    cfg.active_mode = name;
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch { /* skip */ }
}

function loadActiveMode(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    const mode: string = cfg.active_mode ?? "";
    if (mode && getMode(mode)) return mode;
    const publics = getPublicModes();
    return publics.length > 0 ? publics[0] : "worker";
  } catch {
    return "worker";
  }
}

/** 种子默认模式到用户配置（仅当 config 中无 modes 字段时写入） */
function seedDefaultModes(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    if (raw.modes) return;
    if (!fs.existsSync(DEFAULTS_PATH)) return;
    raw.modes = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf-8"));
    fs.writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } catch {}
}

// ── 模式应用 ──────────────────────────────────────────────────────────────

function getActiveMode(): string {
  return loadActiveMode();
}

function applyMode(pi: ExtensionAPI, name: string): boolean {
  const mode = getMode(name);
  if (!mode) return false;

  try {
    const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
    const allow = new Set([...mode.tools, "switch_mode"]);
    allow.delete("subagent");
    pi.setActiveTools(all.filter((n: string) => allow.has(n)));
    saveMode(name);
  } catch {}
  return true;
}

export function getModeInstructions(name: string): string | undefined {
  return getMode(name)?.instructions;
}

// ── 注册 pi 命令和事件 ──────────────────────────────────────────────────

function registerModeCommands(pi: ExtensionAPI): void {
  seedDefaultModes();

  pi.registerCommand("mode", {
    description: `Switch mode. Usage: /mode <name>`,
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();
      const publics = getPublicModes();
      const allNames = getAllModeNames();

      if (trimmed) {
        if (!allNames.includes(trimmed)) {
          ctx.ui.notify(`Unknown mode: "${trimmed}".`, "error");
          return;
        }
        applyMode(pi, trimmed);
        const def = getMode(trimmed);
        ctx.ui.notify(`Switched to: ${trimmed} (${def?.label ?? trimmed})`, "success");
        return;
      }

      const current = loadActiveMode();
      const options = publics.map((k) => {
        const def = getMode(k);
        return `${k === current ? "\u25cf " : "\u25cb "}${k} \u2014 ${def?.label ?? k}`;
      });
      const selected = await ctx.ui.select(`Current: ${current}. Select mode:`, options);
      if (!selected) return;
      const picked = publics[options.indexOf(selected)];
      if (!picked || picked === current) return;
      applyMode(pi, picked);
      const def = getMode(picked);
      ctx.ui.notify(`Switched to: ${picked} (${def?.label ?? picked})`, "success");
    },
  });
}

function registerModeHooks(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    _modeDefs = null;
    seedDefaultModes();
    const mode = loadActiveMode();
    applyMode(pi, mode);
  });

  pi.on("before_agent_start", async (event) => {
    const mode = loadActiveMode();
    const def = getMode(mode);
    if (def?.instructions) {
      return {
        systemPrompt: `${def.instructions}\n\n---\n\n${event.systemPrompt}`,
      };
    }
  });
}

// ── 独立扩展入口 ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  registerModeCommands(pi);
  registerModeHooks(pi);

  pi.registerTool({
    name: "switch_mode",
    label: "Switch Mode",
    description: `Switch to the next mode in the workflow chain. Can return to the first mode. Only call after the user explicitly confirms.`,
    parameters: Type.Object({
      mode: Type.String({ description: "Target mode name" }),
    }),
    async execute(_toolCallId: string, params: { mode: string }) {
      const name = params.mode?.trim().toLowerCase();
      if (!name || !getMode(name)) {
        return {
          content: [{ type: "text" as const, text: `\u4e0d\u5b58\u5728\u8be5\u6a21\u5f0f\u3002` }],
          isError: true,
          details: {} as any,
        };
      }

      let currentMode = "";
      let allowed: string[] = [];
      try {
        const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
        currentMode = (raw as any).active_mode ?? "";
        const currentDef = getMode(currentMode);
        allowed = currentDef?.next ?? [];
      } catch {}

      if (!allowed.includes(name)) {
        return {
          content: [{ type: "text" as const, text: `\u5f53\u524d\u6a21\u5f0f\u4e0d\u5141\u8bb8\u76f4\u63a5\u5207\u6362\u5230\u76ee\u6807\u6a21\u5f0f\u3002` }],
          isError: true,
          details: {} as any,
        };
      }

      applyMode(pi, name);
      return {
        content: [{ type: "text" as const, text: `\u5207\u6362\u5230: ${name}` }],
        details: { mode: name },
      };
    },
  });
}
