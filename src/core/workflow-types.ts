// ============================================================
// Stage Output（子代理输出契约）
// ============================================================
export interface StageOutput {
  status?: "complete" | "needs_user" | "failed";
  summary: string;
  /** Minimal context passed to the next stage; not a full process log. */
  context: string;
  evidence?: Array<{
    path?: string;
    source?: string;
    reason: string;
  }>;
  artifacts?: {
    files?: string[];
    decisions?: string[];
    risks?: string[];
    commands?: string[];
  };
  openQuestions?: Array<{
    question: string;
    options?: string[];
    required?: boolean;
  }>;
  suggestedNext?: {
    branch?: string;
    reason?: string;
  };
}

// ============================================================
// Workflow 树形节点
// ============================================================
export interface StageNode {
  id?: string;
  agent: string;
  description?: string;
  /** Stage-specific task instructions. Workflow defines flow; agent prompt defines role. */
  task?: string;
  /** Optional schema name for later validation/format-specific handling. */
  outputSchema?: string;
  /** Keep the stage pool agent alive after completion. Defaults to false. */
  keepAlive?: boolean;
  /** Optional per-stage delegation override; narrows configured delegates for this stage. */
  allowedSubagents?: string[];
}

export interface ChoiceNode {
  id?: string;
  type: "choice";
  prompt?: string;
  branches: Array<{
    label: string;
    description: string;
    stages: WorkflowNode[];
  }>;
}

export type WorkflowNode = StageNode | ChoiceNode;

export interface WorkflowDefinition {
  name: string;
  description: string;
  stages: WorkflowNode[];
}

export interface WorkflowsConfig {
  default: string;
  list: WorkflowDefinition[];
}

export interface StageResultComplete {
  type: "complete";
  summary: string;
  context: string;
  evidence?: StageOutput["evidence"];
  artifacts?: StageOutput["artifacts"];
  suggestedNext?: StageOutput["suggestedNext"];
}

export interface StageResultAskUser {
  type: "ask_user";
  summary: string;
  question: string;
  options?: string[];
  evidence?: StageOutput["evidence"];
  artifacts?: StageOutput["artifacts"];
  suggestedNext?: StageOutput["suggestedNext"];
}

export type WorkflowStageToolResult = StageResultComplete | StageResultAskUser;

export type StageEvent =
  | { type: "running"; agent: string; stageId: string; poolId: string }
  | { type: "message"; agent: string; stageId: string; poolId: string; text: string }
  | { type: "choice"; prompt: string; branches: Array<{ label: string; description: string }> }
  | { type: "waiting_user"; agent: string; stageId: string; poolId: string; output: StageOutput }
  | { type: "transition_approval"; agent: string; stageId: string; poolId: string; output: StageOutput; nextStage?: string }
  | { type: "complete"; agent: string; stageId: string; poolId: string; output: StageOutput }
  | { type: "workflow_complete"; workflow: string }
  | { type: "error"; agent: string; stageId?: string; poolId?: string; error: string };
