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
  DynamicBorder,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { AutocompleteItem, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { loadActiveMode, getModeInstructions, setOnModeChange, setOnBeforeModeChange, validateModeAllowlist, getFirstModeAgent, isCurrentModePipeline, emitModeSwitched, getAgent, rehydrateActiveModeTools, registerModeCommands, registerModeHooks, registerSwitchModeTool } from "./pi-modes";
import { setToolScope, isToolAllowed, getToolScope, auditPayloadTools } from "../policy/tool-scope-manager";
import { checkClarification } from "../policy/clarification-policy";
import { setAuditEnabled, auditClarification, auditApproval, auditToolScope } from "../policy/runtime-audit";
import {
  recordDeniedToolCall,
  isDeniedToolCall,
  buildDeniedToolGuardMessage,
} from "../policy/denied-tool-memory";
// pipeline-state 已从执行决策链路移除

import { AGENT_PROMPTS } from "../meeting/pi-agents";
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
import { registerSubagentTool, getPool, initPoolModelResolver, resolveDelegationCaller, resolveSubagentToolNamesForAgent, type PoolAgentInfo } from "../subagent/subagent-pool";
import {
  createComplianceState,
  recordViolation,
  type ComplianceState,
  type ViolationRecord,
} from "../compliance";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getHub } from "../meeting/pi-hub";

import type { WorkflowsConfig } from "../../core/workflow-types";
import type { HarnessConfig } from "../../config/schema";
import { deepMerge, loadPluginConfig } from "../../config/loader";
import { loadRuntimeAgentDefinitions } from "../../adapters/agent-runtime-config";
import { createToolCallGates, createWorkflowStageGateHelpers, shouldRequestPipelineSubagentApproval } from "../policy/tool-call-gates";
import type { WorkflowStageRecoveryCandidate } from "../policy/workflow-stage-runtime";
import { formatWorkflowStageResumeNotice, parseWorkflowStageMarkersFromEntries } from "../policy/workflow-stage-marker";
import { ensureAgentFiles, getPiAgentsDirForSync, updateAgentModels } from "../agents/managed-agent-files";
import { trimProviderToolDescriptions, trimToolDescriptions } from "../prompt/tool-description-trimmer";
import { ORCHESTRATOR_NAME } from "../../config/constants";
import { getPresetCompletions, getPresetModelForOrchestrator, parsePiModelId, resolvePresetSwitchPlan } from "../preset/preset-switch";
import { registerHarnessHooks } from "../harness/register-harness-hooks";

export { createWorkflowStageGateHelpers, shouldRequestPipelineSubagentApproval } from "../policy/tool-call-gates";
export { ensureAgentFiles, getPiAgentsDirForSync } from "../agents/managed-agent-files";
export { parsePiModelId, resolvePresetSwitchPlan } from "../preset/preset-switch";

// ─── Config helpers ────────────────────────────────────────────────────────

const BASIC_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const PRESET_MODEL_SUBCOMMAND = "model";
const LEGACY_RESERVED_PRESET_KEYS = new Set<string>(["master"]);
const PRESET_MODEL_SELECTOR_MAX_VISIBLE = 12;

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
  presets?: Record<string, Record<string, { model?: string; variant?: string; thinking?: string } | Record<string, unknown>>>;
  agents?: Record<string, { model?: string; variant?: string; thinking?: string }>;
  disabled_agents?: string[];
  council?: PiCouncilConfig;
  workflows?: WorkflowsConfig;
  harness?: HarnessConfig;
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

