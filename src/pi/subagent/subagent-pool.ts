/**
 * omo-subagent — Lightweight subagent delegation using pi SDK.
 * Persistent subagent delegation using Pi SDK sessions.
 *
 * Each pool agent owns an SDK session with its own concrete tool list.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '../../adapters/agent-discovery';
import {
  loadRuntimeAgentDefinitions,
  loadRuntimeToolGroups,
  type RuntimeAgentDefinition,
  resolveAgentToolNames,
} from '../../adapters/agent-runtime-config';
import { toSubagentRunEvents } from './subagent-run-adapter';
import type { SubagentRunEvent, SubagentRunStatus } from './subagent-run-state';
import {
  createSubagentRunState,
  updateSubagentRunState,
} from './subagent-run-state';
import {
  createSubagentRunTreeView,
  type SubagentRunTreeView,
  type SubagentRunViewOptions,
} from './subagent-run-view';
import {
  createSubagentSessionSnapshots,
  type SubagentSessionSnapshot,
} from './subagent-session-contract';

// ── Simple mutex for serializing spawn / runIsolatedTask calls ────────
// These functions read/write process.env.OMO_* which is a global. Concurrent
// calls would race on these values. The mutex serializes them.
let spawnMutex: Promise<void> = Promise.resolve();

const MUTEX_TIMEOUT_MS = 30_000;

async function withSpawnMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = spawnMutex;
  spawnMutex = spawnMutex.then(() => wait);
  try {
    await Promise.race([
      prev,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Spawn mutex timeout')),
          MUTEX_TIMEOUT_MS,
        ),
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
  return 'main';
}

// ── Agent env helpers (unified save/restore to keep 3 env lists in sync) ──

interface AgentEnv {
  OMO_SUB_AGENT: string | undefined;
  OMO_AGENT_NAME: string | undefined;
  OMO_PARENT_AGENT_NAME: string | undefined;
  OMO_SUBAGENT_DEPTH: string | undefined;
  OMO_ALLOWED_SUBAGENTS: string | undefined;
  OMO_AGENT_ID: string | undefined;
  OMO_OWNER_SESSION_ID: string | undefined;
}

function saveAgentEnv(): AgentEnv {
  return {
    OMO_SUB_AGENT: process.env.OMO_SUB_AGENT,
    OMO_AGENT_NAME: process.env.OMO_AGENT_NAME,
    OMO_PARENT_AGENT_NAME: process.env.OMO_PARENT_AGENT_NAME,
    OMO_SUBAGENT_DEPTH: process.env.OMO_SUBAGENT_DEPTH,
    OMO_ALLOWED_SUBAGENTS: process.env.OMO_ALLOWED_SUBAGENTS,
    OMO_AGENT_ID: process.env.OMO_AGENT_ID,
    OMO_OWNER_SESSION_ID: process.env.OMO_OWNER_SESSION_ID,
  };
}

function restoreAgentEnv(saved: AgentEnv): void {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

const REGISTRY_FILENAME = 'pool-registry.json';
const SESSION_DIR = path.join(
  os.homedir(),
  '.pi',
  'agent',
  'sessions',
  'subagents',
);

export function resolveSubagentToolNamesForAgent(
  agentName: string,
  cwd = process.cwd(),
  allToolNames: readonly string[] = [],
): string[] | undefined {
  const runtime = loadRuntimeAgentDefinitions(cwd)[agentName] as
    | RuntimeAgentDefinition
    | undefined;
  if (!runtime) return undefined;

  const groups = loadRuntimeToolGroups(cwd);
  return resolveAgentToolNames(runtime, groups, allToolNames);
}

export interface PoolAgentRecord {
  id: string;
  name: string;
  agentName: string;
  task: string;
  model?: string;
  cwd?: string;
  parentAgent?: string;
  depth?: number;
  allowedSubagents?: readonly string[];
  sessionFile?: string;
  spawnedAt: number;
  status?: 'starting' | 'idle' | 'streaming' | 'dead' | 'completed' | 'failed';
  lastResponse?: string;
  errorMessage?: string;
  completedAt?: number;
  messageCount?: number;
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
  status: 'starting' | 'idle' | 'streaming' | 'dead' | 'failed' | 'completed';
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse?: string;
  sessionFile?: string;
}

// ─── One-shot runner ──────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = content
    .filter(
      (c: any) =>
        (c?.type === 'text' || c?.type === undefined) &&
        typeof c.text === 'string',
    )
    .map((c: any) => c.text);
  return parts.join('\n').trim();
}

function noCapturedAssistantText(id: string): string {
  return [
    `[diagnostic] Sub-agent "${id}" completed, but no assistant text was captured.`,
    'The session may have ended without a final message, or the Pi SDK returned a message shape this extension did not recognize.',
    'Use pool=send/resume to ask the sub-agent for a concise summary, or inspect the saved session if available.',
  ].join('\n');
}

function extractAssistantMessageText(message: any): string {
  if (message?.role !== 'assistant') return '';
  return extractText(message.content);
}

function extractLatestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantMessageText(messages[i]);
    if (text) return text;
  }
  return '';
}

function preferNonEmptyText(
  next: string | undefined,
  previous: string | undefined,
): string {
  return next?.trim() ? next : (previous ?? '');
}

export async function runIsolatedTask(opts: {
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
  allToolNames?: readonly string[];
}): Promise<SingleResult> {
  const startTime = Date.now();

  return withSpawnMutex(async () => {
    // Set env vars for the sub-agent session setup
    const prevEnv = saveAgentEnv();
    process.env.OMO_SUB_AGENT = '1';
    process.env.OMO_AGENT_NAME = opts.agent.name;
    if (opts.parentAgent) process.env.OMO_PARENT_AGENT_NAME = opts.parentAgent;
    process.env.OMO_SUBAGENT_DEPTH = String(opts.depth ?? 1);
    if (opts.allowedSubagents)
      process.env.OMO_ALLOWED_SUBAGENTS = opts.allowedSubagents.join(',');

    let session: AgentSession | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const created = await createAgentSession({
        cwd: opts.cwd,
        sessionManager: SessionManager.inMemory(),
        tools: resolveSubagentToolNamesForAgent(
          opts.agent.name,
          opts.cwd,
          opts.allToolNames,
        ),
      });
      session = created.session;

      let response = '';
      let model = '';
      let input = 0,
        output = 0,
        cost = 0,
        turns = 0;
      const collectedMessages: any[] = [];

      session.subscribe((event: any) => {
        if (
          event.type === 'message_end' &&
          event.message?.role === 'assistant'
        ) {
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
        if (event.type === 'session' && event.model) model = event.model;
        opts.onMessage?.(event);
      });

      const taskText = opts.agent.systemPrompt
        ? `${opts.agent.systemPrompt}\n\n## Task\n${opts.task}`
        : opts.task;
      const promptPromise = session.prompt(taskText);
      const abortPromise = opts.signal
        ? new Promise<never>((_, reject) => {
            if (opts.signal!.aborted) reject(new Error('Aborted'));
            opts.signal!.addEventListener(
              'abort',
              () => reject(new Error('Aborted')),
              { once: true },
            );
          })
        : null;
      const timeoutPromise = opts.timeoutMs
        ? new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Sub-agent task timed out')),
              opts.timeoutMs,
            );
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
        response: response || '(no output)',
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
        try {
          await session.abort();
        } catch {}
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
  status: 'starting' | 'idle' | 'streaming' | 'dead' | 'failed' | 'completed';
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse: string;
  busy: boolean;
  parentRunId?: string;
  depth?: number;
  taskPreview?: string;
  sessionFile?: string;
  /** 断流(stall)检测：LLM 流阶段最近一次事件时间戳（ms）。 */
  stallLastEventAt: number;
  /** 断流(stall)检测：进行中的工具调用数（并行工具计数），>0 时不触发 stall。 */
  stallToolDepth: number;
  /** 断流(stall)检测：已判定断流并 abort，防止误标 completed。 */
  stallAborted: boolean;
  /** 断流(stall)检测：已发出 stall 预警（stallTimeoutMs 的一半处），不重复提醒。 */
  stallWarned: boolean;
  stallTimer?: ReturnType<typeof setInterval>;
  /** 发起会话标识：该子代理归哪个会话所有（pi-web 多会话路由用）。 */
  ownerSessionId: string;
}

