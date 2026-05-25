/**
 * omo-subagent — Lightweight subagent delegation using pi's built-in modes.
 *
 * Three modes:
 *   - Single: one-shot via `pi --mode json`
 *   - Pool: persistent agents via `pi --mode rpc`
 *
 * Zero external dependencies — only pi's own packages and Node built-ins.
 *
 * Configuration (in ~/.pi/agent/settings.json under "omo_subagent"):
 *   maxConcurrent: number (default 4) — max parallel tasks at once
 *   maxTotal: number (default 20) — max pool agents
 *   timeoutMs: number (default 300000) — per-task timeout
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agent-discovery";
import { getRuntimeBlockedAgents } from "./agent-runtime-config";
import { checkDelegationAllowed, parseAllowedSubagentsEnv } from "./delegation-rules";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
const DEFAULTS_PATH = path.join(__dirname, "agents-default.json");

// Note: typebox is resolved by pi.ts from its own path, not from here.
// We define inline JSON Schema instead.

function loadToolGroups(): Record<string, string[]> {
  for (const p of [CONFIG_PATH, DEFAULTS_PATH]) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (raw._tool_groups) return raw._tool_groups;
    } catch {}
  }
  return {};
}

function resolveAgentTools(agentName: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const agent = raw.agents?.[agentName];
    if (agent?.roles?.length) {
      const groups = loadToolGroups();
      const tools = new Set<string>();
      for (const role of agent.roles) {
        const group = groups[role];
        if (group) group.forEach(t => tools.add(t));
      }
      const result = [...tools];
      if (result.length === 0) {
        console.error("[omo] resolveAgentTools empty for", agentName);
      }
      return result;
    }
  } catch (e) {
    console.error("[omo] resolveAgentTools error for", agentName, e);
  }
  return [];
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  response: string;
  messages: any[];
  usage: { input: number; output: number; cost: number; turns: number };
  model?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface PoolAgentInfo {
  id: string;
  name: string;         // 人类可读名称
  agentName: string;
  status: "starting" | "idle" | "streaming" | "dead";
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse?: string;
}

// ─── One-shot runner (pi --mode json) ─────────────────────────────────────

export function buildSubagentEnv(opts: {
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  agentName: string;
  depth?: number;
  parentAgent?: string;
  allowedSubagents?: readonly string[];
  stageResultPath?: string;
}): NodeJS.ProcessEnv {
  const activeTools = resolveAgentTools(opts.agentName);
  return {
    ...(opts.baseEnv ?? process.env),
    OMO_SUB_AGENT: "1",
    OMO_AGENT_NAME: opts.agentName,
    OMO_ACTIVE_TOOLS: activeTools.length > 0 ? activeTools.join(",") : "",
    OMO_SUBAGENT_DEPTH: String(opts.depth ?? 1),
    ...(opts.parentAgent ? { OMO_PARENT_AGENT_NAME: opts.parentAgent } : {}),
    ...(opts.allowedSubagents ? { OMO_ALLOWED_SUBAGENTS: opts.allowedSubagents.join(",") } : {}),
    ...(opts.stageResultPath ? { OMO_STAGE_RESULT_PATH: opts.stageResultPath } : {}),
  } as NodeJS.ProcessEnv;
}

function writeTempPrompt(content: string): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-"));
  const fp = path.join(dir, "prompt.md");
  fs.writeFileSync(fp, content, { encoding: "utf-8", mode: 0o600 });
  return { dir, path: fp };
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text);
  return parts.join("\n").trim();
}

/** Spawn pi --mode json for one-shot task, return when complete. */
export async function runIsolatedTask(
  opts: {
    agent: AgentConfig;
    task: string;
    cwd?: string;
    model?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onMessage?: (msg: any) => void;
    parentAgent?: string;
    depth?: number;
    allowedSubagents?: readonly string[];
  },
): Promise<SingleResult> {
  const startTime = Date.now();
  const tmp = opts.agent.systemPrompt
    ? writeTempPrompt(`${opts.agent.systemPrompt}\n\n## Task\n${opts.task}`)
    : writeTempPrompt(opts.task);

  const args = ["--mode", "json", "-p", "--no-session", "-ne"];
  if (opts.model) args.push("--model", opts.model);

  const proc = spawn("pi", [...args, tmp.path], {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    signal: opts.signal,
    env: buildSubagentEnv({
      agentName: opts.agent.name,
      depth: opts.depth,
      parentAgent: opts.parentAgent,
      allowedSubagents: opts.allowedSubagents,
    }),
  });

  let buffer = "";
  const decoder = new TextDecoder();
  const messages: any[] = [];
  let response = "";
  let model = "";
  let input = 0, output = 0, cost = 0, turns = 0;
  let errorMessage = "";

  const eventTypes = new Set<string>();

  function processLine(line: string) {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line);
      if (!ev || typeof ev !== "object") return;

      if (ev.type === "message" && ev.message?.role === "assistant") {
        messages.push(ev.message);
        const text = extractText(ev.message.content);
        if (text) response = text;
        if (ev.message.stopReason === "toolUse") return;
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const text = extractText(ev.message.content);
        if (text) response = text;
        const u = ev.message.usage;
        if (u) {
          input = u.input || 0;
          output = u.output || 0;
          cost = u.cost?.total ?? u.cost ?? 0;
          turns = 1;
        }
        const m = ev.message.model || ev.message.api;
        if (m) model = m;
      }
      if (ev.type === "session" && ev.model) model = ev.model;
      eventTypes.add(ev.type);
    } catch {}
  }

  return new Promise((resolve) => {
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        processLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });

    let stderr = "";
    proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      // Process remaining buffer
      if (buffer.trim()) processLine(buffer.trim());

      if (!response && stderr.trim()) {
        response = stderr.trim();
        errorMessage = stderr.trim();
      }

      resolve({
        agent: opts.agent.name,
        task: opts.task,
        exitCode: code ?? 1,
        response: response || "(no output)",
        messages,
        usage: { input, output, cost, turns },
        model: model || undefined,
        errorMessage: errorMessage || undefined,
        durationMs: Date.now() - startTime,
      });

      // Cleanup temp file
      try { fs.rmSync(tmp.dir, { recursive: true }); } catch {}
    });

    proc.on("error", (err) => {
      // Cleanup temp file on spawn error too
      try { fs.rmSync(tmp.dir, { recursive: true }); } catch {}
      resolve({
        agent: opts.agent.name,
        task: opts.task,
        exitCode: 1,
        response: `Failed to spawn subagent: ${err.message}`,
        messages: [],
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        errorMessage: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ─── Pool manager (pi --mode rpc persistent agents) ──────────────────────

interface PoolEntry {
  id: string;
  name: string;         // 人类可读名称
  agentName: string;
  proc: ChildProcess;
  status: "starting" | "idle" | "streaming" | "dead";
  startedAt: number;
  messageCount: number;
  model: string;
  buffer: string;
  lastResponse: string;
  pendingResolve: ((result: { response: string; error?: string }) => void) | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentPoolOptions {
  timeoutMs?: number;
  sessionDir?: string;
  spawnProcess?: typeof spawn;
}

export class AgentPool {
  private agents = new Map<string, PoolEntry>();
  private decoder = new TextDecoder();
  private readonly timeoutMs: number;
  private readonly sessionDir: string;
  private readonly spawnProcess: typeof spawn;

  constructor(options: AgentPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.sessionDir = options.sessionDir ?? path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  /** Spawn a new persistent agent via pi --mode rpc. */
  async spawn(opts: {
    id: string;
    name: string;        // 人类可读名称
    agent: AgentConfig;
    task: string;
    model?: string;
    cwd?: string;
    parentAgent?: string;
    depth?: number;
    allowedSubagents?: readonly string[];
    stageResultPath?: string;
  }): Promise<{ response: string; error?: string }> {
    if (this.agents.has(opts.id)) {
      return { response: "", error: `Agent "${opts.id}" already exists in pool` };
    }

    fs.mkdirSync(this.sessionDir, { recursive: true });
    const args = ["--mode", "rpc", "--session-dir", this.sessionDir];
    if (opts.model) args.push("--model", opts.model);

    const proc = this.spawnProcess("pi", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSubagentEnv({
        agentName: opts.agent.name,
        depth: opts.depth,
        parentAgent: opts.parentAgent,
        allowedSubagents: opts.allowedSubagents,
        stageResultPath: opts.stageResultPath,
      }),
    });

    const entry: PoolEntry = {
      id: opts.id,
      name: opts.name,
      agentName: opts.agent.name,
      proc,
      status: "starting",
      startedAt: Date.now(),
      messageCount: 0,
      model: opts.model || "default",
      buffer: "",
      lastResponse: "",
      pendingResolve: null,
      pendingTimer: null,
    };

    this.agents.set(opts.id, entry);

    proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(opts.id, chunk);
    });

    proc.on("close", () => {
      entry.status = "dead";
      if (entry.pendingTimer) {
        clearTimeout(entry.pendingTimer);
        entry.pendingTimer = null;
      }
      if (entry.pendingResolve) {
        entry.pendingResolve({ response: entry.lastResponse, error: "Process died" });
        entry.pendingResolve = null;
      }
    });

    // Send initial task
    const systemPart = opts.agent.systemPrompt
      ? `${opts.agent.systemPrompt}\n\n## Initial Task\n${opts.task}`
      : opts.task;

    return this.sendPrompt(opts.id, systemPart);
  }

  private handleData(id: string, chunk: Buffer) {
    const entry = this.agents.get(id);
    if (!entry) return;

    entry.buffer += this.decoder.decode(chunk, { stream: true });

    while (true) {
      const idx = entry.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = entry.buffer.slice(0, idx);
      entry.buffer = entry.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      try {
        const ev = JSON.parse(line);
        if (!ev || typeof ev !== "object") continue;

        if (ev.type === "response") {
          if (ev.command === "prompt" && ev.success) {
            entry.status = "streaming";
          }
          if (ev.command === "steer" && ev.success) {
            entry.status = "streaming";
          }
        }

        if (ev.type === "agent_end") {
          entry.status = "idle";
          entry.messageCount++;

          // Extract response from last assistant message
          const msgs = ev.messages ?? [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === "assistant") {
              entry.lastResponse = extractText(m.content) || entry.lastResponse;
              break;
            }
          }

          if (entry.pendingResolve) {
            if (entry.pendingTimer) {
              clearTimeout(entry.pendingTimer);
              entry.pendingTimer = null;
            }
            entry.pendingResolve({ response: entry.lastResponse });
            entry.pendingResolve = null;
          }
        }

        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const text = extractText(ev.message.content);
          if (text) entry.lastResponse = text;
        }
      } catch {}
    }
  }

  /** Send a prompt to an existing pool agent and wait for response. */
  sendPrompt(id: string, message: string, type?: string): Promise<{ response: string; error?: string }> {
    const entry = this.agents.get(id);
    if (!entry) {
      return Promise.resolve({ response: "", error: `Agent "${id}" not found in pool` });
    }
    if (entry.status === "dead") {
      return Promise.resolve({ response: "", error: `Agent "${id}" is dead` });
    }

    if (entry.pendingResolve) {
      return Promise.resolve({ response: "", error: `Agent "${id}" is busy` });
    }

    return new Promise((resolve) => {
      entry.pendingResolve = resolve;
      entry.pendingTimer = setTimeout(() => {
        if (entry.pendingResolve) {
          const resolvePending = entry.pendingResolve;
          entry.pendingResolve = null;
          entry.pendingTimer = null;
          resolvePending({ response: entry.lastResponse, error: `Agent "${id}" timed out` });
          this.kill(id);
        }
      }, this.timeoutMs);
      const msgType = type || "prompt";
      const cmd = JSON.stringify({ type: msgType, message }) + "\n";
      entry.proc.stdin!.write(cmd);
    });
  }

  /** Get info about all pool agents. */
  list(): PoolAgentInfo[] {
    const result: PoolAgentInfo[] = [];
    for (const [id, entry] of this.agents) {
      result.push({
        id,
        name: entry.name,
        agentName: entry.agentName,
        status: entry.status,
        startedAt: entry.startedAt,
        messageCount: entry.messageCount,
        model: entry.model,
        lastResponse: entry.lastResponse.slice(0, 200),
      });
    }
    return result;
  }

  /** 获取某个进程的 ChildProcess */
  getProcess(id: string): ChildProcess | undefined {
    return this.agents.get(id)?.proc;
  }

  /** Kill a pool agent. */
  kill(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry) return false;
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    if (entry.pendingResolve) {
      entry.pendingResolve({ response: entry.lastResponse, error: "Killed" });
      entry.pendingResolve = null;
    }
    try { entry.proc.kill(); } catch {}
    this.agents.delete(id);
    return true;
  }

  /** Kill all pool agents. */
  killAll(): void {
    for (const [id] of this.agents) this.kill(id);
  }
}

