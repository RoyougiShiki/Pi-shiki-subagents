/**
 * Agent Context — 区分主 agent 和子代理角色
 *
 * 设计原则：
 * - 子代理完成自己的任务是正常的，不应被 block
 * - 主 agent 需要检查所有子代理状态
 * - Stop vs SubagentStop 事件区分（cc-haha 设计）
 *
 * 环境变量检测：
 * - OMO_SUB_AGENT=1 表示子代理
 * - OMO_AGENT_NAME 表示当前 agent 名称
 * - OMO_PARENT_AGENT_NAME 表示父 agent 名称（如果有）
 */

export type AgentRole = "main" | "subagent";

export interface AgentContext {
  role: AgentRole;
  agentName?: string;
  parentAgentName?: string;
}

export interface AgentContextOptions {
  env?: Record<string, string | undefined>;
}

const SUB_AGENT_ENV_KEY = "OMO_SUB_AGENT";
const AGENT_NAME_ENV_KEY = "OMO_AGENT_NAME";
const PARENT_AGENT_NAME_ENV_KEY = "OMO_PARENT_AGENT_NAME";

/**
 * 从环境变量检测 agent 角色
 */
export function detectAgentRole(env: Record<string, string | undefined> = process.env): AgentRole {
  const subAgentFlag = env[SUB_AGENT_ENV_KEY];
  return subAgentFlag === "1" ? "subagent" : "main";
}

/**
 * 获取完整的 agent context
 */
export function getAgentContext(options: AgentContextOptions = {}): AgentContext {
  const env = options.env ?? process.env;
  const role = detectAgentRole(env);
  return {
    role,
    agentName: env[AGENT_NAME_ENV_KEY],
    parentAgentName: env[PARENT_AGENT_NAME_ENV_KEY],
  };
}

/**
 * 检查是否是主 agent
 */
export function isMainAgent(context: AgentContext): boolean {
  return context.role === "main";
}

/**
 * 检查是否是子代理
 */
export function isSubagent(context: AgentContext): boolean {
  return context.role === "subagent";
}

/**
 * Stop vs SubagentStop 事件类型
 * cc-haha 设计：主 agent 触发 Stop，子代理触发 SubagentStop
 */
export type HookEventName = "Stop" | "SubagentStop";

/**
 * 根据 agent role 确定 hook event 类型
 */
export function getHookEventName(context: AgentContext): HookEventName {
  return isSubagent(context) ? "SubagentStop" : "Stop";
}