import type { WorkflowDefinition, WorkflowsConfig } from './workflow-types';

export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'standard-dev',
    description: '标准开发流程：分析 → 计划 → 标准实施',
    stages: [
      {
        id: 'analyst',
        agent: 'analyst',
        description: '分析需求边界、影响范围、方案和风险',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
      {
        id: 'plan',
        agent: 'designer',
        description: '生成实施计划与任务文件',
        outputSchema: 'plan',
      },
      {
        id: 'implement',
        agent: 'dispatcher',
        description: '按计划驱动实现与审查',
        outputSchema: 'implementation',
      },
    ],
  },
  {
    name: 'quick-fix',
    description: '快速修复流程：分析 → 快速实施',
    stages: [
      {
        id: 'analyst',
        agent: 'analyst',
        description: '分析修复范围、边界和风险',
        outputSchema: 'analysis',
        allowedSubagents: ['search'],
      },
      {
        id: 'worker',
        agent: 'worker',
        description: '驱动 fixer 实现并用 oracle 审查',
        outputSchema: 'implementation',
      },
    ],
  },
  {
    name: 'research-only',
    description: '研究流程：分析',
    stages: [
      {
        id: 'analyst',
        agent: 'analyst',
        description: '分析研究问题并做只读研究结论',
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
