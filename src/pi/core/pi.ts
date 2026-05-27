/**
 * Pi Agent Adapter for oh-my-opencode-slim
 *
 * Transforms OMO's agent orchestration system into a pi extension.
 *
 * Architecture:
 *   - Agent markdown files are generated in ~/.pi/agents/ on first load
 *   - Constitution/orchestrator prompt is injected via before_agent_start
 *   - Non-blocking behavior reminders and optional compliance_check remain as adapter quality guidance
 *   - OMO's custom tools (delegate, council) are registered
 *     as pi tools (webfetch omitted - pi-web-access provides better ones)
 *   - /preset command switches model presets at runtime
 *
 * Dependencies:
 *   - pi-agents (optional but recommended): provides agent/workflow tools
 *   - pi-mcp-adapter: provides MCP gateway
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { loadActiveMode, getModeInstructions, setOnModeChange } from "./pi-modes";
import type { WorkflowStageToolResult, StageResultComplete, StageResultAskUser } from "../../core/workflow-types";
import { AGENT_PROMPTS, reloadAgentPrompts } from "../meeting/pi-agents";
import {
  formatPiCouncilResults,
  resolvePiCouncilParticipants,
  runPiCouncilParticipant,
  type PiCouncilParticipant,
  type PiCouncilRunResult,
} from "../meeting/pi-council";
import { formatPiMeetingResult, runPiMeeting, type PiMeetingParticipantResult } from "../meeting/pi-meeting";
export { AGENT_PROMPTS } from "../meeting/pi-agents";
export { formatPiCouncilResults, resolvePiCouncilParticipants } from "../meeting/pi-council";


export { formatPiMeetingResult, normalizePiMeetingBackend, normalizePiMeetingMaxRounds, normalizePiMeetingObjective } from "../meeting/pi-meeting";
import { registerSubagentTool, getPool, initPoolModelResolver, type PoolAgentInfo } from "../subagent/subagent-pool";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getHub } from "../meeting/pi-hub";
import { createChatStatusView, groupChatStatusViews, type ChatStatusView } from "../subagent/chat-status-view";
import { runPrivateChat, runGroupChat, autoOpenChat } from "../subagent/pi-chat-bridge";
import { WorkflowManager } from "../workflow/workflow-manager";
import { getCurrentPoolId, setStageResult } from "../workflow/stage-result-store";
import { bindWorkflowChatBridge } from "../workflow/workflow-chat-binding";
import { registerWorkflowCommands } from "../workflow/workflow-commands";
import { WorkflowsConfig } from "../../core/workflow-types";
import { DEFAULT_WORKFLOWS } from "../../config/schema";
import { deepMerge, loadPluginConfig } from "../../config/loader";


// ─── Config helpers ────────────────────────────────────────────────────────

const BASIC_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

function trimToolDescriptions(prompt: string, config: Record<string, any>): string {
  const hide = new Set((config?.hide as string[]) ?? []);
  const truncCfg = (config?.truncate ?? {}) as Record<string, number>;
  const defaultTrunc = truncCfg.default ?? 0;

  const lines = prompt.split("\n");
  const out: string[] = [];
  let inTools = false;
  let inJsonSection = false;
  const jsonBlock: string[] = [];
  let braceDepth = 0;

  function flushJsonBlock(): void {
    if (jsonBlock.length === 0) return;
    const block = jsonBlock.join("\n");
    try {
      const obj = JSON.parse(block);
      if (obj && typeof obj.name === "string") {
        const name = obj.name;
        if (hide.has(name)) {
          jsonBlock.length = 0;
          return;
        }
        if (typeof obj.description === "string") {
          const maxLen = truncCfg[name] ?? defaultTrunc;
          if (maxLen > 0 && obj.description.length > maxLen) {
            obj.description = obj.description.slice(0, maxLen) + "...";
            jsonBlock.length = 0;
            jsonBlock.push(JSON.stringify(obj, null, 2));
          }
        }
      }
    } catch {}
    for (const l of jsonBlock) out.push(l);
    jsonBlock.length = 0;
  }

  for (const line of lines) {
    // Detect "Available Tool Schemas" section header
    if (/^\s*Available Tool Schemas/i.test(line)) {
      flushJsonBlock();
      inJsonSection = true;
      out.push(line);
      continue;
    }

    // Detect "Available tools" section header (line format)
    if (/^\s*Available tools[:\s]/i.test(line)) {
      flushJsonBlock();
      inTools = true;
      inJsonSection = false;
      out.push(line);
      continue;
    }

    if (inJsonSection) {
      const trimmed = line.trim();
      if (trimmed === "" && jsonBlock.length === 0) {
        out.push(line);
        continue;
      }
      if (trimmed === "" && jsonBlock.length > 0) {
        flushJsonBlock();
        out.push(line);
        continue;
      }

      jsonBlock.push(line);
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }

      if (braceDepth <= 0 && jsonBlock.length > 0) {
        flushJsonBlock();
        braceDepth = 0;
      }
      continue;
    }

    if (inTools) {
      // Tool line: "- name: description"
      const match = line.match(/^\s*- (\w+):\s*/);
      if (match) {
        const name = match[1];
        const desc = line.slice(match[0].length);

        if (hide.has(name)) {
          out.push("  - " + name);
        } else {
          const maxLen = truncCfg[name] ?? defaultTrunc;
          if (maxLen > 0 && desc.length > maxLen) {
            out.push("  - " + name + ": " + desc.slice(0, maxLen) + "...");
          } else {
            out.push(line);
          }
        }
        continue;
      }

      // Empty line or non-tool line: end of tools section
      if (line.trim() === "" || !line.startsWith("- ")) {
        inTools = false;
        out.push(line);
        continue;
      }
    }

    out.push(line);
  }

  flushJsonBlock();
  return out.join("\n");
}

