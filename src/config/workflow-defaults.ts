import type { WorkflowDefinition, WorkflowsConfig } from './workflow-types';

export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'standard-dev',
    description: '标准受控开发流程：分析 → 计划 → 实现与审查',
    stages: [
      {
        id: 'analysis',
        agent: 'analyst',
        description: '分析需求边界、影响范围、证据缺口和风险；必要时委托 search 补证',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
      {
        id: 'plan',
        agent: 'designer',
        description: '基于已确认分析生成实施计划、TDD/验证路径和分步任务；必要时委托 search/oracle 做只读确认',
        outputSchema: 'plan',
        allowedSubagents: ['search', 'oracle'],
      },
      {
        id: 'implement',
        agent: 'fixer',
        description: '按已确认计划实现并验证；实现后委托 oracle 做规格/质量审查，不通过则继续同一 fixer 会话返工',
        outputSchema: 'implementation',
        allowedSubagents: ['oracle'],
      },
    ],
  },
  {
    name: 'quick-fix',
    description: '快速修复流程：边界分析 → 实现与审查',
    stages: [
      {
        id: 'analysis',
        agent: 'analyst',
        description: '分析修复范围、边界、风险和最小验证路径；必要时委托 search 补证',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
      {
        id: 'implement',
        agent: 'fixer',
        description: '实施最小修复并运行验证；必要时委托 oracle 审查，不通过则继续同一 fixer 会话返工',
        outputSchema: 'implementation',
        allowedSubagents: ['oracle'],
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
        description: '分析研究问题、证据、unknowns 和结论边界；必要时委托 search 补证',
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
  return workflows?.list && workflows.list.length > 0
    ? workflows.list
    : fallback;
}
