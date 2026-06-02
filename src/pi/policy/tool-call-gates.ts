import type { StageNode, WorkflowsConfig } from "../../core/workflow-types";
import { checkSubagentSpawnContract } from "./subagent-contract-policy";
import { classifyWorkflowStageTarget } from "./workflow-stage-policy";
import { issuePipelineDelegationGrant } from "./pipeline-delegation-grants";
import {
  createWorkflowStageRuntime,
  type RuntimeDecision,
  type WorkflowStageRecoveryCandidate,
  type WorkflowStageRuntimeSnapshot,
} from "./workflow-stage-runtime";
import { formatWorkflowStageMarker } from "./workflow-stage-marker";

export type ApprovalResult = { approved: true } | { approved: false; reason: string };
export type GateDecision = { ok: true } | { ok: false; reason: string };

export const SWITCH_MODE_APPROVAL_MESSAGE = {
  title: "切换模式",
  action: "模型请求切换模式，是否同意？",
} as const;

export interface WorkflowStageGateContext {
  workflows: WorkflowsConfig["list"];
  workflowName: string;
  stageIndex: number;
  knownAgents: string[];
  stage: StageNode;
}

export interface WorkflowStageGateHelpers {
  getWorkflowStageGateContext: () => WorkflowStageGateContext | null;
  getWorkflowStageRuntimeSnapshot: () => WorkflowStageRuntimeSnapshot;
  advanceWorkflowStage: (args: {
    workflowName: string;
    fromStageIndex: number;
    toStageIndex: number;
    fromStageId?: string;
    toStageId?: string;
    targetAgent: string;
  }) => RuntimeDecision;
  confirmWorkflowStageRecovery: (args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
  }) => RuntimeDecision;
  recordWorkflowStageAttempt: (args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
  }) => void;
}

