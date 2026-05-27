import {
  type WorkflowNode,
  type StageNode,
  type StageOutput,
  type StageEvent,
  type WorkflowDefinition,
  type WorkflowStageToolResult,
} from "../../core/workflow-types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPool } from "../subagent/subagent-pool";
import { resolveAgent, type AgentConfig } from "../../adapters/agent-discovery";

interface CurrentStage {
  workflowName: string;
  stageId: string;
  poolId: string;
  agent: string;
  input: string;
  node: StageNode;
  stageResultPath: string;
}

export interface WorkflowPool {
  spawn(opts: {
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
  }): Promise<{ response: string; error?: string }>;
  sendPrompt(id: string, message: string, type?: string): Promise<{ response: string; error?: string }>;
  kill(id: string): Promise<boolean>;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  pool?: WorkflowPool;
  resolveAgent?: (cwd: string, name: string) => AgentConfig | undefined;
}

function parseWorkflowStageToolResult(text: string): { result?: WorkflowStageToolResult; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: "Workflow stage result must be a JSON object" };
  }

  const candidate = parsed as Partial<WorkflowStageToolResult> & Record<string, unknown>;
  if (candidate.type === "complete") {
    if (typeof candidate.summary !== "string" || !candidate.summary.trim()) {
      return { error: "stage_complete.summary must be a non-empty string" };
    }
    if (typeof candidate.context !== "string") {
      return { error: "stage_complete.context must be a string" };
    }
    return { result: { type: "complete", summary: candidate.summary, context: candidate.context, evidence: (candidate as any).evidence, artifacts: (candidate as any).artifacts, suggestedNext: (candidate as any).suggestedNext } };
  }

  if (candidate.type === "ask_user") {
    if (typeof candidate.summary !== "string" || !candidate.summary.trim()) {
      return { error: "stage_ask_user.summary must be a non-empty string" };
    }
    if (typeof candidate.question !== "string" || !candidate.question.trim()) {
      return { error: "stage_ask_user.question must be a non-empty string" };
    }
    if (candidate.options !== undefined && !Array.isArray(candidate.options)) {
      return { error: "stage_ask_user.options must be a string array" };
    }
    return {
      result: {
        type: "ask_user",
        summary: candidate.summary,
        question: candidate.question,
        options: Array.isArray(candidate.options) ? candidate.options.filter((v): v is string => typeof v === "string") : undefined,
        evidence: (candidate as any).evidence,
        artifacts: (candidate as any).artifacts,
      },
    };
  }

  return { error: "Unsupported workflow stage result type" };
}

function stageResultToStageOutput(result: WorkflowStageToolResult): StageOutput {
  if (result.type === "complete") {
    return { status: "complete", summary: result.summary, context: result.context, evidence: result.evidence, artifacts: result.artifacts, suggestedNext: result.suggestedNext };
  }
  return {
    status: "needs_user",
    summary: result.summary,
    context: "",
    evidence: result.evidence,
    artifacts: result.artifacts,
    openQuestions: [{ question: result.question, options: result.options }],
  };
}

/**
 * 通用 workflow 管理器。
 * WorkflowDefinition 决定阶段顺序。
 */
export class WorkflowManager {
  private events: Array<(event: StageEvent) => void> = [];
  private running = false;
  private workflowName: string | null = null;
  private stageWaitResolver: ((output: StageOutput) => void) | null = null;
  private transitionResolver: ((approved: boolean) => void) | null = null;
  private transitionPending: { output: StageOutput; nextStage?: string; stage: CurrentStage; approved?: boolean; rejectMessage?: string } | null = null;
  private pendingEvents: StageEvent[] = [];
  private currentStage: CurrentStage | null = null;
  private stageCounter = 0;
  private lastError: string | null = null;
  private lastEvent: StageEvent | null = null;
  private readonly cwd: string;
  private abortedByUser = false;
  private consecutiveToolMisses = 0;
  private readonly pool: WorkflowPool;
  private readonly resolveAgentFn: (cwd: string, name: string) => AgentConfig | undefined;

  constructor(options: WorkflowManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.pool = options.pool ?? getPool();
    this.resolveAgentFn = options.resolveAgent ?? resolveAgent;
  }

  onEvent(cb: (event: StageEvent) => void): () => void {
    this.events.push(cb);
    return () => { this.events = this.events.filter(e => e !== cb); };
  }

