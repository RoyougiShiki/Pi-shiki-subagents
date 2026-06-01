import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '../../core/workflow-types';
import { checkWorkflowStageTargetAllowed, getStageAllowedAgents } from './workflow-stage-policy';

const workflow: WorkflowDefinition = {
  name: 'flow',
  description: 'synthetic workflow',
  stages: [
    {
      id: 'stage-one',
      agent: 'stage-agent',
      allowedSubagents: ['helper-agent', 'stage-agent'],
      review: { agent: 'review-agent' },
    },
    {
      id: 'stage-two',
      agent: 'future-agent',
    },
  ],
};

const knownAgents = ['stage-agent', 'helper-agent', 'review-agent', 'future-agent'];

describe('workflow stage policy', () => {
  test('computes unique allowed agents from current stage config', () => {
    expect(getStageAllowedAgents(workflow.stages[0])).toEqual(['stage-agent', 'helper-agent', 'review-agent']);
  });

  test('allows current stage agent and marks it as requiring approval', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'stage-agent', knownAgents });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  test('allows current stage review agent without approval', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'review-agent', knownAgents });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  test('allows current stage allowedSubagents without approval', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'helper-agent', knownAgents });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  test('blocks future stage agent', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'future-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual(['stage-agent', 'helper-agent', 'review-agent']);
  });

  test('blocks blank target agent', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: '   ', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Missing target agent');
  });

  test('allows configured agents when knownAgents is omitted', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'stage-agent' });
    expect(result.allowed).toBe(true);
  });

  test('trims knownAgents entries before comparing', () => {
    const spacedKnownAgents = ['stage-agent ', 'helper-agent ', 'review-agent ', 'future-agent '];
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'helper-agent', knownAgents: spacedKnownAgents });
    expect(result.allowed).toBe(true);
  });

  test('blocks unknown target agent', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'missing-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not registered');
  });

  test('blocks unknown workflow', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'missing-flow', stageIndex: 0, targetAgent: 'stage-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found');
  });

  test('blocks missing stage index', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 9, targetAgent: 'stage-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no stage');
  });

  test('blocks invalid workflow config that references unknown stage agents', () => {
    const invalid: WorkflowDefinition = {
      name: 'invalid-flow',
      description: 'invalid workflow',
      stages: [{ id: 'invalid-stage', agent: 'unknown-stage-agent' }],
    };
    const result = checkWorkflowStageTargetAllowed({ workflows: [invalid], workflowName: 'invalid-flow', stageIndex: 0, targetAgent: 'unknown-stage-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('references unknown agent');
  });

  test('does not hard-code workflow or agent names', () => {
    const custom: WorkflowDefinition = {
      name: 'custom-flow',
      description: 'custom names',
      stages: [
        { id: 'custom-stage', agent: 'alpha', allowedSubagents: ['beta'], review: { agent: 'gamma' } },
        { id: 'later', agent: 'delta' },
      ],
    };
    const customKnownAgents = ['alpha', 'beta', 'gamma', 'delta'];
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'alpha', knownAgents: customKnownAgents }).allowed).toBe(true);
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'beta', knownAgents: customKnownAgents }).allowed).toBe(true);
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'gamma', knownAgents: customKnownAgents }).allowed).toBe(true);
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'delta', knownAgents: customKnownAgents }).allowed).toBe(false);
  });
});
