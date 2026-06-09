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
import { loadRuntimeAgentDefinitions, loadRuntimeToolGroups, mergeManagedRuntimeAgentDefinitions, resolveAgentToolNames } from "../../adapters/agent-runtime-config";
import { getDefaultAgentPromptPath, getDefaultAgentsPath } from "../../adapters/default-agent-assets";
import { TOOL_GROUPS_CONFIG_KEY } from "../../config/config-keys";
import { parseJsonc } from "../../config/jsonc";
import {
  getPiNativeConfigPath,
} from "../../config/pi-native";
import { DEFAULT_WORKFLOWS, resolveWorkflowList } from "../../config/workflow-defaults";
import { setToolScope, getToolScope } from "../policy/tool-scope-manager";

// ── 类型 ──────────────────────────────────────────────────────────────────

interface AgentDefinition {
  type: "mode" | "subagent" | "both";
  label: string;
  tools?: string[];
  roles?: string[];
  instructions?: string;
  hidden?: boolean;
  /** If true, assistant output must start with Intent: prefix (enforced at message_end). */
  requiresIntentPrefix?: boolean;
  /** Regex pattern string to validate the Intent prefix line. */
  intentPattern?: string;
  /** If true, this mode must be activated via /mode command, not switch_mode tool. */
  requiresUserCommand?: boolean;
  /** If true, this mode drives a pipeline (step validation + approval gate). */
  pipelineMode?: boolean;
  /** Workflow bound to this pipeline mode. */
  workflow?: string;
  /** If true, presets use this mode entry as the foreground model target. */
  presetPrimary?: boolean;
}

// ── 常量 ──────────────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(homedir(), ".pi", "agents");
const DEFAULTS_PATH = getDefaultAgentsPath();
const SESSION_MODE_MAP_PATH = path.join(homedir(), ".pi", "agent", ".session-modes.json");
let _currentSessionFile: string | undefined;

function getConfigPath(): string {
  return getPiNativeConfigPath();
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
  const builtInPath = getDefaultAgentPromptPath(name);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools, hidden: frontmatter.hidden };
    }
    if (fs.existsSync(builtInPath)) {
      const content = fs.readFileSync(builtInPath, "utf-8").trim();
      const { frontmatter, body } = parseFrontmatter(content);
      return { instructions: body, tools: frontmatter.tools, hidden: frontmatter.hidden };
    }
  } catch { }
  return null;
}


// ── Agent 定义加载 ────────────────────────────────────────────────────────

let _agentDefs: Record<string, AgentDefinition> | null = null;
let _toolGroups: Record<string, string[]> | null = null;
let _cachedAllTools: string[] | null = null;

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

