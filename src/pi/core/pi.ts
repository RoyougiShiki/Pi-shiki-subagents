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
import { loadActiveMode, getModeInstructions, setOnModeChange, setOnBeforeModeChange, validateModeAllowlist, getFirstModeAgent, isCurrentModePipeline, emitModeSwitched, getAgent } from "./pi-modes";
import { setToolScope, isToolAllowed, getToolScope, auditPayloadTools } from "../policy/tool-scope-manager";
import { checkClarification, shouldBlockForClarification } from "../policy/clarification-policy";
import { checkApproval, requiresApproval } from "../policy/approval-policy";
import { checkSubagentSpawnContract } from "../policy/subagent-contract-policy";
import { recordEvidence, getWriteEvidences } from "../policy/evidence-tracker";
import { setAuditEnabled, auditClarification, auditApproval, auditEvidence, auditToolScope } from "../policy/runtime-audit";
// pipeline-state 已从执行决策链路移除

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
import {
  createComplianceState,
  recordViolation,
  type ComplianceState,
  type ViolationRecord,
} from "../compliance";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getHub } from "../meeting/pi-hub";
import { createChatStatusView, groupChatStatusViews, type ChatStatusView } from "../subagent/chat-status-view";
import { runPrivateChat, runGroupChat } from "../subagent/pi-chat-bridge";

