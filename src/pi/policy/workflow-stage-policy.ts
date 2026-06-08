import type { StageNode, WorkflowDefinition } from "../../config/workflow-types";

export type WorkflowStageTargetKind = "current" | "next" | "future" | "past" | "unrelated" | "invalid";

export interface WorkflowStageTargetClassification {
  kind: WorkflowStageTargetKind;
  workflowName: string;
  currentStageIndex: number;
  targetStageIndex?: number;
  currentStageId?: string;
  targetStageId?: string;
  currentAllowedAgents: readonly string[];
  targetAllowedAgents?: readonly string[];
  reason?: string;
  requiresApproval: boolean;
}

export interface WorkflowStageGateDecision {
  allowed: boolean;
  reason?: string;
  allowedAgents: readonly string[];
  /** True only for the current stage primary agent. Review/auxiliary agents do not need user approval. */
  requiresApproval: boolean;
  workflowName?: string;
  stageId?: string;
  stageIndex?: number;
}

export interface WorkflowStageGateInput {
  workflows: readonly WorkflowDefinition[];
  workflowName: string;
  stageIndex: number;
  targetAgent: string;
  knownAgents?: readonly string[];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function unknownAgent(name: string, knownAgents?: readonly string[]): boolean {
  return knownAgents !== undefined && !knownAgents.some((knownAgent) => knownAgent.trim() === name);
}

function baseDecision(args: {
  allowed: boolean;
  allowedAgents: readonly string[];
  requiresApproval?: boolean;
  reason?: string;
  workflowName?: string;
  stageId?: string;
  stageIndex?: number;
}): WorkflowStageGateDecision {
  return {
    allowed: args.allowed,
    reason: args.reason,
    allowedAgents: args.allowedAgents,
    requiresApproval: args.requiresApproval ?? false,
    workflowName: args.workflowName,
    stageId: args.stageId,
    stageIndex: args.stageIndex,
  };
}

export function getStageAllowedAgents(stage: StageNode): string[] {
  return unique([
    stage.agent,
    ...(stage.allowedSubagents ?? []),
  ]);
}

export function isStagePrimaryAgent(stage: StageNode, targetAgent: string): boolean {
  return stage.agent.trim() === targetAgent.trim();
}

function hasUnknownConfiguredAgents(args: {
  workflowName: string;
  stage: StageNode;
  stageIndex: number;
  allowedAgents: readonly string[];
  knownAgents?: readonly string[];
}): WorkflowStageTargetClassification | null {
  const stageId = args.stage.id ?? String(args.stageIndex);
  for (const agentName of args.allowedAgents) {
    if (unknownAgent(agentName, args.knownAgents)) {
      return {
        kind: "invalid",
        workflowName: args.workflowName,
        currentStageIndex: args.stageIndex,
        currentStageId: stageId,
        currentAllowedAgents: args.allowedAgents,
        requiresApproval: false,
        reason: `Workflow "${args.workflowName}" stage "${stageId}" references unknown agent "${agentName}"`,
      };
    }
  }
  return null;
}

export function classifyWorkflowStageTarget(input: WorkflowStageGateInput): WorkflowStageTargetClassification {
  const workflow = input.workflows.find((candidate) => candidate.name === input.workflowName);
  if (!workflow) {
    return {
      kind: "invalid",
      workflowName: input.workflowName,
      currentStageIndex: input.stageIndex,
      currentAllowedAgents: [],
      requiresApproval: false,
      reason: `Workflow "${input.workflowName}" not found`,
    };
  }

  const currentStage = workflow.stages[input.stageIndex];
  if (!currentStage) {
    return {
      kind: "invalid",
      workflowName: workflow.name,
      currentStageIndex: input.stageIndex,
      currentAllowedAgents: [],
      requiresApproval: false,
      reason: `Workflow "${workflow.name}" has no stage at index ${input.stageIndex}`,
    };
  }

  const currentAllowedAgents = getStageAllowedAgents(currentStage);
  const currentStageId = currentStage.id ?? String(input.stageIndex);
  const invalidCurrentConfig = hasUnknownConfiguredAgents({
    workflowName: workflow.name,
    stage: currentStage,
    stageIndex: input.stageIndex,
    allowedAgents: currentAllowedAgents,
    knownAgents: input.knownAgents,
  });
  if (invalidCurrentConfig) return invalidCurrentConfig;

  const targetAgent = input.targetAgent.trim();
  if (!targetAgent) {
    return {
      kind: "invalid",
      workflowName: workflow.name,
      currentStageIndex: input.stageIndex,
      currentStageId,
      currentAllowedAgents,
      requiresApproval: false,
      reason: "Missing target agent",
    };
  }

  if (unknownAgent(targetAgent, input.knownAgents)) {
    return {
      kind: "invalid",
      workflowName: workflow.name,
      currentStageIndex: input.stageIndex,
      currentStageId,
      currentAllowedAgents,
      requiresApproval: false,
      reason: `Target agent "${targetAgent}" is not registered`,
    };
  }

  const classifyMatchedStage = (stageIndex: number, stage: StageNode): WorkflowStageTargetClassification => {
    const targetAllowedAgents = getStageAllowedAgents(stage);
    const targetStageId = stage.id ?? String(stageIndex);
    const invalidConfig = hasUnknownConfiguredAgents({
      workflowName: workflow.name,
      stage,
      stageIndex,
      allowedAgents: targetAllowedAgents,
      knownAgents: input.knownAgents,
    });
    if (invalidConfig) {
      return {
        ...invalidConfig,
        currentStageIndex: input.stageIndex,
        currentStageId,
        currentAllowedAgents,
        targetStageIndex: stageIndex,
        targetStageId,
        targetAllowedAgents,
      };
    }

    const delta = stageIndex - input.stageIndex;
    const kind: WorkflowStageTargetKind = delta === 0 ? "current" : delta === 1 ? "next" : delta > 1 ? "future" : "past";
    return {
      kind,
      workflowName: workflow.name,
      currentStageIndex: input.stageIndex,
      targetStageIndex: stageIndex,
      currentStageId,
      targetStageId,
      currentAllowedAgents,
      targetAllowedAgents,
      requiresApproval: isStagePrimaryAgent(stage, targetAgent),
    };
  };

  // 前置检查：当前 stage 的 allowedSubagents 优先级高于后续 stage 的主 agent
  // 避免同名 agent 被错误分类为 next（R1）
  if ((currentStage.allowedSubagents ?? []).includes(targetAgent)) {
    return classifyMatchedStage(input.stageIndex, currentStage);
  }

  for (let i = 0; i < workflow.stages.length; i++) {
    const stage = workflow.stages[i];
    if (stage.agent.trim() === targetAgent) return classifyMatchedStage(i, stage);
  }

  for (let i = 0; i < workflow.stages.length; i++) {
    if (i === input.stageIndex) continue;
    const stage = workflow.stages[i];
    if ((stage.allowedSubagents ?? []).some((agentName) => agentName.trim() === targetAgent)) {
      return classifyMatchedStage(i, stage);
    }
  }

  return {
    kind: "unrelated",
    workflowName: workflow.name,
    currentStageIndex: input.stageIndex,
    currentStageId,
    currentAllowedAgents,
    requiresApproval: false,
    reason: `Agent "${targetAgent}" is not part of workflow "${workflow.name}"`,
  };
}

export function checkWorkflowStageTargetAllowed(input: WorkflowStageGateInput): WorkflowStageGateDecision {
  const workflow = input.workflows.find((candidate) => candidate.name === input.workflowName);
  if (!workflow) {
    return baseDecision({
      allowed: false,
      reason: `Workflow "${input.workflowName}" not found`,
      allowedAgents: [],
      workflowName: input.workflowName,
      stageIndex: input.stageIndex,
    });
  }

  const stage = workflow.stages[input.stageIndex];
  if (!stage) {
    return baseDecision({
      allowed: false,
      reason: `Workflow "${workflow.name}" has no stage at index ${input.stageIndex}`,
      allowedAgents: [],
      workflowName: workflow.name,
      stageIndex: input.stageIndex,
    });
  }

  const allowedAgents = getStageAllowedAgents(stage);
  const stageId = stage.id ?? String(input.stageIndex);

  for (const agentName of allowedAgents) {
    if (unknownAgent(agentName, input.knownAgents)) {
      return baseDecision({
        allowed: false,
        reason: `Workflow "${workflow.name}" stage "${stageId}" references unknown agent "${agentName}"`,
        allowedAgents,
        workflowName: workflow.name,
        stageId,
        stageIndex: input.stageIndex,
      });
    }
  }

  const targetAgent = input.targetAgent.trim();
  if (!targetAgent) {
    return baseDecision({
      allowed: false,
      reason: "Missing target agent",
      allowedAgents,
      workflowName: workflow.name,
      stageId,
      stageIndex: input.stageIndex,
    });
  }

  if (unknownAgent(targetAgent, input.knownAgents)) {
    return baseDecision({
      allowed: false,
      reason: `Target agent "${targetAgent}" is not registered`,
      allowedAgents,
      workflowName: workflow.name,
      stageId,
      stageIndex: input.stageIndex,
    });
  }

  if (allowedAgents.includes(targetAgent)) {
    return baseDecision({
      allowed: true,
      allowedAgents,
      requiresApproval: isStagePrimaryAgent(stage, targetAgent),
      workflowName: workflow.name,
      stageId,
      stageIndex: input.stageIndex,
    });
  }

  return baseDecision({
    allowed: false,
    reason: `Agent "${targetAgent}" is not allowed in workflow "${workflow.name}" stage "${stageId}"`,
    allowedAgents,
    workflowName: workflow.name,
    stageId,
    stageIndex: input.stageIndex,
  });
}