  private emit(event: StageEvent): void {
    this.lastEvent = event;
    if (event.type === "error") this.lastError = event.error;
    for (const cb of this.events) cb(event);
  }

  async runWorkflow(wf: WorkflowDefinition, initialInput: string): Promise<void> {
    if (this.running) throw new Error("Workflow already running");
    this.running = true;
    this.workflowName = wf.name;
    this.stageCounter = 0;
    this.lastError = null;
    this.lastEvent = null;
    try {
      await this.runStages(wf.name, wf.stages, initialInput);
    } catch (err) {
      if (!this.lastError) this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const stageResultPath = this.currentStage?.stageResultPath;
      this.running = false;
      this.workflowName = null;
      this.currentStage = null;
      this.stageWaitResolver = null;
      this.transitionResolver = null;
      this.transitionPending = null;
      this.pendingEvents = [];
      if (stageResultPath) {
        try { fs.rmSync(stageResultPath, { force: true }); } catch {}
      }
    }
  }

  private async runStages(workflowName: string, stages: WorkflowNode[], input: string): Promise<string> {
    let currentInput = input;
    for (let index = 0; index < stages.length; index += 1) {
      const node = stages[index]!;
      if (!this.running) return currentInput;
      const nextNode = stages[index + 1];
      const nextStage = nextNode ? nextNode.agent : undefined;
      currentInput = await this.runSingleStage(workflowName, node, currentInput, nextStage);
    }
    return currentInput;
  }

  private buildStageTask(node: StageNode, input: string): string {
    const parts = [
      "You are running as one stage in a workflow. When done, call stage_complete.",
      "If you need to ask the user something, call stage_ask_user.",
      "Do NOT just reply with text. You must use stage_complete or stage_ask_user.",
    ];
    if (node.description) parts.push(`Stage description:\n${node.description}`);
    if (node.task) parts.push(`Stage task:\n${node.task}`);
    if (node.outputSchema) parts.push(`Output schema name: ${node.outputSchema}`);
    parts.push(`Input from previous stage:\n${input}`);
    return parts.join("\n\n");
  }

  private makeStageId(workflowName: string, node: StageNode): string {
    this.stageCounter += 1;
    const explicit = node.id ? `${this.stageCounter}-${node.id}` : `${this.stageCounter}-${node.agent}`;
    return `${workflowName}-${explicit}`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  }

  private createStageResultPath(poolId: string): string {
    return path.join(os.tmpdir(), `${poolId}.stage-result.json`);
  }

  private clearStageResult(stageResultPath: string): void {
    try { fs.rmSync(stageResultPath, { force: true }); } catch {}
  }

  private readStageResult(stageResultPath: string): { result?: WorkflowStageToolResult; error?: string } {
    if (!fs.existsSync(stageResultPath)) {
      return { error: "Stage did not call stage_complete or stage_ask_user" };
    }
    try {
      const text = fs.readFileSync(stageResultPath, "utf-8");
      return parseWorkflowStageToolResult(text);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to read stage result file" };
    }
  }

  private waitForUserCompletion(): Promise<StageOutput> {
    return new Promise((resolve) => {
      this.stageWaitResolver = resolve;
    });
  }

  private waitForTransitionApproval(stage: CurrentStage, output: StageOutput, nextStage?: string): Promise<boolean> {
    this.transitionPending = { output, nextStage, stage, approved: false };
    const event: StageEvent = { type: "transition_approval", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output, nextStage };
    this.pendingEvents.push(event);
    this.emit(event);
    return new Promise((resolve) => {
      this.transitionResolver = (approved: boolean) => {
        this.transitionPending = null;
        this.transitionResolver = null;
        resolve(approved);
      };
    });
  }

