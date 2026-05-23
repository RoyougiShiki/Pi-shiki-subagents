import {
  type WorkflowNode,
  type ChoiceNode,
  type StageNode,
  type StageOutput,
  type StageEvent,
  type WorkflowDefinition,
  type WorkflowStageToolResult,
} from "../core/workflow-types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPool } from "./subagent-pool";
import { resolveAgent, type AgentConfig } from "./agent-discovery";

function isChoiceNode(node: WorkflowNode): node is ChoiceNode {
  return (node as any).type === "choice";
}

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
  sendPrompt(id: string, message: string): Promise<{ response: string; error?: string }>;
  kill(id: string): boolean;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  keepStageAgents?: boolean;
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
    return { result: { type: "complete", summary: candidate.summary, context: candidate.context } };
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
      },
    };
  }

  return { error: "Unsupported workflow stage result type" };
}

function stageResultToStageOutput(result: WorkflowStageToolResult): StageOutput {
  if (result.type === "complete") {
    return { status: "complete", summary: result.summary, context: result.context };
  }
  return {
    status: "needs_user",
    summary: result.summary,
    context: "",
    openQuestions: [{ question: result.question, options: result.options }],
  };
}

/**
 * 通用 workflow 管理器。
 * 不硬编码任何具体流程；WorkflowDefinition 决定阶段顺序和分支。
 */
export class WorkflowManager {
  private events: Array<(event: StageEvent) => void> = [];
  private running = false;
  private workflowName: string | null = null;
  private choiceResolver: ((branchIndex: number) => void) | null = null;
  private choiceRejecter: ((error: Error) => void) | null = null;
  private choicePending: { prompt: string; branches: Array<{ label: string; description: string }> } | null = null;
  private stageWaitResolver: ((output: StageOutput) => void) | null = null;
  private transitionResolver: (() => void) | null = null;
  private transitionPending: { output: StageOutput; nextStage?: string; stage: CurrentStage; approved?: boolean } | null = null;
  private pendingEvents: StageEvent[] = [];
  private currentStage: CurrentStage | null = null;
  private stageCounter = 0;
  private lastError: string | null = null;
  private lastEvent: StageEvent | null = null;
  private readonly cwd: string;
  private readonly keepStageAgents: boolean;
  private readonly pool: WorkflowPool;
  private readonly resolveAgentFn: (cwd: string, name: string) => AgentConfig | undefined;