export function createWorkflowStageGateHelpers(args: {
  workflows: WorkflowsConfig | undefined;
  knownAgents: string[];
  getSessionRecoveryState?: () => { sessionWasResumed: boolean; recoveryCandidate?: WorkflowStageRecoveryCandidate | null };
}): WorkflowStageGateHelpers {
  const workflowConfigSnapshot = args.workflows;
  // Snapshot tradeoff: dynamic config/agent changes during a session are not reflected.
  // Restart the session to refresh workflow/agent definitions used by this gate.
  const knownAgentNamesSnapshot = args.knownAgents;
  const runtime = createWorkflowStageRuntime({
    workflowName: workflowConfigSnapshot?.default,
    initialStageIndex: 0,
  });

  const syncRecoveryState = () => {
    const state = args.getSessionRecoveryState?.();
    runtime.setRecoveryContext({
      sessionWasResumed: state?.sessionWasResumed === true,
      recoveryCandidate: state?.recoveryCandidate ?? null,
    });
  };

  const getWorkflowStageGateContext = (): WorkflowStageGateContext | null => {
    syncRecoveryState();
    const workflows = workflowConfigSnapshot;
    const snapshot = runtime.getSnapshot();
    const workflowName = snapshot.workflowName?.trim() || workflows?.default?.trim();
    if (!workflows || !workflowName || workflows.list.length === 0) return null;
    const workflow = workflows.list.find((candidate) => candidate.name === workflowName);
    const stageIndex = runtime.getCurrentStageIndex();
    const stage = workflow?.stages[stageIndex];
    if (!stage) return null;
    return {
      workflows: workflows.list,
      workflowName,
      stageIndex,
      knownAgents: knownAgentNamesSnapshot,
      stage,
    };
  };

  return {
    getWorkflowStageGateContext,
    getWorkflowStageRuntimeSnapshot: () => {
      syncRecoveryState();
      return runtime.getSnapshot();
    },
    advanceWorkflowStage: (next) => runtime.advanceToNextStage(next),
    confirmWorkflowStageRecovery: (next) => runtime.confirmRecovery(next),
    recordWorkflowStageAttempt: (next) => runtime.recordAttemptStarted(next),
  };
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

function getWorkflowStage(ctx: WorkflowStageGateContext, stageIndex: number | undefined): StageNode | undefined {
  if (stageIndex === undefined) return undefined;
  const workflow = ctx.workflows.find((candidate) => candidate.name === ctx.workflowName);
  return workflow?.stages[stageIndex];
}

function stageId(stage: StageNode | undefined, fallbackIndex: number | undefined): string | undefined {
  if (!stage && fallbackIndex === undefined) return undefined;
  return stage?.id ?? (fallbackIndex === undefined ? undefined : String(fallbackIndex));
}

function emitNotice(args: { emit?: (text: string) => void; text: string }): void {
  try {
    args.emit?.(args.text);
  } catch {}
}

function issueGrant(args: {
  caller: string | undefined;
  target: string;
  stage: StageNode | undefined;
}): void {
  issuePipelineDelegationGrant({
    caller: args.caller,
    target: args.target,
    depth: 0,
    childAllowedSubagents: args.stage?.allowedSubagents,
  });
}

export function createToolCallGates(args: {
  getWorkflowStageGateContext: () => WorkflowStageGateContext | null;
  getWorkflowStageRuntimeSnapshot: () => WorkflowStageRuntimeSnapshot;
  advanceWorkflowStage: WorkflowStageGateHelpers["advanceWorkflowStage"];
  confirmWorkflowStageRecovery: WorkflowStageGateHelpers["confirmWorkflowStageRecovery"];
  recordWorkflowStageAttempt: WorkflowStageGateHelpers["recordWorkflowStageAttempt"];
  notifyWorkflowStageGateSkipped: (ctx?: any) => void;
  isCurrentModePipeline: () => boolean;
  resolveDelegationCaller: () => string | undefined;
  emitWorkflowStageNotice?: (text: string) => void;
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

    const stageContext = args.getWorkflowStageGateContext();
    if (!stageContext) {
      args.notifyWorkflowStageGateSkipped(ctx);
      return allow();
    }

    const classification = classifyWorkflowStageTarget({
      workflows: stageContext.workflows,
      workflowName: stageContext.workflowName,
      stageIndex: stageContext.stageIndex,
      targetAgent: input.agent,
      knownAgents: stageContext.knownAgents,
    });

    if (classification.kind === "invalid") {
      return deny(`Workflow stage gate blocked "${input.agent}": ${classification.reason ?? "invalid workflow stage target"}`);
    }

    if (classification.kind === "unrelated") {
      return allow();
    }

    if (classification.kind === "past") {
      return deny(`Workflow stage gate blocked "${input.agent}": target belongs to a past workflow stage "${classification.targetStageId ?? classification.targetStageIndex}".`);
    }

    if (classification.kind === "current") {
      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: stageContext.stageIndex,
        stageId: classification.currentStageId,
        targetAgent: input.agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: input.agent, stage: stageContext.stage });
      return allow();
    }

    const targetStage = getWorkflowStage(stageContext, classification.targetStageIndex);
    const targetStageId = stageId(targetStage, classification.targetStageIndex);
    const snapshot = args.getWorkflowStageRuntimeSnapshot();
    const candidate = snapshot.recoveryCandidate;
    const candidateMatches = snapshot.sessionWasResumed === true
      && snapshot.recoveryConsumed !== true
      && candidate?.workflowName === stageContext.workflowName
      && candidate.stageIndex === classification.targetStageIndex;

    // On resumed sessions, recovery of a previously reached stage must take
    // precedence over normal next-stage transition. Otherwise a recovered
    // stage-1 marker would be re-approved as a new 0→1 transition instead of
    // restoring the runtime cursor with a recovery_confirmed marker.
    if ((classification.kind === "next" || classification.kind === "future") && candidateMatches) {
      const approval = await requestApproval(
        ctx,
        "恢复工作流阶段",
        `检测到这是恢复后的会话。历史 stage marker 显示 workflow「${candidate!.workflowName}」曾进入阶段「${candidate!.stageId ?? candidate!.stageIndex}」。模型请求委托「${input.agent}」继续该阶段。若你确认这是恢复中断前进度，请同意恢复 runtime stage 位置并放行。`,
      );
      if (!approval) return deny("阶段恢复被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
      if (!approval.approved) return deny(`用户拒绝恢复工作流阶段。原因：${approval.reason}`);

      const recovered = args.confirmWorkflowStageRecovery({
        workflowName: stageContext.workflowName,
        stageIndex: classification.targetStageIndex!,
        stageId: targetStageId,
        targetAgent: input.agent,
      });
      if (!recovered.ok) return deny(`阶段恢复失败：${recovered.reason}`);

      emitNotice({
        emit: args.emitWorkflowStageNotice,
        text: formatWorkflowStageMarker({
          event: "recovery_confirmed",
          workflowName: stageContext.workflowName,
          stageIndex: classification.targetStageIndex!,
          stageId: targetStageId,
          stageAgent: targetStage?.agent,
          targetAgent: input.agent,
        }),
      });
      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: classification.targetStageIndex!,
        stageId: targetStageId,
        targetAgent: input.agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: input.agent, stage: targetStage });
      return allow();
    }

    if (classification.kind === "next") {
      const approval = await requestApproval(
        ctx,
        "进入下一阶段",
        `模型请求进入 workflow「${stageContext.workflowName}」的下一阶段「${targetStageId ?? classification.targetStageIndex}」，并委托「${input.agent}」执行，是否同意？`,
      );
      if (!approval) return deny("阶段推进被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
      if (!approval.approved) return deny(`用户拒绝进入下一阶段。原因：${approval.reason}`);

      const advanced = args.advanceWorkflowStage({
        workflowName: stageContext.workflowName,
        fromStageIndex: stageContext.stageIndex,
        toStageIndex: classification.targetStageIndex!,
        fromStageId: classification.currentStageId,
        toStageId: targetStageId,
        targetAgent: input.agent,
      });
      if (!advanced.ok) return deny(`阶段推进失败：${advanced.reason}`);

      emitNotice({
        emit: args.emitWorkflowStageNotice,
        text: formatWorkflowStageMarker({
          event: "transition_approved",
          workflowName: stageContext.workflowName,
          stageIndex: classification.targetStageIndex!,
          stageId: targetStageId,
          stageAgent: targetStage?.agent,
          targetAgent: input.agent,
        }),
      });
      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: classification.targetStageIndex!,
        stageId: targetStageId,
        targetAgent: input.agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: input.agent, stage: targetStage });
      return allow();
    }

    if (classification.kind === "future") {
      return deny(`Workflow stage gate blocked "${input.agent}": target belongs to a future workflow stage "${targetStageId ?? classification.targetStageIndex}" and does not match the resume recovery candidate.`);
    }

    return deny(`Workflow stage gate blocked "${input.agent}": unsupported workflow stage classification "${classification.kind}".`);
  };

  const gateSwitchMode = async (ctx: any, input: any): Promise<GateDecision> => {
    if (!input?.mode) return allow();

    const approval = await requestApproval(
      ctx,
      SWITCH_MODE_APPROVAL_MESSAGE.title,
      `${SWITCH_MODE_APPROVAL_MESSAGE.action}\n目标：${input.mode}`,
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