function trimProviderToolDescriptions(
  obj: Record<string, any>,
  hide: Set<string>,
  truncCfg: Record<string, number>,
  defaultTrunc: number,
): void {
  // OpenAI / Anthropic format: { tools: [{ function: { name, description } }] }
  if (Array.isArray(obj.tools)) {
    obj.tools = obj.tools.filter((t: any) => {
      const name = t.function?.name ?? t.name ?? "";
      if (hide.has(name)) return false;
      const descField = t.function?.description ?? t.description ?? "";
      if (typeof descField === "string") {
        const maxLen = truncCfg[name] ?? defaultTrunc;
        if (maxLen > 0 && descField.length > maxLen) {
          if (t.function) t.function.description = descField.slice(0, maxLen) + "...";
          else t.description = descField.slice(0, maxLen) + "...";
        }
      }
      return true;
    });
  }
  // Google / Vertex format: { tools: [{ functionDeclarations: [{ name, description }] }] }
  for (const t of (Array.isArray(obj.tools) ? obj.tools : [])) {
    if (Array.isArray(t.functionDeclarations)) {
      t.functionDeclarations = t.functionDeclarations.filter((fd: any) => {
        const name = fd.name ?? "";
        if (hide.has(name)) return false;
        const maxLen = truncCfg[name] ?? defaultTrunc;
        if (maxLen > 0 && typeof fd.description === "string" && fd.description.length > maxLen) {
          fd.description = fd.description.slice(0, maxLen) + "...";
        }
        return true;
      });
    }
  }
}

export interface PiCouncilParticipantConfig {
  name?: string;
  agent?: string;
  model?: string;
  variant?: string;
  prompt?: string;
}

export interface PiCouncilConfig {
  presets?: Record<string, Record<string, PiCouncilParticipantConfig>>;
  default_preset?: string;
  timeout?: number;
  councillor_execution_mode?: "parallel" | "serial";
  meeting_backend?: "session" | "collaborating";
}

export interface OmniMoConfig {
  preset?: string;
  presets?: Record<string, Record<string, { model?: string; variant?: string; thinking?: string }>>;
  agents?: Record<string, { model?: string; variant?: string; thinking?: string }>;
  disabled_agents?: string[];
  council?: PiCouncilConfig;
  workflows?: WorkflowsConfig;
}

interface PiDelegationCapabilities {
  hasPiAgents: boolean;
  hasSubagent: boolean;
  hasAgentMessage: boolean;
}

export function stripJsonCommentsSafely(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaping = false;
  let lineComment = false;
  let blockComment = false;

  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inString) {
      out += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function getPiAgentDirForConfig(): string {
  return getAgentDir();
}

function readPiNativeConfig(): OmniMoConfig | null {
  const configBase = path.join(getPiAgentDirForConfig(), "oh-my-opencode-slim");
  for (const configPath of [`${configBase}.jsonc`, `${configBase}.json`]) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(stripJsonCommentsSafely(raw)) as OmniMoConfig;
    } catch {}
  }
  return null;
}

export function loadOmniMoConfig(cwd = process.cwd()): OmniMoConfig | null {
  const piNativeConfig = readPiNativeConfig();
  const sharedConfig = loadPluginConfig(cwd) as OmniMoConfig;
  const config = deepMerge(
    (piNativeConfig as Record<string, unknown>) ?? undefined,
    Object.keys(sharedConfig).length > 0 ? sharedConfig as Record<string, unknown> : undefined,
  ) as OmniMoConfig | undefined;
  return config && Object.keys(config).length > 0 ? config : null;
}

function getDefaultModel(
  agentName: string,
  config: OmniMoConfig | null,
): string {
  if (!config) return "openai/gpt-4o-mini";

  const presetName = config.preset ?? "default";
  const preset = config.presets?.[presetName];
  const agentOverride = preset?.[agentName];
  const agentsOverride = config.agents?.[agentName];

  return (
    (agentOverride as any)?.model ??
    (agentsOverride as any)?.model ??
    DEFAULT_MODELS[agentName] ??
    "openai/gpt-4o-mini"
  );
}

const DEFAULT_MODELS: Record<string, string> = {
  explorer: "openai/gpt-4o-mini",
  librarian: "openai/gpt-4o-mini",
  oracle: "openai/gpt-4.1",
  fixer: "openai/gpt-4o-mini",
  designer: "openai/gpt-4o-mini",
  observer: "openai/gpt-4o-mini",
};

// ─── Agent file generation ─────────────────────────────────────────────────

function getManagedAgentSourceHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function withManagedAgentMetadata(content: string): string {
  const sourceHash = getManagedAgentSourceHash(content);
  if (!content.startsWith("---\n")) {
    return content;
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return content;
  }
  const block = content.slice(4, end);
  const body = content.slice(end);
  const metadata = [
    "omo-managed: true",
    `omo-source-hash: ${sourceHash}`,
  ];
  const nextBlock = [
    ...block.split("\n").filter((line) => !/^omo-(managed|source-hash):/.test(line.trim())),
    ...metadata,
  ].join("\n");
  return `---\n${nextBlock}${body}`;
}

function parseAgentFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end === -1) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim();
  }
  return frontmatter;
}

function isManagedAgentContent(content: string): boolean {
  return parseAgentFrontmatter(content)["omo-managed"] === "true";
}

function stripManagedMetadata(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^omo-(managed|source-hash):/.test(line.trim()))
    .join("\n");
}

function normalizeAgentContentForComparison(content: string): string {
  return stripManagedMetadata(content)
    .split("\n")
    .filter((line) => !/^(model|thinking|tools):/.test(line.trim()))
    .join("\n")
    .trim();
}

const LEGACY_GENERATED_AGENT_BODY_MARKERS: Record<string, readonly RegExp[]> = {
  "oracle.md": [/You are Oracle - a strategic technical advisor and code reviewer\./],
  "fixer.md": [/You are Fixer\b/, /Fast implementation specialist/],
  "designer.md": [/You are Designer\b/, /UI\/UX design, review, and implementation/],
  "explorer.md": [/You are Explorer\b/],
  "librarian.md": [/You are Librarian\b/],
  "observer.md": [/You are Observer\b/],
};

