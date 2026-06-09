import type { StageNode, WorkflowsConfig } from "../../config/workflow-types";
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
import { isSubagentExecutionPoolAction } from "../subagent/subagent-tool-actions";

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
  getWorkflowStageGateConfigError: () => string | undefined;
  getWorkflowStageRuntimeSnapshot: () => WorkflowStageRuntimeSnapshot;
  resetWorkflowStageRuntime: (workflowName?: string) => void;
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
  approveWorkPackage: (args: {
    workflowName: string;
    stageIndex: number;
    stageId?: string;
    targetAgent: string;
    poolId: string;
    task: string;
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
  getActiveWorkflowName?: () => string | undefined;
  getSessionRecoveryState?: () => { sessionWasResumed: boolean; recoveryCandidate?: WorkflowStageRecoveryCandidate | null };
  clearSessionRecoveryState?: () => void;
}): WorkflowStageGateHelpers {
  const workflowConfigSnapshot = args.workflows;
  // Snapshot tradeoff: dynamic config/agent changes during a session are not reflected.
  // Restart the session to refresh workflow/agent definitions used by this gate.
  const knownAgentNamesSnapshot = args.knownAgents;
  const runtime = createWorkflowStageRuntime({
    initialStageIndex: 0,
  });
  let lastConfigError: string | undefined;

  const syncRecoveryState = () => {
    const state = args.getSessionRecoveryState?.();
    runtime.setRecoveryContext({
      sessionWasResumed: state?.sessionWasResumed === true,
      recoveryCandidate: state?.recoveryCandidate ?? null,
    });
  };

  const resolveActiveWorkflowName = (): string | undefined => {
    const name = args.getActiveWorkflowName?.()?.trim();
    return name || undefined;
  };

  const ensureRuntimeWorkflow = (workflowName: string): void => {
    if (runtime.getSnapshot().workflowName !== workflowName) {
      runtime.reset({ workflowName, initialStageIndex: 0, preserveRecoveryContext: true });
    }
  };

  const getWorkflowStageGateContext = (): WorkflowStageGateContext | null => {
    syncRecoveryState();
    lastConfigError = undefined;
    const workflows = workflowConfigSnapshot;
    const workflowName = resolveActiveWorkflowName();
    if (!workflowName) {
      lastConfigError = "Pipeline mode requires agents.<mode>.workflow; workflows.default is not used at runtime.";
      return null;
    }
    if (!workflows || workflows.list.length === 0) {
      lastConfigError = `Pipeline mode workflow "${workflowName}" cannot run because workflows.list is missing or empty.`;
      return null;
    }
    const workflow = workflows.list.find((candidate) => candidate.name === workflowName);
    if (!workflow) {
      lastConfigError = `Pipeline mode workflow "${workflowName}" was not found in workflows.list.`;
      return null;
    }
    ensureRuntimeWorkflow(workflowName);
    const stageIndex = runtime.getCurrentStageIndex();
    const stage = workflow.stages[stageIndex];
    if (!stage) {
      lastConfigError = `Workflow "${workflowName}" has no stage at index ${stageIndex}.`;
      return null;
    }
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
    getWorkflowStageGateConfigError: () => lastConfigError,
    getWorkflowStageRuntimeSnapshot: () => {
      syncRecoveryState();
      return runtime.getSnapshot();
    },
    resetWorkflowStageRuntime: (workflowName) => {
      args.clearSessionRecoveryState?.();
      runtime.reset({ workflowName, initialStageIndex: 0 });
    },
    advanceWorkflowStage: (next) => runtime.advanceToNextStage(next),
    confirmWorkflowStageRecovery: (next) => runtime.confirmRecovery(next),
    approveWorkPackage: (next) => runtime.approveWorkPackage(next),
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

type ConfirmResponse =
  | boolean
  | { approved: boolean; reason?: string };

interface GateUiContext {
  ui?: {
    confirm?: (title: string, message: string) => ConfirmResponse | Promise<ConfirmResponse>;
    input?: (title: string, message: string) => string | undefined | Promise<string | undefined>;
  };
}

interface SubagentGateInput {
  pool?: unknown;
  id?: unknown;
  agent?: unknown;
  task?: unknown;
}

interface SwitchModeGateInput {
  mode?: unknown;
}

interface SwitchModeTargetPolicy {
  exists: boolean;
  usableAsMode: boolean;
  requiresUserCommand: boolean;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function requestApproval(
  ctx: GateUiContext,
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

function formatWorkPackageApprovalMessage(args: {
  workflowName: string;
  stageId?: string;
  targetAgent: string;
  task: string;
}): string {
  return [
    `模型请求进入 workflow「${args.workflowName}」的实现工作包「${args.stageId ?? "current"}」，并委托「${args.targetAgent}」执行。`,
    "",
    "请确认当前需求、修改范围、停止条件和验证方式已经明确；同意后该工作包内可继续同一子代理会话返工和复审。",
    "如果需求变更、范围扩大、意图不确定或要改新的关键模块，后续必须重新回到用户确认。",
    "",
    "工作包任务:",
    args.task,
  ].join("\n");
}

export function createToolCallGates(args: {
  getWorkflowStageGateContext: () => WorkflowStageGateContext | null;
  getWorkflowStageGateConfigError?: () => string | undefined;
  getWorkflowStageRuntimeSnapshot: () => WorkflowStageRuntimeSnapshot;
  advanceWorkflowStage: WorkflowStageGateHelpers["advanceWorkflowStage"];
  confirmWorkflowStageRecovery: WorkflowStageGateHelpers["confirmWorkflowStageRecovery"];
  approveWorkPackage: WorkflowStageGateHelpers["approveWorkPackage"];
  recordWorkflowStageAttempt: WorkflowStageGateHelpers["recordWorkflowStageAttempt"];
  notifyWorkflowStageGateSkipped: (ctx?: GateUiContext) => void;
  isCurrentModePipeline: () => boolean;
  resolveDelegationCaller: () => string | undefined;
  resolveSwitchModeTarget?: (mode: string) => SwitchModeTargetPolicy | undefined;
  emitWorkflowStageNotice?: (text: string) => void;
}) {
  const gatePipelineSubagent = async (ctx: GateUiContext, input: SubagentGateInput): Promise<GateDecision> => {
    const isExecutionAction = isSubagentExecutionPoolAction(input?.pool);
    if (!isExecutionAction) return allow();

    const isSpawn = input?.pool === "spawn";
    const agent = stringValue(input?.agent);
    const id = stringValue(input?.id);
    const task = stringValue(input?.task);

    if (isSpawn) {
      // 先做参数完整性预检：缺参直接拒绝且不触发审批
      if (!id || !agent || !task) {
        return deny("pool spawn requires id, agent, and task");
      }

      const contractDecision = checkSubagentSpawnContract(input);
      if (contractDecision.action === "block") {
        return deny(`${contractDecision.reason ?? "subagent_task_contract_failed"}${contractDecision.hint ? `
${contractDecision.hint}` : ""}`);
      }
    }

    // Non-pipeline rescue modes (for example fallback) must not be constrained
    // by the active workflow stage; otherwise they can no longer rescue lockouts.
    if (!args.isCurrentModePipeline()) return allow();

    const stageContext = args.getWorkflowStageGateContext();
    if (!stageContext) {
      args.notifyWorkflowStageGateSkipped(ctx);
      return deny(args.getWorkflowStageGateConfigError?.() ?? "Pipeline workflow stage gate is unavailable.");
    }

    if (!isSpawn) return allow();

    const classification = classifyWorkflowStageTarget({
      workflows: stageContext.workflows,
      workflowName: stageContext.workflowName,
      stageIndex: stageContext.stageIndex,
      targetAgent: agent,
      knownAgents: stageContext.knownAgents,
    });

    if (classification.kind === "invalid") {
      return deny(`Workflow stage gate blocked "${agent}": ${classification.reason ?? "invalid workflow stage target"}`);
    }

    if (classification.kind === "unrelated") {
      return allow();
    }

    if (classification.kind === "past") {
      return deny(`Workflow stage gate blocked "${agent}": target belongs to a past workflow stage "${classification.targetStageId ?? classification.targetStageIndex}".`);
    }

    if (classification.kind === "current") {
      if (stageContext.stage.requiresApproval === true && classification.requiresApproval) {
        const snapshot = args.getWorkflowStageRuntimeSnapshot();
        const approvedPackage = snapshot.approvedWorkPackage;
        const alreadyApproved = approvedPackage?.workflowName === stageContext.workflowName
          && approvedPackage.stageIndex === stageContext.stageIndex
          && approvedPackage.stageId === classification.currentStageId
          && approvedPackage.targetAgent === agent
          && approvedPackage.poolId === id
          && approvedPackage.task === task;

        if (!alreadyApproved) {
          const approval = await requestApproval(
            ctx,
            "批准实现工作包",
            formatWorkPackageApprovalMessage({
              workflowName: stageContext.workflowName,
              stageId: classification.currentStageId,
              targetAgent: agent,
              task,
            }),
          );
          if (!approval) return deny("工作包审批被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
          if (!approval.approved) return deny(`用户拒绝实现工作包。原因：${approval.reason}`);

          const approved = args.approveWorkPackage({
            workflowName: stageContext.workflowName,
            stageIndex: stageContext.stageIndex,
            stageId: classification.currentStageId,
            targetAgent: agent,
            poolId: id,
            task,
          });
          if (!approved.ok) return deny(`工作包审批记录失败：${approved.reason}`);

          emitNotice({
            emit: args.emitWorkflowStageNotice,
            text: formatWorkflowStageMarker({
              event: "work_package_approved",
              workflowName: stageContext.workflowName,
              stageIndex: stageContext.stageIndex,
              stageId: classification.currentStageId,
              stageAgent: stageContext.stage.agent,
              targetAgent: agent,
              poolId: id,
              task,
            }),
          });
        }
      }

      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: stageContext.stageIndex,
        stageId: classification.currentStageId,
        targetAgent: agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: agent, stage: stageContext.stage });
      return allow();
    }

    const targetStageIndex = classification.targetStageIndex;
    if (targetStageIndex === undefined) {
      return deny(`Workflow stage gate blocked "${agent}": missing target stage index.`);
    }

    const targetStage = getWorkflowStage(stageContext, targetStageIndex);
    const targetStageId = stageId(targetStage, targetStageIndex);
    const snapshot = args.getWorkflowStageRuntimeSnapshot();
    const candidate = snapshot.recoveryCandidate;
    const candidateMatches = snapshot.sessionWasResumed === true
      && snapshot.recoveryConsumed !== true
      && candidate?.workflowName === stageContext.workflowName
      && candidate.stageIndex === targetStageIndex;

    // On resumed sessions, recovery of a previously reached stage must take
    // precedence over normal next-stage transition. Otherwise a recovered
    // stage-1 marker would be re-approved as a new 0→1 transition instead of
    // restoring the runtime cursor with a recovery_confirmed marker.
    if ((classification.kind === "next" || classification.kind === "future") && candidateMatches && candidate) {
      const approval = await requestApproval(
        ctx,
        "恢复工作流阶段",
        `检测到这是恢复后的会话。历史 stage marker 显示 workflow「${candidate.workflowName}」曾进入阶段「${candidate.stageId ?? candidate.stageIndex}」。模型请求委托「${agent}」继续该阶段。确认后会恢复 runtime stage 位置并放行；同一话题后续应继续使用 pool send/resume。`,
      );
      if (!approval) return deny("阶段恢复被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
      if (!approval.approved) return deny(`用户拒绝恢复工作流阶段。原因：${approval.reason}`);

      const recovered = args.confirmWorkflowStageRecovery({
        workflowName: stageContext.workflowName,
        stageIndex: targetStageIndex,
        stageId: targetStageId,
        targetAgent: agent,
      });
      if (!recovered.ok) return deny(`阶段恢复失败：${recovered.reason}`);

      emitNotice({
        emit: args.emitWorkflowStageNotice,
        text: formatWorkflowStageMarker({
          event: "recovery_confirmed",
          workflowName: stageContext.workflowName,
          stageIndex: targetStageIndex,
          stageId: targetStageId,
          stageAgent: targetStage?.agent,
          targetAgent: agent,
        }),
      });
      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: targetStageIndex,
        stageId: targetStageId,
        targetAgent: agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: agent, stage: targetStage });
      return allow();
    }

    if (classification.kind === "next") {
      if (!classification.requiresApproval) {
        return deny(`Workflow stage gate blocked "${agent}": target belongs to the next workflow stage "${targetStageId ?? targetStageIndex}" but is not the stage primary agent. Enter the stage through "${targetStage?.agent ?? "the stage primary agent"}" before using auxiliary agents.`);
      }

      const approval = await requestApproval(
        ctx,
        "进入下一阶段",
        `模型请求从当前阶段进入 workflow「${stageContext.workflowName}」的下一阶段「${targetStageId ?? targetStageIndex}」，并委托「${agent}」执行。请确认上一阶段结论、unknowns 和风险已处理；同意后会记录 stage marker 并放行。`,
      );
      if (!approval) return deny("阶段推进被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
      if (!approval.approved) return deny(`用户拒绝进入下一阶段。原因：${approval.reason}`);

      const advanced = args.advanceWorkflowStage({
        workflowName: stageContext.workflowName,
        fromStageIndex: stageContext.stageIndex,
        toStageIndex: targetStageIndex,
        fromStageId: classification.currentStageId,
        toStageId: targetStageId,
        targetAgent: agent,
      });
      if (!advanced.ok) return deny(`阶段推进失败：${advanced.reason}`);

      emitNotice({
        emit: args.emitWorkflowStageNotice,
        text: formatWorkflowStageMarker({
          event: "transition_approved",
          workflowName: stageContext.workflowName,
          stageIndex: targetStageIndex,
          stageId: targetStageId,
          stageAgent: targetStage?.agent,
          targetAgent: agent,
        }),
      });
      args.recordWorkflowStageAttempt({
        workflowName: stageContext.workflowName,
        stageIndex: targetStageIndex,
        stageId: targetStageId,
        targetAgent: agent,
      });
      issueGrant({ caller: args.resolveDelegationCaller(), target: agent, stage: targetStage });
      return allow();
    }

    if (classification.kind === "future") {
      return deny(`Workflow stage gate blocked "${agent}": target belongs to a future workflow stage "${targetStageId ?? targetStageIndex}" and does not match the resume recovery candidate.`);
    }

    return deny(`Workflow stage gate blocked "${agent}": unsupported workflow stage classification "${classification.kind}".`);
  };

  const gateSwitchMode = async (ctx: GateUiContext, input: SwitchModeGateInput): Promise<GateDecision> => {
    const mode = stringValue(input?.mode).toLowerCase();
    if (!mode) return allow();

    const target = args.resolveSwitchModeTarget?.(mode);
    if (target) {
      if (!target.exists) {
        return deny(`模式切换被拒绝：不存在该 agent「${mode}」。`);
      }
      if (!target.usableAsMode) {
        return deny(`模式切换被拒绝：「${mode}」是子代理，不能作为模式切换。`);
      }
      if (target.requiresUserCommand) {
        return deny(`模式切换被拒绝：「${mode}」必须由用户使用 /mode 命令切换。`);
      }
    }

    const approval = await requestApproval(
      ctx,
      SWITCH_MODE_APPROVAL_MESSAGE.title,
      `${SWITCH_MODE_APPROVAL_MESSAGE.action}\n目标：${mode}`,
    );
    if (!approval) {
      return deny("模式切换被拒绝：当前环境不支持审批确认（ui.confirm 不可用）。");
    }
    if (!approval.approved) {
      return deny(`用户拒绝了切换到「${mode}」。原因：${approval.reason}`);
    }

    return allow();
  };

  return { gatePipelineSubagent, gateSwitchMode };
}