export function getAgent(name: string): AgentDefinition | undefined {
  return loadAgentDefinitions()[name];
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeManagedAgentDefinitions(
  existing: Record<string, any> | undefined,
  defaults: Record<string, any>,
): Record<string, any> {
  const runtimeExisting: Record<string, any> = {};
  for (const [name, definition] of Object.entries(existing ?? {})) {
    if (name === TOOL_GROUPS_CONFIG_KEY) continue;
    if (isPlainObject(definition)) runtimeExisting[name] = definition;
  }
  const runtimeDefaults: Record<string, any> = {};
  for (const [name, definition] of Object.entries(defaults)) {
    if (name === TOOL_GROUPS_CONFIG_KEY) continue;
    if (isPlainObject(definition)) runtimeDefaults[name] = definition;
  }
  return mergeManagedRuntimeAgentDefinitions(runtimeDefaults, runtimeExisting);
}

function mergeManagedWorkflows(
  existing: unknown,
): { list: typeof DEFAULT_WORKFLOWS } {
  const defaultsByName = new Set(DEFAULT_WORKFLOWS.map((workflow) => workflow.name));
  const customWorkflows = isPlainObject(existing) && Array.isArray(existing.list)
    ? existing.list.filter((workflow: unknown) =>
        isPlainObject(workflow) &&
        typeof workflow.name === "string" &&
        !defaultsByName.has(workflow.name)
      )
    : [];
  return {
    list: [...DEFAULT_WORKFLOWS, ...customWorkflows],
  };
}

export function normalizeManagedRuntimeConfig(raw: Record<string, any>): { config: Record<string, any>; changed: boolean } {
  const defaults = fs.existsSync(DEFAULTS_PATH)
    ? parseJsonc<Record<string, any>>(fs.readFileSync(DEFAULTS_PATH, "utf-8"))
    : {};
  const next: Record<string, any> = { ...raw };

  if (Object.keys(defaults).length > 0) {
    next.agents = mergeManagedAgentDefinitions(
      isPlainObject(raw.agents) ? raw.agents : undefined,
      defaults,
    );
  }
  next.workflows = mergeManagedWorkflows(raw.workflows);

  return {
    config: next,
    changed: JSON.stringify(raw) !== JSON.stringify(next),
  };
}

/**
 * Returns whether the given mode requires an Intent: prefix on assistant output.
 * Falls back to false when the agent definition is missing.
 */
export function modeRequiresIntentPrefix(name: string): boolean {
  const agent = getAgent(name);
  return agent?.requiresIntentPrefix ?? false;
}

/**
 * Returns the Intent regex pattern for a mode, or the default pattern.
 */
export function getIntentPattern(name: string): RegExp {
  const agent = getAgent(name);
  if (agent?.intentPattern) {
    try { return new RegExp(agent.intentPattern); } catch { /* fall through */ }
  }
  return /^Intent:\s*\S/;
}

function ensureToolGroups(): Record<string, string[]> {
  if (_toolGroups) return _toolGroups;
  _toolGroups = loadRuntimeToolGroups();
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

// ── 唯一的最终兜底常量 ──────────────────────────────────────────────
const FALLBACK_MODE = "fallback";

/**
 * 从配置中读取第一个 type:mode 的 agent 名字。
 * 失败时返回最终兜底常量。
 */
export function getFirstModeAgent(): string {
  try {
    const publics = getPublicAgents();
    if (publics.length > 0) return publics[0];
  } catch {}
  return FALLBACK_MODE;
}

// ── Session mode persistence ───────────────────────────────────────────

export function loadActiveMode(): string {
  try {
    if (_currentSessionFile) {
      const saved = loadSessionMode(_currentSessionFile);
      if (saved && getAgent(saved)) return saved;
    }
    return getFirstModeAgent();
  } catch {
    return FALLBACK_MODE;
  }
}

function getActiveMode(): string {
  return loadActiveMode();
}

export function applyAgentTools(pi: ExtensionAPI, name: string, allowSubagentType = false): boolean {
  const agent = getAgent(name);
  if (!agent) return false;
  if (!allowSubagentType && agent.type !== "mode" && agent.type !== "both") return false;

  try {
    // 获取全部工具并缓存（唯一真源）
    const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
    _cachedAllTools = all;

    // 解析配置的工具表达式（支持 "*"、"@组"、通配符）
    const toolList = resolveConfiguredTools(agent, all);
    
    // 如果配置为空（无 tools 和 roles），使用全部工具
    const tools = toolList.length > 0 ? toolList : all;
    const baseAllow = new Set(tools);
    if (!allowSubagentType) baseAllow.add("switch_mode");
    const active = all.filter((n: string) => baseAllow.has(n));
    pi.setActiveTools(active);

    // ── 写入工具真值快照（单一决策源）──────────────────────────────────
    setToolScope(
      active,
      allowSubagentType ? "subagent" : "mode",
      name,
      { roles: agent.roles, tools: agent.tools }
    );
  } catch (e) {
    console.error(`[omo-modes] applyAgentTools("${name}") error:`, e);
    return false;
  }
  return true;
}

function applyMode(pi: ExtensionAPI, name: string, notifyChange = true): boolean {
  // 1) turnExecutionContext 重置（pre-switch hook）
  try { _onBeforeModeChange?.(name); } catch {}

  // 2) allowedTools 更新
  const ok = applyAgentTools(pi, name, false);
  if (!ok) {
    console.error(`[omo-modes] applyMode("${name}") FAILED`);
    return false;
  }

  // 3) currentMode 已通过 saveAgent() 持久化
  // 4) 记录 mode-change 事件（供观测）
  if (notifyChange) {
    try { _onModeChange?.({ mode: name, origin: consumeModeSwitchOrigin() }); } catch {}
  }
  return ok;
}

export function rehydrateActiveModeTools(pi: ExtensionAPI, sessionFile?: string): string | undefined {
  try {
    if (sessionFile) _currentSessionFile = sessionFile;
    const mode = loadActiveMode();
    if (!getAgent(mode)) return undefined;
    return applyMode(pi, mode, false) ? mode : undefined;
  } catch {
    return undefined;
  }
}

export function getModeInstructions(name: string): string | undefined {
  return getAgent(name)?.instructions;
}

/**
 * 当前模式是否走 pipeline 编排（有步骤校验 + 审批 gate）。
 */
export function isCurrentModePipeline(): boolean {
  const snapshot = getToolScope();
  if (!snapshot) return false;
  if (snapshot.source === "subagent") return false;
  if (snapshot.source === "mode") {
    const snapshotAgent = getAgent(snapshot.sourceName);
    return snapshotAgent?.pipelineMode === true;
  }
  return false;
}

export function getModeWorkflow(name: string): string | undefined {
  const workflow = getAgent(name)?.workflow?.trim();
  return workflow || undefined;
}

function getCurrentModeName(): string {
  const snapshot = getToolScope();
  if (snapshot?.source === "mode") {
    const sourceName = snapshot.sourceName.trim();
    if (sourceName) return sourceName;
  }
  return loadActiveMode();
}

export function getActiveModeWorkflow(): string | undefined {
  return getModeWorkflow(getCurrentModeName());
}

function loadToolGroups(): Record<string, string[]> {
  return ensureToolGroups();
}

/**
 * 从 agent 配置解析工具列表（仅用于配置阶段，不参与 runtime gate）。
 *
 * 解析逻辑（优先级从高到低）：
 * 1. 有 roles → 从 _tool_groups 合并（展开 @组引用和通配符）
 * 2. 有 tools → 解析表达式（支持 "*"、"@组"、通配符、字面量）
 * 3. 都没有 → 返回空数组（表示不限制，由 applyAgentTools 决定使用 all）
 *
 * @param agent Agent 定义
 * @param allTools 全部工具列表（可选，用于展开表达式）
 * @returns 解析后的工具名数组
 * @see tool-scope-manager.ts — runtime 决策唯一来源
 */
function resolveConfiguredTools(agent: AgentDefinition, allTools?: string[]): string[] {
  const groups = loadToolGroups();
  const toolsList = allTools || _cachedAllTools || [];
  return resolveAgentToolNames(agent, groups, toolsList) ?? [];
}

// ── Mode change callbacks (wired by composition root) ────────────────
let _onModeChange: ((event: ModeChangeEvent) => void) | null = null;
let _onBeforeModeChange: ((mode: string) => void) | null = null;

type ModeSwitchOrigin = "system" | "user_command" | "tool_call";

interface ModeChangeEvent {
  mode: string;
  origin: ModeSwitchOrigin;
}

let _nextModeSwitchOrigin: ModeSwitchOrigin | null = null;

function consumeModeSwitchOrigin(): ModeSwitchOrigin {
  const origin = _nextModeSwitchOrigin ?? "system";
  _nextModeSwitchOrigin = null;
  return origin;
}

export function runWithModeSwitchOrigin<T>(origin: ModeSwitchOrigin, fn: () => T): T {
  const previous = _nextModeSwitchOrigin;
  _nextModeSwitchOrigin = origin;
  try {
    return fn();
  } finally {
    _nextModeSwitchOrigin = previous;
  }
}

/**
 * Register a callback invoked before every mode switch.
 * Used by pi.ts to reset turn execution context.
 */
export function setOnBeforeModeChange(cb: (mode: string) => void): void {
  _onBeforeModeChange = cb;
}

/**
 * Register a callback invoked after every mode switch.
 * Called by pi.ts (composition root) to wire view layer updates.
 */
export function setOnModeChange(cb: (event: ModeChangeEvent) => void): void {
  _onModeChange = cb;
}

export const MODE_MESSAGE_TYPES = {
  switched: "mode_switched",
  sessionStarted: "mode_session_started",
  sessionResumed: "mode_session_resumed",
} as const;

function getModeToolSummary(): { tools: string[]; line: string } {
  const snapshot = getToolScope();
  const tools = snapshot ? [...snapshot.tools] : [];
  const preview = tools.slice(0, 12).join(", ");
  const more = tools.length > 12 ? ` ...(+${tools.length - 12})` : "";
  const line = tools.length > 0
    ? `\n[tools:${tools.length}] ${preview}${more}`
    : "\n[tools] all (no explicit allowlist)";
  return { tools, line };
}

function getWorkflowSummaryLine(mode: string): string {
  const workflow = getModeWorkflow(mode);
  return workflow
    ? `\n[workflow] ${workflow} (stage-gated; next stage requires approval)`
    : "\n[workflow] none (non-pipeline/rescue)";
}

function formatModePromptBlock(mode: string): string {
  const instructions = getModeInstructions(mode)?.trim();
  return instructions ? `\n\n<MODE name="${mode}">\n${instructions}\n</MODE>` : "";
}

export function emitModeSwitched(
  pi: ExtensionAPI,
  fromMode: string,
  toMode: string,
  triggerTurn: boolean,
): void {
  const { tools, line: toolLine } = getModeToolSummary();
  const workflowLine = getWorkflowSummaryLine(toMode);

  pi.sendMessage({
    customType: MODE_MESSAGE_TYPES.switched,
    content: `[mode] ${fromMode} -> ${toMode}${workflowLine}${toolLine}${formatModePromptBlock(toMode)}`,
    display: true,
    details: {
      kind: "switched",
      fromMode,
      mode: toMode,
      workflow: getModeWorkflow(toMode) ?? null,
      tools,
      toolCount: tools.length,
      timestamp: Date.now(),
    },
  }, { deliverAs: "followUp", triggerTurn });
}

export function emitModeSessionNotice(
  pi: ExtensionAPI,
  kind: "started" | "resumed",
  mode: string,
): void {
  const { tools, line: toolLine } = getModeToolSummary();
  const workflowLine = getWorkflowSummaryLine(mode);
  const modePromptBlock = formatModePromptBlock(mode);
  const customType = kind === "resumed"
    ? MODE_MESSAGE_TYPES.sessionResumed
    : MODE_MESSAGE_TYPES.sessionStarted;

  pi.sendMessage({
    customType,
    content: `[mode-session] ${kind} | mode: ${mode}${workflowLine}${toolLine}${modePromptBlock}`,
    display: true,
    details: {
      kind,
      mode,
      workflow: getModeWorkflow(mode) ?? null,
      tools,
      toolCount: tools.length,
      timestamp: Date.now(),
    },
  }, { deliverAs: "followUp", triggerTurn: false });
}

/**
 * 首轮健康检查：验证当前 mode 的 allowlist 是否合法。
 * 检查：allowedTools 为空 / 有重复 / 含未知工具名。
 * 返回错误信息，无错误返回 null。
 */
export function validateModeAllowlist(allTools: string[]): string | null {
  const name = loadActiveMode();
  const agent = getAgent(name);
  if (!agent) return `Mode "${name}" not found in agent definitions`;

  const tools = resolveConfiguredTools(agent, allTools);
  if (tools.length === 0 && !agent.roles) {
    return `Mode "${name}" has empty allowedTools`;
  }

  const seen = new Set<string>();
  const dupes: string[] = [];
  const unknown: string[] = [];
  const allSet = new Set(allTools);

  for (const t of tools) {
    if (seen.has(t)) dupes.push(t);
    seen.add(t);
    if (!allSet.has(t)) unknown.push(t);
  }

  if (dupes.length > 0) return `Mode "${name}" allowedTools has duplicates: ${dupes.join(", ")}`;
  if (unknown.length > 0) return `Mode "${name}" allowedTools contains unknown tools: ${unknown.join(", ")}`;
  return null;
}

export function validateModeWorkflowBinding(args: {
  modeName: string;
  agent: { pipelineMode?: boolean; workflow?: string } | undefined;
  workflows: { list?: Array<{ name: string }> } | undefined;
}): string | null {
  if (!args.agent || args.agent.pipelineMode !== true) return null;

  const workflowName = args.agent.workflow?.trim();
  if (!workflowName) {
    return `Pipeline mode "${args.modeName}" must set agents.${args.modeName}.workflow; workflows.default is not used at runtime`;
  }

  const workflowList = resolveWorkflowList(args.workflows);
  if (!workflowList.some((workflow) => workflow.name === workflowName)) {
    return `Pipeline mode "${args.modeName}" references missing workflow "${workflowName}"`;
  }

  return null;
}

export function validateActiveModeWorkflow(
  workflows: { list?: Array<{ name: string }> } | undefined,
): string | null {
  const name = getCurrentModeName();
  return validateModeWorkflowBinding({
    modeName: name,
    agent: getAgent(name),
    workflows,
  });
}

function switchToModeByName(pi: ExtensionAPI, ctx: ExtensionContext, name: string): boolean {
  const agent = getAgent(name);
  if (!agent || agent.hidden || (agent.type !== "mode" && agent.type !== "both")) return false;
  runWithModeSwitchOrigin("user_command", () => applyMode(pi, name));
  saveAgent(name);
  try { ctx.ui.setStatus("mode", `Mode: ${name}`); } catch {}
  return true;
}

function cyclePublicMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1): void {
  const publics = getPublicAgents();
  if (publics.length === 0) {
    try { ctx.ui.notify("没有可切换的模式。", "warning"); } catch {}
    return;
  }
  if (publics.length === 1) return;

  const current = loadActiveMode();
  const currentIndex = publics.indexOf(current);
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const next = publics[(baseIndex + direction + publics.length) % publics.length];
  if (!next || next === current) return;
  switchToModeByName(pi, ctx, next);
}

// ── 注册 pi 命令和事件 ──────────────────────────────────────────────────

export function registerModeCommands(pi: ExtensionAPI): void {
  // Keep managed mode/workflow defaults canonical while preserving user models
  // and custom agents/workflows.
  try {
    const configPath = getConfigPath();
    const raw = parseJsonc<Record<string, any>>(fs.readFileSync(configPath, "utf-8"));
    const { config: normalized, changed } = normalizeManagedRuntimeConfig(raw);

    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
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
        if (!switchToModeByName(pi, ctx, trimmed)) {
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
      const selected = await ctx.ui.select("选择模式:", options);
      if (!selected) return;
      const picked = publics[options.indexOf(selected)];
      if (!picked || picked === current) return;
      switchToModeByName(pi, ctx, picked);
    },
  });

  pi.registerShortcut("ctrl+down", {
    description: "切换到下一个模式",
    handler: (ctx) => cyclePublicMode(pi, ctx, 1),
  });

  pi.registerShortcut("ctrl+up", {
    description: "切换到上一个模式",
    handler: (ctx) => cyclePublicMode(pi, ctx, -1),
  });
}