function getAgentNameFromFileLabel(label: string): string {
  return label.replace(/\.md$/, "");
}

function getAgentBody(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? content : content.slice(end + 4).trim();
}

function isLegacyGeneratedAgentContent(existing: string, label: string): boolean {
  const frontmatter = parseAgentFrontmatter(existing);
  if (frontmatter.name !== getAgentNameFromFileLabel(label)) return false;
  const body = getAgentBody(existing);
  const markers = LEGACY_GENERATED_AGENT_BODY_MARKERS[label] ?? [];
  return markers.some((marker) => marker.test(body));
}

function isLegacyOmoAgentContent(existing: string, sourceContent: string, label: string): boolean {
  return normalizeAgentContentForComparison(existing) === normalizeAgentContentForComparison(sourceContent) ||
    isLegacyGeneratedAgentContent(existing, label);
}

function writeManagedAgentFile(target: string, managedContent: string, label: string): "updated" {
  const existing = fs.readFileSync(target, "utf-8");
  fs.writeFileSync(`${target}.bak`, existing, "utf-8");
  fs.writeFileSync(target, managedContent, "utf-8");
  console.error(`[oh-my-opencode-slim] Updated managed agent file: ${label}`);
  return "updated";
}

function syncAgentFile(target: string, sourceContent: string, label: string): "created" | "updated" | "skipped" {
  const managedContent = withManagedAgentMetadata(sourceContent);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, managedContent, "utf-8");
    console.error(`[oh-my-opencode-slim] Generated agent file: ${label}`);
    return "created";
  }

  const existing = fs.readFileSync(target, "utf-8");
  if (!isManagedAgentContent(existing)) {
    if (!isLegacyOmoAgentContent(existing, sourceContent, label)) {
      return "skipped";
    }
    return writeManagedAgentFile(target, managedContent, label);
  }
  if (existing === managedContent) {
    return "skipped";
  }

  return writeManagedAgentFile(target, managedContent, label);
}

