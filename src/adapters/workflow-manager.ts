import {
  type WorkflowNode,
  type ChoiceNode,
  type StageNode,
  type StageOutput,
  type StageEvent,
  type WorkflowDefinition,
} from "../core/workflow-types";
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

function parseStageOutput(text: string): { output?: StageOutput; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: "StageOutput must be a JSON object" };
  }
  const candidate = parsed as Partial<StageOutput>;
  if (candidate.status && !["complete", "needs_user", "failed"].includes(candidate.status)) {
    return { error: "StageOutput.status must be complete, needs_user, or failed" };
  }
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) {
    return { error: "StageOutput.summary must be a non-empty string" };
  }
  if (typeof candidate.context !== "string") {
    return { error: "StageOutput.context must be a string" };
  }

  return { output: { ...candidate, status: candidate.status ?? "complete" } as StageOutput };
}

function buildStageOutputRepairPrompt(error: string, original: string): string {
  return [
    "Your previous response did not match the required StageOutput JSON contract.",
    `Validation error: ${error}`,
    "Return ONLY a valid JSON object with at least:",
    '{"status":"complete","summary":"...","context":"..."}',
    "Do not include markdown fences or explanatory text.",
    "Previous response:",
    original.slice(0, 4000),
  ].join("\n\n");
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
      this.running = false;
      this.workflowName = null;
      this.currentStage = null;
      this.choicePending = null;
      this.choiceResolver = null;
      this.choiceRejecter = null;
      this.stageWaitResolver = null;
    }
  }

  private async runStages(workflowName: string, stages: WorkflowNode[], input: string): Promise<string> {
    let currentInput = input;
    for (const node of stages) {
      if (!this.running) return currentInput;
      if (isChoiceNode(node)) {
        const chosen = await this.awaitChoice(node);
        currentInput = await this.runStages(workflowName, chosen.stages, currentInput);
      } else {
        currentInput = await this.runSingleStage(workflowName, node, currentInput);
      }
    }
    return currentInput;
  }

  private buildStageTask(node: StageNode, input: string): string {
    const parts = [
      "You are running as one stage in a workflow.",
      "Workflow definitions control the process. Your agent prompt controls your role boundary.",
      "Return ONLY the final stage result as valid StageOutput JSON.",
      "Required fields: status, summary, context. status is complete, needs_user, or failed.",
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

  private async parseOrRepairStageOutput(poolId: string, response: string): Promise<StageOutput> {
    const first = parseStageOutput(response);
    if (first.output) return first.output;

    const repair = await this.pool.sendPrompt(
      poolId,
      buildStageOutputRepairPrompt(first.error ?? "Invalid StageOutput", response),
    );
    if (repair.error) {
      return { status: "failed", summary: repair.error, context: "", artifacts: { risks: [repair.error] } };
    }

    const second = parseStageOutput(repair.response);
    if (second.output) return second.output;

    return {
      status: "failed",
      summary: "Stage failed to return valid StageOutput JSON",
      context: "",
      artifacts: { risks: [second.error ?? "Invalid StageOutput"] },
    };
  }

  private waitForUserCompletion(): Promise<StageOutput> {
    return new Promise((resolve) => {
      this.stageWaitResolver = resolve;
    });
  }

  private async runSingleStage(workflowName: string, node: StageNode, input: string): Promise<string> {
    const agentConfig = this.resolveAgentFn(this.cwd, node.agent);
    const stageId = this.makeStageId(workflowName, node);
    const poolId = `wf-${stageId}-${Date.now()}`;

    if (!agentConfig) {
      const error = `Agent "${node.agent}" not found`;
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error });
      throw new Error(error);
    }

    this.currentStage = { workflowName, stageId, poolId, agent: node.agent, input, node };

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
    });
    this.emit({ type: "running", agent: node.agent, stageId, poolId });

    const result = await resultPromise;

    if (result.error) {
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error: result.error });
      if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
      throw new Error(result.error);
    }

    this.emit({ type: "message", agent: node.agent, stageId, poolId, text: result.response });

    let output = await this.parseOrRepairStageOutput(poolId, result.response);
    if (output.status === "needs_user") {
      this.emit({ type: "waiting_user", agent: node.agent, stageId, poolId, output });
      output = await this.waitForUserCompletion();
    }
    if (output.status === "failed") {
      this.emit({ type: "error", agent: node.agent, stageId, poolId, error: output.summary });
      if (!node.keepAlive && !this.keepStageAgents) this.pool.kill(poolId);
      throw new Error(output.summary);
    }

    this.emit({ type: "complete", agent: node.agent, stageId, poolId, output });
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

  async sendUserMessage(text: string): Promise<{ response: string; error?: string }> {
    const stage = this.currentStage;
    if (!stage) return { response: "", error: "No active workflow stage" };
    if (!this.stageWaitResolver) {
      return { response: "", error: "Current workflow stage is not waiting for user input" };
    }
    const result = await this.pool.sendPrompt(stage.poolId, text);
    if (result.error) return result;

    const output = await this.parseOrRepairStageOutput(stage.poolId, result.response);
    if (output.status === "needs_user") {
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
      const message = input ?? "Retry the current stage using the original input. Return a complete StageOutput JSON.";
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
    lastError: string | null;
    lastEvent: StageEvent | null;
  } {
    return {
      running: this.running,
      workflow: this.workflowName,
      stage: this.currentStage,
      choice: this.choicePending,
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
    this.running = false;
    this.workflowName = null;
    this.currentStage = null;
    this.choicePending = null;
    this.choiceResolver = null;
  }
}
