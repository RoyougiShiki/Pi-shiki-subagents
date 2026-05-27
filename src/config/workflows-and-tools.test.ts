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

  test('agents-default.json keeps coordinator on workflow controls and leaf agents without omo_subagent', () => {
    const configPath = path.join(import.meta.dir, '..', 'adapters', 'agents-default.json');
    const defs = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, { tools?: string[] }>;

    expect(defs.coordinator?.tools).toEqual([
      'start_workflow',
      'list_workflows',

      'workflow_status',
      'continue_workflow',
      'send_stage_message',
      'abort_workflow',
      'retry_stage',
      'reject_transition',
      'ask_user_question',
    ]);

    for (const leaf of ['oracle', 'fixer', 'explorer', 'librarian', 'observer']) {
      expect(defs[leaf]?.tools ?? []).not.toContain('omo_subagent');
    }
  });
});