import type { WorkflowsConfig } from "../../core/workflow-types";
import { deepMerge, loadPluginConfig } from "../../config/loader";
import { loadRuntimeAgentDefinitions } from "../../adapters/agent-runtime-config";


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
      // Tool line: "- tool_name: description" (allow indentation + underscore names)
      const match = line.match(/^\s*-\s+([A-Za-z0-9_]+):\s*/);
      if (match) {
        const name = match[1]!;
        const desc = line.slice(match[0].length);

        if (hide.has(name)) {
          // Hidden tools must be removed from visible list to avoid prompt leakage.
        } else {
          const maxLen = truncCfg[name] ?? defaultTrunc;
          if (maxLen > 0 && desc.length > maxLen) {
            out.push(`  - ${name}: ${desc.slice(0, maxLen)}...`);
          } else {
            out.push(line);
          }
        }
        continue;
      }

      // Empty line or non-bullet line: end of tools section
      if (line.trim() === "" || !/^\s*-\s+/.test(line)) {
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

  // ── Compliance state (session-level, in-memory) ──────────────────────
  let complianceState: ComplianceState = createComplianceState();
  let toolExecutedThisTurn = false; // reset per tool_execution_start

  // ── Pipeline state (session-level, 替代 WorkflowManager) ─────────────


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
    // 启用审计（可通过环境变量控制）
    if (process.env.OMO_AUDIT === "1" || process.env.OMO_DEBUG_TOOLS === "1") {
      setAuditEnabled(true);
    }

    // 注意：pipeline checkpoint 恢复已从执行决策链路移除。

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
      if (event.type === "completed") {
        try {
          pi.sendMessage({
            customType: "pool_completed",
            content: event.response
              ? `[pool] ${event.agentName} 已完成\n\n${event.response}\n\n[decision] 请选择下一步: 返工继续 / 提问用户 / 调用下一阶段子代理`
              : `[pool] ${event.agentName} 已完成\n\n[decision] 请选择下一步: 返工继续 / 提问用户 / 调用下一阶段子代理`,
            display: true,
          }, { deliverAs: "followUp", triggerTurn: true });
        } catch {}
      }
    });

    // Wire mode change → status bar + immediate switch notification
    try {
      const initialMode = loadActiveMode();
      let currentMode = initialMode;
      ctx.ui.setStatus("mode", `Mode: ${initialMode}`);
      setOnBeforeModeChange(() => {
        toolExecutedThisTurn = false;
      });
      setOnModeChange((newMode: string) => {
        const prevMode = currentMode;
        currentMode = newMode;
        ctx.ui.setStatus("mode", `Mode: ${newMode}`);
        try {
          emitModeSwitched(pi, prevMode, newMode, true);
        } catch {}
      });
    } catch {}

    // 首轮健康检查：验证 allowlist 合法性
    try {
      const allTools = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
      const err = validateModeAllowlist(allTools);
      if (err) {
        ctx.ui.notify(`[mode] 健康检查失败: ${err}`, "error");
        console.error(`[omo-modes] health-check: ${err}`);
      }
    } catch (e) {
      console.warn("[omo-modes] health-check error:", e);
    }

  });

  // ── Compliance: track whether a tool was actually executed this turn ──
  pi.on("tool_execution_start", async (_event) => {
    toolExecutedThisTurn = true;
  });

  pi.on("turn_start", async (_event) => {
    toolExecutedThisTurn = false;
  });

  // ── Inject orchestrator system prompt ───────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Sub-agent detection: skip constitution/mode injection for sub-agent sessions
    // Sub-agents (council participants) have appendSystemPrompt set as a marker
    if (event.systemPromptOptions?.appendSystemPrompt === "__OMO_SUB_AGENT__" || process.env.OMO_SUB_AGENT === "1") {
      // Filter tools per agent roles before returning
      if (process.env.OMO_AGENT_NAME) {
        try {
          const agentName = process.env.OMO_AGENT_NAME;
          const runtimeDefs = loadRuntimeAgentDefinitions(process.cwd());
          const agentCfg = runtimeDefs[agentName] ?? getAgent(agentName);
          const allTools = pi.getAllTools();
          const allToolNames = allTools.map((t: any) => t.name).filter(Boolean);

          let allowed = new Set<string>();
          if (agentCfg) {
            const groups = (() => {
              try {
                const configPath = path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
                const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                return raw._tool_groups ?? {};
              } catch {
                return {} as Record<string, string[]>;
              }
            })();

            if (Array.isArray((agentCfg as any).tools) && (agentCfg as any).tools.length > 0) {
              allowed = new Set((agentCfg as any).tools);
            } else if (Array.isArray((agentCfg as any).roles) && (agentCfg as any).roles.length > 0 && Object.keys(groups).length > 0) {
              for (const role of (agentCfg as any).roles) {
                const group = (groups as Record<string, string[]>)[role];
                if (Array.isArray(group)) group.forEach((t: string) => allowed.add(t));
              }
            }
          }

          const active = allTools.filter((t: any) => allowed.has(t.name)).map((t: any) => t.name);
          // Sub-agent sessions must never inherit parent tool scope.
          pi.setActiveTools(active);

          // ── 写入工具真值快照（单一决策源）──────────────────────────────────
          setToolScope(active, "subagent", agentName, {
            roles: (agentCfg as any)?.roles,
            tools: (agentCfg as any)?.tools,
          });

          const activeSet = new Set(active);
          const filteredPrompt = trimToolDescriptions(event.systemPrompt, {
            hide: allToolNames.filter((name) => !activeSet.has(name)),
            truncate: (config as any)?.tool_descriptions?.truncate ?? {},
          });

          const toolPreview = active.slice(0, 20).join(", ");
          const more = active.length > 20 ? ` ...(+${active.length - 20})` : "";
          const boundary = `\n\n[ToolBoundary]\n当前可用工具(${active.length}): ${toolPreview}${more}\n[/ToolBoundary]`;

          // 审计：记录子代理工具范围（受 OMO_AUDIT 环境变量控制）
          auditToolScope("set", "subagent", agentName, active);

          return {
            systemPromptOptions: {
              ...(event.systemPromptOptions ?? {}),
              selectedTools: active,
            },
            systemPrompt: `${filteredPrompt}${boundary}`,
          };
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
    const activeMode = loadActiveMode();
    const modeInstructions = getModeInstructions(activeMode) ?? "";
    const modePrompt = modeInstructions
      ? `<MODE name="${activeMode}">\n${modeInstructions}\n</MODE>`
      : "";

    // ── 简化的合规提示（仅做语义说明，强控制已下沉 runtime guard）────
    const compliancePrompt = `<ComplianceRules>
- 工具调用由 runtime 白名单控制，不在列表中的工具无法执行。
- 模式切换需用户确认，模型不能自行切换。
</ComplianceRules>`;

    return {
      systemPrompt: [omniPrompt, modePrompt, compliancePrompt, trimmedPrompt].filter(Boolean).join("\n\n---\n\n"),
    };
  });

      // ── Trim tool descriptions in provider API payload ────────────────
  pi.on("before_provider_request", (event, _ctx) => {
    const toolCfg = (config as any)?.tool_descriptions ?? {};
    const hide = new Set<string>((toolCfg.hide as string[]) ?? []);
    const truncCfg = (toolCfg.truncate ?? {}) as Record<string, number>;
    const defaultTrunc = truncCfg.default ?? 0;
    if (hide.size === 0 && defaultTrunc === 0 && Object.keys(truncCfg).length === 0) {
      // still continue to debug payload tools below
    } else {
      trimProviderToolDescriptions(event.payload as Record<string, any>, hide, truncCfg, defaultTrunc);
    }

    // ── 审计：payload.tools vs snapshot（仅观测，不参与决策）──────────
    try {
      const payload = event.payload as Record<string, any>;
      const names = new Set<string>();
      const tools = Array.isArray((payload as any).tools) ? (payload as any).tools : [];
      for (const t of tools) {
        const n1 = (t as any)?.function?.name;
        const n2 = (t as any)?.name;
        if (typeof n1 === "string" && n1) names.add(n1);
        if (typeof n2 === "string" && n2) names.add(n2);
        const fds = (t as any)?.functionDeclarations;
        if (Array.isArray(fds)) {
          for (const fd of fds) {
            const n3 = (fd as any)?.name;
            if (typeof n3 === "string" && n3) names.add(n3);
          }
        }
      }

      const payloadTools = [...names];
      const audit = auditPayloadTools(payloadTools);
      const snapshot = getToolScope();
      const snapshotCount = snapshot ? snapshot.tools.size : 0;
      const payloadCount = payloadTools.length;

      // 某些 provider 会在 payload.tools 中携带全量 schema（而非 runtime allowlist）。
      // 这会导致 extraInPayload 大量出现，但不代表执行权限失效。
      // 判定规则：payload 远大于 snapshot 且 extra 占比很高 → 视为 schema_mode，仅审计不报警。
      const extraRatio = payloadCount > 0 ? audit.extraInPayload.length / payloadCount : 0;
      const schemaMode = !!snapshot && payloadCount >= Math.max(snapshotCount + 8, snapshotCount * 2) && extraRatio > 0.6;

      if (!schemaMode && !audit.consistent && (process.env.OMO_DEBUG_TOOLS === "1" || process.env.OMO_AUDIT === "1")) {
        console.error(
          `[tool-scope-audit] payload.tools 与 snapshot 不一致:\n` +
          `  snapshot=${snapshotCount}, payload=${payloadCount}\n` +
          `  missingInPayload: ${audit.missingInPayload.join(", ") || "(无)"}\n` +
          `  extraInPayload: ${audit.extraInPayload.join(", ") || "(无)"}`
        );
      }

      // 统一写入审计（不进聊天流）
      auditToolScope("audit", schemaMode ? "payload:schema_mode" : "payload", "before_provider_request", payloadTools);
    } catch {}
  });

  // ── Compliance: tool_call gate ──────────────────────────────────────
  // Conservative implementation: detects blocked/abandoned patterns,
  // records violations but only blocks clearly dangerous calls.
  // Additionally enforces mode allowlist: tools not in current mode preset
  // are blocked as defense-in-depth.
  type ApprovalResult = { approved: true } | { approved: false; reason: string };
  type GateDecision = { ok: true } | { ok: false; reason: string };
  const deny = (reason: string): GateDecision => ({ ok: false, reason });
  const allow = (): GateDecision => ({ ok: true });


  const requestApproval = async (
    ctx: any,
    title: string,
    message: string,
  ): Promise<ApprovalResult | null> => {
    if (!ctx?.ui?.confirm) return null;
    const result = await ctx.ui.confirm(title, message);

    // Backward-compatible host UI: boolean confirm result.
    if (typeof result === "boolean") {
      if (result) return { approved: true };
      let reason = "user_rejected";
      try {
        if (ctx?.ui?.input) {
          const text = await ctx.ui.input("拒绝原因（可选）", "请输入拒绝原因，便于模型调整下一步");
          if (typeof text === "string" && text.trim()) reason = text.trim();
        }
      } catch {}
      return { approved: false, reason };
    }

    // Structured confirm result.
    if (!result || typeof result !== "object" || typeof result.approved !== "boolean") {
      return { approved: false, reason: "invalid_confirm_response" };
    }

    if (result.approved) return { approved: true };
    const reason = typeof result.reason === "string" ? result.reason.trim() : "";
    if (reason) return { approved: false, reason };

    let fallbackReason = "user_rejected";
    try {
      if (ctx?.ui?.input) {
        const text = await ctx.ui.input("拒绝原因（可选）", "请输入拒绝原因，便于模型调整下一步");
        if (typeof text === "string" && text.trim()) fallbackReason = text.trim();
      }
    } catch {}
    return { approved: false, reason: fallbackReason };
  };

  const gatePipelineSubagent = async (ctx: any, input: any): Promise<GateDecision> => {
    // 非 spawn 路径不做子代理审批 gate
    if (input?.pool !== "spawn") return allow();

    // 先做参数完整性预检：缺参直接拒绝且不触发审批
    if (!input?.id || !input?.agent || !input?.task) {
      return deny("pool spawn requires id, agent, and task");
    }

    const contractDecision = checkSubagentSpawnContract(input);
    if (contractDecision.action === "block") {
      return deny(`${contractDecision.reason ?? "subagent_task_contract_failed"}${contractDecision.hint ? `
${contractDecision.hint}` : ""}`);
    }

    if (!isCurrentModePipeline()) return allow();

    // Pipeline 模式下，子代理 spawn 需要审批（不再做 step 门禁）
    const approval = await requestApproval(
      ctx,
      "子代理审批",
      `模型请求委托「${input.agent}」执行，是否同意？`,
    );
    if (!approval) {
      return deny("子代理审批被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
    }
    if (!approval.approved) {
      return deny(`用户拒绝了「${input.agent}」的执行。原因：${approval.reason}`);
    }

    return allow();
  };

  const gateSwitchMode = async (ctx: any, input: any): Promise<GateDecision> => {
    if (!input?.mode) return allow();

    const approval = await requestApproval(
      ctx,
      "切换模式",
      `模型请求切换到「${input.mode}」，是否同意？`,
    );
    if (!approval) {
      return deny("模式切换被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
    }
    if (!approval.approved) {
      return deny(`用户拒绝了切换到「${input.mode}」。原因：${approval.reason}`);
    }

    return allow();
  };

  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const input = (event as any).input;

    if (toolName === "omo_subagent") {
      const decision = await gatePipelineSubagent(ctx, input);
      if (!decision.ok) return { block: true, reason: decision.reason };
    }

    if (toolName === "switch_mode") {
      const decision = await gateSwitchMode(ctx, input);
      if (!decision.ok) return { block: true, reason: decision.reason };
    }

    // ── Tool scope gate（单一真值：只读 snapshot，不重算）─────────────
    // switch_mode and ask_user_question are always allowed across modes.
    if (toolName && toolName !== "switch_mode" && toolName !== "ask_user_question") {
      const snapshot = getToolScope();
      if (snapshot && !isToolAllowed(toolName)) {
        const violation: ViolationRecord = {
          type: "TOOL_BLOCKED",
          reason: `Tool "${toolName}" is not in current tool scope (source: ${snapshot.source}/${snapshot.sourceName}).`,
          at: Date.now(),
        };
        recordViolation(complianceState, violation);
        auditApproval("denied", toolName, undefined, violation.reason);
        return {
          block: true,
          reason: `POLICY_VIOLATION: ${violation.reason}\n[guard] 下一步：说明当前工具限制，并请求用户确认可行替代方案。`,
        };
      }
    }

    // ── Clarification gate（信息不足时不盲目执行）───────────────────────
    if (toolName && typeof input === "object" && input !== null) {
      const clarifyDecision = checkClarification(toolName, input as Record<string, unknown>);
      if (!clarifyDecision.ready) {
        auditClarification("blocked", toolName, clarifyDecision.reason);
        return {
          block: true,
          reason: `需要先确认信息: ${clarifyDecision.reason}\n[guard] 下一步：先询问缺失信息，不要猜测执行。`,
        };
      }
      auditClarification("passed", toolName);
    }

    // ── Approval gate（高风险操作需审批）───────────────────────────────
    if (toolName && typeof input === "object" && input !== null) {
      const approvalDecision = checkApproval(toolName, input as Record<string, unknown>);
      if (approvalDecision.action === "require_approval") {
        const approval = await requestApproval(
          ctx,
          "操作审批",
          `模型请求执行「${toolName}」(${approvalDecision.reason})，是否同意？`
        );
        if (!approval) {
          auditApproval("denied", toolName, approvalDecision.riskLevel, "环境不支持审批");
          return { block: true, reason: "当前环境不支持审批确认（ui.confirm 不可用）。" };
        }
        if (!approval.approved) {
          auditApproval("denied", toolName, approvalDecision.riskLevel, approval.reason);
          return {
            block: true,
            reason: `用户拒绝了「${toolName}」的执行。原因：${approval.reason}\n[guard] 下一步：停止同类动作，给出低风险替代方案或请求用户下一步指示。`,
          };
        }
        auditApproval("approved", toolName, approvalDecision.riskLevel);
      } else {
        auditApproval("passed", toolName);
      }
    }

    // Detect tool calls with empty/missing required args as potential
    // pseudo-tool patterns (model declares intent but doesn't fill params).
    if (
      toolName &&
      typeof input === "object" &&
      input !== null &&
      Object.keys(input).length === 0 &&
      ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(toolName)
    ) {
      const violation: ViolationRecord = {
        type: "TOOL_BLOCKED",
        reason: `Tool "${toolName}" called with empty parameters — likely pseudo-call.`,
        at: Date.now(),
      };
      recordViolation(complianceState, violation);
      return { block: true, reason: `POLICY_VIOLATION: ${violation.reason}` };
    }

    // Explicitly blocked tool names / patterns
    const BLOCKED_PREFIXES = ["sudo ", "rm -rf /", ":(){ :|:& };:"];
    if (toolName === "bash" && typeof input?.command === "string") {
      for (const prefix of BLOCKED_PREFIXES) {
        if (input.command.trim().startsWith(prefix)) {
          const violation: ViolationRecord = {
            type: "TOOL_BLOCKED",
            reason: `Blocked dangerous bash command starting with "${prefix}".`,
            at: Date.now(),
          };
          recordViolation(complianceState, violation);
          return {
          block: true,
          reason: `POLICY_VIOLATION: ${violation.reason}\n[guard] 下一步：说明当前工具限制，并请求用户确认可行替代方案。`,
        };
        }
      }
    }
  });

  // ── Evidence tracking: 记录工具执行结果 ────────────────────────────
  pi.on("tool_result", async (event) => {
    const toolName = (event as any).toolName;
    const toolCallId = (event as any).toolCallId;
    const args = (event as any).args ?? {};
    const result = (event as any).result;
    const success = (event as any).success !== false;

    if (toolName) {
      recordEvidence(toolName, toolCallId ?? "", args, result, success);
      auditEvidence("recorded", toolName, toolCallId);
    }
  });

  // ── Compliance: message_end gate（已下线）────────────────────────────
  // message_end 内容改写已在 P0 中下线。
  // 强控制已改为 runtime guard（tool_call 白名单拦截 + switch_mode 用户审批）。


  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.council);

  // ── Register omo_subagent tool (zero external deps, uses pi --mode rpc/json) ─
  registerSubagentTool(pi);

  // ── Pipeline completion is driven by pool_completed + coordinator decision.
  // step_report / step_ask_user tools removed to keep runtime protocol minimal.
  // Agent review followUp disabled: avoid chat pollution and context drift.
  let _debugProviderLogged = false;

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

  pi.registerCommand("pool-status", {
    description: "查看子代理 pool 状态（轻量，只读，不进入 chat TUI）",
    handler: async (_args, ctx) => {
      const agents = getPool().list();
      if (agents.length === 0) {
        ctx.ui.notify("Pool is empty.", "info");
        return;
      }
      const lines = agents.map((a: PoolAgentInfo) =>
        `${a.status === "dead" ? "✗" : "●"} ${a.id} (${a.agentName}) — ${a.status}, ${a.messageCount} msgs, model: ${a.model}`
      );
      ctx.ui.notify(`Pool agents (${agents.length}):\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("chat", {
    description: "交互式子代理 chat TUI（当前禁用；请用 /pool-status 查看状态）",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "交互式子代理 chat TUI 当前暂停维护。请使用 /pool-status 查看子代理状态；底层 pool/hub 能力保留给未来 UI。",
        "info",
      );
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
