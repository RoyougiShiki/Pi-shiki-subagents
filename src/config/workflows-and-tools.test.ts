import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_WORKFLOWS, WorkflowsConfigSchema } from './schema';

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
        if (stage.id === 'analyst') {
          expect(stage.allowedSubagents).toContain('search');
        }
      }
    }
  });

  test('workflows schema defaults to standard-dev and embeds DEFAULT_WORKFLOWS', () => {
    const parsed = WorkflowsConfigSchema.parse({});
    expect(parsed.default).toBe('standard-dev');
    expect(parsed.list.map((workflow) => workflow.name)).toEqual(
      DEFAULT_WORKFLOWS.map((workflow) => workflow.name),
    );
  });

  test('agents-default.json keeps coordinator scoped and fallback as full rescue mode', () => {
    const configPath = path.join(import.meta.dir, '..', 'adapters', 'agents-default.json');
    const defs = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, { type?: string; tools?: string[]; delegates?: string[] }>;

    expect(defs.coordinator?.tools).toEqual([
      'ask_user_question',
      'todo',
      'switch_mode',
      'omo_subagent',
      'omo_council',
    ]);
    expect(defs.coordinator?.delegates).toEqual(['search', 'oracle']);

    expect(defs.fallback?.tools).toEqual(expect.arrayContaining([
      'read',
      'write',
      'edit',
      'bash',
      'omo_subagent',
      'omo_council',
      'todo',
    ]));
    const subagents = Object.entries(defs)
      .filter(([name, def]) => name !== 'fallback' && (def.type === 'subagent' || def.type === 'both'))
      .map(([name]) => name);
    expect(defs.fallback?.delegates?.sort()).toEqual(subagents.sort());

    for (const leaf of ['oracle', 'fixer', 'observer']) {
      expect(defs[leaf]?.tools ?? []).not.toContain('omo_subagent');
    }
  });
});