  private async runSingleStage(workflowName: string, node: StageNode, input: string, nextStage?: string): Promise<string> {
    // Reset consecutive tool miss counter for each new stage
    this.consecutiveToolMisses = 0;
    const agentConfig = this.resolveAgentFn(this.cwd, node.agent);
    const stageId = this.makeStageId(workflowName, node);
    const poolId = `wf-${stageId}-${Date.now()}`;

    if (!agentConfig) {
      const error = `Agent "${node.agent}" not found`;
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error });
      throw new Error(error);
    }

    const stageResultPath = this.createStageResultPath(poolId);
    try { fs.rmSync(stageResultPath, { force: true }); } catch {}
    this.currentStage = { workflowName, stageId, poolId, agent: node.agent, input, node, stageResultPath };

    const resultPromise = this.pool.spawn({
      id: poolId,
      name: stageId,
      agent: agentConfig,
      task: this.buildStageTask(node, input),
      model: agentConfig.model,
      cwd: this.cwd,
      parentAgent: "coordinator",
      depth: 1,
      allowedSubagents: node.allowedSubagents,
      stageResultPath,
    });
    this.emit({ type: "running", agent: node.agent, stageId, poolId });

    const result = await resultPromise;

    if (result.error) {
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error: result.error });
      this.pool.kill(poolId);
      throw new Error(result.error);
    }

    let output: StageOutput;
    const stageResult = this.readStageResult(stageResultPath);
    this.clearStageResult(stageResultPath);
    if (!stageResult.result) {
      // Initial spawn: retry once with reminder
      const retryMsg = "[System] Call stage_complete to finish this stage. Use stage_ask_user if you need input. Do not just reply with text.";
      const retryResult = await this.pool.sendPrompt(poolId, retryMsg);
      if (retryResult.error) {
        const error = retryResult.error;
        this.emit({ type: "error", agent: node.agent, stageId, poolId, error });
        this.pool.kill(poolId);
        throw new Error(error);
      }
      const retryStageResult = this.readStageResult(stageResultPath);
      this.clearStageResult(stageResultPath);
      if (!retryStageResult.result) {
        const error = retryStageResult.error ?? "Stage did not call stage_complete or stage_ask_user";
        this.emit({ type: "error", agent: node.agent, stageId, poolId, error });
        this.pool.kill(poolId);
        throw new Error(error);
      }
      output = stageResultToStageOutput(retryStageResult.result);
    } else {
      output = stageResultToStageOutput(stageResult.result);
    }
    if (output.status === "needs_user") {
      // Clean up stale waiting_user events for this stage before pushing new one
      this.pendingEvents = this.pendingEvents.filter(
        (e) => !(e.type === 'waiting_user' && e.poolId === poolId && e.stageId === stageId),
      );
      this.pendingEvents.push({ type: "waiting_user", agent: node.agent, stageId, poolId, output });
      this.emit({ type: "waiting_user", agent: node.agent, stageId, poolId, output });
      output = await this.waitForUserCompletion();
    }
    if (output.status === "failed") {
      // Clean up waiting_user events for this stage
      this.pendingEvents = this.pendingEvents.filter(
        (e) => !(e.type === 'waiting_user' && e.poolId === poolId && e.stageId === stageId),
      );
      // Skip error event for intentional abort (main agent already knows)
      if (!this.abortedByUser) {
        this.emit({ type: "error", agent: node.agent, stageId, poolId, error: output.summary });
      }
      this.pool.kill(poolId);
      throw new Error(output.summary);
    }

    // ── Auto-review: run once, result attached to output ──
    if (node.review && output.status === "complete" && this.running) {
      const reviewAgentCfg = node.review.agent
        ? this.resolveAgentFn(this.cwd, node.review.agent)
        : undefined;
      if (!reviewAgentCfg) {
        console.warn(`[workflow] Review agent "${node.review.agent}" not found, skipping`);
      } else {
        const reviewPoolId = `${poolId}-review`;
        const reviewTask = [
          `Review stage "${node.agent}" output:`,
          `Summary: ${output.summary}`,
          output.context ? `Context: ${output.context}` : "",
          output.evidence?.length ? `Evidence:\n${output.evidence.map((e: any) => `  - ${e.reason}${e.path ? ` (${e.path})` : ""}`).join("\n")}` : "",
          output.artifacts?.decisions?.length ? `Decisions:\n${output.artifacts.decisions.map((d: string) => `  - ${d}`).join("\n")}` : "",
          output.artifacts?.risks?.length ? `Risks:\n${output.artifacts.risks.map((r: string) => `  - ${r}`).join("\n")}` : "",
          "",
          "Reply APPROVED or REJECTED with reasoning.",
        ].filter(Boolean).join("\n");

        const reviewResult = await this.pool.spawn({
          id: reviewPoolId, name: `${stageId}-review`,
          agent: reviewAgentCfg, task: reviewTask,
          cwd: this.cwd, parentAgent: "coordinator", depth: 2,
        });

        this.pool.kill(reviewPoolId).catch(() => {});

        const approved = (reviewResult.response ?? "").toUpperCase().includes("APPROVED");
        if (approved) {
          output = { ...output, artifacts: { ...(output.artifacts ?? {}), decisions: [...(output.artifacts?.decisions ?? []), `审查通过(${reviewAgentCfg.name})`] } };
        } else {
          output = { ...output, artifacts: { ...(output.artifacts ?? {}), risks: [...(output.artifacts?.risks ?? []), `审查意见(${reviewAgentCfg.name}): ${(reviewResult.response ?? "").slice(0, 300)}`] } };
        }
      }
    }

    // Clean up waiting_user events for this stage before emitting complete
    this.pendingEvents = this.pendingEvents.filter(
      (e) => !(e.type === 'waiting_user' && e.poolId === poolId && e.stageId === stageId),
    );
    this.emit({ type: "complete", agent: node.agent, stageId, poolId, output });
    // Loop to allow transition rejection → back to waiting_user → re-complete
    if (nextStage) {
      while (true) {
        // Clean up stale waiting_user from previous iteration
        this.pendingEvents = this.pendingEvents.filter(
          (e) => !(e.type === 'waiting_user' && e.poolId === poolId && e.stageId === stageId),
        );
        const approved = await this.waitForTransitionApproval({ workflowName, stageId, poolId, agent: node.agent, input, node, stageResultPath }, output, nextStage);
        if (approved || !this.running) break;
        // Rejected: inform agent and loop back to waiting_user
        this.pendingEvents = this.pendingEvents.filter(
          (e) => !(e.type === 'waiting_user' && e.poolId === poolId && e.stageId === stageId),
        );
        try {
          const note = this.transitionPending?.rejectMessage || "Your completion request was rejected. Continue working.";
          this.pool.sendPrompt(poolId, note, 'steer').catch(() => {});
        } catch {}
        this.emit({ type: "complete", agent: node.agent, stageId, poolId, output });
        output = await this.waitForUserCompletion();
        if (output.status === "failed") break;
      }
    } else {
      this.emit({ type: "workflow_complete", workflow: workflowName });
    }
    this.pool.kill(poolId);
    if (this.currentStage?.poolId === poolId) this.currentStage = null;
    return output.context;
  }

  continueWorkflow(): boolean {
    if (!this.transitionResolver || !this.transitionPending) return false;
    const stage = this.transitionPending.stage;
    if (this.currentStage?.poolId === stage.poolId) this.currentStage = null;
    this.transitionPending.approved = true;
    this.pendingEvents = this.pendingEvents.filter(
      (e) => !(e.type === 'transition_approval' && e.poolId === stage.poolId && e.stageId === stage.stageId),
    );
    const resolve = this.transitionResolver;
    this.transitionResolver = null;
    resolve(true);
    return true;
  }

  rejectTransition(message?: string): boolean {
    if (!this.transitionResolver || !this.transitionPending) return false;
    const stage = this.transitionPending.stage;
    this.pendingEvents = this.pendingEvents.filter(
      (e) => !(e.type === 'transition_approval' && e.poolId === stage.poolId && e.stageId === stage.stageId),
    );
    // Store reject message for the while loop to send to agent
    this.transitionPending.rejectMessage = message;
    const resolve = this.transitionResolver;
    this.transitionResolver = null;
    this.transitionPending = null;
    resolve(false);
    return true;
  }

  async sendUserMessage(text: string): Promise<{ response: string; error?: string }> {
    const stage = this.currentStage;
    if (!stage) return { response: "", error: "No active workflow stage" };
    if (!this.stageWaitResolver) {
      return { response: "", error: "Current workflow stage is not waiting for user input" };
    }
    this.clearStageResult(stage.stageResultPath);
    const result = await this.pool.sendPrompt(stage.poolId, text);
    if (result.error) return result;

    const stageResult = this.readStageResult(stage.stageResultPath);
    this.clearStageResult(stage.stageResultPath);
    if (!stageResult.result) {
      // First miss: send system reminder via prompt with [System] prefix
      const retryMsg = "[System] You ended your turn without calling a stage tool. Continue working, or use the tool to ask a question or complete the stage.";
      this.clearStageResult(stage.stageResultPath);
      const retryResult = await this.pool.sendPrompt(stage.poolId, retryMsg).catch(() => ({ response: "", error: "send failed" }));
      // Check if agent called a tool after reminder
      const retryStageResult = this.readStageResult(stage.stageResultPath);
      this.clearStageResult(stage.stageResultPath);
      if (retryStageResult.result) {
        this.consecutiveToolMisses = 0;
        const retryOutput = stageResultToStageOutput(retryStageResult.result);
        if (retryOutput.status === "needs_user") {
          this.pendingEvents = this.pendingEvents.filter(
            (e) => !(e.type === 'waiting_user' && e.poolId === stage.poolId && e.stageId === stage.stageId),
          );
          this.pendingEvents.push({ type: "waiting_user", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output: retryOutput });
          this.emit({ type: "waiting_user", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output: retryOutput });
          return retryResult;
        }
        if (this.stageWaitResolver) {
          const resolve = this.stageWaitResolver;
          this.stageWaitResolver = null;
          resolve(retryOutput);
        }
        return retryResult;
      }
      // Reminder didn't help — second consecutive miss
      this.consecutiveToolMisses++;
      if (this.consecutiveToolMisses >= 2) {
        this.emit({ type: "error", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, error: "Stage agent stopped responding with a tool call. You can retry or abort." });
      }
      return { response: result.response, error: "Stage agent stopped responding with a tool call. You can retry or abort." };
    }

    // Agent called a tool — reset consecutive miss counter
    this.consecutiveToolMisses = 0;
    const output = stageResultToStageOutput(stageResult.result);
    if (output.status === "needs_user") {
      this.pendingEvents = this.pendingEvents.filter(
        (e) => !(e.type === 'waiting_user' && e.poolId === stage.poolId && e.stageId === stage.stageId),
      );
      this.pendingEvents.push({ type: "waiting_user", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output });
      this.emit({ type: "waiting_user", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output });
      return result;
    }
    if (this.stageWaitResolver) {
      const resolve = this.stageWaitResolver;
      this.stageWaitResolver = null;
      resolve(output);
    }
    return result;
  }

  async retryStage(input?: string): Promise<{ ok: boolean; error?: string }> {
    const stage = this.currentStage;
    if (!stage) return { ok: false, error: "No active workflow stage" };

    if (this.stageWaitResolver) {
      const message = input ?? "Retry the current stage using the original input. Use stage_complete or stage_ask_user as appropriate.";
      const result = await this.sendUserMessage(message);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true };
    }

    return { ok: false, error: "Current stage is not waiting for retry input" };
  }

  status(): {
    running: boolean;
    workflow: string | null;
    stage: CurrentStage | null;
    transition: { nextStage?: string; output: StageOutput; stageId: string; poolId: string } | null;
    pendingEvents: StageEvent[];
    lastError: string | null;
    lastEvent: StageEvent | null;
  } {
    return {
      running: this.running,
      workflow: this.workflowName,
      stage: this.currentStage,
      transition: this.transitionPending ? {
        nextStage: this.transitionPending.nextStage,
        output: this.transitionPending.output,
        stageId: this.transitionPending.stage.stageId,
        poolId: this.transitionPending.stage.poolId,
      } : null,
      pendingEvents: [...this.pendingEvents],
      lastError: this.lastError,
      lastEvent: this.lastEvent,
    };
  }

  private abortStage(stage: CurrentStage): void {
    // Clean up any pending events for this stage
    this.pendingEvents = this.pendingEvents.filter(
      (e) => !('poolId' in e && e.poolId === stage.poolId && (e.type === 'waiting_user' || e.type === 'transition_approval')),
    );
    if (this.stageWaitResolver) {
      const resolve = this.stageWaitResolver;
      this.stageWaitResolver = null;
      resolve({ status: "failed", summary: "Stage agent failed", context: "" });
    }
    if (this.transitionPending?.stage.poolId === stage.poolId) {
      this.transitionPending = null;
      this.transitionResolver = null;
    }
    if (this.currentStage?.poolId === stage.poolId) {
      this.currentStage = null;
    }
  }

  isRunning(): boolean { return this.running; }

  abort(): void {
    this.abortedByUser = true;
    const poolId = this.currentStage?.poolId;
    if (poolId) this.pool.kill(poolId);
    if (this.stageWaitResolver) {
      const resolve = this.stageWaitResolver;
      this.stageWaitResolver = null;
      resolve({ status: "failed", summary: "Workflow aborted", context: "" });
    }
    if (this.transitionResolver) {
      const resolve = this.transitionResolver;
      this.transitionResolver = null;
      this.transitionPending = null;
      resolve(false);
    }
    this.running = false;
    this.workflowName = null;
    this.currentStage = null;
    this.pendingEvents = [];
  }
}
