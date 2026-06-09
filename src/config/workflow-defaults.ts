import type { WorkflowDefinition, WorkflowsConfig } from './workflow-types';

export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'standard-dev',
    description: '标准受控开发流程：分析 → 计划 → 调度实现与审查',
    stages: [
      {
        id: 'analysis',
        agent: 'analyst',
        description: '分析需求边界、影响范围、证据缺口和风险；必要时委托查证类辅助补证',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
      {
        id: 'plan',
        agent: 'designer',
        description: '基于已确认分析生成实施计划、TDD/验证路径和分步任务；必要时委托只读辅助确认',
        outputSchema: 'plan',
        allowedSubagents: ['search', 'oracle'],
      },
      {
        id: 'implement',
        agent: 'dispatcher',
        description: '按已确认计划调度实现和审查；审查不通过则继续同一实现会话返工',
        outputSchema: 'implementation',
        allowedSubagents: ['fixer', 'oracle'],
      },
    ],
  },
  {
    name: 'quick-fix',
    description: '轻量快速修复流程：主 agent 判断边界 → 用户确认工作包 → 最小实现 → 审查',
    stages: [
      {
        id: 'fix',
        agent: 'fixer',
        description: '主 agent 自行收束范围并经用户确认工作包后，委托当前实现阶段主子代理做最小修复；必要时补证并审查；不通过则继续同一实现会话返工',
        outputSchema: 'implementation',
        allowedSubagents: ['search', 'oracle'],
        requiresApproval: true,
      },
    ],
  },
  {
    name: 'research-only',
    description: '只读研究流程：查证与分析',
    stages: [
      {
        id: 'analysis',
        agent: 'analyst',
        description: '分析研究问题、证据、unknowns 和结论边界；必要时委托查证类辅助补证',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
    ],
  },
];

export function resolveWorkflowList(
  workflows?: Pick<WorkflowsConfig, 'list'> | null,
): WorkflowDefinition[];
export function resolveWorkflowList<T extends { name: string }>(
  workflows?: { list?: T[] } | null,
  fallback?: T[],
): T[];
export function resolveWorkflowList<T extends { name: string }>(
  workflows?: { list?: T[] } | null,
  fallback: T[] = DEFAULT_WORKFLOWS as unknown as T[],
): T[] {
  const defaultByName = new Map(fallback.map((workflow) => [workflow.name, workflow]));
  const customWorkflows = (workflows?.list ?? []).filter(
    (workflow) => !defaultByName.has(workflow.name),
  );
  return [...fallback, ...customWorkflows];
}
