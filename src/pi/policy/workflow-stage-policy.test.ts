import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '../../config/workflow-types';
import { checkWorkflowStageTargetAllowed, classifyWorkflowStageTarget, getStageAllowedAgents } from './workflow-stage-policy';

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
    {
      id: 'stage-three',
      agent: 'final-agent',
    },
  ],
};

const knownAgents = ['stage-agent', 'helper-agent', 'review-agent', 'future-agent', 'final-agent', 'outside-agent'];

describe('workflow stage policy', () => {
  test('classifies current, next, future, past, unrelated, and invalid targets', () => {
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'stage-agent', knownAgents }).kind).toBe('current');
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'future-agent', knownAgents }).kind).toBe('next');
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'final-agent', knownAgents }).kind).toBe('future');
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 2, targetAgent: 'stage-agent', knownAgents }).kind).toBe('past');
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'outside-agent', knownAgents }).kind).toBe('unrelated');
    expect(classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'missing-agent', knownAgents }).kind).toBe('invalid');
  });

  test('classifies custom names without hard-coded agents', () => {
    const custom: WorkflowDefinition = {
      name: 'custom-flow',
      description: 'custom names',
      stages: [
        { id: 'custom-stage', agent: 'alpha', allowedSubagents: ['beta'], review: { agent: 'gamma' } },
        { id: 'later', agent: 'delta' },
        { id: 'last', agent: 'epsilon' },
      ],
    };
    const customKnownAgents = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const current = classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'alpha', knownAgents: customKnownAgents });
    expect(current.kind).toBe('current');
    expect(current.targetStageId).toBe('custom-stage');
    // beta is in current stage allowedSubagents — classified as current, no approval
    const betaResult = classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'beta', knownAgents: customKnownAgents });
    expect(betaResult.kind).toBe('current');
    expect(betaResult.requiresApproval).toBe(false);
    expect(classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'delta', knownAgents: customKnownAgents }).kind).toBe('next');
    expect(classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'epsilon', knownAgents: customKnownAgents }).kind).toBe('future');
    expect(classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 1, targetAgent: 'alpha', knownAgents: customKnownAgents }).kind).toBe('past');
    expect(classifyWorkflowStageTarget({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'zeta', knownAgents: customKnownAgents }).kind).toBe('unrelated');
  });

  test('classifies invalid workflow config referencing unknown target stage agents', () => {
    const invalid: WorkflowDefinition = {
      name: 'invalid-flow',
      description: 'invalid workflow',
      stages: [
        { id: 'valid-stage', agent: 'alpha' },
        { id: 'invalid-stage', agent: 'beta', allowedSubagents: ['missing-stage-agent'] },
      ],
    };
    const result = classifyWorkflowStageTarget({ workflows: [invalid], workflowName: 'invalid-flow', stageIndex: 0, targetAgent: 'beta', knownAgents: ['alpha', 'beta'] });
    expect(result.kind).toBe('invalid');
    expect(result.reason).toContain('references unknown agent');
  });
  test('computes unique allowed agents from current stage config', () => {
    expect(getStageAllowedAgents(workflow.stages[0])).toEqual(['stage-agent', 'helper-agent']);
  });

  test('allows current stage agent and marks it as requiring approval', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'stage-agent', knownAgents });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  test('classifies review-only agent as unrelated', () => {
    const result = classifyWorkflowStageTarget({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'review-agent', knownAgents });
    expect(result.kind).toBe('unrelated');
  });

  test('allows current stage allowedSubagents without approval', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'helper-agent', knownAgents });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  test('blocks future stage agent', () => {
    const result = checkWorkflowStageTargetAllowed({ workflows: [workflow], workflowName: 'flow', stageIndex: 0, targetAgent: 'future-agent', knownAgents });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual(['stage-agent', 'helper-agent']);
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
    // review agents are no longer part of stage allowed agents
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'gamma', knownAgents: customKnownAgents }).allowed).toBe(false);
    expect(checkWorkflowStageTargetAllowed({ workflows: [custom], workflowName: 'custom-flow', stageIndex: 0, targetAgent: 'delta', knownAgents: customKnownAgents }).allowed).toBe(false);
  });
});