export interface AgentPoolOptions {
  timeoutMs?: number;
  /** 断流(stall)检测：LLM 流阶段无任何事件即判定断流并 abort（毫秒）。默认 120000；0 = 禁用。 */
  stallTimeoutMs?: number;
  /** 断流(stall)检测：检查间隔（毫秒）。默认 10000。 */
  stallCheckIntervalMs?: number;
  sessionDir?: string;
  createSession?: typeof createAgentSession;
  createSessionManager?: (cwd: string, sessionDir: string) => any;
  openSessionManager?: (sessionFile: string) => any;
  /** Resolve modelId string to Model object. */
  resolveModel?: (modelId: string) => any | undefined;
  /** Resolve all runtime tool names for expression expansion. */
  resolveAllToolNames?: () => readonly string[];
}

export interface PoolEvent {
  type: 'error' | 'completed' | 'stall_warn';
  poolId: string;
  agentName: string;
  /** 发起会话标识：完成/失败/预警通知只路由到该会话。 */
  sessionId: string;
  error?: string;
  response?: string;
}

export class AgentPool {
  private agents = new Map<string, PoolEntry>();
  private timeoutMs: number;
  private stallTimeoutMs: number;
  private stallCheckIntervalMs: number;
  private readonly sessionDir: string;
  private readonly createSession: typeof createAgentSession;
  private readonly createSessionManager: (
    cwd: string,
    sessionDir: string,
  ) => any;
  private readonly openSessionManager: (sessionFile: string) => any;
  private readonly resolveModel:
    | ((modelId: string) => any | undefined)
    | undefined;
  private readonly resolveAllToolNames: (() => readonly string[]) | undefined;
  private eventListeners: Array<(event: PoolEvent) => void> = [];
  private runStateListeners: Array<() => void> = [];
  private runState = createSubagentRunState();