export function registerModeHooks(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    try { _currentSessionFile = (ctx as any)?.sessionManager?.getSessionFile?.() ?? undefined; } catch { _currentSessionFile = undefined; }

    _agentDefs = null;
    _toolGroups = null;

    const noticeKind = event.reason === "resume" ? "resumed" : "started";
    if (event.reason === "resume") {
      const saved = loadActiveMode();
      if (saved && getAgent(saved)) {
        if (applyMode(pi, saved, false)) {
          try { ctx.ui.setStatus("mode", `Mode: ${saved}`); } catch {}
          try { emitModeSessionNotice(pi, noticeKind, saved); } catch {}
          return;
        }
      }
    }
    const subagentName = process.env.OMO_AGENT_NAME;
    // Guard: only enter sub-agent path when OMO_SUB_AGENT is set, the
    // target agent exists in definitions, AND we are in a spawn context
    // (OMO_PARENT_AGENT_NAME present).  Without this guard, stale env vars
    // left over from a previous spawn (e.g. after extension reload) would
    // apply the wrong tool set to the main session.
    const isSubAgentSpawn = process.env.OMO_SUB_AGENT === "1"
      && process.env.OMO_PARENT_AGENT_NAME
      && subagentName
      && getAgent(subagentName);
    if (isSubAgentSpawn) {
      // Sub-agent tool boundary is enforced in pi.ts/before_agent_start as single source of truth.
      return;
    }
    const mode = loadActiveMode();
    if (applyMode(pi, mode, false)) {
      try { ctx.ui.setStatus("mode", `Mode: ${mode}`); } catch {}
      try { emitModeSessionNotice(pi, noticeKind, mode); } catch {}
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sf = (ctx as any)?.sessionManager?.getSessionFile?.();
      if (sf) {
        saveSessionMode(sf, loadActiveMode());
      }
    } catch {}
  });
}

