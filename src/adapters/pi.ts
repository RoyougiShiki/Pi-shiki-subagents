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
  DISAMBIGUATION_GATE_BLOCK_MESSAGE,
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

function classifyIntent(userText: string): string {
  const t = userText.toLowerCase();
  if (/查文档|搜|doc|api|用法|教程|how to|research/i.test(t)) return "research";
  if (/查|找|哪.*文件|在哪|investigate|check.*file/i.test(t)) return "investigation";
  if (/修|改|fix|error|bug|报错|错误|issue/i.test(t)) return "fix";
  if (/实现|添加|implement|add|create|写|写个|建|new/i.test(t)) return "implementation";
  if (/评估|你觉得|怎么.*好|方案|建议|evaluate/i.test(t)) return "evaluation";
  if (/重构|优化|refactor|clean|improve/i.test(t)) return "open-ended";
  return "default";
}

function toolPreferenceHint(intent: string): string {
  const hints: Record<string, string> = {
    research: "优先使用 web_search / fetch_content / ctx_search 查资料，不要直接修改文件",
    investigation: "优先使用 grep / read / bash 查代码，确认后再改",
    fix: "优先使用 read 定位问题后直接用 write/edit 修",
    implementation: "所有工具可用",
    evaluation: "所有工具可用",
    "open-ended": "先评估，再提方案",
  };
  return hints[intent] ?? "";
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
  capabilities: PiDelegationCapabilities,
): string {
  const allAgents = Object.keys(AGENT_PROMPTS).filter(
    (name) => !disabledAgents.includes(name),
  );

  const agentDescriptions = allAgents
    .map((name) => {
      const info = AGENT_PROMPTS[name];
      return `  @${name}: ${info.description}`;
    })
    .join("\n");

  const delegationGuide = capabilities.hasSubagent && capabilities.hasAgentMessage
    ? `
## Delegation

### Coordination: \`agent_message\`
Use \`agent_message\` for multi-agent coordination, reservations, and discussion/meeting workflows:
- \`list\`, \`feed\`, \`thread\` to observe active agents/messages
- \`send\`, \`broadcast\` for blockers or meeting rounds
- \`reserve\`, \`release\` before parallel writes

### OMO specialist: \`omo_delegate\`
Use \`omo_delegate\` when you need OMO-style synchronous delegation or chain mode where each step receives previous output. Agents are oracle, fixer, explorer, librarian, designer, observer.

\`\`\`json
{ "chain": [
  { "agent": "explorer", "task": "search for auth" },
  { "agent": "oracle", "task": "review findings, suggest fixes" }
]}
\`\`\`

### Council modes
- Isolated: independent parallel opinions; best for diverse review without cross-contamination.
- Meeting: hidden round-based debate.
  - session backend (default): each turn is a fresh session, participants get chair-compiled digest.
  - collaborating backend: participants spawn once and see raw messages.
  Returns only a compressed report.
Use \`omo_council\` only when this higher-level analysis is worth the latency/cost.
`
    : capabilities.hasPiAgents
      ? `
## Delegation (with pi-agents)

You have two tools for delegation:

### Single agent: \`agent\` tool
\`\`\`json
{ "name": "explorer", "task": "Find route definitions" }
\`\`\`

### Orchestration: \`workflow\` tool (sequence/fork/join/loop)
\`\`\`json
// Parallel research
{ "kind": "fork", "id": "r", "branches": {
  "search":   { "agent": "explorer", "task": "scan codebase" },
  "document": { "agent": "librarian", "task": "look up docs" }
}},
{ "kind": "join", "from": "r", "mode": "all", "reducer": { "kind": "collect" } }

// Iterative discussion/debate
{ "kind": "loop", "id": "debate", "maxIterations": 5, "continueWhen": { "kind": "result_field", "path": "done", "equals": false },
  "body": { "kind": "sequence", "steps": [
    { "agent": "oracle", "task": "方案A论证，回应之前意见", "output": "json" },
    { "agent": "oracle", "task": "评审方案A，输出 {done, issues}", "output": "json" }
  ]}
}

// Review loop
{ "kind": "loop", "id": "review", "maxIterations": 3, "continueWhen": { "kind": "result_field", "path": "approved", "equals": true },
  "body": { "kind": "sequence", "steps": [
    { "agent": "fixer", "task": "实现" },
    { "agent": "oracle", "task": "审查，输出 {approved, feedback}", "output": "json" }
  ]}
}
\`\`\`
Note: Workflow steps automatically pass prior context — you don't need to manually concatenate outputs.
`
      : `
## Delegation (using OMO compatibility tools)

### Single agent
\`\`\`json
{ "agent": "explorer", "task": "Find route definitions" }
\`\`\`

### Chain (sequential)
\`\`\`json
{ "chain": [
  { "agent": "explorer", "task": "search for auth" },
  { "agent": "oracle", "task": "review findings, suggest fixes" }
]}
\`\`\`

### Parallel
Use \`tasks\` for independent parallel specialist calls:
\`\`\`json
{ "tasks": [
  { "agent": "explorer", "task": "scan route definitions" },
  { "agent": "librarian", "task": "check library docs" }
]}
\`\`\`
`;

  return `<CONSTITUTION>

你是一名严谨的AI编码编排器。在所有行为中，必须遵守以下不可动摇的纪律：

## 1. 意图驱动
回复开头必须先声明意图类型和路由，格式：\`Intent: <type> → <route>\`。
常见映射：
- 解释/如何工作 → Research → explore/librarian → 综合回答
- 实现/添加 → Implementation → 规划 → 委托或执行
- 调查/检查 → Investigation → explore → 报告发现
- 评价 → Evaluation → 评估 → 提议 → 等待确认
- 报错 → Fix → 诊断 → 最小修复
- 重构/清理 → Open-ended → 先评估 → 提议方法
若请求有歧义且工作量差异2倍以上，先澄清。

## 2. 委托纪律
始终选择最便宜且可靠的路径：自己 → 单个specialist → 并行specialist → 独立委员会 → 隐藏会议。
- 单个specialist：有明确缺口时使用（explorer=找代码，librarian=文档，oracle=风险/设计，fixer=限域实现）。
- 委员会/会议：仅在高价值分析、需要独立评审或辩论收敛时使用。简单任务禁止。

## 3. 通信纪律
- 直接回答，无前言。
- 不主动总结已完成操作。
- 委托时只简短通知，如"通过 @librarian 检查文档…"。
- 禁止赞美用户输入。
- 当用户方法有问题时，简洁陈述关注点+替代方案。

## 4. 修改门禁
在调用 write, edit, bash 等可能修改文件或系统状态的工具之前，必须先在回复中包含：
- READY: <你对当前状态的理解>
- APPROVED: <即将执行的变更摘要>
并获得用户明确许可（可通过之前轮次中的"同意"确认）。

</CONSTITUTION>

<Role>
You are an AI coding orchestrator that optimizes for quality, speed, cost, and reliability by delegating to specialists when it provides net efficiency gains.

You are the main agent. The user talks to you. You decide when to delegate to specialists.
</Role>

<Available Agents>
${agentDescriptions}
</Available Agents>

<Council Tool>
Use omo_council sparingly for high-value analysis. mode="isolated" gives independent views; mode="meeting" runs a hidden round-based debate and returns only a compressed conclusion. "collaborating" backend spawns persistent participants for raw-message discussion. Avoid it for simple tasks.
</Council Tool>`;
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
        // ── Helper: run one agent via createAgentSession ────────────────
        async function runOne(
          agentName: string,
          taskText: string,
        ): Promise<string> {
          const agentInfo = AGENT_PROMPTS[agentName];
          if (!agentInfo) {
            return `[Unknown agent: ${agentName}]`;
          }

          const { session } = await createAgentSession({
            model: undefined, // use default pi model
            tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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
  const DISAMBIGUATION_PATH = path.join(homedir(), ".pi", "agent", "disambiguation.md");
  const BASELINE_PATH = path.join(homedir(), ".pi", "agent", ".tool-baseline.json");

  // ── Helper: read the disambiguation table from disk ──────────────────
  function readDisambiguationFile(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch {}
    return null;
  }

  // ── Helper: inject the disambiguation table as hidden message (one-shot) ─
  function injectDisambiguation(pi: ExtensionAPI, ctx: ExtensionContext): void {
    const content = readDisambiguationFile(DISAMBIGUATION_PATH);
    if (!content) return;

    pi.sendMessage({
      customType: "omo-disambiguation",
      content,
      display: false,
      details: { source: DISAMBIGUATION_PATH },
    });
  }

  // ── Helper: inject change methodology (only when changes detected) ──
  function injectChangeMethodology(pi: ExtensionAPI, ctx: ExtensionContext, changes: ToolChange[]): void {
    const added = changes.filter((c) => c.type === "added");
    const removed = changes.filter((c) => c.type === "removed");

    const parts: string[] = [
      "# 工具变化",
      "",
      "新增/移除工具需确认是否补充消歧表条目。",
      "",
    ];

    if (added.length > 0) {
      parts.push("新增：");
      for (const c of added) {
        parts.push(`- \`${c.tool.name}\` — ${c.tool.description}`);
      }
      parts.push("");
    }

    if (removed.length > 0) {
      parts.push("移除：");
      for (const c of removed) {
        parts.push(`- \`${c.tool.name}\``);
      }
      parts.push("");
    }

    parts.push(
      "流程：",
      "1. 判断新工具是否与消歧表条目语义重叠",
      "2. 有重叠→问用户，确认后 write 补一行（'意图'→'某工具'）",
      "   不写工具描述已有的内容，只写消歧所需的边界",
      "3. 无重叠→无需操作",
    );

    pi.sendMessage({
      customType: "omo-disambiguation-methodology",
      content: parts.join("\n"),
      display: false,
      details: { changes: changes.map((c) => ({ type: c.type, name: c.tool.name })) },
    });
  }

  // ── Helper: enumerate tools in Pi format ──────────────────────────────
  function enumeratePiTools(): ToolInfo[] {
    try {
      const tools = pi.getAllTools();
      return tools.map((t: any) => ({
        name: t.name ?? "",
        description: (t.description ?? "").slice(0, 200),
        source: detectToolSource(t.sourceInfo),
      }));
    } catch {
      return [];
    }
  }

  function detectToolSource(sourceInfo: any): ToolInfo["source"] {
    if (!sourceInfo) return "unknown";
    const s = String(sourceInfo.source ?? "");
    if (s === "builtin") return "builtin";
    if (s === "sdk") return "sdk";
    if (s === "mcp") return "mcp";
    return "extension";
  }

  // ── Helper: run tool detection ───────────────────────────────────────
  let pendingDisambiguationReview = false;

  function detectToolChanges(pi: ExtensionAPI, ctx: ExtensionContext): void {
    const current = enumeratePiTools();
    if (current.length === 0) return;

    const baselineExists = fs.existsSync(BASELINE_PATH);
    let baseline: ToolInfo[] = [];
    try {
      if (baselineExists) {
        const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
        baseline = raw.tools ?? [];
      }
    } catch {
      // corrupt baseline, will rebuild below
    }

    // First run: create baseline silently
    if (!baselineExists) {
      const newBaseline = createBaseline(current);
      try {
        fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2), "utf-8");
      } catch {}
      return;
    }

    const changes = compareToBaseline(current, baseline);
    if (changes.length === 0) return;

    // Save updated baseline
    const newBaseline = createBaseline(current);
    try {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2), "utf-8");
    } catch {}

    // Inject methodology so LLM can handle the change
    injectChangeMethodology(pi, ctx, changes);

    // Activate Mapping Gate: first tool call will be blocked until LLM asks user
    pendingDisambiguationReview = true;
    gateState.disambiguationHandled = false; // reset for new session with new changes
  }

  // ── Generate agent files on first load ──────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    ensureAgentFiles(config);

    // Always inject the disambiguation table
    injectDisambiguation(pi, ctx);

    // Detect changes: extra methodology injected only when tools changed
    detectToolChanges(pi, ctx);
  });

  // ── Lifecycle-based gate state ─────────────────────────────────────
  // Gates track declarations per agent cycle (before_agent_start → agent_end).
  // Each gate only blocks once per cycle — after declared, subsequent
  // tools in the same cycle pass without re-declaration.
  let gateState: { cycle: number; intent: boolean; ready: boolean; approved: boolean; disambiguationHandled: boolean } = {
    cycle: 0, intent: false, ready: false, approved: false, disambiguationHandled: false,
  };

  // ── Inject orchestrator system prompt ───────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Reset gate state for new agent cycle
    gateState = { cycle: gateState.cycle + 1, intent: false, ready: false, approved: false, disambiguationHandled: gateState.disambiguationHandled };
    const capabilities = refreshDelegationCapabilities(event.systemPrompt);
    const disabledAgents = config?.disabled_agents ?? [];
    const omniPrompt = buildPiOrchestratorPrompt(
      disabledAgents,
      config,
      capabilities,
    );

    // Dynamic tool preference hint based on current user intent
    const userIntent = classifyIntent(event.prompt ?? "");
    const hint = toolPreferenceHint(userIntent);
    const hintSection = hint ? `\n\n## 当前工具引导\n${hint}` : "";

    return {
      systemPrompt: `${omniPrompt}${hintSection}\n\n---\n\n${event.systemPrompt}`,
    };
  });

  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.delegate);
  pi.registerTool(tools.council);
  pi.registerTool(tools.astGrepSearch);
  pi.registerTool(tools.astGrepReplace);

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

      // Readiness + Approval Gates: block once per cycle for edit/write.
      if (event.toolName === "edit" || event.toolName === "write") {
        if (!hasReady && !gateState.ready) {
          return { block: true, reason: READINESS_GATE_BLOCK_MESSAGE };
        }
        if (hasReady) gateState.ready = true;

        if (!hasApproved && !gateState.approved) {
          return { block: true, reason: APPROVAL_GATE_BLOCK_MESSAGE };
        }
        if (hasApproved) gateState.approved = true;

        // Mapping Gate: fire once per session when tool changes are pending
        if (pendingDisambiguationReview && !gateState.disambiguationHandled) {
          gateState.disambiguationHandled = true;
          return { block: true, reason: DISAMBIGUATION_GATE_BLOCK_MESSAGE };
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
YOU MUST write these declarations in YOUR assistant reply before calling any tool:
1. Intent: <classification> → <routing>
2. ORCHESTRATION: self | delegate to <agent> (if using agent/workflow/subagent/omo_delegate)
3. READY: <context> + APPROVED: <plan> (if using edit/write)

Example: "Intent: investigation → explore the repo"` }],
    };
    const hasReminder = event.messages.some(
      (m: any) => m.role === "system" && m.content?.some?.((p: any) => p.text?.startsWith("[Gate Rules]")),
    );
    if (!hasReminder) {
      return { messages: [...event.messages, reminder] };
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

  // ── Log startup ─────────────────────────────────────────────────────
  const presetName = config?.preset ?? "default";
  const orchestratorModel = getPresetModelForOrchestrator(config, presetName) ?? "default";
  const startupCapabilities = refreshDelegationCapabilities();
  console.error(
    `[oh-my-opencode-slim] Pi adapter loaded. Preset: ${presetName}, Orchestrator model: ${orchestratorModel}, capabilities: pi-agents=${startupCapabilities.hasPiAgents ? "yes" : "no"}, subagent=${startupCapabilities.hasSubagent ? "yes" : "no"}, agent_message=${startupCapabilities.hasAgentMessage ? "yes" : "no"}`,
  );
}