  constructor(options: AgentPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 120_000;
    this.stallCheckIntervalMs = options.stallCheckIntervalMs ?? 10_000;
    this.sessionDir = options.sessionDir ?? SESSION_DIR;
    this.createSession = options.createSession ?? createAgentSession;
    this.createSessionManager =
      options.createSessionManager ??
      ((cwd, sessionDir) => SessionManager.create(cwd, sessionDir));
    this.openSessionManager =
      options.openSessionManager ??
      ((sessionFile) => SessionManager.open(sessionFile));
    this.resolveModel = options.resolveModel;
    this.resolveAllToolNames = options.resolveAllToolNames;
  }

  onEvent(cb: (event: PoolEvent) => void): () => void {
    this.eventListeners.push(cb);
    return () => {
      this.eventListeners = this.eventListeners.filter((e) => e !== cb);
    };
  }

  onRunStateChange(cb: () => void): () => void {
    this.runStateListeners.push(cb);
    return () => {
      this.runStateListeners = this.runStateListeners.filter(
        (listener) => listener !== cb,
      );
    };
  }

  private emit(event: PoolEvent): void {
    for (const cb of this.eventListeners) cb(event);
  }

  private recordRunEvent(event: SubagentRunEvent): void {
    this.runState = updateSubagentRunState(this.runState, event);
    for (const cb of this.runStateListeners) cb();
  }

  private initialRunStatus(id: string): SubagentRunStatus | undefined {
    return this.runState.runs[id]?.status;
  }

  private initialRunActive(id: string): boolean {
    const status = this.initialRunStatus(id);
    return (
      status === undefined ||
      status === 'starting' ||
      status === 'streaming' ||
      status === 'idle'
    );
  }