// Singleton pool instance (lifetime = pi session)
let activePool: AgentPool | null = null;

export function getPool(): AgentPool {
  if (!activePool) activePool = new AgentPool();
  return activePool;
}

/** 获取某个池子进程的 ChildProcess */
export function getPoolProcess(id: string): ChildProcess | undefined {
  return getPool().getProcess(id);
}

// ─── Tool registration ────────────────────────────────────────────────────

export function registerSubagentTool(pi: ExtensionAPI): void {
  // ── omo_subagent tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "omo_subagent",
    label: "OMO Subagent",
    description: [
      "╔══════════════════════════════════════════════════╗",
      "║  选择指南（选错会阻塞主 agent 或无法继续对话）      ║",
      "║  • 只需要一次结果，不需要后续对话 → Single         ║",
      "║  • 需要持续对话 / 用户可能要用 /chat 聊天 → Pool  ║",
      "╚══════════════════════════════════════════════════╝",
      "",
      "Single: { agent, task }",
      "  → 一次性查询，阻塞主 agent，不可继续对话",
      "",
      "Pool spawn: { pool: \"spawn\", id, agent, task }",
      "  → 后台创建长驻子代理（非阻塞）",
      "  → 之后可用 pool:send 继续，也可用 /chat 命令进入聊天面板",
      "",
      "Pool send: { pool: \"send\", id, message }",
      "  → 继续与已有长驻子代理对话，非阻塞",
      "",
      "Pool list: { pool: \"list\" } → 查看活跃子代理",
      "Pool kill: { pool: \"kill\", id } → 杀掉子代理",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name (for single mode)" },
        task: { type: "string", description: "Task prompt (for single mode)" },
        pool: { type: "string", description: "Pool action: spawn | send | list | kill" },
        id: { type: "string", description: "Pool agent ID (for spawn/send/kill)" },
        message: { type: "string", description: "Message for pool send action" },
        model: { type: "string", description: "Model override" },
      },
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const agents = discoverAgents(cwd);
      const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      // ── Mode-based agent restriction check ────────────────────────────
      const checkAgentAllowed = (agentName: string): string | null => {
        let currentMode = "fallback";
        try {
          const sessionModePath = path.join(os.homedir(), ".pi", "agent", ".session-modes.json");
          const sessionFile = ctx?.sessionManager?.getSessionFile?.();
          if (sessionFile && fs.existsSync(sessionModePath)) {
            const map = JSON.parse(fs.readFileSync(sessionModePath, "utf-8"));
            currentMode = map[sessionFile] || "fallback";
          }
        } catch {}

        const blocked = getRuntimeBlockedAgents(currentMode, cwd);
        if (blocked.includes(agentName)) {
          const allowed = agents.map(a => a.name).filter(a => !blocked.includes(a));
          return allowed.length > 0 ? allowed.join(", ") : "(无可用子代理)";
        }
        return null;
      };

      const callerAgent = process.env.OMO_AGENT_NAME;
      const callerDepth = Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? "0", 10) || 0;
      const allowedSubagents = parseAllowedSubagentsEnv(process.env.OMO_ALLOWED_SUBAGENTS);

      if (params.agent) {
        const blocked = checkAgentAllowed(params.agent);
        if (blocked !== null) {
          return {
            content: [{ type: "text", text: `当前模式下可用子代理：${blocked}。` }],
            details: {}, isError: true,
          };
        }
        const delegation = checkDelegationAllowed({
          caller: callerAgent,
          target: params.agent,
          depth: callerDepth,
          cwd,
          allowedSubagents,
        });
        if (!delegation.allowed) {
          const allowed = delegation.allowedAgents?.length ? delegation.allowedAgents.join(", ") : "(none)";
          return {
            content: [{ type: "text", text: `${delegation.reason}. Allowed agents: ${allowed}` }],
            details: { caller: callerAgent, target: params.agent, depth: callerDepth, allowedAgents: delegation.allowedAgents },
            isError: true,
          };
        }
      }

      // ── Pool mode ────────────────────────────────────────────────────
      if (params.pool) {
        const pool = getPool();
        if (params.pool === "spawn") {
          if (!params.id || !params.agent || !params.task) {
            return { content: [{ type: "text", text: "pool spawn requires id, agent, and task" }], details: {}, isError: true };
          }
          const agentCfg = agents.find((a) => a.name === params.agent);
          if (!agentCfg) {
            return { content: [{ type: "text", text: `Agent "${params.agent}" not found. Available: ${agents.map(a => a.name).join(", ")}` }], details: {}, isError: true };
          }
          // Fire-and-forget: spawn without awaiting
          pool.spawn({
            id: params.id,
            name: params.id,
            agent: agentCfg,
            task: params.task,
            model: params.model || agentCfg.model || defaultModel,
            cwd,
            parentAgent: callerAgent,
            depth: callerDepth + 1,
            allowedSubagents,
          }).catch((err) => {
            console.error(`[omo-subagent] Spawn ${params.id} failed:`, err);
          });
          return { content: [{ type: "text", text: `✓ Pool agent "${params.id}" (${params.agent}) spawned. Use pool:send to interact.` }], details: {} };
        }

        if (params.pool === "send") {
          if (!params.id || !params.message) {
            return { content: [{ type: "text", text: "pool send requires id and message" }], details: {}, isError: true };
          }
          const result = await pool.sendPrompt(params.id, params.message);
          if (result.error) {
            return { content: [{ type: "text", text: `✗ ${result.error}` }], details: {}, isError: true };
          }
          return { content: [{ type: "text", text: `Response from ${params.id}:\n\n${result.response}` }], details: {} };
        }

        if (params.pool === "list") {
          const list = pool.list();
          if (list.length === 0) {
            return { content: [{ type: "text", text: "Pool is empty." }], details: {} };
          }
          const lines = list.map((a: PoolAgentInfo) =>
            `  ${a.status === "dead" ? "✗" : "●"} ${a.id} (${a.agentName}) — ${a.status}, ${a.messageCount} msgs, model: ${a.model}`
          );
          return { content: [{ type: "text", text: `Pool agents (${list.length}):\n${lines.join("\n")}` }], details: {} };
        }

        if (params.pool === "kill") {
          if (!params.id) {
            return { content: [{ type: "text", text: "pool kill requires id" }], details: {}, isError: true };
          }
          const ok = pool.kill(params.id);
          return { content: [{ type: "text", text: ok ? `✓ Killed "${params.id}"` : `✗ Agent "${params.id}" not found` }], details: {} };
        }
      }

      // ── Single mode ─────────────────────────────────────────────────
      if (params.agent && params.task) {
        const agentCfg = agents.find((a) => a.name === params.agent);
        if (!agentCfg) {
          return { content: [{ type: "text", text: `Agent "${params.agent}" not found. Available: ${agents.map(a => a.name).join(", ")}` }], details: {}, isError: true };
        }
        const result = await runIsolatedTask({
          agent: agentCfg,
          task: params.task,
          model: params.model || agentCfg.model || defaultModel,
          cwd,
          parentAgent: callerAgent,
          depth: callerDepth + 1,
          allowedSubagents,
        });
        return {
          content: [{ type: "text", text: result.response }],
          details: {
            agent: params.agent,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            usage: result.usage,
            model: result.model,
          },
          isError: result.exitCode !== 0,
        };
      }

      return { content: [{ type: "text", text: "Invalid params. Use single (agent+task) or pool action." }], details: {}, isError: true };
    },
  });

  // ── /subagents command (list pool status) ─────────────────────────────
}
