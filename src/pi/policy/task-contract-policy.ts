export type PlannedActionKind =
  | "read"
  | "write"
  | "modify"
  | "bash_safe"
  | "bash_risky"
  | "subagent_spawn"
  | "discussion";

export interface TaskContractInput {
  kind: PlannedActionKind;
  goal?: string;
  knowns?: string[];
  unknowns?: string[];
  nextStep?: string;
  stopConditions?: string[];
  subagentTask?: string;
}

export interface TaskContractDecision {
  action: "allow" | "warn" | "block";
  missing?: string[];
  reason?: string;
  hint?: string;
}

const allow = (): TaskContractDecision => ({ action: "allow" });

const warn = (reason: string, hint: string, missing?: string[]): TaskContractDecision => ({
  action: "warn",
  reason,
  hint,
  missing,
});

const block = (reason: string, hint: string, missing?: string[]): TaskContractDecision => ({
  action: "block",
  reason,
  hint,
  missing,
});

const hasText = (value?: string): boolean => typeof value === "string" && value.trim().length > 0;
const hasList = (value?: string[]): boolean => Array.isArray(value) && value.some((v) => hasText(v));

function looksLikeObjectlessTask(task: string): boolean {
  const normalized = task.trim();
  if (normalized.length < 12) return true;

  const genericOnlyPatterns = [
    /^输出\s*\d*\s*条?.{0,8}$/,
    /^总结.{0,8}$/,
    /^分析.{0,8}$/,
    /^列出.{0,8}$/,
    /^给出.{0,8}$/,
  ];
  if (genericOnlyPatterns.some((re) => re.test(normalized))) return true;

  // Common weak tasks: action + output type, but no target object.
  const hasGenericVerb = /(输出|总结|分析|列出|给出|生成)/.test(normalized);
  const hasOutputType = /(缺失信息|候选假设|建议|方案|清单|摘要|结论)/.test(normalized);
  const hasObjectMarker = /(针对|关于|围绕|文件|函数|模块|问题|需求|功能|bug|Bug|错误|异常|支付|库存|订单|用户|项目|系统|代码|配置|路径|接口|服务)/.test(normalized);
  return hasGenericVerb && hasOutputType && !hasObjectMarker;
}

function validateWriteLike(input: TaskContractInput): TaskContractDecision {
  const missing: string[] = [];
  if (!hasText(input.goal)) missing.push("goal");
  if (!hasText(input.nextStep)) missing.push("nextStep");
  if (!hasList(input.stopConditions)) missing.push("stopConditions");

  if (missing.length > 0) {
    return block(
      "task_contract_missing",
      `[guard] 执行动作缺少最小任务合同：${missing.join(", ")}。下一步：先补充目标、下一步和停止条件。`,
      missing,
    );
  }
  return allow();
}

function validateSubagentSpawn(input: TaskContractInput): TaskContractDecision {
  if (!hasText(input.subagentTask)) {
    return block(
      "subagent_task_missing",
      "[guard] 子代理委托缺少 task。下一步：补全分析对象、期望输出和约束。",
      ["subagentTask"],
    );
  }

  const task = input.subagentTask!.trim();
  if (looksLikeObjectlessTask(task)) {
    return block(
      "subagent_task_object_missing",
      "[guard] 委托任务缺少分析对象。下一步：补全要分析的问题/功能/文件/需求。",
      ["analysisObject"],
    );
  }

  const hasExpectedOutput = /(输出|给出|列出|总结|评审|分析|返回|生成)/.test(task);
  if (!hasExpectedOutput) {
    return warn(
      "subagent_task_output_unclear",
      "[guard] 委托任务的期望输出不够明确。建议补充输出形式或条数限制。",
      ["expectedOutput"],
    );
  }

  return allow();
}

/**
 * Task Contract Guard.
 *
 * Pure policy: no runtime state, no tool calls, no UI, no workflow.
 */
export function checkTaskContract(input: TaskContractInput): TaskContractDecision {
  switch (input.kind) {
    case "read":
    case "bash_safe":
    case "discussion":
      return allow();
    case "write":
    case "modify":
    case "bash_risky":
      return validateWriteLike(input);
    case "subagent_spawn":
      return validateSubagentSpawn(input);
    default:
      return allow();
  }
}
