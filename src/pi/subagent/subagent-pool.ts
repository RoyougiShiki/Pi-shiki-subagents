/**
 * omo-subagent — Lightweight subagent delegation using pi SDK.
 *
 * Two modes:
 *   - Single: one-shot via `createAgentSession()` + `session.prompt()`
 *   - Pool: persistent agents via `Map<string, AgentSession>`
 *
 * Uses pi SDK directly — no child process, no JSONL parsing, no RPC protocol.
 * Tools are managed by the extension's mode system from JSON config (same as old RPC).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "../../adapters/agent-discovery";
import { checkDelegationAllowed, parseAllowedSubagentsEnv } from "../../adapters/delegation-rules";
import { loadActiveMode } from "../core/pi-modes";
import { getToolScope } from "../policy/tool-scope-manager";
import { consumePipelineDelegationGrant } from "../policy/pipeline-delegation-grants";


// ── Simple mutex for serializing spawn / runIsolatedTask calls ────────
// These functions read/write process.env.OMO_* which is a global. Concurrent
// calls would race on these values. The mutex serializes them.
let spawnMutex: Promise<void> = Promise.resolve();

const MUTEX_TIMEOUT_MS = 30_000;

async function withSpawnMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const prev = spawnMutex;
  spawnMutex = spawnMutex.then(() => wait);
  try {
    await Promise.race([
      prev,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Spawn mutex timeout")), MUTEX_TIMEOUT_MS),
      ),
    ]);
    return await fn();
  } finally {
    release!();
  }
}

export function resolveDelegationCaller(): string | undefined {
  const envCaller = process.env.OMO_AGENT_NAME?.trim();
  if (envCaller) return envCaller;

  const snapshot = getToolScope();
  if (snapshot?.sourceName?.trim()) return snapshot.sourceName.trim();

  return loadActiveMode()?.trim() || undefined;
}

// ── Agent env helpers (unified save/restore to keep 3 env lists in sync) ──

interface AgentEnv {
  OMO_SUB_AGENT: string | undefined;
  OMO_AGENT_NAME: string | undefined;
  OMO_PARENT_AGENT_NAME: string | undefined;
  OMO_SUBAGENT_DEPTH: string | undefined;
  OMO_STAGE_RESULT_PATH: string | undefined;
  OMO_ALLOWED_SUBAGENTS: string | undefined;
  OMO_AGENT_ID: string | undefined;
}

function saveAgentEnv(): AgentEnv {
  return {
    OMO_SUB_AGENT: process.env.OMO_SUB_AGENT,
    OMO_AGENT_NAME: process.env.OMO_AGENT_NAME,
    OMO_PARENT_AGENT_NAME: process.env.OMO_PARENT_AGENT_NAME,
    OMO_SUBAGENT_DEPTH: process.env.OMO_SUBAGENT_DEPTH,
    OMO_STAGE_RESULT_PATH: process.env.OMO_STAGE_RESULT_PATH,
    OMO_ALLOWED_SUBAGENTS: process.env.OMO_ALLOWED_SUBAGENTS,
    OMO_AGENT_ID: process.env.OMO_AGENT_ID,
  };
}

function restoreAgentEnv(saved: AgentEnv): void {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "oh-my-opencode-slim.json");
const DEFAULTS_PATH = path.join(__dirname, "..", "adapters", "agents-default.json");
const REGISTRY_FILENAME = "pool-registry.json";
const SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

interface PoolAgentRecord {
  id: string;
  name: string;
  agentName: string;
  task: string;
  model?: string;
  cwd?: string;
  parentAgent?: string;
  depth?: number;
  allowedSubagents?: readonly string[];
  stageResultPath?: string;
  sessionFile?: string;
  spawnedAt: number;
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
  name: string;
  agentName: string;
  status: "starting" | "idle" | "streaming" | "dead";
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse?: string;
}

// ─── One-shot runner ──────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text);
  return parts.join("\n").trim();
}

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

  return withSpawnMutex(async () => {
    // Set env vars for the sub-agent session setup
    const prevEnv = saveAgentEnv();
    process.env.OMO_SUB_AGENT = "1";
    process.env.OMO_AGENT_NAME = opts.agent.name;
    if (opts.parentAgent) process.env.OMO_PARENT_AGENT_NAME = opts.parentAgent;
    process.env.OMO_SUBAGENT_DEPTH = String(opts.depth ?? 1);
    if (opts.allowedSubagents) process.env.OMO_ALLOWED_SUBAGENTS = opts.allowedSubagents.join(",");

    let session: AgentSession | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const created = await createAgentSession({
        cwd: opts.cwd,
        sessionManager: SessionManager.inMemory(),
      });
      session = created.session;

      let response = "";
      let model = "";
      let input = 0, output = 0, cost = 0, turns = 0;
      const collectedMessages: any[] = [];

      session.subscribe((event: any) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = extractText(event.message.content);
          if (text) response = text;
          collectedMessages.push(event.message);
          const u = event.message.usage;
          if (u) {
            input = u.input || 0;
            output = u.output || 0;
            cost = u.cost?.total ?? u.cost ?? 0;
            turns = 1;
          }
          const m = event.message.model || event.message.api;
          if (m) model = m;
        }
        if (event.type === "session" && event.model) model = event.model;
        opts.onMessage?.(event);
      });

      const taskText = opts.agent.systemPrompt
        ? `${opts.agent.systemPrompt}\n\n## Task\n${opts.task}`
        : opts.task;
      const promptPromise = session.prompt(taskText);
      const abortPromise = opts.signal
        ? new Promise<never>((_, reject) => {
            if (opts.signal!.aborted) reject(new Error("Aborted"));
            opts.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
          })
        : null;
      const timeoutPromise = opts.timeoutMs
        ? new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Sub-agent task timed out")), opts.timeoutMs);
          })
        : null;

      const racing = [promptPromise];
      if (abortPromise) racing.push(abortPromise);
      if (timeoutPromise) racing.push(timeoutPromise);
      await Promise.race(racing);

      return {
        agent: opts.agent.name,
        task: opts.task,
        exitCode: 0,
        response: response || "(no output)",
        messages: collectedMessages,
        usage: { input, output, cost, turns },
        model: model || undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        agent: opts.agent.name,
        task: opts.task,
        exitCode: 1,
        response: `Sub-agent failed: ${err.message}`,
        messages: [],
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        errorMessage: err.message,
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (session) {
        try { await session.abort(); } catch {}
        session.dispose();
      }
      restoreAgentEnv(prevEnv);
    }
  });
}

// ─── Pool manager (SDK-based) ─────────────────────────────────────────────

interface PoolEntry {
  id: string;
  name: string;
  agentName: string;
  session: AgentSession;
  status: "starting" | "idle" | "streaming" | "dead";
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse: string;
  busy: boolean;
}

/** Read the active preset's model string for a given agent from the config file. */
function getPresetModelForAgent(agentName: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const presetName = raw.preset || "省钱模式";
    return raw.presets?.[presetName]?.[agentName]?.model;
  } catch {}
  return undefined;
}