function generateAgentMd(
  name: string,
  prompt: string,
  description: string,
): string {
  return `---
name: ${name}
description: ${description}
---

${prompt}
`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeTomlMultilineString(value: string): string {
  // TOML multiline basic strings end at triple quotes; split accidental
  // occurrences so generated agent prompts remain parseable.
  return value.replace(/"""/g, '""\\"');
}

function generateAgentToml(
  name: string,
  prompt: string,
  description: string,
  model: string,
): string {
  return `name = "${escapeTomlBasicString(name)}"
description = "${escapeTomlBasicString(description)}"
model = "${escapeTomlBasicString(model)}"
reasoning = "low"
prompt = """${escapeTomlMultilineString(prompt)}
"""
`;
}

export function getPiAgentsDirForSync(): string {
  return path.join(path.dirname(getAgentDir()), "agents");
}

export function writeWorkflowStageResult(result: WorkflowStageToolResult, poolId?: string): boolean {
  if (!poolId?.trim()) return false;
  setStageResult(poolId, result);
  return true;
}

export function ensureAgentFiles(): void {
  const agentsDir = getPiAgentsDirForSync();
  const defaultAgentsDir = path.join(__dirname, "..", "..", "adapters", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  try {
    if (!fs.existsSync(defaultAgentsDir)) return;
    const files = fs.readdirSync(defaultAgentsDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const target = path.join(agentsDir, file);
      const content = fs.readFileSync(path.join(defaultAgentsDir, file), "utf-8");
      syncAgentFile(target, content, file);
    }
    reloadAgentPrompts();
  } catch {}
}

function updateAgentModels(config: OmniMoConfig | null, presetName: string): void {
  const agentsDir = getPiAgentsDirForSync();
  const preset = config?.presets?.[presetName];
  if (!preset) return;

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const agentOverride = preset[name] as { model?: string } | undefined;
    const model = agentOverride?.model ?? getDefaultModel(name, config);

    const mdPath = path.join(agentsDir, `${name}.md`);
    if (fs.existsSync(mdPath)) {
      const content = generateAgentMd(name, info.prompt, info.description);
      syncAgentFile(mdPath, content, `${name}.md`);
    }

    const tomlPath = path.join(agentsDir, `${name}.toml`);
    if (fs.existsSync(tomlPath)) {
      const content = generateAgentToml(name, info.prompt, info.description, model);
      fs.writeFileSync(tomlPath, content, "utf-8");
    }
  }
}

function getPresetModelForOrchestrator(
  config: OmniMoConfig | null,
  presetName: string,
): string | undefined {
  const preset = config?.presets?.[presetName];
  const override = preset?.orchestrator as { model?: string } | undefined;
  return override?.model;
}

function getPresetThinkingForOrchestrator(
  config: OmniMoConfig | null,
  presetName: string,
): string | undefined {
  const preset = config?.presets?.[presetName];
  const override = preset?.orchestrator as { thinking?: string } | undefined;
  return override?.thinking;
}

export function parsePiModelId(modelId: string): { provider: string; model: string } | undefined {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export function resolvePresetSwitchPlan(
  config: OmniMoConfig | null,
  presetName: string,
): { model?: string; thinking?: string; error?: string } {
  if (!config?.presets?.[presetName]) {
    const available = Object.keys(config?.presets ?? {}).join(", ") || "(none)";
    return { error: `Preset "${presetName}" not found. Available presets: ${available}` };
  }
  return {
    model: getPresetModelForOrchestrator(config, presetName),
    thinking: getPresetThinkingForOrchestrator(config, presetName),
  };
}


// ─── Orchestrator System Prompt Builder ────────────────────────────────────

/** Load agent definitions from agents-default.json (built-in defaults). */
function loadAgentDefinitions(): Record<string, { type?: string; label?: string; delegates?: string[]; roles?: string[] }> {
  try {
    const defaultsPath = path.join(__dirname, "..", "..", "adapters", "agents-default.json");
    const raw = JSON.parse(fs.readFileSync(defaultsPath, "utf-8"));
    // Strip internal keys starting with _
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (!key.startsWith("_")) result[key] = val as any;
    }
    return result;
  } catch { return {}; }
}

function buildPiOrchestratorPrompt(
  disabledAgents: string[],
  config: OmniMoConfig | null,
  capabilities: PiDelegationCapabilities,
): string {

  const constPath = path.join(homedir(), ".pi", "agent", "constitution.md");
  let constText = "";
  try { if (fs.existsSync(constPath)) constText = fs.readFileSync(constPath, "utf-8").trim(); } catch {}
  if (!constText) constText = `<CONSTITUTION>\n(未找到 constitution.md)\n</CONSTITUTION>`;

  const agentDefs = loadAgentDefinitions();
  const disabledSet = new Set(disabledAgents);

  // Build available-agents section from AGENT_PROMPTS + agent defs
  const agentLines: string[] = [];
  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    if (disabledSet.has(name)) continue;
    const def = agentDefs[name];
    const typeLabel = def?.type === "mode" ? "(模式)" : def?.type === "subagent" ? "(子代理)" : "";
    const label = def?.label || info.description || name;
    const delegates = def?.delegates?.length ? ` → 可委托: ${[...new Set(def.delegates)].join(", ")}` : "";
    agentLines.push(`  @${name} ${typeLabel} — ${label}${delegates}`);
  }

  const capabilitiesNotes: string[] = [];
  if (capabilities.hasPiAgents) capabilitiesNotes.push("- pi-agents 可用: 支持 task/agent tool");
  if (capabilities.hasSubagent) capabilitiesNotes.push("- omo_subagent 可用: 支持 pool 模式子代理");
  if (capabilities.hasAgentMessage) capabilitiesNotes.push("- agent_message 可用: 支持后台 agent 通信");

  const parts: string[] = [constText];

  if (agentLines.length > 0) {
    parts.push(`\n<AvailableAgents>\n${agentLines.join("\n")}\n</AvailableAgents>`);
  }

  if (disabledSet.size > 0) {
    parts.push(`\n<DisabledAgents>\n  以下 agents 已被禁用: ${[...disabledSet].join(", ")}. 不要尝试委托或引用它们。\n</DisabledAgents>`);
  }

  if (capabilitiesNotes.length > 0) {
    parts.push(`\n<Capabilities>\n${capabilitiesNotes.join("\n")}\n</Capabilities>`);
  }

  // Workflow hints from config
  if (config?.workflows?.list && config.workflows.list.length > 0) {
    const wfLines = config.workflows.list.map(w => {
      const stages = w.stages.map(s => (s as any).agent || "(choice)").join(" → ");
      return `  • ${w.name}: ${w.description} [${stages}]`;
    });
    parts.push(`\n<Workflows>\n可用 workflow:\n${wfLines.join("\n")}\n</Workflows>`);
  }

  return parts.join("\n\n");
}

// ─── Tool implementations ──────────────────────────────────────────────────

function createToolImplementations(config: OmniMoConfig | null) {
  return {
    council: {
      name: "omo_council",
      label: "OMO Council",
      description:
        "Run multiple models on the same question and synthesize their answers. meeting mode uses a hidden round-based debate and returns only a compressed report; collaborating backend uses persistent participants for raw-message discussion.",
      promptSnippet: "Multi-model consensus: run multiple models on the same question and synthesize",
      parameters: Type.Object({
        question: Type.String({ description: "The question or task for all models to analyze" }),
        mode: Type.Optional(Type.String({ description: "Council mode: isolated (default) | meeting" })),
        preset: Type.Optional(Type.String({ description: "Council preset name from config" })),
        objective: Type.Optional(Type.String({ description: "Meeting objective: brainstorm | review | design | debug | decision" })),
        maxRounds: Type.Optional(Type.Integer({ description: "Meeting discussion rounds, clamped to 1..5" })),
        maxDurationMs: Type.Optional(Type.Number({ description: "Meeting timeout budget in milliseconds" })),
        includeTranscript: Type.Optional(Type.Boolean({ description: "Debug only: include raw hidden meeting transcript in the tool result" })),
        backend: Type.Optional(Type.String({ description: "Meeting backend: session (轮次讨论) | pool (实时讨论)" })),
        participants: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.Optional(Type.String({ description: "Participant display name" })),
              agent: Type.Optional(Type.String({ description: "OMO agent prompt to use, e.g. oracle/explorer/fixer" })),
              model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
              prompt: Type.Optional(Type.String({ description: "Optional participant-specific guidance" })),
            }),
            { description: "Explicit council/meeting participants" },
          ),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          question: string;
          mode?: string;
          preset?: string;
          objective?: string;
          maxRounds?: number;
          maxDurationMs?: number;
          includeTranscript?: boolean;
          backend?: string;
          participants?: PiCouncilParticipantConfig[];
        },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        const mode = params.mode ?? "isolated";
        if (mode === "meeting") {
          // 非阻塞会议模式:立即返回,后台运行
          const resolved = resolvePiCouncilParticipants({
            config,
            preset: params.preset,
            participants: params.participants,
          });
          if (resolved.error) {
            return { content: [{ type: "text" as const, text: resolved.error }], details: {}, isError: true };
          }

          const hub = getHub();
          const meetingId = `omo-meet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const spawnedSessions: AgentSession[] = [];
          const errors: string[] = [];

          // 启动每个 participant RPC 进程
          for (const participant of resolved.participants) {
            const agentPrompt = AGENT_PROMPTS[participant.agent]?.prompt || "You are a specialist.";
            const task = [
              `You are ${participant.name} (${participant.agent}) in a group discussion.`,
              `Topic: ${params.question}`,
              `Objective: ${params.objective || "discuss"}`,
              "",
              agentPrompt,
              participant.prompt ? `\nRole guidance: ${participant.prompt}` : "",
              "",
              "--- Protocol ---",
              "You are in a real-time chat with other agents and a user.",
              "You will receive messages from others with [Name]: prefix.",
              "Each new message is sent to you as a prompt.",
              "Read and respond when you have something to add.",
              "Respond concisely and directly.",
              "Stay in context of the topic.",
            ].filter(Boolean).join("\n");

            try {
              const created = await createAgentSession({
                cwd: ctx.cwd,
                sessionManager: SessionManager.inMemory(),
              });
              spawnedSessions.push(created.session);
              await created.session.prompt(task);
            } catch (e: any) {
              errors.push(`${participant.name}: spawn failed - ${e.message}`);
            }
          }

          if (spawnedSessions.length === 0) {
            return {
              content: [{ type: "text" as const, text: `❌ 群聊创建失败,所有参与者都无法启动。\n${errors.join("\n")}` }],
              details: { mode, question: params.question, errors },
              isError: true,
            };
          }

          // 注册到 hub
          const participants = resolved.participants
            .filter((_, i) => i < spawnedSessions.length)
            .map((p, i) => ({
              name: p.name,
              agentType: p.agent,
              session: spawnedSessions[i],
            }));
          hub.registerMeeting(meetingId, params.question.slice(0, 60), participants);

          // 无需 setTimeout--用户加入群聊后第一条消息就是讨论开始
          // 每个 participant 已经收到了初始任务(含 topic),等待第一条消息触发回复

          const warnText = errors.length > 0 ? `\n\n⚠️ 部分参与者启动失败:\n${errors.join("\n")}` : "";

          return {
            content: [{ type: "text" as const, text: `✅ 群聊已创建: "${params.question.slice(0, 60)}"\n参与: ${participants.map(p => p.name).join(", ")}${warnText}\n\n使用 /chat 加入讨论,发言会被同步给所有人。` }],
            details: {
              mode,
              question: params.question,
              meetingId,
              status: "active",
              participants: participants.map(p => ({ name: p.name, agentType: p.agentType })),
              errors: errors.length > 0 ? errors : undefined,
            },

          };
        }

        if (mode !== "isolated") {
          return {
            content: [{ type: "text" as const, text: `Unsupported council mode "${mode}". Use mode="isolated" or mode="meeting".` }],
            details: { mode, question: params.question },
            isError: true,
          };
        }

        const resolved = resolvePiCouncilParticipants({
          config,
          preset: params.preset,
          participants: params.participants,
        });
        if (resolved.error) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            details: { mode, question: params.question },
            isError: true,
          };
        }

        const timeoutMs = config?.council?.timeout ?? 180000;
        const executionMode = config?.council?.councillor_execution_mode ?? "parallel";
        const runOne = (participant: PiCouncilParticipant) =>
          runPiCouncilParticipant({ participant, question: params.question, ctx, timeoutMs });

        const results = executionMode === "serial"
          ? [] as PiCouncilRunResult[]
          : await Promise.all(resolved.participants.map(runOne));

        if (executionMode === "serial") {
          for (const participant of resolved.participants) {
            results.push(await runOne(participant));
          }
        }

        return {
          content: [{ type: "text" as const, text: formatPiCouncilResults(params.question, results) }],
          details: { mode, question: params.question, results },
          isError: results.every((r) => r.status !== "completed"),
        };
      },
    },


  };

}



// ─── Pi extension entry point ──────────────────────────────────────────────

export default function omniMoPiExtension(pi: ExtensionAPI) {
  // Clean up sub-agent env vars to prevent stale values from a previous
  // session leaking through extension reload. These are set by subagent-pool
  // during spawn() and normally restored in the finally block, but a reload
  // can interrupt that, leaving them dangling.
  const OMO_ENV_VARS = [
    "OMO_SUB_AGENT", "OMO_AGENT_NAME", "OMO_PARENT_AGENT_NAME",
    "OMO_SUBAGENT_DEPTH", "OMO_STAGE_RESULT_PATH",
    "OMO_ALLOWED_SUBAGENTS", "OMO_AGENT_ID",
  ];
  for (const v of OMO_ENV_VARS) delete process.env[v];

  const config = loadOmniMoConfig();
  let currentPreset = config?.preset ?? "default";

  // ── Detect delegation capabilities ─────────────────────────────────
  function getToolNames(): Set<string> {
    try {
      const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
      return new Set(tools.map((tool: any) => tool?.name).filter((name: any): name is string => typeof name === "string"));
    } catch {
      return new Set();
    }
  }

  function detectPiAgentsFromSettings(): boolean {
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const packages: unknown[] = settings.packages ?? [];
        return packages.some((entry) => {
          const p = typeof entry === "string"
            ? entry
            : typeof (entry as any)?.source === "string"
              ? (entry as any).source
              : "";
          return p === "npm:pi-agents" || p === "pi-agents" || p.includes("/pi-agents");
        });
      }
    } catch {
      // ignore
    }
    return false;
  }

  let runtimeCapabilities: PiDelegationCapabilities = {
    hasPiAgents: detectPiAgentsFromSettings(),
    hasSubagent: false,
    hasAgentMessage: false,
  };

  function refreshDelegationCapabilities(systemPrompt?: string): PiDelegationCapabilities {
    const toolNames = getToolNames();
    runtimeCapabilities = {
      hasPiAgents:
        runtimeCapabilities.hasPiAgents ||
        toolNames.has("agent") ||
        toolNames.has("workflow") ||
        !!systemPrompt?.includes("<agents scope="),
      hasSubagent: toolNames.has("subagent"),
      hasAgentMessage: toolNames.has("agent_message"),
    };
    return runtimeCapabilities;
  }

  // ── Mapping file path (user-local, not in repo) ──────────────────────
  // ── Generate agent files on first load ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Capture ctx for WorkflowManager chat overlay
    _sessionCtx = ctx;

    // Wire model resolver so pool sub-agents get preset models
    initPoolModelResolver((modelId) => {
      const slash = modelId.indexOf("/");
      if (slash <= 0) return undefined;
      return ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
    });

    ensureAgentFiles();

    // Wire pool error events → chat notification
    getPool().onEvent((event) => {
      if (event.type === "error") {
        try {
          ctx.ui.notify(`[pool] ${event.agentName}: ${event.error}`, "warning");
        } catch {}
      }
    });

    // Wire mode change → status bar
    try {
      const initialMode = loadActiveMode() || "coordinator";
      ctx.ui.setStatus("mode", `Mode: ${initialMode}`);
      setOnModeChange((newMode: string) => {
        ctx.ui.setStatus("mode", `Mode: ${newMode}`);
      });
    } catch {}

  });

  // ── Inject orchestrator system prompt ───────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Sub-agent detection: skip constitution/mode injection for sub-agent sessions
    // Sub-agents (council participants) have appendSystemPrompt set as a marker
    if (event.systemPromptOptions?.appendSystemPrompt === "__OMO_SUB_AGENT__" || process.env.OMO_SUB_AGENT === "1") {
      // Filter tools per agent roles before returning
      if (process.env.OMO_AGENT_NAME) {
        try {
          const configPath = path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const agentCfg = raw.agents?.[process.env.OMO_AGENT_NAME];
          const groups = raw._tool_groups ?? {};
          if (agentCfg?.roles && Object.keys(groups).length > 0) {
            const toolNames = new Set<string>();
            for (const role of agentCfg.roles) {
              const group = groups[role];
              if (group) group.forEach((t: string) => toolNames.add(t));
            }
            const allTools = pi.getAllTools();
            const active = allTools.filter((t: any) => toolNames.has(t.name)).map((t: any) => t.name);
            pi.setActiveTools(active);
          }
        } catch {}
      }
      return { systemPrompt: event.systemPrompt };
    }

    const capabilities = refreshDelegationCapabilities(event.systemPrompt);
    const disabledAgents = config?.disabled_agents ?? [];
    const omniPrompt = buildPiOrchestratorPrompt(
      disabledAgents,
      config,
      capabilities,
    );

    // Trim verbose tool descriptions in system prompt
    const trimmedPrompt = trimToolDescriptions(event.systemPrompt, (config as any)?.tool_descriptions ?? {});
    const activeMode = loadActiveMode() || "coordinator";
    const modeInstructions = getModeInstructions(activeMode) ?? "";
    const modePrompt = modeInstructions
      ? `<MODE name="${activeMode}">\n${modeInstructions}\n</MODE>`
      : "";

    return {
      systemPrompt: [omniPrompt, modePrompt, trimmedPrompt].filter(Boolean).join("\n\n---\n\n"),
    };
  });

      // ── Trim tool descriptions in provider API payload ────────────────
  pi.on("before_provider_request", (event, _ctx) => {
    const toolCfg = (config as any)?.tool_descriptions ?? {};
    const hide = new Set<string>((toolCfg.hide as string[]) ?? []);
    const truncCfg = (toolCfg.truncate ?? {}) as Record<string, number>;
    const defaultTrunc = truncCfg.default ?? 0;
    if (hide.size === 0 && defaultTrunc === 0 && Object.keys(truncCfg).length === 0) return;
    trimProviderToolDescriptions(event.payload as Record<string, any>, hide, truncCfg, defaultTrunc);
  });



  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.council);

  // ── Register omo_subagent tool (zero external deps, uses pi --mode rpc/json) ─
  registerSubagentTool(pi);

  // ── Workflow stage tools ──────────────────────────────────────────
  pi.registerTool({
    name: "stage_complete",
    label: "Request Completion",
    description: "workflow stage 子代理申请完成许可时调用,请求主 agent 批准。",
    parameters: Type.Object({
      summary: Type.String({ description: "简短阶段总结" }),
      context: Type.String({ description: "传给下一阶段的上下文" }),
      evidence: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String({ description: "文件路径" })),
        source: Type.Optional(Type.String({ description: "来源" })),
        reason: Type.String({ description: "引用理由" }),
      }), { description: "证据引用" })),
      artifacts: Type.Optional(Type.Object({
        files: Type.Optional(Type.Array(Type.String({ description: "文件列表" }))),
        decisions: Type.Optional(Type.Array(Type.String({ description: "决策记录" }))),
        risks: Type.Optional(Type.Array(Type.String({ description: "风险点" }))),
        commands: Type.Optional(Type.Array(Type.String({ description: "可执行命令" }))),
      }, { description: "产出物" })),
      suggestedNext: Type.Optional(Type.Object({
        branch: Type.Optional(Type.String({ description: "建议分支" })),
        reason: Type.Optional(Type.String({ description: "理由" })),
      }, { description: "下步建议" })),
    }),
    async execute(_toolCallId, params) {
      const result: StageResultComplete = {
        type: "complete",
        summary: params.summary,
        context: params.context,
        evidence: (params as any).evidence,
        artifacts: (params as any).artifacts,
        suggestedNext: (params as any).suggestedNext,
      };
      const poolId = process.env.OMO_AGENT_ID || getCurrentPoolId();
      const ok = writeWorkflowStageResult(result, poolId);
      return ok
        ? { content: [{ type: "text", text: "stage_complete recorded" }], details: { ok: true } }
        : { content: [{ type: "text", text: "Missing OMO_AGENT_ID" }], details: { ok: false }, isError: true };
    },
  });

  pi.registerTool({
    name: "stage_ask_user",
    label: "Stage Ask User",
    description: "workflow stage 子代理需要用户输入时调用,写入结构化提问结果。",
    parameters: Type.Object({
      summary: Type.String({ description: "当前阶段状态" }),
      question: Type.String({ description: "问题" }),
      options: Type.Optional(Type.Array(Type.String({ description: "可选项" }))),
      evidence: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String({ description: "文件路径" })),
        source: Type.Optional(Type.String({ description: "来源" })),
        reason: Type.String({ description: "引用理由" }),
      }), { description: "证据引用" })),
      artifacts: Type.Optional(Type.Object({
        decisions: Type.Optional(Type.Array(Type.String({ description: "决策记录" }))),
        risks: Type.Optional(Type.Array(Type.String({ description: "风险点" }))),
      }, { description: "产出物" })),
    }),
    async execute(_toolCallId, params) {
      const result: StageResultAskUser = {
        type: "ask_user",
        summary: params.summary,
        question: params.question,
        options: params.options,
        evidence: (params as any).evidence,
        artifacts: (params as any).artifacts,
      };
      const askPoolId = process.env.OMO_AGENT_ID || getCurrentPoolId();
      const ok = writeWorkflowStageResult(result, askPoolId);
      return ok
        ? { content: [{ type: "text", text: "stage_ask_user recorded" }], details: { ok: true } }
        : { content: [{ type: "text", text: "Missing OMO_AGENT_ID" }], details: { ok: false }, isError: true };
    },
  });

  // ── Initialize WorkflowManager ────────────────────────────────────
  const wf = config?.workflows;
  const workflowsConfig: WorkflowsConfig = {
    default: typeof wf?.default === "string" ? wf.default : "standard-dev",
    list: Array.isArray(wf?.list) && wf.list.length > 0 ? wf.list : DEFAULT_WORKFLOWS,
  };
  const workflowManager = new WorkflowManager({ cwd: process.cwd() });
  registerWorkflowCommands(pi, workflowsConfig, workflowManager);

  // 绑定 Chat overlay auto-open (ctx captured from session_start)
  let _sessionCtx: ExtensionContext | null = null;
  bindWorkflowChatBridge({
    manager: workflowManager,
    hub: getHub(),
    getPoolSession: (id) => getPool().getSession(id),
    autoOpenChat,
    getSessionCtx: () => _sessionCtx,
    notify: (message, level = 'info') => _sessionCtx?.ui.notify(message, level),
    setStatus: (key, value) => _sessionCtx?.ui.setStatus(key, value),
    clearStatus: (key) => _sessionCtx?.ui.setStatus(key, ''),
    sendAgentMessage: (content) => {
      try {
        pi.sendMessage({ customType: 'workflow_event', content, display: true }, { deliverAs: 'followUp', triggerTurn: true });
      } catch (e) {
        console.warn('[workflow] sendAgentMessage failed (stale ctx after reload?):', e);
      }
    },
  });

  // ── Tool activation & description tools (always available) ─────────
  pi.registerTool({
    name: "activate_tools",
    label: "Activate Tool",
    description: "激活扩展工具使其在当前会话可用。参数 toolNames:需激活的工具名称列表。",
    parameters: Type.Object({
      toolNames: Type.Array(Type.String({ description: "工具名称列表" })),
    }),
    async execute(_toolCallId: string, params: { toolNames: string[] }) {
      try {
        const allTools = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
        const toActivate = new Set([...BASIC_TOOLS as string[], ...params.toolNames]);
        const active = allTools.filter((t: any) => toActivate.has(t));
        pi.setActiveTools(active);
        return {
          content: [{ type: "text" as const, text: `已激活: ${params.toolNames.join(", ")}` }],
          details: { activated: params.toolNames },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `激活失败: ${err.message}` }],
          details: {}, isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "describe_tool",
    label: "Describe Tool",
    description: "查看某个工具的完整描述、参数和来源。",
    parameters: Type.Object({
      toolName: Type.String({ description: "工具名称" }),
    }),
    async execute(_toolCallId: string, params: { toolName: string }) {
      try {
        const all = pi.getAllTools();
        const tool = all.find((t: any) => t.name === params.toolName);
        if (!tool) {
          return { content: [{ type: "text" as const, text: `工具 "${params.toolName}" 不存在` }], details: {} };
        }
        const info = tool as any;
        return {
          content: [{ type: "text" as const, text: `名称: ${info.name}\n描述: ${info.description}\n来源: ${info.sourceInfo?.source || "unknown"}` }],
          details: { name: info.name, source: info.sourceInfo?.source },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `查询失败: ${err.message}` }],
          details: {}, isError: true,
        };
      }
    },
  });

  // ── Periodic role review — reminds agent every N user messages ──
  // Counts agent_end (once per user message), not turn_end (fires per LLM turn,
  // which is too frequent when the agent makes multiple tool calls in one response).
  // Uses _skipNextAgentEnd to avoid counting the agent_end triggered by the
  // review message itself (sendMessage with triggerTurn:true).
  let _userMsgCount = 0;
  let _skipNextAgentEnd = false;
  const REVIEW_INTERVAL = 5;
  pi.on("agent_end", async () => {
    if (_skipNextAgentEnd) {
      _skipNextAgentEnd = false;
      return;
    }
    _userMsgCount++;
    if (_userMsgCount % REVIEW_INTERVAL === 0) {
      _skipNextAgentEnd = true;
      pi.sendMessage({
        customType: "role_review",
        content: "[Agent Review] " + REVIEW_INTERVAL + " user messages processed. Review your role, constraints, and conversation context.",
        display: true,
      }, { deliverAs: "followUp", triggerTurn: true });
    }
  });

  // ── Commands ────────────────────────────────────────────────────────
  pi.registerCommand("preset", {
    description:
      "Switch model preset. Usage: /preset <name>\n" +
      "Configure presets in ~/.config/opencode/oh-my-opencode-slim.json",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify(
          `Usage: /preset <name>. Current: ${currentPreset}`,
          "info",
        );
        return;
      }

      const newConfig = loadOmniMoConfig();
      const plan = resolvePresetSwitchPlan(newConfig, name);
      if (plan.error || !newConfig) {
        ctx.ui.notify(plan.error ?? "No oh-my-opencode-slim config found", "error");
        return;
      }

      currentPreset = name;
      newConfig.preset = name;
      updateAgentModels(newConfig, name);

      const effects: string[] = ["agent .md/.toml files updated"];

      if (plan.model) {
        const parsed = parsePiModelId(plan.model);
        if (!parsed) {
          effects.push(`orchestrator model not switched: invalid model id ${plan.model}`);
        } else {
          const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
          if (!model) {
            effects.push(`orchestrator model not switched: model not found ${plan.model}`);
          } else {
            const switched = await pi.setModel(model);
            effects.push(
              switched
                ? `orchestrator model switched to ${plan.model}`
                : `orchestrator model not switched: no API key for ${plan.model}`,
            );
          }
        }
      }

      if (plan.thinking) {
        pi.setThinkingLevel(plan.thinking);
        effects.push(`thinking set to ${plan.thinking}`);
      }

      ctx.ui.notify(`Switched to preset: ${name}\n${effects.map((e) => `- ${e}`).join("\n")}`, "success");
    },
  });

  pi.registerCommand("chat", {
    description: "与子代理私聊或加入群聊。交互式选择后进入对话。",
    handler: async (_args, ctx) => {
      const pool = getPool();
      const hub = getHub();

      interface ChatOption {
        label: string;
        type: "chat" | "group";
        meetingId: string;
        name: string;
        selectable: boolean;
      }
      const options: ChatOption[] = [];
      const statusViews: Array<{ view: ChatStatusView; option: ChatOption }> = [];

      const agents = pool.list();
      for (const a of agents) {
        if (a.status === "dead") continue;
        if (hub.getMeeting(a.id)) continue;
        const displayName = a.name || a.agentName;
        const state = a.status === "streaming" || a.status === "starting" ? "working" : "idle";
        const view = createChatStatusView({
          name: displayName,
          state,
          scope: "pool",
          startedAt: a.startedAt,
        });
        statusViews.push({
          view,
          option: { label: view.listRow, type: "chat", meetingId: a.id, name: displayName, selectable: true },
        });
      }

      // 活跃的群聊(只显示 type=group 的)
      const meetings = hub.getActiveMeetings();
      for (const m of meetings) {
        if (m.type === "group") {
          const names = m.participants.map(p => p.name).join(", ");
          options.push({
            label: `Group\n  ${m.name} · ${names}`,
            type: "group",
            meetingId: m.id,
            name: m.name,
            selectable: true,
          });
        }
      }

      // 已有的私聊(可继续)
      for (const m of meetings) {
        if (m.type !== "chat") continue;
        const view = createChatStatusView({
          name: m.name,
          state: m.chatStatus?.state ?? "idle",
          scope: m.chatStatus?.scope ?? "standalone",
          startedAt: m.chatStatus?.startedAt ?? m.startedAt,
          fallbackRecommended: m.chatStatus?.fallbackRecommended,
        });
        statusViews.push({
          view,
          option: { label: view.listRow, type: "chat", meetingId: m.id, name: m.name, selectable: true },
        });
      }

      for (const group of groupChatStatusViews(statusViews.map((item) => item.view))) {
        for (const item of statusViews.filter((candidate) => candidate.view.scope === group.scope)) {
          options.push({ ...item.option, label: `${group.title}  ${item.view.listRow}` });
        }
      }

      if (options.length === 0) {
        ctx.ui.notify("没有活跃的子代理或群聊", "info");
        return;
      }

      const selected = await ctx.ui.select("选择要进入的会话:", options.map(o => o.label));
      if (!selected) return;
      const picked = options.find(o => o.label === selected);
      if (!picked || !picked.selectable) return;

      if (picked.type === "chat") {
        const existing = hub.getMeeting(picked.meetingId);
        if (!existing) {
          const session = getPool().getSession(picked.meetingId);
          if (!session) {
            ctx.ui.notify("子代理会话已不存在", "error");
            return;
          }
          const agentInfo = agents.find((a: PoolAgentInfo) => a.id === picked.meetingId);
          hub.registerChat(picked.meetingId, picked.name, {
            name: picked.name,
            agentType: agentInfo?.agentName ?? "agent",
            session,
          }, undefined, {
            scope: "pool",
            state: agentInfo?.status === "streaming" || agentInfo?.status === "starting" ? "working" : "idle",
            startedAt: agentInfo?.startedAt,
          });
        }
        await runPrivateChat(picked.meetingId, picked.name, ctx);
      } else {
        await runGroupChat(picked.meetingId, picked.name, ctx);
      }
    },
  });

  // ── Cleanup on session shutdown ────────────────────────────────────
  pi.on("session_shutdown", async () => {
    try {
      const { getPool } = await import("../subagent/subagent-pool");
      await getPool().killAll();
    } catch (err) {
      console.error("[pi-hub] Cleanup error:", err);
    }
  });

  // ── Log startup ─────────────────────────────────────────────────────
  const presetName = config?.preset ?? "default";
  const orchestratorModel = getPresetModelForOrchestrator(config, presetName) ?? "default";
  const startupCapabilities = refreshDelegationCapabilities();
  console.error(
    `[oh-my-opencode-slim] Pi adapter loaded. Preset: ${presetName}, Orchestrator model: ${orchestratorModel}, capabilities: pi-agents=${startupCapabilities.hasPiAgents ? "yes" : "no"}, subagent=${startupCapabilities.hasSubagent ? "yes" : "no"}, agent_message=${startupCapabilities.hasAgentMessage ? "yes" : "no"}`,
  );
}