  /** 运行时更新池级限制（断流检测 / prompt 超时）。 */
  setLimits(limits: {
    stallTimeoutMs?: number;
    promptTimeoutMs?: number;
  }): void {
    if (limits.stallTimeoutMs !== undefined) {
      this.stallTimeoutMs = Math.max(0, Math.floor(limits.stallTimeoutMs));
    }
    if (limits.promptTimeoutMs !== undefined) {
      this.timeoutMs = Math.max(0, Math.floor(limits.promptTimeoutMs));
    }
  }

  /**
   * 断流(stall)检测：记录事件时间并维护工具执行深度。
   * 工具执行阶段（toolDepth > 0）不触发 stall，避免误杀长工具调用。
   */
  private noteSessionEvent(entry: PoolEntry, event: unknown): void {
    entry.stallLastEventAt = Date.now();
    const type = (event as any)?.type;
    if (type === 'tool_execution_start') entry.stallToolDepth += 1;
    else if (type === 'tool_execution_end')
      entry.stallToolDepth = Math.max(0, entry.stallToolDepth - 1);
  }

  private armStallDetection(entry: PoolEntry): void {
    if (this.stallTimeoutMs <= 0) return;
    entry.stallLastEventAt = Date.now();
    entry.stallTimer = setInterval(() => {
      this.checkStall(entry);
    }, this.stallCheckIntervalMs);
  }

  private checkStall(entry: PoolEntry): void {
    if (entry.stallAborted) return;
    if (!entry.busy) return;
    if (entry.stallToolDepth > 0) return;
    const age = Date.now() - entry.stallLastEventAt;
    // 两级检测：在 stallTimeoutMs 的一半处先发一次预警（不终止），
    // 让父 agent 有机会提前干预；到 stallTimeoutMs 仍静默才 abort。
    const warnMs = Math.floor(this.stallTimeoutMs / 2);
    if (
      !entry.stallWarned &&
      warnMs > 0 &&
      age >= warnMs &&
      age < this.stallTimeoutMs
    ) {
      entry.stallWarned = true;
      const message = `Sub-agent "${entry.id}" has been silent for ${age}ms in LLM stream phase; will abort at ${this.stallTimeoutMs}ms if still silent.`;
      console.warn(`[pool] ${message}`);
      this.emit({
        type: 'stall_warn',
        poolId: entry.id,
        agentName: entry.agentName,
        error: message,
        sessionId: entry.ownerSessionId,
      });
    }
    if (age < this.stallTimeoutMs) return;
    entry.stallAborted = true;
    const message = `Sub-agent "${entry.id}" stalled: no events for ${this.stallTimeoutMs}ms in LLM stream phase; aborting.`;
    console.warn(`[pool] ${message}`);
    if (entry.session) {
      entry.session.abort().catch(() => undefined);
    }
  }

  getRunTreeView(options?: SubagentRunViewOptions): SubagentRunTreeView {
    return createSubagentRunTreeView(this.runState, options);
  }