function getPiNativeConfigPath(): string {
  const configBase = path.join(getPiAgentDirForConfig(), "oh-my-opencode-slim");
  const jsoncPath = `${configBase}.jsonc`;
  const jsonPath = `${configBase}.json`;
  if (fs.existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

function writePiNativeConfig(config: OmniMoConfig): void {
  const configPath = getPiNativeConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function getConfigPresetNames(config: OmniMoConfig | null): string[] {
  return Object.keys(config?.presets ?? {});
}

function getConfigAgentNames(config: OmniMoConfig | null, presetName: string): string[] {
  const names = new Set<string>(Object.keys(AGENT_PROMPTS));
  for (const name of Object.keys(config?.agents ?? {})) names.add(name);
  for (const name of Object.keys(config?.presets?.[presetName] ?? {})) names.add(name);
  for (const reserved of LEGACY_RESERVED_PRESET_KEYS) names.delete(reserved);
  return [...names].sort();
}

function normalizeModelReference(model: string): string | undefined {
  const parsed = parsePiModelId(model);
  return parsed ? `${parsed.provider}/${parsed.model}` : undefined;
}

function getConfiguredAgentModel(config: OmniMoConfig, presetName: string, agentName: string): string | undefined {
  const presetOverride = config.presets?.[presetName]?.[agentName];
  const globalOverride = config.agents?.[agentName];
  const presetModel = typeof presetOverride === "object" && presetOverride !== null ? (presetOverride as { model?: unknown }).model : undefined;
  const globalModel = typeof globalOverride === "object" && globalOverride !== null ? (globalOverride as { model?: unknown }).model : undefined;
  return typeof presetModel === "string" ? presetModel : typeof globalModel === "string" ? globalModel : undefined;
}

function getAvailableModels(ctx: ExtensionContext): Array<{ provider: string; id: string }> {
  const registry = ctx.modelRegistry as any;
  try { registry.refresh?.(); } catch {}
  const models = typeof registry.getAvailable === "function" ? registry.getAvailable() : registry.getAll?.() ?? [];
  return (models as Array<{ provider?: unknown; id?: unknown }>).filter(
    (model): model is { provider: string; id: string } => typeof model.provider === "string" && typeof model.id === "string",
  );
}

function getModelCompletionItems(ctx: ExtensionContext, prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const models = getAvailableModels(ctx);
  const filtered = models.filter((model) => {
    const ref = `${model.provider}/${model.id}`;
    return !normalizedPrefix || ref.toLowerCase().includes(normalizedPrefix) || model.id.toLowerCase().includes(normalizedPrefix);
  });
  if (filtered.length === 0) return null;
  return filtered.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.id,
    description: model.provider,
  }));
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

function sessionStartTimestamp(ctx: any): number | undefined {
  const headerTimestamp = ctx?.sessionManager?.getHeader?.()?.timestamp;
  const parsedHeader = typeof headerTimestamp === "string" || typeof headerTimestamp === "number"
    ? Date.parse(String(headerTimestamp))
    : NaN;
  if (Number.isFinite(parsedHeader)) return parsedHeader;

  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  const firstTimestamp = Array.isArray(entries) ? entries[0]?.timestamp : undefined;
  const parsedEntry = typeof firstTimestamp === "string" || typeof firstTimestamp === "number"
    ? Date.parse(String(firstTimestamp))
    : NaN;
  return Number.isFinite(parsedEntry) ? parsedEntry : undefined;
}

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

  // ── Mode / agent lifecycle （从 pi-modes.ts 集中注册）─────────────────
  registerModeCommands(pi);
  registerModeHooks(pi);
  registerSwitchModeTool(pi);

  const config = loadOmniMoConfig();
  let currentPreset = config?.preset ?? "default";

  // ── Harness hooks (completion auditor + tool result budget + verifier/nudge) ──
  const harnessRuntime = registerHarnessHooks(pi, { config: config?.harness });

  // ── Compliance state (session-level, in-memory) ──────────────────────
  let complianceState: ComplianceState = createComplianceState();
  let toolExecutedThisTurn = false; // reset per tool_execution_start

  // ── Pipeline state (session-level, 替代 WorkflowManager) ─────────────
  const workflowSessionRecoveryState: {
    sessionWasResumed: boolean;
    recoveryCandidate: WorkflowStageRecoveryCandidate | null;
  } = { sessionWasResumed: false, recoveryCandidate: null };

  const workflowGateHelpers = createWorkflowStageGateHelpers({
    workflows: config?.workflows,
    knownAgents: Object.keys(loadRuntimeAgentDefinitions()),
    getSessionRecoveryState: () => workflowSessionRecoveryState,
  });
  const getWorkflowStageGateContext = workflowGateHelpers.getWorkflowStageGateContext;

  const notifyWorkflowStageGateSkipped = (ctx?: any): void => {
    const message = "Workflow stage gate skipped: workflow config is missing or empty.";
    console.warn(`[oh-my-opencode-slim] ${message}`);
    try { ctx?.ui?.notify?.(message, "warning"); } catch {}
  };

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
  pi.on("session_start", async (event, ctx) => {
    // 启用审计（可通过环境变量控制）
    if (process.env.OMO_AUDIT === "1" || process.env.OMO_DEBUG_TOOLS === "1") {
      setAuditEnabled(true);
    }

    try {
      rehydrateActiveModeTools(pi, (ctx as any)?.sessionManager?.getSessionFile?.());
    } catch {}

    const isResume = (event as any)?.reason === "resume";
    workflowSessionRecoveryState.sessionWasResumed = isResume;
    try {
      const entries = (ctx as any)?.sessionManager?.getEntries?.()
        ?? (ctx as any)?.sessionManager?.getBranch?.()
        ?? [];
      workflowSessionRecoveryState.recoveryCandidate = parseWorkflowStageMarkersFromEntries(entries, {
        minTimestamp: sessionStartTimestamp(ctx),
      });
    } catch {
      workflowSessionRecoveryState.recoveryCandidate = null;
    }
    if (workflowSessionRecoveryState.recoveryCandidate) {
      workflowSessionRecoveryState.sessionWasResumed = true;
    }
    if (isResume || workflowSessionRecoveryState.recoveryCandidate) {
      try {
        pi.sendMessage({
          customType: "workflow_stage_resume",
          content: formatWorkflowStageResumeNotice({ candidate: workflowSessionRecoveryState.recoveryCandidate }),
          display: true,
        }, { deliverAs: "followUp", triggerTurn: false });
      } catch {}
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
        harnessRuntime.ingestPoolCompleted(event, ctx);
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
      setOnModeChange((event) => {
        const prevMode = currentMode;
        currentMode = event.mode;
        ctx.ui.setStatus("mode", `Mode: ${event.mode}`);
        try {
          emitModeSwitched(pi, prevMode, event.mode, event.origin === "tool_call");
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
          const agentCfg = getAgent(agentName);
          const allTools = pi.getAllTools();
          const allToolNames = allTools.map((t: any) => t.name).filter(Boolean);
          const resolvedToolNames = resolveSubagentToolNamesForAgent(agentName, process.cwd());
          const allowed = new Set(resolvedToolNames ?? []);

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
  const { gatePipelineSubagent, gateSwitchMode } = createToolCallGates({
    getWorkflowStageGateContext,
    getWorkflowStageRuntimeSnapshot: workflowGateHelpers.getWorkflowStageRuntimeSnapshot,
    advanceWorkflowStage: workflowGateHelpers.advanceWorkflowStage,
    confirmWorkflowStageRecovery: workflowGateHelpers.confirmWorkflowStageRecovery,
    recordWorkflowStageAttempt: workflowGateHelpers.recordWorkflowStageAttempt,
    notifyWorkflowStageGateSkipped,
    isCurrentModePipeline,
    resolveDelegationCaller,
    emitWorkflowStageNotice: (text: string) => {
      try {
        pi.sendMessage({
          customType: "workflow_stage",
          content: text,
          display: true,
        }, { deliverAs: "followUp", triggerTurn: false });
      } catch {}
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const input = (event as any).input;

    // ── Denied Tool Memory: 防止重复被拒调用 ──────────────────────────────
    if (toolName && typeof input === "object" && input !== null) {
      const deniedRecord = isDeniedToolCall(toolName, input as Record<string, unknown>);
      if (deniedRecord) {
        const guardMessage = buildDeniedToolGuardMessage(deniedRecord);
        return {
          block: true,
          reason: `${guardMessage}\n[guard] 如需继续，请考虑替代方案或询问用户确认。`,
        };
      }
    }

    if (toolName === "omo_subagent") {
      const decision = await gatePipelineSubagent(ctx, input);
      if (!decision.ok) {
        if (toolName && typeof input === "object" && input !== null) {
          recordDeniedToolCall(toolName, input as Record<string, unknown>, decision.reason);
        }
        return { block: true, reason: decision.reason };
      }
    }

    if (toolName === "switch_mode") {
      const decision = await gateSwitchMode(ctx, input);
      if (!decision.ok) {
        if (toolName && typeof input === "object" && input !== null) {
          recordDeniedToolCall(toolName, input as Record<string, unknown>, decision.reason);
        }
        return { block: true, reason: decision.reason };
      }
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
        recordDeniedToolCall(toolName, input as Record<string, unknown>, violation.reason);
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
        if (toolName && typeof input === "object" && input !== null) {
          recordDeniedToolCall(toolName, input as Record<string, unknown>, clarifyDecision.reason ?? "clarification required");
        }
        return {
          block: true,
          reason: `需要先确认信息: ${clarifyDecision.reason}\n[guard] 下一步：先询问缺失信息，不要猜测执行。`,
        };
      }
      auditClarification("passed", toolName);
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
      recordDeniedToolCall(toolName, input as Record<string, unknown>, violation.reason);
      return { block: true, reason: `POLICY_VIOLATION: ${violation.reason}` };
    }

    // Explicitly blocked tool names / patterns
    // Only block truly dangerous commands that would destroy the system
    const DANGER_PATTERNS = [
      /^sudo\s/i,                          // sudo commands
      /^rm\s+-rf\s+\/\s*$/i,               // rm -rf / (exact root)
      /^rm\s+-rf\s+\/\*/i,                 // rm -rf /* (root wildcard)
      /^rm\s+-rf\s+~\s*$/i,                // rm -rf ~ (home directory)
      /^rm\s+-rf\s+~\/*/i,                 // rm -rf ~/* (home wildcard)
      /^:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, // fork bomb
    ];
    if (toolName === "bash" && typeof input?.command === "string") {
      const trimmedCmd = input.command.trim();
      for (const pattern of DANGER_PATTERNS) {
        if (pattern.test(trimmedCmd)) {
          const violation: ViolationRecord = {
            type: "TOOL_BLOCKED",
            reason: `Blocked dangerous bash command matching pattern ${pattern}.`,
            at: Date.now(),
          };
          recordViolation(complianceState, violation);
          recordDeniedToolCall(toolName, input as Record<string, unknown>, violation.reason);
          return {
            block: true,
            reason: `POLICY_VIOLATION: ${violation.reason}\n[guard] 下一步：说明当前工具限制，并请求用户确认可行替代方案。`,
          };
        }
      }
    }
  });

  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.council);

  // ── Register omo_subagent tool (zero external deps, uses pi --mode rpc/json) ─
  registerSubagentTool(pi);

  // ── Pipeline completion is driven by pool_completed + coordinator decision.
  // step_report / step_ask_user tools removed to keep runtime protocol minimal.
  // Agent review followUp disabled: avoid chat pollution and context drift.
  let _debugProviderLogged = false;

  function getPresetCommandCompletions(prefix: string): AutocompleteItem[] | null {
    const latestConfig = loadOmniMoConfig();
    const trimmed = prefix.trimStart();
    const presetItems = getPresetCompletions(latestConfig, trimmed) ?? [];

    if (!trimmed.includes(" ")) {
      const modelItem: AutocompleteItem = {
        value: PRESET_MODEL_SUBCOMMAND,
        label: PRESET_MODEL_SUBCOMMAND,
        description: "Set a model for one agent in a preset",
      };
      const items = [modelItem, ...presetItems].filter((item) =>
        !trimmed || item.value.toLowerCase().includes(trimmed.toLowerCase()),
      );
      return items.length > 0 ? items : null;
    }

    const subcommand = trimmed.split(/\s+/, 1)[0];
    if (subcommand !== PRESET_MODEL_SUBCOMMAND) return presetItems.length > 0 ? presetItems : null;

    const rest = trimmed.slice(PRESET_MODEL_SUBCOMMAND.length).trimStart();
    const endsWithSpace = /\s$/.test(trimmed);
    const tokens = rest ? rest.split(/\s+/) : [];
    const presetNames = getConfigPresetNames(latestConfig);

    if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
      const presetPrefix = tokens[0] ?? "";
      const items = presetNames
        .filter((name) => !presetPrefix || name.toLowerCase().includes(presetPrefix.toLowerCase()))
        .map((name) => ({
          value: `${PRESET_MODEL_SUBCOMMAND} ${name}`,
          label: name,
          description: "preset",
        }));
      return items.length > 0 ? items : null;
    }

    const presetName = tokens[0]!;
    if (tokens.length === 1 && endsWithSpace || tokens.length === 2 && !endsWithSpace) {
      if (!latestConfig?.presets?.[presetName]) return null;
      const agentPrefix = tokens.length === 2 ? tokens[1]! : "";
      const items = getConfigAgentNames(latestConfig, presetName)
        .filter((name) => !agentPrefix || name.toLowerCase().includes(agentPrefix.toLowerCase()))
        .map((name) => ({
          value: `${PRESET_MODEL_SUBCOMMAND} ${presetName} ${name}`,
          label: name,
          description: getConfiguredAgentModel(latestConfig as OmniMoConfig, presetName, name) ?? "agent",
        }));
      return items.length > 0 ? items : null;
    }

    return null;
  }

  async function selectPresetModel(ctx: ExtensionContext, currentModelRef?: string): Promise<string | undefined> {
    const models = getAvailableModels(ctx);
    if (models.length === 0) {
      ctx.ui.notify("No available models found. Configure provider auth first.", "warning");
      return undefined;
    }

    type PresetModelOption = { provider: string; id: string; ref: string; name?: string };
    const options: PresetModelOption[] = models
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        ref: `${model.provider}/${model.id}`,
        name: typeof (model as { name?: unknown }).name === "string" ? (model as unknown as { name: string }).name : undefined,
      }))
      .sort((a, b) => {
        if (currentModelRef) {
          if (a.ref === currentModelRef && b.ref !== currentModelRef) return -1;
          if (b.ref === currentModelRef && a.ref !== currentModelRef) return 1;
        }
        const providerCompare = a.provider.localeCompare(b.provider);
        return providerCompare || a.id.localeCompare(b.id);
      });

    return ctx.ui.custom<string | undefined>(
      (tui, theme, _kb, done) => {
        const searchInput = new Input();
        const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        const title = new Text(theme.fg("accent", theme.bold("Select model for preset agent")), 1, 0);
        const hint = new Text(theme.fg("dim", "Type to filter · ↑↓ move · Enter select · Esc cancel"), 1, 0);
        const spacer = new Spacer(1);
        const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        const selectTheme: SelectListTheme = {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        };

        let disposed = false;
        let selectList = createSelectList("");

        searchInput.onSubmit = () => {
          const selected = selectList.getSelectedItem();
          if (selected) safeDone(selected.value);
        };
        searchInput.onEscape = () => safeDone(undefined);

        function safeDone(value: string | undefined) {
          if (disposed) return;
          disposed = true;
          done(value);
        }

        function toSelectItem(option: PresetModelOption): SelectItem {
          const details = [option.provider, option.name, option.ref === currentModelRef ? "current" : undefined]
            .filter((part): part is string => Boolean(part));
          return {
            value: option.ref,
            label: option.id,
            ...(details.length > 0 ? { description: details.join(" · ") } : {}),
          };
        }

        function filterOptions(query: string): PresetModelOption[] {
          const normalized = query.trim().toLowerCase();
          if (!normalized) return options;
          return options.filter((option) => {
            const haystack = `${option.ref} ${option.id} ${option.provider} ${option.name ?? ""}`.toLowerCase();
            return haystack.includes(normalized);
          });
        }

        function createSelectList(query: string): SelectList {
          const list = new SelectList(
            filterOptions(query).map(toSelectItem),
            PRESET_MODEL_SELECTOR_MAX_VISIBLE,
            selectTheme,
          );
          list.onSelect = (item: SelectItem) => safeDone(item.value);
          list.onCancel = () => safeDone(undefined);
          return list;
        }

        function refreshFilter() {
          selectList = createSelectList(searchInput.getValue());
        }

        return {
          get focused() { return searchInput.focused; },
          set focused(value: boolean) { searchInput.focused = value; },
          render(width: number) {
            return [
              ...topBorder.render(width),
              ...title.render(width),
              ...hint.render(width),
              ...spacer.render(width),
              ...searchInput.render(width),
              ...spacer.render(width),
              ...selectList.render(width),
              ...spacer.render(width),
              ...bottomBorder.render(width),
            ];
          },
          invalidate() {
            topBorder.invalidate();
            title.invalidate();
            hint.invalidate();
            spacer.invalidate();
            searchInput.invalidate();
            selectList.invalidate();
            bottomBorder.invalidate();
          },
          handleInput(data: string) {
            const before = searchInput.getValue();
            selectList.handleInput(data);
            if (disposed) return;
            searchInput.handleInput(data);
            if (searchInput.getValue() !== before) refreshFilter();
            tui.requestRender();
          },
          dispose() { safeDone(undefined); },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: Math.max(12, PRESET_MODEL_SELECTOR_MAX_VISIBLE + 8),
          anchor: "bottom-center",
          margin: 0,
        },
      },
    );
  }

  async function handlePresetModelCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const config = readPiNativeConfig() ?? loadOmniMoConfig() ?? { presets: {} };
    config.presets ??= {};

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    let presetName = tokens[0];
    let agentName = tokens[1];
    let modelRef = tokens[2];

    if (!presetName) {
      const presetNames = getConfigPresetNames(config);
      if (presetNames.length === 0) {
        ctx.ui.notify("No presets configured.", "error");
        return;
      }
      const selectedPreset = await ctx.ui.select("Select preset", presetNames);
      if (!selectedPreset) return;
      presetName = selectedPreset;
    }

    if (!config.presets[presetName]) {
      ctx.ui.notify(`Preset "${presetName}" not found.`, "error");
      return;
    }

    if (!agentName) {
      const agentNames = getConfigAgentNames(config, presetName);
      const selectedAgent = await ctx.ui.select("Select agent", agentNames);
      if (!selectedAgent) return;
      agentName = selectedAgent;
    }

    const currentModelRef = getConfiguredAgentModel(config, presetName, agentName);
    if (!modelRef) {
      const selectedModel = await selectPresetModel(ctx, currentModelRef);
      if (!selectedModel) return;
      modelRef = selectedModel;
    }

    const normalizedModelRef = normalizeModelReference(modelRef);
    if (!normalizedModelRef) {
      ctx.ui.notify(`Invalid model id "${modelRef}". Expected provider/model.`, "error");
      return;
    }

    const parsed = parsePiModelId(normalizedModelRef)!;
    const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
    if (!model) {
      ctx.ui.notify(`Model not found: ${normalizedModelRef}`, "error");
      return;
    }

    const preset = config.presets[presetName]!;
    const existing = typeof preset[agentName] === "object" && preset[agentName] !== null ? preset[agentName] as Record<string, unknown> : {};
    preset[agentName] = { ...existing, model: normalizedModelRef };
    writePiNativeConfig(config);

    const effects = [`${presetName}.${agentName}.model = ${normalizedModelRef}`, `saved to ${getPiNativeConfigPath()}`];
    if (presetName === currentPreset) {
      updateAgentModels(config, presetName);
      effects.push("active agent files updated");
      if (agentName === ORCHESTRATOR_NAME) {
        const switched = await pi.setModel(model);
        effects.push(switched ? `${ORCHESTRATOR_NAME} model switched now` : `${ORCHESTRATOR_NAME} model saved but not switched: no API key`);
      }
    }

    ctx.ui.notify(`Preset model updated:\n${effects.map((effect) => `- ${effect}`).join("\n")}`, "success");
  }

  // ── Commands ────────────────────────────────────────────────────────
  pi.registerCommand("preset", {
    description:
      "Switch model preset. Usage: /preset <name>\n" +
      "Configure presets in ~/.config/opencode/oh-my-opencode-slim.json",
    ...(getPresetCommandCompletions ? {
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
        getPresetCommandCompletions(prefix),
    } : {}),
    handler: async (args, ctx) => {
      const rawArgs = args.trim();
      if (rawArgs === PRESET_MODEL_SUBCOMMAND || rawArgs.startsWith(`${PRESET_MODEL_SUBCOMMAND} `)) {
        await handlePresetModelCommand(rawArgs.slice(PRESET_MODEL_SUBCOMMAND.length), ctx);
        return;
      }

      const name = rawArgs;
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
          effects.push(`${ORCHESTRATOR_NAME} model not switched: invalid model id ${plan.model}`);
        } else {
          const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
          if (!model) {
            effects.push(`${ORCHESTRATOR_NAME} model not switched: model not found ${plan.model}`);
          } else {
            const switched = await pi.setModel(model);
            effects.push(
              switched
                ? `${ORCHESTRATOR_NAME} model switched to ${plan.model}`
                : `${ORCHESTRATOR_NAME} model not switched: no API key for ${plan.model}`,
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