export interface AgentPoolOptions {
  timeoutMs?: number;
  sessionDir?: string;
  createSession?: typeof createAgentSession;
  /** Resolve modelId string to Model object. */
  resolveModel?: (modelId: string) => any | undefined;
}

export interface PoolEvent {
  type: "error" | "completed";
  poolId: string;
  agentName: string;
  error?: string;
  response?: string;
}

export class AgentPool {
  private agents = new Map<string, PoolEntry>();
  private readonly timeoutMs: number;
  private readonly sessionDir: string;
  private readonly createSession: typeof createAgentSession;
  private readonly resolveModel: ((modelId: string) => any | undefined) | undefined;
  private eventListeners: Array<(event: PoolEvent) => void> = [];

  constructor(options: AgentPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.sessionDir = options.sessionDir ?? SESSION_DIR;
    this.createSession = options.createSession ?? createAgentSession;
    this.resolveModel = options.resolveModel;
  }

  onEvent(cb: (event: PoolEvent) => void): () => void {
    this.eventListeners.push(cb);
    return () => { this.eventListeners = this.eventListeners.filter(e => e !== cb); };
  }

  private emit(event: PoolEvent): void {
    for (const cb of this.eventListeners) cb(event);
  }

  async spawn(opts: {
    id: string;
    name: string;
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

    // Serialize spawn calls via mutex to prevent process.env.OMO_* races
    return withSpawnMutex(async () => {
      const prevEnv = saveAgentEnv();
      process.env.OMO_SUB_AGENT = "1";
      process.env.OMO_AGENT_NAME = opts.agent.name;
      if (opts.parentAgent) process.env.OMO_PARENT_AGENT_NAME = opts.parentAgent;
      process.env.OMO_SUBAGENT_DEPTH = String(opts.depth ?? 1);
      if (opts.stageResultPath) process.env.OMO_STAGE_RESULT_PATH = opts.stageResultPath;
      if (opts.allowedSubagents) process.env.OMO_ALLOWED_SUBAGENTS = opts.allowedSubagents.join(",");
      process.env.OMO_AGENT_ID = opts.id;

      // Resolve model from active preset
      const presetModelStr = opts.agent ? getPresetModelForAgent(opts.agent.name) || opts.model : opts.model;
      const resolvedModel = presetModelStr && this.resolveModel ? this.resolveModel(presetModelStr) : undefined;

      let session: AgentSession | undefined;

      try {
        const created = await this.createSession({
          cwd: opts.cwd,
          sessionManager: SessionManager.inMemory(),
          model: resolvedModel,
        });
        session = created.session;

        // Apply tool filtering per agent roles from JSON config
        try {
          const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
          const agentCfg = raw.agents?.[opts.agent.name];
          const groups = raw._tool_groups ?? {};
          if (agentCfg?.roles && Object.keys(groups).length > 0) {
            const toolNames = new Set<string>();
            for (const role of agentCfg.roles) {
              const group = groups[role];
              if (group) group.forEach((t: string) => toolNames.add(t));
            }
            (session as any).setActiveToolsByName([...toolNames]);
          }
        } catch (err) {
          console.warn(`[pool] Tool filtering failed for "${opts.agent.name}":`, err);
        }

        const sessAny = session as any;
        const sessionModel = sessAny.model ? `${sessAny.model.provider}/${sessAny.model.id}` : undefined;

        const entry: PoolEntry = {
          id: opts.id,
          name: opts.name,
          agentName: opts.agent.name,
          session,
          status: "starting",
          startedAt: Date.now(),
          messageCount: 0,
          model: sessionModel || opts.model || "default",
          lastResponse: "",
          busy: false,
        };

        this.agents.set(opts.id, entry);

        const unsubscribe = session.subscribe((event: any) => {
          if (event.type === "turn_start") {
            entry.status = "streaming";
          }
          if (event.type === "agent_end") {
            entry.status = "idle";
            entry.messageCount++;
            const msgs = event.messages ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role === "assistant") {
                const text = extractText(m.content);
                if (text) { entry.lastResponse = text; break; }
              }
            }
          }
        });
        (entry as any)._unsubscribe = unsubscribe;

        this.saveToRegistry({
          id: opts.id,
          name: opts.name,
          agentName: opts.agent.name,
          task: opts.task,
          model: opts.model,
          cwd: opts.cwd,
          parentAgent: opts.parentAgent,
          depth: opts.depth,
          allowedSubagents: opts.allowedSubagents,
          stageResultPath: opts.stageResultPath,
          spawnedAt: Date.now(),
        });

        const taskText = opts.agent.systemPrompt
          ? `${opts.agent.systemPrompt}\n\n## Initial Task\n${opts.task}`
          : opts.task;

        // 异步执行，不阻塞主 agent
        this.sendPrompt(opts.id, taskText).then(result => {
          if (result.error) {
            this.emit({ type: "error", poolId: opts.id, agentName: opts.agent.name, error: result.error });
          } else {
            this.emit({ type: "completed", poolId: opts.id, agentName: opts.agent.name, response: result.response });
          }
        }).catch(err => {
          this.emit({ type: "error", poolId: opts.id, agentName: opts.agent.name, error: err.message });
        });

        return { response: `已启动，ID: ${opts.id}`, error: undefined };
      } catch (err: any) {
        if (session) {
          try { await session.abort(); } catch {}
          session.dispose();
        }
        const spawnError = `Failed to spawn sub-agent: ${err.message}`;
        this.emit({ type: "error", poolId: opts.id, agentName: opts.agent.name, error: spawnError });
        this.agents.delete(opts.id);
        return { response: "", error: spawnError };
      } finally {
        restoreAgentEnv(prevEnv);
      }
    });
  }

  async sendPrompt(id: string, message: string, type?: string): Promise<{ response: string; error?: string }> {
    const entry = this.agents.get(id);
    if (!entry) return { response: "", error: `Agent "${id}" not found in pool` };
    if (entry.status === "dead") return { response: "", error: `Agent "${id}" is dead` };
    if (entry.busy) return { response: "", error: `Agent "${id}" is busy` };

    const sess = entry.session as any;

    try {
      entry.busy = true;

      if (type === "steer" || type === "follow_up") {
        try {
          if (type === "steer") await sess.steer(message);
          else await sess.followUp(message);
          return { response: entry.lastResponse };
        } finally {
          entry.busy = false;
        }
      }

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sess.prompt(message),
          new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              reject(new Error(`Agent "${id}" timed out`));
            }, this.timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
      }

      const messages = (sess.messages ?? []) as any[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          const text = extractText(m.content);
          if (text) {
            entry.lastResponse = text;
            return { response: text };
          }
        }
      }
      return { response: entry.lastResponse };
    } catch (err: any) {
      const errorMsg = err.message ?? String(err);
      this.emit({ type: "error", poolId: id, agentName: entry.agentName, error: errorMsg });
      return { response: entry.lastResponse, error: errorMsg };
    } finally {
      entry.busy = false;
    }
  }

  list(): PoolAgentInfo[] {
    const result: PoolAgentInfo[] = [];
    for (const [id, entry] of this.agents) {
      result.push({
        id, name: entry.name, agentName: entry.agentName,
        status: entry.status, startedAt: entry.startedAt,
        messageCount: entry.messageCount, model: entry.model,
        lastResponse: entry.lastResponse.slice(0, 200),
      });
    }
    return result;
  }

  getSession(id: string): AgentSession | undefined {
    return this.agents.get(id)?.session;
  }

  /** Set or update the model resolver for preset support. */
  setModelResolver(resolver: (modelId: string) => any | undefined): void {
    (this as any).resolveModel = resolver;
  }

  async kill(id: string): Promise<boolean> {
    const entry = this.agents.get(id);
    if (!entry) return false;
    const unsub = (entry as any)._unsubscribe;
    if (typeof unsub === "function") unsub();
    if (entry.session) {
      try { await entry.session.abort(); } catch {}
      entry.session.dispose();
    }
    this.agents.delete(id);
    return true;
  }

  async killAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private get registryPath(): string {
    return path.join(this.sessionDir, REGISTRY_FILENAME);
  }

  private saveToRegistry(record: PoolAgentRecord): void {
    try {
      const existing = this.loadRegistry();
      existing.set(record.id, record);
      const dir = path.dirname(this.registryPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.registryPath, JSON.stringify([...existing.values()], null, 2), "utf-8");
    } catch {}
  }

  loadRegistry(): Map<string, PoolAgentRecord> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
      if (Array.isArray(raw)) {
        return new Map(raw.map((r: PoolAgentRecord) => [r.id, r]));
      }
    } catch {}
    return new Map();
  }

  listRegistryEntries(): PoolAgentRecord[] {
    return [...this.loadRegistry().values()];
  }
}

