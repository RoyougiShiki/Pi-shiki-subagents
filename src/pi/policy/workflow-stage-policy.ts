import type { StageNode, WorkflowDefinition } from "../../core/workflow-types";

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
    stage.review?.agent,
  ]);
}

export function isStagePrimaryAgent(stage: StageNode, targetAgent: string): boolean {
  return stage.agent.trim() === targetAgent.trim();
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
