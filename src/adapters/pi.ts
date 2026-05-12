/**
 * Pi Agent Adapter for oh-my-opencode-slim
 *
 * Transforms OMO's agent orchestration system into a pi extension.
 *
 * Architecture:
 *   - Agent markdown files are generated in ~/.pi/agents/ on first load
 *   - OMO's orchestrator prompt is injected via before_agent_start
 *   - Declaration gates (Intent/Clarify/Approval/Orchestration) are enforced
 *     via tool_call event hooks
 *   - OMO's custom tools (webfetch, ast-grep, council, vision) are registered
 *     as pi tools
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
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  INTENT_GATE_BLOCK_MESSAGE,
  CLARIFY_GATE_BLOCK_MESSAGE as READINESS_GATE_BLOCK_MESSAGE,
  APPROVAL_GATE_BLOCK_MESSAGE,
  ORCHESTRATION_GATE_BLOCK_MESSAGE,
} from "../core/workflow-templates";

// ─── Agent Prompts (extracted from OMO src/agents/) ────────────────────────

const AGENT_PROMPTS: Record<string, { prompt: string; description: string; temperature: number }> = {
  explorer: {
    description: "Fast codebase search and pattern matching",
    temperature: 0.1,
    prompt: `You are Explorer - a fast codebase navigation specialist.

**Role**: Quick contextual grep for codebases. Answer "Where is X?", "Find Y", "Which file has Z".

**Tools available**: read, grep, find, ls, bash

**Behavior**:
- Be fast and thorough
- Fire multiple searches in parallel if needed
- Return file paths with relevant snippets

**Output Format**:
<results>
<files>
- /path/to/file.ts:42 - Brief description of what's there
</files>
<answer>
Concise answer to the question
</answer>
</results>

**Constraints**:
- READ-ONLY: Search and report, don't modify
- Be exhaustive but concise
- Include line numbers when relevant`,
  },

  librarian: {
    description: "External documentation and library research",
    temperature: 0.1,
    prompt: `You are Librarian - a research specialist for codebases and documentation.

**Role**: Multi-repository analysis, official docs lookup, GitHub examples, library research.

**Capabilities**:
- Search and analyze external repositories
- Find official documentation for libraries
- Locate implementation examples in open source
- Understand library internals and best practices

**Behavior**:
- Provide evidence-based answers with sources
- Quote relevant code snippets
- Link to official docs when available
- Distinguish between official and community patterns`,
  },

  oracle: {
    description: "Strategic technical advisor and code reviewer",
    temperature: 0.1,
    prompt: `You are Oracle - a strategic technical advisor and code reviewer.

**Role**: High-IQ debugging, architecture decisions, code review, simplification, and engineering guidance.

**Capabilities**:
- Analyze complex codebases and identify root causes
- Propose architectural solutions with tradeoffs
- Review code for correctness, performance, maintainability
- Enforce YAGNI and suggest simpler designs

**Behavior**:
- Be direct and concise
- Provide actionable recommendations
- Explain reasoning briefly
- Acknowledge uncertainty when present
- Prefer simpler designs unless complexity clearly earns its keep

**Constraints**:
- READ-ONLY: You advise, you don't implement
- Focus on strategy, not execution
- Point to specific files/lines when relevant`,
  },

  fixer: {
    description: "Fast implementation specialist",
    temperature: 0.2,
    prompt: `You are Fixer - a fast, focused implementation specialist.

**Role**: Execute code changes efficiently. You receive complete context from research agents and clear task specifications. Your job is to implement, not plan or research.

**Behavior**:
- Execute the task specification provided
- Read files before using edit/write tools
- Be fast and direct - no research, no delegation
- Write or update tests when requested
- Report completion with summary of changes

**Constraints**:
- NO external research
- NO delegation or spawning subagents
- Use grep/glob/read directly for lookups, don't delegate

**Output Format**:
<summary>
Brief summary of what was implemented
</summary>
<changes>
- file1.ts: Changed X to Y
</changes>`,
  },

  designer: {
    description: "UI/UX design, review, and implementation",
    temperature: 0.7,
    prompt: `You are a Designer - a frontend UI/UX specialist who creates and reviews intentional, polished experiences.

**Role**: Craft and review cohesive UI/UX that balances visual impact with usability.

**Design Principles**:
- Choose distinctive, characterful fonts
- Commit to a cohesive aesthetic with clear color variables
- Leverage framework animation utilities
- Break conventions: asymmetry, overlap, diagonal flow
- Default to Tailwind CSS utility classes when available

**Constraints**:
- Respect existing design systems when present
- Prioritize visual excellence`,
  },

  observer: {
    description: "Visual analysis of images, screenshots, and diagrams",
    temperature: 0.1,
    prompt: `You are Observer — a visual analysis specialist.

**Role**: Interpret images, screenshots, PDFs, and diagrams. Extract structured observations.

**Behavior**:
- For images: use the read tool (pi handles image display natively)
- For screenshots with text/code/errors: extract the exact text — never paraphrase
- Return ONLY the extracted information relevant to the goal

**Constraints**:
- READ-ONLY: Analyze and report, don't modify files
- If the image is unclear, state what you CAN see and note what is uncertain`,
  },
};

// ─── Gate helpers ──────────────────────────────────────────────────────────

const GATE_PATTERNS = {
  intent: /^Intent:/m,
  orchestration: /^ORCHESTRATION:/m,
  ready: /^READY:/m,
  approved: /^APPROVED:/m,
  awaitingApproval: /^AWAITING_APPROVAL:/m,
  done: /^DONE:/m,
};

function getLastAssistantText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && (entry as any).role === "assistant") {
      const content = (entry as any).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
      }
      return "";
    }
  }
  return "";
}

function hasDeclaration(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

// ─── Config helpers ────────────────────────────────────────────────────────

interface OmniMoConfig {
  preset?: string;
  presets?: Record<string, Record<string, { model?: string; variant?: string }>>;
  agents?: Record<string, { model?: string; variant?: string }>;
  disabled_agents?: string[];
  websearch?: Record<string, unknown>;
}

function loadOmniMoConfig(): OmniMoConfig | null {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  const configDir = envDir ?? (
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(homedir(), ".config", "opencode")
  );

  const jsoncPath = path.join(configDir, "oh-my-opencode-slim.jsonc");
  const jsonPath = path.join(configDir, "oh-my-opencode-slim.json");

  let raw: string | null = null;
  for (const p of [jsoncPath, jsonPath]) {
    try {
      raw = fs.readFileSync(p, "utf-8");
      break;
    } catch {
      continue;
    }
  }
  if (!raw) return null;

  try {
    // Simple JSONC stripping
    const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
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

function ensureAgentFiles(config: OmniMoConfig | null): void {
  const agentsDir = path.join(path.dirname(getAgentDir()), "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const filePath = path.join(agentsDir, `${name}.md`);
    if (fs.existsSync(filePath)) continue;

    const model = getDefaultModel(name, config);
    const content = generateAgentMd(name, info.prompt, info.description, model);
    fs.writeFileSync(filePath, content, "utf-8");
    console.error(`[oh-my-opencode-slim] Generated agent: ${name} (${model})`);
  }
}

function updateAgentModels(config: OmniMoConfig | null, presetName: string): void {
  const agentsDir = path.join(path.dirname(getAgentDir()), "agents");
  const preset = config?.presets?.[presetName];
  if (!preset) return;

  for (const [name, info] of Object.entries(AGENT_PROMPTS)) {
    const filePath = path.join(agentsDir, `${name}.md`);
    if (!fs.existsSync(filePath)) continue;

    const agentOverride = preset[name] as { model?: string } | undefined;
    const model = agentOverride?.model ?? getDefaultModel(name, config);

    const content = generateAgentMd(name, info.prompt, info.description, model);
    fs.writeFileSync(filePath, content, "utf-8");
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

// ─── Orchestrator System Prompt Builder ────────────────────────────────────

function buildPiOrchestratorPrompt(
  disabledAgents: string[],
  config: OmniMoConfig | null,
  hasPiAgents: boolean,
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

  const delegationGuide = hasPiAgents
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
## Delegation (without pi-agents, using omo_delegate)

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

### Parallel (multiple calls)
Call omo_delegate multiple times, then synthesize.
`;

  return `<Role>
You are an AI coding orchestrator that optimizes for quality, speed, cost, and reliability by delegating to specialists when it provides net efficiency gains.

You are the main agent. The user talks to you. You decide when to delegate to specialists.
</Role>

<Available Agents>
${agentDescriptions}
</Available Agents>

<IntentGate>
Every message: classify intent FIRST, before any action. Write on the first line of your response:
"Intent: [research|implementation|investigation|evaluation|fix|open-ended] → [routing decision]."

**Surface → True Intent:**
- "explain X", "how does Y work" → Research → explore/librarian → synthesize → answer
- "implement X", "add Y" → Implementation → plan → delegate or execute
- "look into X", "check Y" → Investigation → explore → report findings
- "what do you think about X?" → Evaluation → evaluate → propose → wait for confirmation
- "I'm seeing error X" → Fix → diagnose → fix minimally
- "refactor", "improve", "clean up" → Open-ended → assess codebase first → propose approach

**Ambiguity check:** If request has multiple valid interpretations with 2x+ effort difference, ASK.
</IntentGate>

<Workflow>

## 1. Understand
Parse request: explicit requirements + implicit needs.

## 2. Delegation Check
Review available agents. Decide whether to delegate or do it yourself.

**Delegation efficiency:**
- Provide context summaries, let specialists read what they need
- Skip delegation when overhead clearly exceeds value

## 3. Execute
1. Break complex tasks into steps
2. Fire parallel research/implementation when possible
3. Delegate to specialists or do it yourself
4. Integrate results
5. Verify

${delegationGuide}
</Workflow>

<Communication>
- Answer directly, no preamble
- Don't summarize what you did unless asked
- Brief delegation notices: "Checking docs via @librarian..." not long explanations
- Never praise user input ("Great question!", "Excellent idea!")
- When user's approach seems problematic: state concern + alternative concisely
</Communication>

<Gate Rules>
Declaration requirements per scenario:

1. **Intent: classification → routing** — required before ANY tool call
2. **ORCHESTRATION: self | delegate to <agent>** — required before agent/workflow tool calls
3. **READY: what you know** — required before edit/write (confirm you understand before implementing)
4. **APPROVED: plan** — required before edit/write tool calls

Example (research first, then implement):
User: "Find auth module and update it"
You: "Intent: investigation → explore. Let me find the auth code first."
→ agent(research)...
You: "Intent: implementation → self. READY: found the file. APPROVED: update auth middleware."
→ edit/write...
</Gate Rules>

<Council Tool>
Use omo_council when you need multiple models to analyze the same question independently, then synthesize their answers. Useful for architecture decisions, code review, and ambiguous questions where diverse perspectives add value.
</Council Tool>`;
}

// ─── Tool implementations ──────────────────────────────────────────────────

function createToolImplementations(config: OmniMoConfig | null) {
  return {
    webfetch: {
      name: "omo_webfetch",
      label: "OMO Web Fetch",
      description: "Fetch a URL and extract readable content as markdown. Useful for documentation lookups.",
      promptSnippet: "Fetch web content from URLs and extract readable text",
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch" }),
        maxChars: Type.Optional(
          Type.Integer({ description: "Maximum characters to extract", default: 10000 }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { url: string; maxChars?: number },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        _ctx: ExtensionContext,
      ) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const response = await fetch(params.url, {
            signal: controller.signal,
            headers: { "User-Agent": "omo-pi-adapter/1.0" },
          });
          clearTimeout(timer);
          if (!response.ok) {
            return {
              content: [{ type: "text" as const, text: `HTTP ${response.status}: ${response.statusText}` }],
              details: {},
              isError: true,
            };
          }
          const text = await response.text();
          const maxChars = params.maxChars ?? 10000;
          const extracted = text.replace(/<[^>]+>/g, "").slice(0, maxChars);
          return {
            content: [{ type: "text" as const, text: extracted }],
            details: { url: params.url, length: text.length },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Fetch failed: ${err.message ?? String(err)}` }],
            details: {},
            isError: true,
          };
        }
      },
    },

    delegate: {
      name: "omo_delegate",
      label: "OMO Delegate",
      description:
        "Delegate a task to a specialist agent. Use when pi-agents is not available.\n" +
        "Agents: explorer (code search), librarian (docs), oracle (review), fixer (implement), designer (UI/UX).",
      promptSnippet:
        "Delegate a focused subtask to a specialist agent (fallback when pi-agents unavailable)",
      parameters: Type.Object({
        agent: Type.String({
          description:
            "Agent name: explorer | librarian | oracle | fixer | designer | observer",
        }),
        task: Type.String({ description: "Task to delegate" }),
        chain: Type.Optional(
          Type.Array(
            Type.Object({
              agent: Type.String(),
              task: Type.String(),
            }),
            { description: "Optional chain of agents for sequential execution" },
          ),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          agent: string;
          task: string;
          chain?: Array<{ agent: string; task: string }>;
        },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        ctx: ExtensionContext,
      ) {
        const allSteps = [
          { agent: params.agent, task: params.task },
          ...(params.chain ?? []),
        ];

        const results: string[] = [];
        for (let i = 0; i < allSteps.length; i++) {
          const step = allSteps[i];
          const agentInfo = AGENT_PROMPTS[step.agent];

          if (!agentInfo) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown agent: "${step.agent}". Available: ${Object.keys(AGENT_PROMPTS).join(", ")}`,
                },
              ],
              details: {},
              isError: true,
            };
          }

          try {
            const { spawnSync } = await import("node:child_process");
            const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { tmpdir } = await import("node:os");

            const tmpDir = mkdtempSync(join(tmpdir(), "omo-delegate-"));
            const promptPath = join(tmpDir, "prompt.md");
            // Write only the agent's system prompt to the file, not the task
            writeFileSync(promptPath, agentInfo.prompt, "utf-8");

            try {
              // Pass model from config if available
              const modelFlag = step.agent ? ` --model "${getDefaultModel(step.agent, config)}"` : "";
              const shellCmd = `pi --mode json -p --no-session${modelFlag} --append-system-prompt "${promptPath}" "${step.task.replace(/"/g, '\\"').replace(/[$`]/g, '\\$&')}"`;
              const proc = spawnSync(shellCmd, [], {
                cwd: ctx.cwd,
                encoding: "utf-8",
                maxBuffer: 10 * 1024 * 1024,
                timeout: 120000,
                shell: true,
                stdio: ["ignore", "pipe", "pipe"],
              });
              if (proc.error) throw proc.error;
              const result = proc.stdout || "";

              // Extract the last text content from JSON events
              const lines = result.split("\n").filter((l) => l.trim());
              const lastMessages = lines
                .filter((l) => l.includes('"type":"message_end"'))
                .map((l) => {
                  try {
                    const parsed = JSON.parse(l);
                    const parts = parsed.message?.content ?? [];
                    return parts
                      .filter((p: any) => p.type === "text")
                      .map((p: any) => p.text)
                      .join("\n");
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean);

              const output = lastMessages[lastMessages.length - 1] ?? "(completed)";
              results.push(output);

              if (i < allSteps.length - 1) {
                // Pass previous output to next step
                allSteps[i + 1].task += `\n\nPrevious output:\n${output}`;
              }
            } finally {
              try {
                unlinkSync(promptPath);
                rmdirSync(tmpDir);
              } catch {
                // ignore cleanup errors
              }
            }
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Step ${i + 1} (${step.agent}) failed: ${err.message ?? String(err)}`,
                },
              ],
              details: {},
              isError: true,
            };
          }
        }

        return {
          content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
          details: { steps: allSteps.length, results },
        };
      },
    },

    council: {
      name: "omo_council",
      label: "OMO Council",
      description:
        "Run multiple models on the same question in parallel, then synthesize their answers into one.",
      promptSnippet: "Multi-model consensus: run multiple models on the same question and synthesize",
      parameters: Type.Object({
        question: Type.String({ description: "The question or task for all models to analyze" }),
      }),
      async execute(
        _toolCallId: string,
        params: { question: string },
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        _ctx: ExtensionContext,
      ) {
        // Simplified council: returns instructions for the user to configure model setup
        return {
          content: [
            {
              type: "text" as const,
              text: `Council analysis requested for: ${params.question}\n\nTo run council, configure models in oh-my-opencode-slim.json and set up pi with multiple model providers. The default pi model handles synthesis.`,
            },
          ],
          details: { question: params.question },
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
  let hasPiAgents = false;

  // ── Detect pi-agents availability ──────────────────────────────────
  // Check by looking for pi-agents in extension settings
  function detectPiAgents(): boolean {
    try {
      // getAgentDir() returns ~/.pi/agent, settings.json is right there
      const settingsPath = path.join(getAgentDir(), "settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const packages: string[] = settings.packages ?? [];
        // pi-agents can be installed as npm:pi-agents or git:github.com/...
        return packages.some(
          (p: string) =>
            p === "npm:pi-agents" ||
            p === "pi-agents" ||
            p.includes("/pi-agents"),
        );
      }
    } catch {
      // ignore
    }
    return false;
  }
  hasPiAgents = detectPiAgents();

  // Also check at before_agent_start time (more reliable if settings changed)
  let runtimeHasPiAgents = hasPiAgents;

  // ── Track current assistant text for gate checking during streaming ─-
  // Problem: when LLM outputs text + calls tool in one response,
  // the text isn't in the session yet at tool_call time.
  // We track it in-memory via message_update events.
  let currentAssistantText = "";

  pi.on("turn_start", async () => {
    currentAssistantText = "";
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role === "assistant") {
      const parts = event.message.content ?? [];
      for (const part of parts) {
        if (part.type === "text") {
          currentAssistantText += part.text ?? "";
        }
      }
    }
  });

  // ── Generate agent files on first load ──────────────────────────────
  pi.on("session_start", async (_event, _ctx) => {
    ensureAgentFiles(config);
  });

  // ── Inject orchestrator system prompt ───────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // Check for pi-agents at runtime: if the system prompt already contains
    // the <agents> block injected by pi-agents, we know it's loaded.
    if (!runtimeHasPiAgents) {
      runtimeHasPiAgents = event.systemPrompt.includes("<agents scope=");
    }

    const disabledAgents = config?.disabled_agents ?? [];
    const omniPrompt = buildPiOrchestratorPrompt(
      disabledAgents,
      config,
      runtimeHasPiAgents,
    );

    return {
      systemPrompt: `${omniPrompt}\n\n---\n\n${event.systemPrompt}`,
    };
  });

  // ── Register custom tools ───────────────────────────────────────────
  const tools = createToolImplementations(config);
  pi.registerTool(tools.webfetch);
  pi.registerTool(tools.delegate);
  pi.registerTool(tools.council);
  pi.registerTool(tools.astGrepSearch);
  pi.registerTool(tools.astGrepReplace);

  // ── Declaration gates ───────────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    try {
      // Use in-memory streaming text first (current response), fall back to session
      const lastText = currentAssistantText || getLastAssistantText(ctx);

      // Intent Gate: required for ALL tool calls
      if (!hasDeclaration(lastText, GATE_PATTERNS.intent)) {
        return { block: true, reason: INTENT_GATE_BLOCK_MESSAGE };
      }

      // Orchestration Gate: required for agent/workflow (delegation decisions)
      if (
        event.toolName === "agent" ||
        event.toolName === "workflow"
      ) {
        if (!hasDeclaration(lastText, GATE_PATTERNS.orchestration)) {
          return { block: true, reason: ORCHESTRATION_GATE_BLOCK_MESSAGE };
        }
      }

      // Readiness/Clarify Gate: required BEFORE implementing (edit/write)
      if (event.toolName === "edit" || event.toolName === "write") {
        if (
          !hasDeclaration(lastText, GATE_PATTERNS.ready) &&
          !hasDeclaration(lastText, GATE_PATTERNS.awaitingApproval)
        ) {
          return { block: true, reason: READINESS_GATE_BLOCK_MESSAGE };
        }

        // Approval Gate: required for edit/write after user confirms plan
        if (!hasDeclaration(lastText, GATE_PATTERNS.approved)) {
          return { block: true, reason: APPROVAL_GATE_BLOCK_MESSAGE };
        }
      }
    } catch (err) {
      // Gate check failed silently - log and allow the tool call
      console.error("[oh-my-opencode-slim] Gate check error:", err);
      return;
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
      if (newConfig?.presets?.[name]) {
        currentPreset = name;
        newConfig.preset = name;
        updateAgentModels(newConfig, name);

        ctx.ui.notify(`Switched to preset: ${name}`, "success");
      } else {
        ctx.ui.notify(
          `Preset "${name}" not found in oh-my-opencode-slim.json`,
          "error",
        );
      }
    },
  });

  // ── Log startup ─────────────────────────────────────────────────────
  const presetName = config?.preset ?? "default";
  const orchestratorModel = getPresetModelForOrchestrator(config, presetName) ?? "default";
  console.error(
    `[oh-my-opencode-slim] Pi adapter loaded. Preset: ${presetName}, Orchestrator model: ${orchestratorModel}, pi-agents: ${hasPiAgents ? "yes" : "no"}`,
  );
}