  constructor(options: WorkflowManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.keepStageAgents = options.keepStageAgents ?? false;
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
      this.choicePending = null;
      this.choiceResolver = null;
      this.choiceRejecter = null;
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
      if (isChoiceNode(node)) {
        const chosen = await this.awaitChoice(node);
        currentInput = await this.runStages(workflowName, chosen.stages, currentInput);
      } else {
        const nextNode = stages[index + 1];
        const nextStage = nextNode ? (isChoiceNode(nextNode) ? "(choice)" : nextNode.agent) : undefined;
        currentInput = await this.runSingleStage(workflowName, node, currentInput, nextStage);
      }
    }
    return currentInput;
  }

  private buildStageTask(node: StageNode, input: string): string {
    const parts = [
      "You are running as one stage in a workflow.",
      "Workflow definitions control the process. Your agent prompt controls your role boundary.",
      "Do not output workflow result JSON in normal text.",
      "When you finish this stage, call stage_complete(summary, context). If you need to ask a question first, call stage_ask_user(summary, question, options?).",
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

  private waitForTransitionApproval(stage: CurrentStage, output: StageOutput, nextStage?: string): Promise<void> {
    this.transitionPending = { output, nextStage, stage, approved: false };
    const event: StageEvent = { type: "transition_approval", agent: stage.agent, stageId: stage.stageId, poolId: stage.poolId, output, nextStage };
    this.pendingEvents.push(event);
    this.emit(event);
    return new Promise((resolve) => {
      this.transitionResolver = resolve;
    });
  }

  private async runSingleStage(workflowName: string, node: StageNode, input: string, nextStage?: string): Promise<string> {
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
      if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
      throw new Error(result.error);
    }

    const stageResult = this.readStageResult(stageResultPath);
    this.clearStageResult(stageResultPath);
    if (!stageResult.result) {
      const error = stageResult.error ?? "Stage did not call stage_complete or stage_ask_user";
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error });
      if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
      throw new Error(error);
    }

    let output = stageResultToStageOutput(stageResult.result);
    if (output.status === "needs_user") {
      this.pendingEvents.push({ type: "waiting_user", agent: node.agent, stageId, poolId, output });
      this.emit({ type: "waiting_user", agent: node.agent, stageId, poolId, output });
      output = await this.waitForUserCompletion();
    }
    if (output.status === "failed") {
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error: output.summary });
      if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
      throw new Error(output.summary);
    }

    this.emit({ type: "complete", agent: node.agent, stageId, poolId, output });
    if (nextStage) {
      await this.waitForTransitionApproval({ workflowName, stageId, poolId, agent: node.agent, input, node, stageResultPath }, output, nextStage);
    } else {
      this.emit({ type: "workflow_complete", workflow: workflowName });
    }
    if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
    if (this.currentStage?.poolId === poolId) this.currentStage = null;
    return output.context;
  }

  private awaitChoice(node: ChoiceNode): Promise<{ stages: WorkflowNode[] }> {
    const choice = {
      prompt: node.prompt ?? "请选择",
      branches: node.branches.map(b => ({ label: b.label, description: b.description })),
    };
    this.choicePending = choice;
    this.emit({ type: "choice", ...choice });

    return new Promise((resolve, reject) => {
      this.choiceRejecter = reject;
      this.choiceResolver = (branchIndex: number) => {
        const branch = node.branches[branchIndex];
        if (!branch) return;
        this.choicePending = null;
        this.choiceRejecter = null;
        resolve(branch);
      };
    });
  }

  selectBranch(branchIndex: number): boolean {
    if (!this.choiceResolver || !this.choicePending) return false;
    if (branchIndex < 0 || branchIndex >= this.choicePending.branches.length) return false;
    this.choiceResolver(branchIndex);
    this.choiceResolver = null;
    return true;
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
    this.transitionPending = null;
    resolve();
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
      return { response: result.response, error: stageResult.error ?? "Stage did not call stage_complete or stage_ask_user" };
    }

    const output = stageResultToStageOutput(stageResult.result);
    if (output.status === "needs_user") {
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
    choice: { prompt: string; branches: Array<{ label: string; description: string }> } | null;
    transition: { nextStage?: string; output: StageOutput; stageId: string; poolId: string } | null;
    pendingEvents: StageEvent[];
    lastError: string | null;
    lastEvent: StageEvent | null;
  } {
    return {
      running: this.running,
      workflow: this.workflowName,
      stage: this.currentStage,
      choice: this.choicePending,
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

  isRunning(): boolean { return this.running; }

  abort(): void {
    const poolId = this.currentStage?.poolId;
    if (poolId) this.pool.kill(poolId);
    if (this.choiceRejecter) {
      const reject = this.choiceRejecter;
      this.choiceRejecter = null;
      reject(new Error("Workflow aborted"));
    }
    if (this.stageWaitResolver) {
      const resolve = this.stageWaitResolver;
      this.stageWaitResolver = null;
      resolve({ status: "failed", summary: "Workflow aborted", context: "" });
    }
    if (this.transitionResolver) {
      const resolve = this.transitionResolver;
      this.transitionResolver = null;
      this.transitionPending = null;
      resolve();
    }
    this.running = false;
    this.workflowName = null;
    this.currentStage = null;
    this.choicePending = null;
    this.choiceResolver = null;
    this.pendingEvents = [];
  }
}
