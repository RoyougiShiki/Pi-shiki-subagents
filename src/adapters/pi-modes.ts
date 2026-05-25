/**
 * Pi Agent Switching — 统一 Agent 架构
 *
 * agent 由 JSON 配置的 `agents` 段定义，行为指令由 ~/.pi/agents/{name}.md 提供。
 *
 * 配置来源（优先级从高到低）：
 * 1. ~/.pi/agent/oh-my-opencode-slim.json → agents 字段
 * 2. src/adapters/agents-default.json — 内置默认值
 *
 * 每个 agent 有 type:
 *   "mode"     — 只能通过 switch_mode 切换为主 agent
 *   "subagent" — 只能被 omo_subagent 调用
 *   "both"     — 两者皆可
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { loadRuntimeAgentDefinitions } from "./agent-runtime-config";

// ── 类型 ──────────────────────────────────────────────────────────────────

interface AgentDefinition {
  type: "mode" | "subagent" | "both";
  label: string;
  tools?: string[];
  roles?: string[];
  next?: string[];
  instructions?: string;
  hidden?: boolean;
}

// ── 常量 ──────────────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(homedir(), ".pi", "agents");
const DEFAULTS_PATH = path.join(__dirname, "agents-default.json");
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
      try { value = JSON.parse(value); } catch {}
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    result[m[1]] = value;
  }
  return { frontmatter: result, body };
}

function loadAgentFile(name: string): { instructions: string; tools?: string[]; hidden?: boolean } | null {
  const filePath = path.join(AGENTS_DIR, `${name}.md`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools, hidden: frontmatter.hidden };
    }
  } catch { }
  return null;
}

// ── Agent 定义加载 ────────────────────────────────────────────────────────

let _agentDefs: Record<string, AgentDefinition> | null = null;
let _toolGroups: Record<string, string[]> | null = null;

function loadAgentDefinitions(): Record<string, AgentDefinition> {
  if (_agentDefs) return _agentDefs;

  const raw: Record<string, any> = loadRuntimeAgentDefinitions();

  // Populate instructions from .md files
  for (const name of Object.keys(raw)) {
    const file = loadAgentFile(name);
    if (file) {
      raw[name].instructions = file.instructions || "";
      if (file.hidden !== undefined) raw[name].hidden = file.hidden;
    }
    raw[name].label = raw[name].label || name;
  }

  _agentDefs = raw as Record<string, AgentDefinition>;
  return _agentDefs;
}

function getAgent(name: string): AgentDefinition | undefined {
  return loadAgentDefinitions()[name];
}

function ensureToolGroups(): Record<string, string[]> {
  if (_toolGroups) return _toolGroups;
  // Try user config first
  try {
    const configPath = getConfigPath();
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (raw._tool_groups) {
      _toolGroups = raw._tool_groups;
      return _toolGroups!;
    }
  } catch {}
  // Fall back to defaults
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf-8"));
    _toolGroups = raw._tool_groups || {};
  } catch {
    _toolGroups = {};
  }
  return _toolGroups!;
}

function getAllAgentNames(): string[] {
  return Object.keys(loadAgentDefinitions());
}

function getPublicAgents(): string[] {
  const defs = loadAgentDefinitions();
  return Object.entries(defs)
    .filter(([, v]) => !v.hidden && (v.type === "mode" || v.type === "both"))
    .map(([k]) => k);
}

function getHiddenAgents(): string[] {
  const defs = loadAgentDefinitions();
  return Object.entries(defs).filter(([, v]) => v.hidden).map(([k]) => k);
}

function saveAgent(name: string): void {
  try {
    if (_currentSessionFile) {
      saveSessionMode(_currentSessionFile, name);
    }
  } catch {}
}

// ── Session mode persistence ───────────────────────────────────────────

export function loadActiveMode(): string {
  try {
    if (_currentSessionFile) {
      const saved = loadSessionMode(_currentSessionFile);
      if (saved && getAgent(saved)) return saved;
    }
    const publics = getPublicAgents();
    return publics.length > 0 ? publics[0] : "coordinator";
  } catch {
    return "coordinator";
  }
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

function getActiveMode(): string {
  return loadActiveMode();
}

export function applyAgentTools(pi: ExtensionAPI, name: string, allowSubagentType = false): boolean {
  const agent = getAgent(name);
  if (!agent) return false;
  if (!allowSubagentType && agent.type !== "mode" && agent.type !== "both") return false;

  try {
    const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
    // Empty tools = allow all (used by fallback agent)
    const toolList = resolveAgentTools(agent);
    const tools = toolList.length > 0 || agent.roles ? toolList : all;
    const allow = new Set([...tools, "switch_mode"]);
    allow.delete("subagent");
    const active = all.filter((n: string) => allow.has(n));
    const missing = all.filter(t => !allow.has(t));
    if (missing.length > 0) {
      console.error(`[omo-modes] applyMode("${name}") tools=${tools.length}, all=${all.length}, active=${active.length}, missing=${missing.length}: ${missing.slice(0,10).join(",")}...`);
    }
    console.error(`[omo-modes] applyAgentTools("${name}") roles=${JSON.stringify(agent.roles)} tools=[${tools.join(",")}] active=[${active.join(",")}]`);
    pi.setActiveTools(active);
    saveAgent(name);
  } catch (e) {
    console.error(`[omo-modes] applyAgentTools("${name}") error:`, e);
    return false;
  }
  return true;
}

function applyMode(pi: ExtensionAPI, name: string): boolean {
  if (name === "fallback") {
    // Fallback: all tools available, deduplicated
    try {
      const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
      pi.setActiveTools([...new Set(all)]);
      saveAgent(name);
      return true;
    } catch { return false; }
  }
  return applyAgentTools(pi, name, false);
}

export function getModeInstructions(name: string): string | undefined {
  return getAgent(name)?.instructions;
}

function loadToolGroups(): Record<string, string[]> {
  return ensureToolGroups();
}

function resolveAgentTools(agent: AgentDefinition): string[] {
  if (agent.roles && agent.roles.length > 0) {
    const groups = loadToolGroups();
    if (Object.keys(groups).length === 0) {
      // _tool_groups not found — return empty to force fallback to agent.tools
      return [];
    }
    const tools = new Set<string>();
    for (const role of agent.roles) {
      const group = groups[role];
      if (group) group.forEach(t => tools.add(t));
    }
    return [...tools];
  }
  return agent.tools || [];
}

// ── 注册 pi 命令和事件 ──────────────────────────────────────────────────

function registerModeCommands(pi: ExtensionAPI): void {
  // Auto-populate oh-my-opencode-slim.json with agents from defaults if empty
  try {
    const configPath = getConfigPath();
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!raw.agents && fs.existsSync(DEFAULTS_PATH)) {
      raw.agents = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf-8"));
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    }
  } catch {}

  // /modes command (kept for backward compatibility)
  pi.registerCommand("agents", {
    description: "列出所有可用 agent 及其类型",
    handler: async (_args, ctx) => {
      const all = getAllAgentNames();
      const publics = getPublicAgents();
      const current = loadActiveMode();
      const lines = all.map(n => {
        const a = getAgent(n);
        if (!a) return "";
        const marker = n === current ? " ●" : "  ";
        const label = a.label || n;
        const typeLabel = a.type === "mode" ? "模式" : a.type === "subagent" ? "子代理" : "两者";
        return `${marker} ${n} (${label}) — ${typeLabel}`;
      }).filter(Boolean);
      ctx.ui.notify(`可用 agents (${all.length}):\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("mode", {
    description: `切换模式。用法: /mode <名字> 或 /mode 弹出选择`,
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim().toLowerCase();
      const publics = getPublicAgents();
      const allNames = getAllAgentNames();

      if (trimmed) {
        if (!allNames.includes(trimmed)) {
          ctx.ui.notify(`未知模式: "${trimmed}"。`, "error");
          return;
        }
        const agent = getAgent(trimmed);
        if (agent && (agent.type === "mode" || agent.type === "both")) {
          applyMode(pi, trimmed);
          ctx.ui.notify(`切换到: ${trimmed}`, "info");
        } else {
          ctx.ui.notify(`"${trimmed}" 不能作为模式使用`, "error");
        }
        return;
      }

      const current = loadActiveMode();
      const options = publics.map((k: string) => {
        const a = getAgent(k);
        const label = a?.label || k;
        return `${k === current ? "● " : "○ "}${k} — ${label}`;
      });
      const selected = await ctx.ui.select(`当前: ${current}. 选择模式:`, options);
      if (!selected) return;
      const picked = publics[options.indexOf(selected)];
      if (!picked || picked === current) return;
      applyMode(pi, picked);
      ctx.ui.notify(`切换到: ${picked}`, "info");
    },
  });
}

function registerModeHooks(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    try { _currentSessionFile = (ctx as any)?.sessionManager?.getSessionFile?.() ?? undefined; } catch { _currentSessionFile = undefined; }

    if (event.reason === "resume" && _currentSessionFile) {
      const saved = loadSessionMode(_currentSessionFile);
      if (saved && getAgent(saved)) {
        _agentDefs = null;
        _toolGroups = null;
        applyMode(pi, saved);
        return;
      }
    }

    _agentDefs = null;
    _toolGroups = null;
    const subagentName = process.env.OMO_AGENT_NAME;
    if (process.env.OMO_SUB_AGENT === "1" && subagentName && applyAgentTools(pi, subagentName, true)) {
      return;
    }
    const mode = loadActiveMode();
    applyMode(pi, mode);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sf = (ctx as any)?.sessionManager?.getSessionFile?.();
      if (sf) saveSessionMode(sf, loadActiveMode());
    } catch {}
  });
}

// ── 独立扩展入口 ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Sub-agent tool filtering
  if (process.env.OMO_SUB_AGENT === "1" && process.env.OMO_AGENT_NAME) {
    const agentName = process.env.OMO_AGENT_NAME;
    const tryFilter = () => {
      const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
      if (all.length === 0) { setImmediate(tryFilter); return; }
      const agent = getAgent(agentName);
      if (!agent) { setImmediate(tryFilter); return; }
      const toolList = resolveAgentTools(agent);
      if (toolList.length > 0) {
        const allow = new Set([...toolList]);
        const active = all.filter((n: string) => allow.has(n));
        if (active.length > 0) pi.setActiveTools(active);
      }
    };
    setImmediate(tryFilter);
  }

  registerModeCommands(pi);
  registerModeHooks(pi);

  pi.registerTool({
    name: "switch_mode",
    label: "Switch Mode",
    description: `Switch to the next agent/mode in the workflow chain. Can return to the first. Only call after the user explicitly confirms.`,
    parameters: Type.Object({
      mode: Type.String({ description: "Target agent/mode name" }),
    }),
    async execute(_toolCallId: string, params: { mode: string }) {
      const name = params.mode?.trim().toLowerCase();
      if (name === "fallback") {
        return { content: [{ type: "text" as const, text: `请使用 /mode 命令切换到 fallback。` }], isError: true, details: {} as any };
      }
      if (!name || !getAgent(name)) {
        return { content: [{ type: "text" as const, text: `不存在该 agent。` }], isError: true, details: {} as any };
      }
      const agent = getAgent(name)!;
      if (agent.type !== "mode" && agent.type !== "both") {
        return { content: [{ type: "text" as const, text: `"${name}" 是子代理，不能作为模式切换。` }], isError: true, details: {} as any };
      }
      // Check if current mode allows switching to target mode
      const currentMode = getActiveMode() || "coordinator";
      const currentAgent = getAgent(currentMode);
      if (currentAgent?.next && Array.isArray(currentAgent.next)) {
        if (currentAgent.next.length === 0 || !currentAgent.next.includes(name)) {
          return { content: [{ type: "text" as const, text: `当前模式 "${currentMode}" 不允许切换到 "${name}"。` }], isError: true, details: {} as any };
        }
      }
      applyMode(pi, name);
      return { content: [{ type: "text" as const, text: `切换到: ${name}` }], details: { mode: name } };
    },
  });
}
