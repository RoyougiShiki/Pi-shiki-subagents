/**
 * Pi Agent Adapter for oh-my-opencode-slim
 *
 * Transforms OMO's agent orchestration system into a pi extension.
 *
 * Architecture:
 *   - Agent markdown files are generated in ~/.pi/agents/ on first load
 *   - OMO's orchestrator prompt is injected via before_agent_start
 *   - Declaration gates (Intent/Clarify/Approval/Orchestration) are enforced
 *     via system prompt instructions and context event reminders
 *   - OMO's custom tools (delegate, council, ast-grep) are registered
 *     as pi tools (webfetch omitted — pi-web-access provides better ones)
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
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  INTENT_GATE_BLOCK_MESSAGE,
  CLARIFY_GATE_BLOCK_MESSAGE as READINESS_GATE_BLOCK_MESSAGE,
  APPROVAL_GATE_BLOCK_MESSAGE,
  ORCHESTRATION_GATE_BLOCK_MESSAGE,
} from "../core/workflow-templates";

import { AGENT_PROMPTS } from "./pi-agents";
import {
  formatPiCouncilResults,
  resolvePiCouncilParticipants,
  runPiCouncilParticipant,
  type PiCouncilParticipant,
  type PiCouncilRunResult,
} from "./pi-council";
import { formatPiMeetingResult, runPiMeeting, type PiMeetingParticipantResult } from "./pi-meeting";
export { AGENT_PROMPTS } from "./pi-agents";
export { formatPiCouncilResults, resolvePiCouncilParticipants } from "./pi-council";

import {
  compareToBaseline,
  createBaseline,
} from "../core/tool-detector";
import type { ToolInfo, ToolChange } from "../core/tool-detector";
export { formatPiMeetingResult, normalizePiMeetingBackend, normalizePiMeetingMaxRounds, normalizePiMeetingObjective } from "./pi-meeting";

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
  compliance_check?: {
    enabled?: boolean;
    modes?: string[];
  };
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

function loadOmniMoConfig(): OmniMoConfig | null {
  // Priority: env var → Pi native path → OpenCode path (legacy)
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envDir) {
    const envPath = path.join(envDir, "oh-my-opencode-slim.json");
    try { return JSON.parse(fs.readFileSync(envPath, "utf-8")); } catch {}
  }

  const piPath = path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
  try { return JSON.parse(fs.readFileSync(piPath, "utf-8")); } catch {}

  const legacyDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(homedir(), ".config", "opencode");
  for (const p of [path.join(legacyDir, "oh-my-opencode-slim.jsonc"), path.join(legacyDir, "oh-my-opencode-slim.json")]) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(stripJsonCommentsSafely(raw));
    } catch {}
  }

  return null;
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

function generateAgentMd(
  name: string,
  prompt: string,
  description: string,
  model: string,
): string {
  return `---
name: ${name}
description: ${description}
model: ${model}
thinking: low
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

function ensureAgentFiles(config: OmniMoConfig | null): void {
  const agentsDir = path.join(path.dirname(getAgentDir()), "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const model = getDefaultModel(name, config);

    const mdPath = path.join(agentsDir, `${name}.md`);
    if (!fs.existsSync(mdPath)) {
      const content = generateAgentMd(name, info.prompt, info.description, model);
      fs.writeFileSync(mdPath, content, "utf-8");
      console.error(`[oh-my-opencode-slim] Generated Pi agent: ${name}.md (${model})`);
    }

    const tomlPath = path.join(agentsDir, `${name}.toml`);
    if (!fs.existsSync(tomlPath)) {
      const content = generateAgentToml(name, info.prompt, info.description, model);
      fs.writeFileSync(tomlPath, content, "utf-8");
      console.error(`[oh-my-opencode-slim] Generated collaborating subagent type: ${name}.toml (${model})`);
    }
  }
}

function updateAgentModels(config: OmniMoConfig | null, presetName: string): void {
  const agentsDir = path.join(path.dirname(getAgentDir()), "agents");
  const preset = config?.presets?.[presetName];
  if (!preset) return;

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const agentOverride = preset[name] as { model?: string } | undefined;
    const model = agentOverride?.model ?? getDefaultModel(name, config);

    const mdPath = path.join(agentsDir, `${name}.md`);
    if (fs.existsSync(mdPath)) {
      const content = generateAgentMd(name, info.prompt, info.description, model);
      fs.writeFileSync(mdPath, content, "utf-8");
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

function buildPiOrchestratorPrompt(
  disabledAgents: string[],
  _config: OmniMoConfig | null,
  _capabilities: PiDelegationCapabilities,
): string {

  const constPath = path.join(homedir(), ".pi", "agent", "constitution.md");
  let constText = "";
  try { if (fs.existsSync(constPath)) constText = fs.readFileSync(constPath, "utf-8").trim(); } catch {}
  if (!constText) constText = `<CONSTITUTION>\n（未找到 constitution.md）\n</CONSTITUTION>`;

    return constText || `<CONSTITUTION>\n（未找到 constitution.md）\n</CONSTITUTION>`;
}

// ─── Tool implementations ──────────────────────────────────────────────────

function createToolImplementations(config: OmniMoConfig | null) {
  return {
    delegate: {
      name: "omo_delegate",
      label: "OMO Delegate",
      description:
        "Delegate tasks to specialist agents in-process (no subprocess).\n" +
        "Modes: single (agent + task), chain (sequential with context), tasks (parallel).\n" +
        "Agents: explorer, librarian, oracle, fixer, designer, observer.",
      promptSnippet:
        "Delegate a focused subtask to a specialist agent (in-process, returns result)",
      parameters: Type.Object({
        agent: Type.Optional(Type.String({
          description: "Agent name: explorer | librarian | oracle | fixer | designer | observer",
        })),
        task: Type.Optional(Type.String({ description: "Task to delegate" })),
        tasks: Type.Optional(
          Type.Array(
            Type.Object({
              agent: Type.String(),
              task: Type.String(),
            }),
            { description: "Parallel tasks array" },
          ),
        ),
        chain: Type.Optional(
          Type.Array(
            Type.Object({
              agent: Type.String(),
              task: Type.String(),
            }),
            { description: "Chain of agents for sequential execution" },
          ),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          agent?: string;
          task?: string;
          tasks?: Array<{ agent: string; task: string }>;
          chain?: Array<{ agent: string; task: string }>;
        },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        // ── Mode-based delegation guard (config-driven) ─────────────
        let currentMode = "";
        let blocked: string[] = [];
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json"), "utf-8"));
          currentMode = (raw as any).active_mode ?? "";
          const restrictions = (raw as any).mode_agent_restrictions ?? {};
          blocked = restrictions[currentMode]?.blocked ?? [];
        } catch {}

        if (blocked.length > 0) {
          const requested = params.agent || params.tasks?.[0]?.agent || params.chain?.[0]?.agent || "";
          if (blocked.includes(requested)) {
            return {
              content: [{ type: "text" as const, text: `[Agent Restricted] 当前模式为 "${currentMode}"，不支持委托代理 "${requested}"。该模式允许的代理：explorer, librarian。如需使用 ${requested}，请切换到 worker 或 batch 模式。` }], isError: true, details: {} as any };
          }
          const allAgents = [
            ...(params.tasks?.map(t => t.agent) || []),
            ...(params.chain?.map(c => c.agent) || []),
          ].filter(Boolean);
          const blockedOne = allAgents.find(a => blocked.includes(a));
          if (blockedOne) {
            return {
              content: [{ type: "text" as const, text: `[Agent Restricted] 当前模式为 "${currentMode}"，任务列表中包含受限代理 "${blockedOne}"。受限代理：${blocked.join(", ")}。请移除后重试。` }], isError: true, details: {} as any };
          }
        }

        // ── Helper: run one agent via createAgentSession ────────────────
        async function runOne(
          agentName: string,
          taskText: string,
        ): Promise<string> {
          const agentInfo = AGENT_PROMPTS[agentName];
          if (!agentInfo) {
            return `[Unknown agent: ${agentName}]`;
          }

          // Resolve tools from agent_roles + role_templates
          const rolesCfg = config as any;
          const agentRoleNames: string[] = rolesCfg?.agent_roles?.[agentName] || [];
          const templates = rolesCfg?.role_templates || {};
          const resolvedAgentTools: string[] = [...new Set(agentRoleNames.flatMap((r: string) => (templates as any)[r] || []) as string[])];
          const { session } = await createAgentSession({
            model: undefined, // use default pi model
            tools: resolvedAgentTools.length > 0 ? resolvedAgentTools : ["read"],
            sessionManager: SessionManager.inMemory(),
            cwd: ctx.cwd,
          });

          const fullPrompt = `${agentInfo.prompt}\n\n## Task\n${taskText}`;
          await session.prompt(fullPrompt, { source: "extension" });

          // Extract last assistant text
          const msgs = session.state.messages ?? [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === "assistant") {
              const parts = m.content ?? [];
              const texts = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .filter(Boolean);
              if (texts.length > 0) return texts.join("\n");
            }
          }
          return "(completed)";
        }

        // ── Parallel mode ───────────────────────────────────────────────
        if (params.tasks && params.tasks.length > 0) {
          try {
            const results = await Promise.all(
              params.tasks.map((t) => runOne(t.agent, t.task)),
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: results.map((r, i) => `[${params.tasks![i].agent}]\n${r}`).join("\n\n---\n\n"),
                },
              ],
              details: { mode: "parallel", count: params.tasks.length },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text" as const, text: `Parallel delegation failed: ${err.message}` }],
              details: {},
              isError: true,
            };
          }
        }

        // ── Chain mode ─────────────────────────────────────────────────
        if (params.chain && params.chain.length > 0) {
          const results: string[] = [];
          let context = "";
          for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const taskWithContext = context ? `${step.task}\n\nPrevious output:\n${context}` : step.task;
            try {
              const output = await runOne(step.agent, taskWithContext);
              results.push(output);
              context = output;
            } catch (err: any) {
              return {
                content: [{ type: "text" as const, text: `Step ${i + 1} (${step.agent}) failed: ${err.message}` }],
                details: {},
                isError: true,
              };
            }
          }
          return {
            content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
            details: { mode: "chain", steps: results.length },
          };
        }

        // ── Single mode ────────────────────────────────────────────────
        if (!params.agent || !params.task) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Provide agent + task, or tasks[], or chain[]. Available agents: ${Object.keys(AGENT_PROMPTS).join(", ")}`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        try {
          const output = await runOne(params.agent, params.task);
          return {
            content: [{ type: "text" as const, text: output }],
            details: { mode: "single", agent: params.agent },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Delegation failed: ${err.message}` }],
            details: {},
            isError: true,
          };
        }
      },
    },

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
          participants?: PiCouncilParticipantConfig[];
        },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        const mode = params.mode ?? "isolated";
        if (mode === "meeting") {
          const meeting = await runPiMeeting({
            question: params.question,
            preset: params.preset,
            participants: params.participants,
            objective: params.objective,
            maxRounds: params.maxRounds,
            maxDurationMs: params.maxDurationMs,
            includeTranscript: params.includeTranscript,
            ctx,
            config,
          });
          if (meeting.error || !meeting.result) {
            return {
              content: [{ type: "text" as const, text: meeting.error ?? "Meeting failed before starting." }],
              details: { mode, question: params.question },
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: formatPiMeetingResult(meeting.result) }],
            details: {
              mode,
              question: params.question,
              meetingId: meeting.result.meetingId,
              status: meeting.result.status,
              roundsCompleted: meeting.result.roundsCompleted,
              requestedBackend: meeting.result.requestedBackend,
              backendUsed: meeting.result.backendUsed,
              fallbackReason: meeting.result.fallbackReason,
              participants: meeting.result.participants.map((p: PiMeetingParticipantResult) => ({ name: p.name, agent: p.agent, status: p.status })),
              keySignals: meeting.result.keySignals,
            },
            isError: meeting.result.status === "failed" || meeting.result.status === "timed_out",
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

    astGrepSearch: {
      name: "omo_ast_grep_search",
      label: "OMO AST Grep Search",
      description: "AST-aware code search. Use for structural patterns like function shapes, class structures.",
      promptSnippet: "Search code with AST pattern matching",
      parameters: Type.Object({
        pattern: Type.String({ description: "AST grep pattern (e.g., 'function $NAME($$$)')" }),
        paths: Type.Optional(
          Type.Array(Type.String(), { description: "Paths to search (default: current dir)" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { pattern: string; paths?: string[] },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        const searchPaths = params.paths?.join(" ") ?? ".";
        try {
          const { execSync } = await import("node:child_process");
          const result = execSync(
            `sg --json '${params.pattern}' ${searchPaths}`,
            { cwd: ctx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 30000 },
          );
          return {
            content: [{ type: "text" as const, text: result || "(no matches)" }],
            details: {},
          };
        } catch (err: any) {
          if (err.status === 1 && !err.stdout) {
            return {
              content: [{ type: "text" as const, text: "(no matches)" }],
              details: {},
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `ast-grep failed: ${err.message ?? String(err)}. Use grep for simple patterns.`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      },
    },

    astGrepReplace: {
      name: "omo_ast_grep_replace",
      label: "OMO AST Grep Replace",
      description: "AST-aware code replacement. Use for structural code transformations.",
      promptSnippet: "Replace code patterns with AST-aware rewriting",
      parameters: Type.Object({
        pattern: Type.String({ description: "AST grep pattern to match" }),
        rewrite: Type.String({ description: "Replacement pattern (use $MATCH, $NAME, etc.)" }),
        paths: Type.Optional(
          Type.Array(Type.String(), { description: "Paths to modify (default: current dir)" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { pattern: string; rewrite: string; paths?: string[] },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        const searchPaths = params.paths?.join(" ") ?? ".";
        try {
          const { execSync } = await import("node:child_process");
          const result = execSync(
            `sg --json '${params.pattern}' --rewrite '${params.rewrite}' ${searchPaths}`,
            { cwd: ctx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 30000 },
          );
          return {
            content: [{ type: "text" as const, text: result || "(no changes)" }],
            details: {},
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `ast-grep replace failed: ${err.message ?? String(err)}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      },
    },


  };
}



// ─── Pi extension entry point ──────────────────────────────────────────────

export default function omniMoPiExtension(pi: ExtensionAPI) {
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
    // Reset mode injection tracker for new session
    _lastInjectedMode = "";

    ensureAgentFiles(config);

    // Hide subagent tool (broken + overlaps with omo_delegate).
    // Keep agent_message — omo_council collaborating backend needs it.
    try {
      const all = pi.getAllTools().map((t: any) => t.name).filter(Boolean);
      pi.setActiveTools(all.filter((n: string) => n !== "subagent"));
    } catch {}
  });

  // ── Lifecycle-based gate state ─────────────────────────────────────
  // Gates track declarations per agent cycle (before_agent_start → agent_end).
  // Each gate only blocks once per cycle — after declared, subsequent
  // tools in the same cycle pass without re-declaration.
  let gateState: { cycle: number; intent: boolean; ready: boolean; approved: boolean } = {
    cycle: 0, intent: false, ready: false, approved: false,
  };

  // ── Context-aware gate state
  let userTurn = 0;
  let lastApprovedTurn: number | null = null;
  let lastReadyTurn: number | null = null;
  let lastIntentTurn: number | null = null;
  const DECLARATION_EXPIRY_USER_MSGS = 5;

  // ── Inject orchestrator system prompt ───────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Reset gate state for new agent cycle
    gateState = { cycle: gateState.cycle + 1, intent: false, ready: false, approved: false };
    const capabilities = refreshDelegationCapabilities(event.systemPrompt);
    const disabledAgents = config?.disabled_agents ?? [];
    const omniPrompt = buildPiOrchestratorPrompt(
      disabledAgents,
      config,
      capabilities,
    );

    // Trim verbose tool descriptions in system prompt
    const trimmedPrompt = trimToolDescriptions(event.systemPrompt, (config as any)?.tool_descriptions ?? {});

    return {
      systemPrompt: `${omniPrompt}\n\n---\n\n${trimmedPrompt}`,
    };
  });

  // ── Track last injected mode for first-after-switch detection ──
  let _lastInjectedMode = "";

      // ── Trim tool descriptions in provider API payload ────────────────
  pi.on("before_provider_request", (event, _ctx) => {
    const toolCfg = (config as any)?.tool_descriptions ?? {};
    const hide = new Set<string>((toolCfg.hide as string[]) ?? []);
    const truncCfg = (toolCfg.truncate ?? {}) as Record<string, number>;
    const defaultTrunc = truncCfg.default ?? 0;
    if (hide.size === 0 && defaultTrunc === 0 && Object.keys(truncCfg).length === 0) return;
    trimProviderToolDescriptions(event.payload as Record<string, any>, hide, truncCfg, defaultTrunc);
  });

  // ── Inject mode identity before user message (always runs) ────
  pi.on("before_provider_request", (event, _ctx) => {
    try {
      const cfgPath = path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
      if (!fs.existsSync(cfgPath)) return;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const mode: string = cfg.active_mode || "worker";
      const payload = event.payload as Record<string, any>;
      if (!Array.isArray(payload?.messages)) return;

      // Detect mode switch: first message after switch gets full prompt
      const isSwitch = mode !== _lastInjectedMode;
      _lastInjectedMode = mode;

      let content: string;
      if (isSwitch) {
        // Load full .md content for the new mode
        const modeFilePath = path.join(homedir(), ".pi", "agent", "modes", "${mode}.md");
        let fullPrompt = "";
        try {
          if (fs.existsSync(modeFilePath)) {
            const raw = fs.readFileSync(modeFilePath, "utf-8");
            const bodyMatch = raw.match(/---\n[\s\S]*?\n---\n([\s\S]*)/);
            fullPrompt = bodyMatch ? bodyMatch[1].trim() : raw.trim();
          }
        } catch {}
        content = `<systemReminder>\n\n### [Current Mode: ${mode}]\n\n` +
          (fullPrompt
            ? `─────────────────────────────────────────────\n${fullPrompt}\n─────────────────────────────────────────────\n\nYou just switched to this mode. Read the rules above carefully before responding.`
            : `You just switched to this mode. Review your role and follow it.`) +
          `\n\n</systemReminder>`;
      } else {
        content = `<systemReminder>\n\n### Mode Compliance\n\n**Current mode:** ${mode}\n\nYour full mode prompt is at the top of system prompt \u2014 re-read it now. It defines your role, allowed tools, behavioral rules, and hard boundaries (e.g. which agents you may delegate to, what actions are forbidden).\n\nVerify before responding: Is your next action permitted in this mode? If not, stop and correct.\n\n</systemReminder>`;
      }

      // Insert before the last user message
      let insertAt = payload.messages.length - 1;
      for (let i = payload.messages.length - 1; i >= 0; i--) {
        if (payload.messages[i]?.role === "user") {
          insertAt = i;
          break;
        }
      }
      payload.messages.splice(insertAt, 0, { role: "system", content });
    } catch {
      // ignore read errors
    }
  });

  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.delegate);
  pi.registerTool(tools.council);
  pi.registerTool(tools.astGrepSearch);
  pi.registerTool(tools.astGrepReplace);

  // ── Tool activation & description tools (always available) ─────────
  pi.registerTool({
    name: "activate_tools",
    label: "Activate Tool",
    description: "激活扩展工具使其在当前会话可用。参数 toolNames：需激活的工具名称列表。",
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

  // ── Declaration gates via tool_call blocking ───────────────────────
  // Pi synchronizes ctx.sessionManager through the current assistant
  // tool-calling message before tool_call handlers run. Use that current
  // message first, then fall back to previous assistant text. These gates are
  // intentionally instructional: blocking is a reminder to stop and reason
  // about intent/readiness/approval, not just a permission denial.
  function getAssistantText(msg: any): string {
    const content = msg?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
  }

  function assistantHasToolCall(msg: any, toolCallId: string): boolean {
    const content = msg?.content;
    return Array.isArray(content) && content.some((p: any) => p?.type === "toolCall" && p.id === toolCallId);
  }

  function getRelevantAssistantText(ctx: ExtensionContext, toolCallId: string): string {
    try {
      const branch = ctx.sessionManager.getBranch();
      let fallback = "";
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        const msg = (entry as any).message;
        if (msg?.role !== "assistant") continue;
        const text = getAssistantText(msg);
        if (!text) continue;
        if (assistantHasToolCall(msg, toolCallId)) return text;
        if (!fallback) fallback = text;
      }
      return fallback;
    } catch {
      return "";
    }
  }

  function hasDeclaration(text: string, label: string): boolean {
    // Prefer declarations at line starts, but allow compact same-line forms:
    // "Intent: ... READY: ... APPROVED: ...". The gate is instructional;
    // overblocking valid compact declarations makes weaker models loop.
    return new RegExp(`(^|\\s)${label}:`, "im").test(text);
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      const assistantText = getRelevantAssistantText(ctx, event.toolCallId);

      // First turn or provider emitted tool call without any visible text:
      // remind through context/prompt next time, but do not hard-block purely
      // empty text because some providers can generate tool-only first calls.
      if (!assistantText) return;

      // Detect declarations in the current assistant message
      const hasIntent = hasDeclaration(assistantText, "Intent");
      const hasReady = hasDeclaration(assistantText, "READY") || hasDeclaration(assistantText, "AWAITING_APPROVAL");
      const hasApproved = hasDeclaration(assistantText, "APPROVED");
      const hasOrchestration = hasDeclaration(assistantText, "ORCHESTRATION");

      // Intent Gate: block once per cycle if not yet declared.
      // Once declared in any turn of this cycle, skip Intent check for
      // subsequent tools (LLM is continuing the same intent).
      if (!hasIntent && !gateState.intent) {
        return { block: true, reason: INTENT_GATE_BLOCK_MESSAGE };
      }
      if (hasIntent) gateState.intent = true;

      // Orchestration Gate: block each time for delegation tools.
      // Each delegate call is an independent orchestration decision.
      if (["agent", "workflow", "subagent", "omo_delegate"].includes(event.toolName)) {
        if (!hasOrchestration) {
          return { block: true, reason: ORCHESTRATION_GATE_BLOCK_MESSAGE };
        }
      }

      // Readiness + Approval Gates: block once per cycle. Supports cross-cycle continuation.
      if (event.toolName === "edit" || event.toolName === "write") {
        const hasContinued = hasDeclaration(assistantText, "CONTINUED");
        if (hasContinued) { gateState.ready = true; gateState.approved = true; lastApprovedTurn = userTurn; }

        if (!hasReady && !hasContinued && !hasApproved && !gateState.ready) {
          if (lastApprovedTurn !== null && (userTurn - lastApprovedTurn) <= DECLARATION_EXPIRY_USER_MSGS && !gateState.approved) {
            return { block: true, reason: `[ApprovalGate] ⚡ 检测到近期的批准记录（第 ${lastApprovedTurn} 轮）。延续任务？回复开头写 "CONTINUED: <任务名>"，否则写 READY+APPROVED` };
          }
          return { block: true, reason: READINESS_GATE_BLOCK_MESSAGE };
        }
        if (hasReady || hasContinued) gateState.ready = true;

        if (!hasApproved && !hasContinued && !gateState.approved) {
          return { block: true, reason: APPROVAL_GATE_BLOCK_MESSAGE };
        }
        if (hasApproved || hasContinued) {
          gateState.ready = true; gateState.approved = true;
          lastApprovedTurn = userTurn; lastReadyTurn = userTurn;
        }
      }
    } catch (err) {
      console.error("[oh-my-opencode-slim] Gate error:", err);
    }
  });

  // ── Gate reminders in context ──────────────────────────────────────
  pi.on("context", async (event, _ctx) => {
    const reminder = {
      role: "system" as const,
      content: [{ type: "text" as const, text: `[Gate Rules]
Declare these before calling tools:

• Intent: <type> — required before any tool call. Shows you've understood what to do.
• ORCHESTRATION: self | delegate to <agent> — required BEFORE omo_delegate/agent tools.
   Why declare it? It forces you to consciously choose the right approach for each task.
   Not declaring = gate will block your delegation. You'll waste a turn.
• READY: <context> + APPROVED: <plan> — required before write/edit tools.
   Not declaring = gate will block the modification.` }],
    };
    const hasReminder = event.messages.some(
      (m: any) => m.role === "system" && m.content?.some?.((p: any) => p.text?.startsWith("[Gate Rules]")),
    );
    if (!hasReminder) {
      return { messages: [...event.messages, reminder] };
    }
  });

  // ── Compliance check on turn end ──────────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    try {
      const config = loadOmniMoConfig();
      if (!config?.compliance_check?.enabled) return;

      const activeMode = (config as any).active_mode ?? "worker";
      const checkModes: string[] = (config.compliance_check?.modes as string[]) ?? ["thinker-clarify", "thinker-analysis"];
      if (!checkModes.includes(activeMode)) return;

      const modeFilePath = path.join(homedir(), ".pi", "agent", "modes", `${activeMode}.md`);
      let modePrompt = "";
      try { modePrompt = fs.readFileSync(modeFilePath, "utf-8"); } catch { return; }

      const agentOutput = event.message?.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("\n") ?? "";

      if (!agentOutput.trim()) return;

      const prompt = `Respond with JSON only: { "compliant": boolean, "violations": [{ "type": string, "severity": "blocking" | "major" | "minor", "description": string }] }

You are a compliance checker. Check if the agent's output violates the mode rules.

Mode rules:
${modePrompt.slice(0, 2000)}

Agent output:
${agentOutput.slice(0, 3000)}`;

      const tmpFile = path.join(homedir(), ".pi", "agent", ".compliance-tmp.txt");
      fs.writeFileSync(tmpFile, prompt, "utf-8");
      const { execFileSync } = await import("node:child_process");
      const result = execFileSync("pi", ["--print", "--no-tools", `@${tmpFile}`], {
        encoding: "utf-8",
        timeout: 15000,
      });

      let checkResult: any;
      try { checkResult = JSON.parse(result.trim()); } catch { return; }

      if (!checkResult.compliant && checkResult.violations?.length > 0) {
        const violationMsg = checkResult.violations
          .map((v: any) => `- [${v.severity}] ${v.type}: ${v.description}`)
          .join("\n");
        pi.sendUserMessage(
          `[Compliance Check] 检测到违规行为，请修正：\n\n${violationMsg}`,
          { deliverAs: "followUp" },
        );
      }
    } catch (e) {
      console.error("[oh-my-opencode-slim] Compliance check error:", e instanceof Error ? e.message : String(e));
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

  // ── Tool description management command ───────────────────────────
  pi.registerCommand("tooldesc", {
    description: "管理工具描述显示。无参交互式，有参直接执行。用法: /tooldesc hide|show|truncate|full <tool>... [length]",
    handler: async (args: string, ctx: any) => {
      try {
        const configPath = path.join(homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
        const raw = fs.readFileSync(configPath, "utf-8");
        const cfg = JSON.parse(raw);
        if (!cfg.tool_descriptions) cfg.tool_descriptions = { hide: [], truncate: {} };
        const allTools = pi.getAllTools().map((t: any) => t.name).filter(Boolean);

        // ── Parse args mode ────────────────────────────────────────
        const parts = (args ?? "").trim().split(/\s+/);
        const cmd = parts[0];
        const toolArgs = parts.slice(1).filter((t: string) => t && !/^\d+$/.test(t));
        const lenStr = parts.slice(1).find((t: string) => /^\d+$/.test(t));
        const len = lenStr ? parseInt(lenStr, 10) : 40;

        if (cmd && ["hide", "show", "truncate", "full"].includes(cmd)) {
          if (toolArgs.length === 0) {
            ctx.ui.notify("请指定工具名", "info");
            return;
          }
          if (cmd === "hide") {
            const h = cfg.tool_descriptions.hide as string[];
            for (const tool of toolArgs) {
              if (!h.includes(tool)) h.push(tool);
            }
            cfg.tool_descriptions.hide = h;
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            ctx.ui.notify("描述已隐藏: " + toolArgs.join(", "), "info");
          } else if (cmd === "show") {
            const hideSet = new Set(cfg.tool_descriptions.hide as string[]);
            for (const tool of toolArgs) hideSet.delete(tool);
            cfg.tool_descriptions.hide = [...hideSet];
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            ctx.ui.notify("描述已恢复: " + toolArgs.join(", "), "info");
          } else if (cmd === "truncate") {
            for (const tool of toolArgs) cfg.tool_descriptions.truncate[tool] = len;
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            ctx.ui.notify("截断 " + toolArgs.join(", ") + " 至 " + len + " 字符", "info");
          } else if (cmd === "full") {
            for (const tool of toolArgs) delete cfg.tool_descriptions.truncate[tool];
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            ctx.ui.notify("恢复完整描述: " + toolArgs.join(", "), "info");
          }
          return;
        }

        // ── Interactive mode ───────────────────────────────────────
        const actionLabel = await ctx.ui.select("操作:", [
          "隐藏描述",
          "恢复描述",
          "截断描述",
          "取消截断",
          "查看当前配置",
        ]);
        if (!actionLabel) return;

        if (actionLabel === "查看当前配置") {
          const h = (cfg.tool_descriptions.hide as string[]).join(", ") || "(无)";
          const t = Object.entries(cfg.tool_descriptions.truncate as Record<string, number>)
            .map(([k, v]) => k + "=" + v).join(", ") || "(无)";
          ctx.ui.notify("隐藏: " + h + " | 截断: " + t, "info");
          return;
        }

        // Determine candidate tools based on action
        const hidden = new Set(cfg.tool_descriptions.hide as string[]);
        const truncated = new Set(Object.keys(cfg.tool_descriptions.truncate as Record<string, number>));
        let candidates: string[];
        if (actionLabel === "隐藏描述") candidates = allTools.filter((t: string) => !hidden.has(t));
        else if (actionLabel === "恢复描述") candidates = allTools.filter((t: string) => hidden.has(t));
        else if (actionLabel === "截断描述") candidates = allTools.filter((t: string) => !truncated.has(t));
        else if (actionLabel === "取消截断") candidates = allTools.filter((t: string) => truncated.has(t));
        else candidates = allTools;

        if (candidates.length === 0) {
          ctx.ui.notify("没有符合条件的工具", "info");
          return;
        }

        // Multi-select tools via loop
        let selectedTools: string[] = [];
        while (true) {
          const remaining = candidates.filter((t: string) => !selectedTools.includes(t));
          if (remaining.length === 0) break;
          const pick = await ctx.ui.select(
            selectedTools.length === 0 ? "选择工具:" : "已选 " + selectedTools.length + " 个，继续选择:",
            remaining,
          );
          if (!pick) break;
          selectedTools.push(pick);
          if (selectedTools.length >= remaining.length) break;
        }

        if (selectedTools.length === 0) return;

        if (actionLabel === "隐藏描述") {
          const h = cfg.tool_descriptions.hide as string[];
          for (const tool of selectedTools) {
            if (!h.includes(tool)) h.push(tool);
          }
          cfg.tool_descriptions.hide = h;
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ctx.ui.notify("描述已隐藏: " + selectedTools.join(", "), "info");
        } else if (actionLabel === "恢复描述") {
          const hideSet = new Set(cfg.tool_descriptions.hide as string[]);
          for (const tool of selectedTools) hideSet.delete(tool);
          cfg.tool_descriptions.hide = [...hideSet];
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ctx.ui.notify("描述已恢复: " + selectedTools.join(", "), "info");
        } else if (actionLabel === "截断描述") {
          const lenStr = await ctx.ui.input("截断长度:", "40");
          const n = parseInt(lenStr ?? "40", 10);
          const finalLen = isNaN(n) ? 40 : n;
          for (const tool of selectedTools) cfg.tool_descriptions.truncate[tool] = finalLen;
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ctx.ui.notify("截断 " + selectedTools.join(", ") + " 至 " + finalLen + " 字符", "info");
        } else if (actionLabel === "取消截断") {
          for (const tool of selectedTools) delete cfg.tool_descriptions.truncate[tool];
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ctx.ui.notify("恢复完整描述: " + selectedTools.join(", "), "info");
        }
      } catch (err: any) {
        ctx.ui.notify("操作失败: " + err.message, "error");
      }
    },
  });

  // ── Log startup ─────────────────────────────────────────────────────
  const presetName = config?.preset ?? "default";
  const orchestratorModel = getPresetModelForOrchestrator(config, presetName) ?? "default";
  const startupCapabilities = refreshDelegationCapabilities();
  console.error(
    `[oh-my-opencode-slim] Pi adapter loaded. Preset: ${presetName}, Orchestrator model: ${orchestratorModel}, capabilities: pi-agents=${startupCapabilities.hasPiAgents ? "yes" : "no"}, subagent=${startupCapabilities.hasSubagent ? "yes" : "no"}, agent_message=${startupCapabilities.hasAgentMessage ? "yes" : "no"}`,
  );
}