  getSubagentSessionSnapshots(): SubagentSessionSnapshot[] {
    return createSubagentSessionSnapshots(this.runState);
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
    parentRunId?: string;
    resumeSessionFile?: string;
    resumeMessage?: string;
    /** 发起会话标识：pi-web 多会话并存时，完成通知只回发给该会话。 */
    ownerSessionId: string;
  }): Promise<{ response: string; error?: string }> {
    if (this.agents.has(opts.id)) {
      return {
        response: '',
        error: `Agent "${opts.id}" already exists in pool`,
      };
    }

    // Serialize spawn calls via mutex to prevent process.env.OMO_* races
    return withSpawnMutex(async () => {
      const prevEnv = saveAgentEnv();
      process.env.OMO_SUB_AGENT = '1';
      process.env.OMO_AGENT_NAME = opts.agent.name;
      if (opts.parentAgent)
        process.env.OMO_PARENT_AGENT_NAME = opts.parentAgent;
      process.env.OMO_SUBAGENT_DEPTH = String(opts.depth ?? 1);
      if (opts.allowedSubagents)
        process.env.OMO_ALLOWED_SUBAGENTS = opts.allowedSubagents.join(',');
      process.env.OMO_AGENT_ID = opts.id;
      // 嵌套子代理继承根发起会话：孙子 spawn 时从环境变量读取归属。
      process.env.OMO_OWNER_SESSION_ID = opts.ownerSessionId;

      let session: AgentSession | undefined;
      let existingRecord: PoolAgentRecord | undefined;
      try {
        // Resolve model from the already-discovered runtime agent config.
        // /preset persists the active preset before discovery; avoid re-reading
        // stale config here and overriding the selected preset with an old value.
        const modelStr = opts.model || opts.agent.model;
        const resolvedModel =
          modelStr && this.resolveModel
            ? this.resolveModel(modelStr)
            : undefined;
        const allToolNames = this.resolveAllToolNames?.() ?? [];
        const resolvedTools = resolveSubagentToolNamesForAgent(
          opts.agent.name,
          opts.cwd,
          allToolNames,
        );
        existingRecord = this.getRegistryEntry(opts.id);
        const sessionManager = opts.resumeSessionFile
          ? this.openSessionManager(opts.resumeSessionFile)
          : this.createSessionManager(
              opts.cwd ?? process.cwd(),
              this.sessionDir,
            );
        const created = await this.createSession({
          cwd: opts.cwd,
          sessionManager,
          model: resolvedModel,
          tools: resolvedTools,
        });
        session = created.session;

        // Defense-in-depth for SDKs that support runtime tool updates.
        // The primary boundary is createAgentSession({ tools: resolvedTools }) above,
        // which avoids async process.env races during before_agent_start.
        try {
          if (
            resolvedTools &&
            typeof (session as any).setActiveToolsByName === 'function'
          ) {
            (session as any).setActiveToolsByName(resolvedTools);
          }
        } catch (err) {
          console.warn(
            `[pool] Tool filtering failed for "${opts.agent.name}":`,
            err,
          );
        }

        const sessAny = session as any;
        const sessionModel = sessAny.model
          ? `${sessAny.model.provider}/${sessAny.model.id}`
          : undefined;
        const sessionFile =
          typeof sessAny.sessionFile === 'string' && sessAny.sessionFile.trim()
            ? sessAny.sessionFile
            : opts.resumeSessionFile;

        const entry: PoolEntry = {
          id: opts.id,
          name: opts.name,
          agentName: opts.agent.name,
          session,
          status: 'starting',
          startedAt: Date.now(),
          messageCount: 0,
          model: sessionModel || modelStr || 'default',
          lastResponse: existingRecord?.lastResponse ?? '',
          busy: false,
          parentRunId: opts.parentRunId,
          depth: opts.depth,
          taskPreview: opts.task,
          sessionFile,
          ownerSessionId: opts.ownerSessionId,
          stallLastEventAt: Date.now(),
          stallToolDepth: 0,
          stallAborted: false,
          stallWarned: false,
        };

        this.agents.set(opts.id, entry);
        this.recordRunEvent({
          type: 'run_started',
          runId: opts.id,
          parentRunId: opts.parentRunId,
          agentName: opts.agent.name,
          displayName: opts.name || opts.id,
          depth: opts.depth ?? 0,
          startedAt: entry.startedAt,
          taskPreview: opts.task,
          model: entry.model,
          ownerSessionId: opts.ownerSessionId,
        });

        const unsubscribe = session.subscribe((event: any) => {
          this.noteSessionEvent(entry, event);
          if (this.initialRunActive(opts.id)) {
            for (const runEvent of toSubagentRunEvents(
              {
                runId: opts.id,
                agentName: opts.agent.name,
                now: () => Date.now(),
              },
              event,
            )) {
              this.recordRunEvent(runEvent);
            }
          }
          if (event.type === 'turn_start') {
            if (entry.status !== 'failed' && entry.status !== 'dead') {
              entry.status = 'streaming';
              this.updateRegistry(opts.id, { status: 'streaming' });
            }
          }
          if (event.type === 'message_end') {
            const text = extractAssistantMessageText(event.message);
            if (text) {
              entry.lastResponse = text;
              this.updateRegistry(opts.id, { lastResponse: text });
            }
          }
          if (event.type === 'agent_end') {
            const settled =
              entry.status === 'failed' || entry.status === 'dead';
            if (!settled) {
              entry.status = 'idle';
              this.updateRegistry(opts.id, { status: 'idle' });
            }
            entry.messageCount++;
            const text = extractLatestAssistantText(event.messages ?? []);
            if (text) entry.lastResponse = text;
            this.updateRegistry(opts.id, {
              messageCount: entry.messageCount,
              lastResponse: entry.lastResponse,
            });
          }
        });
        (entry as any)._unsubscribe = unsubscribe;
        this.armStallDetection(entry);

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
          sessionFile,
          spawnedAt: Date.now(),
          status: 'starting',
          messageCount: existingRecord?.messageCount ?? 0,
          lastResponse: existingRecord?.lastResponse ?? '',
        });

        const taskText = opts.resumeSessionFile
          ? opts.resumeMessage ||
            [
              'Continue the previous sub-agent session from its existing context.',
              '',
              'If the previous work was interrupted, resume from the last useful point.',
              'If it was already complete, summarize the final result and any remaining risks.',
            ].join('\n')
          : opts.agent.systemPrompt
            ? `${opts.agent.systemPrompt}\n\n## Initial Task\n${opts.task}`
            : opts.task;

        // 异步执行，不阻塞主 agent
        this.sendPrompt(opts.id, taskText, undefined, { emitErrorEvent: false })
          .then((result) => {
            if (result.error) {
              entry.status = 'failed';
              this.updateRegistry(opts.id, {
                status: 'failed',
                errorMessage: result.error,
                lastResponse: preferNonEmptyText(
                  entry.lastResponse,
                  existingRecord?.lastResponse,
                ),
                completedAt: Date.now(),
                messageCount: entry.messageCount,
                sessionFile: entry.sessionFile,
              });
              if (this.initialRunActive(opts.id)) {
                this.recordRunEvent({
                  type: 'run_finished',
                  runId: opts.id,
                  timestamp: Date.now(),
                  status: 'failed',
                  errorMessage: result.error,
                });
              }
              this.emit({
                type: 'error',
                poolId: opts.id,
                agentName: opts.agent.name,
                error: result.error,
                sessionId: entry.ownerSessionId,
              });
            } else {
              this.updateRegistry(opts.id, {
                status: 'completed',
                lastResponse: preferNonEmptyText(
                  result.response,
                  existingRecord?.lastResponse,
                ),
                completedAt: Date.now(),
                messageCount: entry.messageCount,
                errorMessage: undefined,
                sessionFile: entry.sessionFile,
              });
              if (this.initialRunActive(opts.id)) {
                this.recordRunEvent({
                  type: 'run_finished',
                  runId: opts.id,
                  timestamp: Date.now(),
                  status: 'completed',
                  text: result.response,
                });
              }
              this.emit({
                type: 'completed',
                poolId: opts.id,
                agentName: opts.agent.name,
                response: result.response,
                sessionId: entry.ownerSessionId,
              });
            }
          })
          .catch((err) => {
            entry.status = 'failed';
            this.updateRegistry(opts.id, {
              status: 'failed',
              errorMessage: err.message,
              lastResponse: preferNonEmptyText(
                entry.lastResponse,
                existingRecord?.lastResponse,
              ),
              completedAt: Date.now(),
              messageCount: entry.messageCount,
              sessionFile: entry.sessionFile,
            });
            if (this.initialRunActive(opts.id)) {
              this.recordRunEvent({
                type: 'run_finished',
                runId: opts.id,
                timestamp: Date.now(),
                status: 'failed',
                errorMessage: err.message,
              });
            }
            this.emit({
              type: 'error',
              poolId: opts.id,
              agentName: opts.agent.name,
              error: err.message,
              sessionId: entry.ownerSessionId,
            });
          });

        return { response: `已启动，ID: ${opts.id}`, error: undefined };
      } catch (err: any) {
        if (session) {
          try {
            await session.abort();
          } catch {}
          session.dispose();
        }
        const spawnError = `Failed to spawn sub-agent: ${err.message}`;
        this.updateRegistry(opts.id, {
          status: 'failed',
          errorMessage: spawnError,
          lastResponse: existingRecord?.lastResponse ?? '',
          completedAt: Date.now(),
          messageCount: existingRecord?.messageCount ?? 0,
          sessionFile: existingRecord?.sessionFile ?? opts.resumeSessionFile,
        });
        this.emit({
          type: 'error',
          poolId: opts.id,
          agentName: opts.agent.name,
          error: spawnError,
          sessionId: opts.ownerSessionId,
        });
        if (session) {
          this.recordRunEvent({
            type: 'run_finished',
            runId: opts.id,
            timestamp: Date.now(),
            status: 'failed',
            errorMessage: spawnError,
          });
        }
        this.agents.delete(opts.id);
        return { response: '', error: spawnError };
      } finally {
        restoreAgentEnv(prevEnv);
      }
    });
  }

  async sendPrompt(
    id: string,
    message: string,
    type?: string,
    options: { emitErrorEvent?: boolean } = {},
  ): Promise<{ response: string; error?: string }> {
    const entry = this.agents.get(id);
    if (!entry)
      return { response: '', error: `Agent "${id}" not found in pool` };
    if (entry.status === 'dead')
      return { response: '', error: `Agent "${id}" is dead` };
    if (entry.busy) return { response: '', error: `Agent "${id}" is busy` };

    const sess = entry.session as any;

    const fail = (errorMsg: string) => {
      entry.status = 'failed';
      this.updateRegistry(id, {
        status: 'failed',
        errorMessage: errorMsg,
        lastResponse: entry.lastResponse,
        completedAt: Date.now(),
        messageCount: entry.messageCount,
      });
      if (options.emitErrorEvent !== false) {
        if (this.initialRunActive(id)) {
          this.recordRunEvent({
            type: 'run_finished',
            runId: id,
            timestamp: Date.now(),
            status: 'failed',
            errorMessage: errorMsg,
          });
        }
        this.emit({
          type: 'error',
          poolId: id,
          agentName: entry.agentName,
          error: errorMsg,
          sessionId: entry.ownerSessionId,
        });
      }
      return { response: entry.lastResponse, error: errorMsg };
    };

    try {
      entry.busy = true;
      entry.stallAborted = false;
      entry.stallWarned = false;
      entry.stallLastEventAt = Date.now();
      if (entry.status === 'failed') entry.status = 'streaming';

      if (type === 'steer' || type === 'follow_up') {
        try {
          if (type === 'steer') await sess.steer(message);
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

      if (entry.stallAborted) {
        return fail(
          `Sub-agent "${id}" stalled: no events for ${this.stallTimeoutMs}ms in LLM stream phase; aborted.`,
        );
      }

      const messages =
        sess.messages ??
        sess.state?.messages ??
        sess.agent?.state?.messages ??
        [];
      const text = extractLatestAssistantText(messages);
      if (text) {
        entry.lastResponse = text;
        this.updateRegistry(id, {
          status: entry.status,
          lastResponse: text,
          messageCount: entry.messageCount,
        });
        return { response: text };
      }
      this.updateRegistry(id, {
        status: entry.status,
        lastResponse: entry.lastResponse,
        messageCount: entry.messageCount,
      });
      if (entry.lastResponse) return { response: entry.lastResponse };

      const diagnostic = noCapturedAssistantText(id);
      entry.lastResponse = diagnostic;
      this.updateRegistry(id, {
        status: entry.status,
        lastResponse: diagnostic,
        messageCount: entry.messageCount,
      });
      return { response: diagnostic };
    } catch (err: any) {
      const errorMsg = err.message ?? String(err);
      return fail(errorMsg);
    } finally {
      entry.busy = false;
    }
  }

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
        sessionFile: entry.sessionFile,
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

  /** Set or update the all-tool-names resolver for tool expression expansion. */
  setAllToolNamesResolver(resolver: () => readonly string[]): void {
    (this as any).resolveAllToolNames = resolver;
  }

  async kill(id: string): Promise<boolean> {
    const entry = this.agents.get(id);
    if (!entry) return false;
    if (entry.stallTimer) {
      clearInterval(entry.stallTimer);
      entry.stallTimer = undefined;
    }
    const unsub = (entry as any)._unsubscribe;
    if (typeof unsub === 'function') unsub();
    if (this.initialRunActive(id)) {
      this.recordRunEvent({
        type: 'run_finished',
        runId: id,
        timestamp: Date.now(),
        status: 'dead',
      });
    }
    entry.status = 'dead';
    const record = this.getRegistryEntry(id);
    if (record?.status !== 'completed' && record?.status !== 'failed') {
      this.updateRegistry(id, {
        status: 'dead',
        lastResponse: entry.lastResponse,
        messageCount: entry.messageCount,
        completedAt: Date.now(),
      });
    }
    if (entry.session) {
      try {
        await entry.session.abort();
      } catch {}
      entry.session.dispose();
    }
    this.agents.delete(id);
    return true;
  }

  async killAll(ownerSessionId?: string): Promise<void> {
    const ids = [...this.agents.keys()].filter((id) => {
      if (ownerSessionId === undefined) return true;
      return this.agents.get(id)?.ownerSessionId === ownerSessionId;
    });
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
      fs.writeFileSync(
        this.registryPath,
        JSON.stringify([...existing.values()], null, 2),
        'utf-8',
      );
    } catch {}
  }

  private updateRegistry(id: string, patch: Partial<PoolAgentRecord>): void {
    try {
      const existing = this.loadRegistry();
      const current = existing.get(id);
      if (!current) return;
      this.saveToRegistry({ ...current, ...patch });
    } catch {}
  }

  loadRegistry(): Map<string, PoolAgentRecord> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (Array.isArray(raw)) {
        return new Map(raw.map((r: PoolAgentRecord) => [r.id, r]));
      }
    } catch {}
    return new Map();
  }

  listRegistryEntries(): PoolAgentRecord[] {
    return [...this.loadRegistry().values()];
  }

  getRegistryEntry(id: string): PoolAgentRecord | undefined {
    return this.loadRegistry().get(id);
  }
}

// Singleton
let activePool: AgentPool | null = null;

export function getPool(): AgentPool {
  if (!activePool) activePool = new AgentPool();
  return activePool;
}

/** Configure singleton pool with model resolver for preset support. */
export function initPoolModelResolver(
  resolver: (modelId: string) => any | undefined,
): void {
  getPool().setModelResolver(resolver);
}

/** Configure singleton pool with all tool names resolver for expression expansion. */
export function initPoolAllToolNamesResolver(
  resolver: () => readonly string[],
): void {
  getPool().setAllToolNamesResolver(resolver);
}

export interface PoolLimitConfig {
  /** LLM 流阶段无声事件判定断流的毫秒数；0 = 禁用 stall 检测。默认 120000。 */
  stallTimeoutMs?: number;
  /** 单次 prompt 总超时毫秒数；0 = 不限制。默认 600000。 */
  promptTimeoutMs?: number;
}

/** Configure singleton pool stall/prompt limits. */
export function initPoolLimits(limits: PoolLimitConfig): void {
  getPool().setLimits(limits);
}

export async function resetPool(sessionId?: string): Promise<void> {
  if (activePool) {
    await activePool.killAll(sessionId);
    if (sessionId === undefined) activePool = null;
  }
}