// ── 独立扩展入口 ──────────────────────────────────────────────────────────

export function registerSwitchModeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "switch_mode",
    label: "Switch Mode",
    description: `请求切换到指定模式。需要用户确认后才真正生效。`,
    parameters: Type.Object({
      mode: Type.String({ description: "目标模式名称" }),
    }),
    async execute(_toolCallId: string, params: { mode: string }) {
      const name = params.mode?.trim().toLowerCase();
      const targetAgent = name ? getAgent(name) : undefined;
      if (targetAgent?.requiresUserCommand) {
        return { content: [{ type: "text" as const, text: `请使用 /mode 命令切换到 ${name}。` }], isError: true, details: {} as any };
      }
      if (!name || !getAgent(name)) {
        return { content: [{ type: "text" as const, text: `不存在该 agent。` }], isError: true, details: {} as any };
      }
      const agent = getAgent(name)!;
      if (agent.type !== "mode" && agent.type !== "both") {
        return { content: [{ type: "text" as const, text: `"${name}" 是子代理，不能作为模式切换。` }], isError: true, details: {} as any };
      }
      // 审批已统一到 tool_call gate 中处理，此处不再弹确认框
      runWithModeSwitchOrigin("tool_call", () => applyMode(pi, name));
      saveAgent(name);
      return { content: [{ type: "text" as const, text: `已切换到: ${name}` }], details: { mode: name } };
    },
  });
}
