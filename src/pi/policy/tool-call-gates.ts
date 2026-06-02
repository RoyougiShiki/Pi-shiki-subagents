import type { StageNode, WorkflowsConfig } from "../../core/workflow-types";
import { checkSubagentSpawnContract } from "./subagent-contract-policy";
import { checkWorkflowStageTargetAllowed } from "./workflow-stage-policy";
import { issuePipelineDelegationGrant } from "./pipeline-delegation-grants";

export type ApprovalResult = { approved: true } | { approved: false; reason: string };
export type GateDecision = { ok: true } | { ok: false; reason: string };

export interface WorkflowStageGateContext {
  workflows: WorkflowsConfig["list"];
  workflowName: string;
  stageIndex: number;
  knownAgents: string[];
  stage: StageNode;
}

export function createWorkflowStageGateHelpers(args: {
  workflows: WorkflowsConfig | undefined;
  knownAgents: string[];
}) {
  const workflowConfigSnapshot = args.workflows;
  // Snapshot tradeoff: dynamic config/agent changes during a session are not reflected.
  // Restart the session to refresh workflow/agent definitions used by this gate.
  const knownAgentNamesSnapshot = args.knownAgents;
  // V1: stageIndex remains 0 throughout the session.
  // Stage progression is not implemented yet — only one stage is ever active.
  // Any future pipeline progression must be explicit, runtime-checked, and user-approved.
  const workflowSessionState = {
    workflowName: workflowConfigSnapshot?.default,
    stageIndex: 0,
  };

  const getWorkflowStageGateContext = (): WorkflowStageGateContext | null => {
    const workflows = workflowConfigSnapshot;
    const workflowName = workflowSessionState.workflowName?.trim() || workflows?.default?.trim();
    if (!workflows || !workflowName || workflows.list.length === 0) return null;
    const workflow = workflows.list.find((candidate) => candidate.name === workflowName);
    const stage = workflow?.stages[workflowSessionState.stageIndex];
    if (!stage) return null;
    return {
      workflows: workflows.list,
      workflowName,
      stageIndex: workflowSessionState.stageIndex,
      knownAgents: knownAgentNamesSnapshot,
      stage,
    };
  };

  return { getWorkflowStageGateContext };
}

export function shouldRequestPipelineSubagentApproval(args: {
  isPipelineMode: boolean;
  requiresStageApproval: boolean;
}): boolean {
  return args.isPipelineMode && args.requiresStageApproval;
}

function deny(reason: string): GateDecision {
  return { ok: false, reason };
}

function allow(): GateDecision {
  return { ok: true };
}

async function requestApproval(
  ctx: any,
  title: string,
  message: string,
): Promise<ApprovalResult | null> {
  if (!ctx?.ui?.confirm) return null;
  const result = await ctx.ui.confirm(title, message);

  // Backward-compatible host UI: boolean confirm result.
  if (typeof result === "boolean") {
    if (result) return { approved: true };
    let reason = "user_rejected";
    try {
      if (ctx?.ui?.input) {
        const text = await ctx.ui.input("拒绝原因（可选）", "请输入拒绝原因，便于模型调整下一步");
        if (typeof text === "string" && text.trim()) reason = text.trim();
      }
    } catch {}
    return { approved: false, reason };
  }

  // Structured confirm result.
  if (!result || typeof result !== "object" || typeof result.approved !== "boolean") {
    return { approved: false, reason: "invalid_confirm_response" };
  }

  if (result.approved) return { approved: true };
  const reason = typeof result.reason === "string" ? result.reason.trim() : "";
  if (reason) return { approved: false, reason };

  let fallbackReason = "user_rejected";
  try {
    if (ctx?.ui?.input) {
      const text = await ctx.ui.input("拒绝原因（可选）", "请输入拒绝原因，便于模型调整下一步");
      if (typeof text === "string" && text.trim()) fallbackReason = text.trim();
    }
  } catch {}
  return { approved: false, reason: fallbackReason };
}

export function createToolCallGates(args: {
  getWorkflowStageGateContext: () => WorkflowStageGateContext | null;
  notifyWorkflowStageGateSkipped: (ctx?: any) => void;
  isCurrentModePipeline: () => boolean;
  resolveDelegationCaller: () => string | undefined;
}) {
  const gatePipelineSubagent = async (ctx: any, input: any): Promise<GateDecision> => {
    // 非 spawn 路径不做子代理审批 gate
    if (input?.pool !== "spawn") return allow();

    // 先做参数完整性预检：缺参直接拒绝且不触发审批
    if (!input?.id || !input?.agent || !input?.task) {
      return deny("pool spawn requires id, agent, and task");
    }

    const contractDecision = checkSubagentSpawnContract(input);
    if (contractDecision.action === "block") {
      return deny(`${contractDecision.reason ?? "subagent_task_contract_failed"}${contractDecision.hint ? `
${contractDecision.hint}` : ""}`);
    }

    // Non-pipeline rescue modes (for example fallback) must not be constrained
    // by the active workflow stage; otherwise they can no longer rescue lockouts.
    if (!args.isCurrentModePipeline()) return allow();

    let requiresStageApproval = false;
    const stageContext = args.getWorkflowStageGateContext();
    if (!stageContext) args.notifyWorkflowStageGateSkipped(ctx);
    if (stageContext) {
      const stageDecision = checkWorkflowStageTargetAllowed({
        ...stageContext,
        targetAgent: input.agent,
      });
      if (!stageDecision.allowed) {
        const allowed = stageDecision.allowedAgents.length > 0 ? stageDecision.allowedAgents.join(", ") : "(none)";
        return deny(`Workflow stage gate blocked "${input.agent}": ${stageDecision.reason}. Allowed agents in current stage: ${allowed}`);
      }
      requiresStageApproval = stageDecision.requiresApproval;
    }

    if (!shouldRequestPipelineSubagentApproval({ isPipelineMode: args.isCurrentModePipeline(), requiresStageApproval })) return allow();

    // Pipeline 模式下，仅当前 workflow stage 的主 agent spawn 需要用户审批。
    // review.agent / allowedSubagents 属于辅助查证或审查路径，由 stage gate 直接放行。
    const approval = await requestApproval(
      ctx,
      "子代理审批",
      `模型请求委托「${input.agent}」执行，是否同意？`,
    );
    if (!approval) {
      return deny("子代理审批被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
    }
    if (!approval.approved) {
      return deny(`用户拒绝了「${input.agent}」的执行。原因：${approval.reason}`);
    }

    issuePipelineDelegationGrant({
      caller: args.resolveDelegationCaller(),
      target: input.agent,
      depth: 0,
      childAllowedSubagents: stageContext?.stage.allowedSubagents,
    });

    return allow();
  };

  const gateSwitchMode = async (ctx: any, input: any): Promise<GateDecision> => {
    if (!input?.mode) return allow();

    const approval = await requestApproval(
      ctx,
      "切换模式",
      `模型请求切换到「${input.mode}」，是否同意？`,
    );
    if (!approval) {
      return deny("模式切换被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
    }
    if (!approval.approved) {
      return deny(`用户拒绝了切换到「${input.mode}」。原因：${approval.reason}`);
    }

    return allow();
  };

  return { gatePipelineSubagent, gateSwitchMode };
}