// Singleton
let activePool: AgentPool | null = null;

export function getPool(): AgentPool {
  if (!activePool) activePool = new AgentPool();
  return activePool;
}

/** Configure singleton pool with model resolver for preset support. */
export function initPoolModelResolver(resolver: (modelId: string) => any | undefined): void {
  getPool().setModelResolver(resolver);
}

export async function resetPool(): Promise<void> {
  if (activePool) {
    await activePool.killAll();
    activePool = null;
  }
}

// ─── Tool registration ────────────────────────────────────────────────────

export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "omo_subagent",
    label: "OMO Subagent",
    description: [
      "通过 pool 模式委托子代理。用法：",
      "  spawn: { pool: \"spawn\", id, agent, task }",
      "  send: { pool: \"send\", id, message }",
      "  list: { pool: \"list\" }",
      "  listSaved: { pool: \"listSaved\" } — 查看可恢复会话",
      "  resume: { pool: \"resume\", id } — 恢复任务上下文",
      "  kill: { pool: \"kill\", id }",
      "",
      "协议（实现无关）：",
      "  - spawn 提交任务后即进入异步执行；默认下一步是等待完成通知。",
      "  - send 仅用于向已存在会话追加指令，不是 spawn 后默认动作。",
      "  - 会话处于运行态时不要重复提交同类请求；收到 busy/reject 先降级或询问用户。",
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

      const callerAgent = resolveDelegationCaller();
      const callerDepth = Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? "0", 10) || 0;
      const allowedSubagents = parseAllowedSubagentsEnv(process.env.OMO_ALLOWED_SUBAGENTS);

      const requireDelegationAllowed = (targetAgent: string, childAllowedSubagents?: readonly string[]): { ok: true; childAllowedSubagents?: readonly string[] } | { ok: false; response: any } => {
        const delegation = checkDelegationAllowed({
          caller: callerAgent, target: targetAgent, depth: callerDepth,
          cwd, allowedSubagents: childAllowedSubagents ?? allowedSubagents,
        });
        if (delegation.allowed) return { ok: true, childAllowedSubagents };
        const allowed = delegation.allowedAgents?.length ? delegation.allowedAgents.join(", ") : "(none)";
        return {
          ok: false,
          response: {
            content: [{ type: "text", text: `${delegation.reason}. Allowed agents: ${allowed}` }],
            details: { caller: callerAgent, target: targetAgent, depth: callerDepth, allowedAgents: delegation.allowedAgents },
            isError: true,
          },
        };
      };

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
          let pipelineGrantAllowedSubagents: readonly string[] | undefined;
          const grant = consumePipelineDelegationGrant({
            caller: callerAgent,
            target: params.agent,
            depth: callerDepth,
          });
          if (grant) {
            pipelineGrantAllowedSubagents = grant.childAllowedSubagents;
          } else {
            const delegation = requireDelegationAllowed(params.agent);
            if (!delegation.ok) return delegation.response;
          }
          const spawnResult = await pool.spawn({
            id: params.id, name: params.id, agent: agentCfg,
            task: params.task, model: params.model || agentCfg.model,
            cwd, parentAgent: callerAgent, depth: callerDepth + 1, allowedSubagents: pipelineGrantAllowedSubagents ?? allowedSubagents,
          });
          if (spawnResult.error) {
            return { content: [{ type: "text", text: `✗ Spawn failed: ${spawnResult.error}` }], details: {}, isError: true };
          }
          return {
            content: [{
              type: "text",
              text: `✓ Pool agent "${params.id}" (${params.agent}) spawned. Initial task started asynchronously; wait for completion notification.`
            }],
            details: {},
          };
        }

        if (params.pool === "send") {
          if (!params.id || !params.message) {
            return { content: [{ type: "text", text: "pool send requires id and message" }], details: {}, isError: true };
          }

          const current = pool.list().find((a: PoolAgentInfo) => a.id === params.id);
          if (current && (current.status === "starting" || current.status === "streaming")) {
            return {
              content: [{
                type: "text",
                text: `Agent "${params.id}" is running (${current.status}). Do not submit another request now; wait for completion notification.\n[guard] 下一步：等待完成后再继续，或先向用户确认是否改为降级方案。`
              }],
              details: {},
              isError: true,
            };
          }

          const result = await pool.sendPrompt(params.id, params.message);
          if (result.error) {
            return { content: [{ type: "text", text: `✗ ${result.error}` }], details: {}, isError: true };
          }
          return { content: [{ type: "text", text: `Response from ${params.id}:\n\n${result.response}` }], details: {} };
        }

        if (params.pool === "list") {
          const list = pool.list();
          if (list.length === 0) return { content: [{ type: "text", text: "Pool is empty." }], details: {} };
          const lines = list.map((a: PoolAgentInfo) =>
            `  ${a.status === "dead" ? "✗" : "●"} ${a.id} (${a.agentName}) — ${a.status}, ${a.messageCount} msgs, model: ${a.model}`
          );
          return { content: [{ type: "text", text: `Pool agents (${list.length}):\n${lines.join("\n")}` }], details: {} };
        }

        if (params.pool === "kill") {
          if (!params.id) return { content: [{ type: "text", text: "pool kill requires id" }], details: {}, isError: true };
          const ok = await pool.kill(params.id);
          return { content: [{ type: "text", text: ok ? `✓ Killed "${params.id}"` : `✗ Agent "${params.id}" not found` }], details: {} };
        }

        if (params.pool === "listSaved") {
          const entries = pool.listRegistryEntries();
          if (entries.length === 0) return { content: [{ type: "text", text: "No saved sub-agent sessions." }], details: {} };
          const lines = entries.map((r) => `  ${r.id} (${r.agentName}) — ${r.task.slice(0, 100)}`);
          return { content: [{ type: "text", text: `Saved sessions (${entries.length}):\n${lines.join("\n")}` }], details: {} };
        }

        if (params.pool === "resume") {
          if (!params.id) return { content: [{ type: "text", text: "resume requires id" }], details: {}, isError: true };
          const entries = pool.listRegistryEntries();
          const record = entries.find((r) => r.id === params.id);
          if (!record) return { content: [{ type: "text", text: `Saved session "${params.id}" not found` }], details: {}, isError: true };
          const agentCfg = agents.find((a) => a.name === record.agentName);
          if (!agentCfg) return { content: [{ type: "text", text: `Agent "${record.agentName}" not found. Cannot resume.` }], details: {}, isError: true };
          const resumeResult = await pool.spawn({
            id: record.id, name: record.name, agent: agentCfg,
            task: record.task, model: params.model || agentCfg.model,
            cwd: record.cwd || cwd, parentAgent: resolveDelegationCaller(),
            depth: (Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1,
            allowedSubagents: parseAllowedSubagentsEnv(process.env.OMO_ALLOWED_SUBAGENTS),
          });
          if (resumeResult.error) {
            return { content: [{ type: "text", text: `✗ Resume failed: ${resumeResult.error}` }], details: {}, isError: true };
          }
          return { content: [{ type: "text", text: `✓ Agent "${record.id}" (${record.agentName}) resumed with task context.` }], details: {} };
        }
      }

      if (params.agent && params.task) {
        const agentCfg = agents.find((a) => a.name === params.agent);
        if (!agentCfg) return { content: [{ type: "text", text: `Agent "${params.agent}" not found. Available: ${agents.map(a => a.name).join(", ")}` }], details: {}, isError: true };
        return {
          content: [{ type: "text", text: `Single mode is disabled. Use pool spawn: { pool: "spawn", id: "...", agent: "${params.agent}", task: "..." }` }],
          details: {}, isError: true,
        };
      }

      return { content: [{ type: "text", text: "Invalid params. Use single (agent+task) or pool action." }], details: {}, isError: true };
    },
  });
}
