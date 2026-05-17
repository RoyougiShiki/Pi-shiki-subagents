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
const SESSION_MODE_MAP_PATH = path.join(homedir(), ".pi", "agent", ".session-modes.json");
let _currentSessionFile: string | undefined;

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
  if (_modeDefs) return _modeDefs;

  let raw: Record<string, any> = {};
  let modeRoles: Record<string, string[]> = {};
  let roleTemplates: Record<string, string[]> = {};

  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    raw = cfg.modes ?? {};
    modeRoles = cfg.mode_roles ?? {};
    roleTemplates = cfg.role_templates ?? {};
  } catch {}

  if (Object.keys(raw).length === 0) {
    try {
      if (fs.existsSync(DEFAULTS_PATH)) {
        const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf-8"));
        raw = defaults;
        if (defaults.mode_roles) modeRoles = defaults.mode_roles;
        if (defaults.role_templates) roleTemplates = defaults.role_templates;
      }
    } catch {}
  }

  if (Object.keys(raw).length === 0) {
    raw = { worker: { label: "Worker", tools: ["read", "grep", "find", "ls", "omo_delegate"] } };
  }

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

    if (!raw[name].tools || raw[name].tools.length === 0) {
      const roleNames = modeRoles[name] ?? [];
      const resolved = new Set<string>();
      for (const rn of roleNames) {
        const tmpl = roleTemplates[rn] ?? [];
        for (const t of tmpl) resolved.add(t);
      }
      if (resolved.size > 0) {
        raw[name].tools = Array.from(resolved);
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
    if (_currentSessionFile) {
      saveSessionMode(_currentSessionFile, name);
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    cfg.active_mode = name;
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch {}
}

export function loadActiveMode(): string {
  try {
    if (_currentSessionFile) {
      const saved = loadSessionMode(_currentSessionFile);
      if (saved && getMode(saved)) return saved;
    }
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

function saveSessionMode(sessionFile: string, mode: string): void {
  try {
    let map: Record<string, string> = {};
    try { map = JSON.parse(fs.readFileSync(SESSION_MODE_MAP_PATH, "utf-8")); } catch {}
    map[sessionFile] = mode;
    fs.writeFileSync(SESSION_MODE_MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf-8");
  } catch {}
}

function loadSessionMode(sessionFile: string): string | undefined {
  try {
    const map: Record<string, string> = JSON.parse(fs.readFileSync(SESSION_MODE_MAP_PATH, "utf-8"));
    return map[sessionFile];
  } catch { return undefined; }
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
  pi.on("session_start", async (event, ctx) => {
    // Track current session file
    try { _currentSessionFile = (ctx as any)?.sessionManager?.getSessionFile?.() ?? undefined; } catch { _currentSessionFile = undefined; }

    // If resuming a session, restore its saved mode
    if (event.reason === "resume" && (event as any).previousSessionFile) {
      const saved = loadSessionMode((event as any).previousSessionFile);
      if (saved && getMode(saved)) {
        _modeDefs = null;
        seedDefaultModes();
        applyMode(pi, saved);
        return;
      }
    }

    _modeDefs = null;
    seedDefaultModes();
    const mode = loadActiveMode();
    applyMode(pi, mode);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sf = (ctx as any)?.sessionManager?.getSessionFile?.();
      if (sf) saveSessionMode(sf, loadActiveMode());
    } catch {}
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

      const currentMode = loadActiveMode();
      const currentDef = getMode(currentMode);
      const allowed = currentDef?.next ?? [];

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
