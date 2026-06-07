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
  getDefaultAgentsPath,
  loadRuntimeAgentDefinitions,
  resolveAgentToolNames,
  type RuntimeAgentDefinition,
} from '../../adapters/agent-runtime-config';
import { parseJsonc } from '../../config/jsonc';
import { getToolScope } from '../policy/tool-scope-manager';
import { readPiNativeConfigObject } from '../../config/pi-native';
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

  const snapshot = getToolScope();
  if (snapshot?.sourceName?.trim()) return snapshot.sourceName.trim();

  // Do not fall back to loadActiveMode(): during extension reload its module-local
  // session file can be unset, which falls back to the first configured mode and
  // misclassifies rescue/fallback calls as coordinator delegation.
  return undefined;
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

const DEFAULTS_PATH = getDefaultAgentsPath();
const REGISTRY_FILENAME = 'pool-registry.json';
const SESSION_DIR = path.join(
  os.homedir(),
  '.pi',
  'agent',
  'sessions',
  'subagents',
);

function readConfigObject(filePath: string): Record<string, any> {
  try {
    return parseJsonc<Record<string, any>>(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function readFirstConfigObject(filePaths: readonly string[]): Record<string, any> {
  for (const filePath of filePaths) {
    const config = readConfigObject(filePath);
    if (Object.keys(config).length > 0) return config;
  }
  return {};
}
function readToolGroups(cwd = process.cwd()): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  const mergeGroups = (groups: unknown) => {
    if (!groups || typeof groups !== 'object') return;
    for (const [name, tools] of Object.entries(
      groups as Record<string, unknown>,
    )) {
      if (Array.isArray(tools))
        merged[name] = tools.filter(
          (tool): tool is string =>
            typeof tool === 'string' && tool.trim().length > 0,
        );
    }
  };

  mergeGroups(readConfigObject(DEFAULTS_PATH)._tool_groups);
  mergeGroups(readPiNativeConfigObject()._tool_groups);
  const projectConfigBase = path.join(
    cwd,
    '.opencode',
    'oh-my-opencode-slim',
  );
  mergeGroups(
    readFirstConfigObject([
      `${projectConfigBase}.jsonc`,
      `${projectConfigBase}.json`,
    ])._tool_groups,
  );
  return merged;
}


export function resolveSubagentToolNamesForAgent(
  agentName: string,
  cwd = process.cwd(),
  allToolNames: readonly string[] = [],
): string[] | undefined {
  const runtime = loadRuntimeAgentDefinitions(cwd)[agentName] as
    | RuntimeAgentDefinition
    | undefined;
  if (!runtime) return undefined;

  const groups = readToolGroups(cwd);
  return resolveAgentToolNames(runtime, groups, allToolNames);
}

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
  status: 'starting' | 'idle' | 'streaming' | 'dead';
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse?: string;
}

// ─── One-shot runner ──────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text);
  return parts.join('\n').trim();
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
        tools: resolveSubagentToolNamesForAgent(opts.agent.name, opts.cwd, opts.allToolNames),
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
  status: 'starting' | 'idle' | 'streaming' | 'dead';
  startedAt: number;
  messageCount: number;
  model: string;
  lastResponse: string;
  busy: boolean;
  parentRunId?: string;
  depth?: number;
  taskPreview?: string;
}

export interface AgentPoolOptions {
  timeoutMs?: number;
  sessionDir?: string;
  createSession?: typeof createAgentSession;
  /** Resolve modelId string to Model object. */
  resolveModel?: (modelId: string) => any | undefined;
  /** Resolve all runtime tool names for expression expansion. */
  resolveAllToolNames?: () => readonly string[];
}

export interface PoolEvent {
  type: 'error' | 'completed';
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
  private readonly resolveModel:
    | ((modelId: string) => any | undefined)
    | undefined;
  private readonly resolveAllToolNames:
    | (() => readonly string[])
    | undefined;
  private eventListeners: Array<(event: PoolEvent) => void> = [];
  private runStateListeners: Array<() => void> = [];
  private runState = createSubagentRunState();

  constructor(options: AgentPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.sessionDir = options.sessionDir ?? SESSION_DIR;
    this.createSession = options.createSession ?? createAgentSession;
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
    stageResultPath?: string;
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
      if (opts.stageResultPath)
        process.env.OMO_STAGE_RESULT_PATH = opts.stageResultPath;
      if (opts.allowedSubagents)
        process.env.OMO_ALLOWED_SUBAGENTS = opts.allowedSubagents.join(',');
      process.env.OMO_AGENT_ID = opts.id;

      // Resolve model from the already-discovered runtime agent config.
      // /preset persists the active preset before discovery; avoid re-reading
      // stale config here and overriding the selected preset with an old value.
      const modelStr = opts.model || opts.agent.model;
      const resolvedModel =
        modelStr && this.resolveModel ? this.resolveModel(modelStr) : undefined;

      let session: AgentSession | undefined;
      const allToolNames = this.resolveAllToolNames?.() ?? [];
      const resolvedTools = resolveSubagentToolNamesForAgent(
        opts.agent.name,
        opts.cwd,
        allToolNames,
      );
      try {
        const created = await this.createSession({
          cwd: opts.cwd,
          sessionManager: SessionManager.inMemory(),
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

        const entry: PoolEntry = {
          id: opts.id,
          name: opts.name,
          agentName: opts.agent.name,
          session,
          status: 'starting',
          startedAt: Date.now(),
          messageCount: 0,
          model: sessionModel || modelStr || 'default',
          lastResponse: '',
          busy: false,
          parentRunId: opts.parentRunId,
          depth: opts.depth,
          taskPreview: opts.task,
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
        });

        const unsubscribe = session.subscribe((event: any) => {
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
            entry.status = 'streaming';
          }
          if (event.type === 'agent_end') {
            entry.status = 'idle';
            entry.messageCount++;
            const msgs = event.messages ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role === 'assistant') {
                const text = extractText(m.content);
                if (text) {
                  entry.lastResponse = text;
                  break;
                }
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
        this.sendPrompt(opts.id, taskText, undefined, { emitErrorEvent: false })
          .then((result) => {
            if (result.error) {
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
              });
            } else {
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
              });
            }
          })
          .catch((err) => {
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
        this.emit({
          type: 'error',
          poolId: opts.id,
          agentName: opts.agent.name,
          error: spawnError,
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

    try {
      entry.busy = true;

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

      const messages = (sess.messages ?? []) as any[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') {
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
      if (options.emitErrorEvent !== false) {
        this.emit({
          type: 'error',
          poolId: id,
          agentName: entry.agentName,
          error: errorMsg,
        });
      }
      return { response: entry.lastResponse, error: errorMsg };
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
    if (entry.session) {
      try {
        await entry.session.abort();
      } catch {}
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
      fs.writeFileSync(
        this.registryPath,
        JSON.stringify([...existing.values()], null, 2),
        'utf-8',
      );
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

export async function resetPool(): Promise<void> {
  if (activePool) {
    await activePool.killAll();
    activePool = null;
  }
}
