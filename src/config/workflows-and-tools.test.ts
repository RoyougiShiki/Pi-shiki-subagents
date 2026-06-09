import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_WORKFLOWS, PluginConfigSchema, WorkflowsConfigSchema, resolveWorkflowList } from './schema';

describe('default workflows and agent tool matrix', () => {
  test('default workflows include the expected named flows with stage metadata', () => {
    const names = DEFAULT_WORKFLOWS.map((workflow) => workflow.name);
    expect(names).toEqual([
      'standard-dev',
      'quick-fix',
      'research-only',
    ]);

    for (const workflow of DEFAULT_WORKFLOWS) {
      expect(workflow.stages.length).toBeGreaterThan(0);
      for (const stage of workflow.stages) {
        expect(stage.agent).toBeTruthy();
        expect(stage.description).toBeTruthy();
        expect(stage.outputSchema).toBeTruthy();
        if (stage.id === 'analysis') {
          expect(stage.allowedSubagents).toContain('search');
        }
      }
    }

    const standardDev = DEFAULT_WORKFLOWS.find((workflow) => workflow.name === 'standard-dev');
    expect(standardDev?.stages.map((stage) => stage.agent)).toEqual([
      'analyst',
      'designer',
      'dispatcher',
    ]);
    expect(standardDev?.stages.at(-1)?.allowedSubagents).toEqual([
      'fixer',
      'oracle',
    ]);

    const quickFix = DEFAULT_WORKFLOWS.find((workflow) => workflow.name === 'quick-fix');
    expect(quickFix?.stages.map((stage) => stage.agent)).toEqual([
      'analyst',
      'worker',
    ]);
    expect(quickFix?.stages.at(-1)?.allowedSubagents).toEqual([
      'fixer',
      'oracle',
    ]);
  });

  test('workflows schema embeds DEFAULT_WORKFLOWS without a runtime default', () => {
    const parsed = WorkflowsConfigSchema.parse({});
    expect(parsed.default).toBeUndefined();
    expect(parsed.list.map((workflow) => workflow.name)).toEqual(
      DEFAULT_WORKFLOWS.map((workflow) => workflow.name),
    );
  });

  test('resolveWorkflowList is the single fallback for missing workflow lists', () => {
    const custom = [
      {
        name: 'custom-flow',
        description: 'Custom',
        stages: [{ agent: 'custom-agent' }],
      },
    ];

    expect(resolveWorkflowList(undefined)).toBe(DEFAULT_WORKFLOWS);
    expect(resolveWorkflowList({ list: [] })).toBe(DEFAULT_WORKFLOWS);
    expect(resolveWorkflowList({ list: custom })).toBe(custom);
  });

  test('agent config schema accepts pipeline mode workflow bindings and user-command modes', () => {
    const parsed = PluginConfigSchema.parse({
      agents: {
        customLead: {
          type: 'mode',
          pipelineMode: true,
          workflow: 'custom-flow',
        },
        customRescue: {
          type: 'mode',
          pipelineMode: false,
          requiresUserCommand: true,
        },
      },
      workflows: {
        list: [
          {
            name: 'custom-flow',
            description: 'Custom',
            stages: [{ id: 'work', agent: 'customWorker' }],
          },
        ],
      },
    });

    expect(parsed.agents?.customLead?.pipelineMode).toBe(true);
    expect(parsed.agents?.customLead?.workflow).toBe('custom-flow');
    expect(parsed.agents?.customRescue?.requiresUserCommand).toBe(true);
  });

  test('agents-default.json keeps coordinator scoped and fallback as full rescue mode', () => {
    const configPath = path.join(import.meta.dir, '..', 'adapters', 'agents-default.json');
    const defs = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, { type?: string; tools?: string[]; roles?: string[]; delegates?: string[]; workflow?: string }>;

    // coordinator 使用工具组引用
    expect(defs.coordinator?.tools).toEqual(['@交互', '@子代理']);
    expect(defs.coordinator?.delegates).toEqual(['search', 'oracle']);
    expect(defs.coordinator?.workflow).toBe('standard-dev');
    expect(defs.worker?.delegates).toEqual(['fixer', 'oracle']);
    expect(defs.worker?.roles).toEqual(['流程', '管理']);

    // fallback 使用 "*" 表示全部工具
    expect(defs.fallback?.tools).toEqual(['*']);
    const subagents = Object.entries(defs)
      .filter(([name, def]) => name !== 'fallback' && (def.type === 'subagent' || def.type === 'both'))
      .map(([name]) => name);
    expect(defs.fallback?.delegates?.sort()).toEqual(subagents.sort());

    for (const leaf of ['oracle', 'fixer', 'observer']) {
      expect(defs[leaf]?.tools ?? []).not.toContain('omo_subagent');
    }
  });
});
