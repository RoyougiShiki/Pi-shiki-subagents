import { describe, expect, test } from 'bun:test';
import type { WorkflowsConfig } from '../../core/workflow-types';
import { createToolCallGates, createWorkflowStageGateHelpers } from './tool-call-gates';

const workflows: WorkflowsConfig = {
  default: 'flow',
  list: [
    {
      name: 'flow',
      description: 'synthetic flow',
      stages: [
        { id: 'analysis', agent: 'alpha', allowedSubagents: ['helper'] },
        { id: 'implementation', agent: 'beta', allowedSubagents: ['helper2'] },
        { id: 'review', agent: 'gamma' },
      ],
    },
  ],
};

function makeGates(args: {
  pipeline?: boolean;
  resumed?: boolean;
  recoveryStageIndex?: number;
  approvals?: boolean[];
  notices?: string[];
} = {}) {
  const helpers = createWorkflowStageGateHelpers({
    workflows,
    knownAgents: ['alpha', 'helper', 'beta', 'helper2', 'gamma'],
    getSessionRecoveryState: () => ({
      sessionWasResumed: args.resumed === true,
      recoveryCandidate: args.recoveryStageIndex === undefined ? null : {
        workflowName: 'flow',
        stageIndex: args.recoveryStageIndex,
        markerEvent: 'transition_approved',
        source: 'session_marker',
      },
    }),
  });
  const approvals = [...(args.approvals ?? [])];
  const gates = createToolCallGates({
    getWorkflowStageGateContext: helpers.getWorkflowStageGateContext,
    getWorkflowStageRuntimeSnapshot: helpers.getWorkflowStageRuntimeSnapshot,
    advanceWorkflowStage: helpers.advanceWorkflowStage,
    confirmWorkflowStageRecovery: helpers.confirmWorkflowStageRecovery,
    recordWorkflowStageAttempt: helpers.recordWorkflowStageAttempt,
    notifyWorkflowStageGateSkipped: () => {},
    isCurrentModePipeline: () => args.pipeline === true,
    resolveDelegationCaller: () => 'caller',
    emitWorkflowStageNotice: (text) => args.notices?.push(text),
  });
  const ctx = { ui: { confirm: async () => approvals.shift() ?? true } };
  return { gates, ctx, helpers };
}

const spawn = (agent: string) => ({ pool: 'spawn', id: `id-${agent}`, agent, task: 'Do the task with explicit context.' });

describe('tool call workflow stage gates', () => {
  test('allows non-spawn calls without stage checks', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, { pool: 'list' });
    expect(decision.ok).toBe(true);
  });

  test('denies spawn calls with missing required parameters', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, { pool: 'spawn', id: 'x', agent: 'alpha' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('requires id, agent, and task');
  });

  test('denies spawn calls that fail the subagent task contract', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, { pool: 'spawn', id: 'x', agent: 'alpha', task: '分析' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('subagent_task_object_missing');
  });

  test('allows when workflow stage context is missing', async () => {
    const gates = createToolCallGates({
      getWorkflowStageGateContext: () => null,
      getWorkflowStageRuntimeSnapshot: () => ({ currentStageIndex: 0, sessionWasResumed: false, recoveryConsumed: false, history: [] }),
      advanceWorkflowStage: () => ({ ok: false, reason: 'unused' }),
      confirmWorkflowStageRecovery: () => ({ ok: false, reason: 'unused' }),
      recordWorkflowStageAttempt: () => {},
      notifyWorkflowStageGateSkipped: () => {},
      isCurrentModePipeline: () => true,
      resolveDelegationCaller: () => 'caller',
    });
    const decision = await gates.gatePipelineSubagent({ ui: { confirm: async () => false } }, spawn('alpha'));
    expect(decision.ok).toBe(true);
  });

  test('bypasses workflow stage gate in non-pipeline modes', async () => {
    const { gates, ctx } = makeGates({ pipeline: false });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('gamma'));
    expect(decision.ok).toBe(true);
  });

  test('allows current stage without approval', async () => {
    const { gates, ctx } = makeGates({ pipeline: true, approvals: [false] });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('alpha'));
    expect(decision.ok).toBe(true);
  });

  test('approves next stage, advances cursor, and emits marker', async () => {
    const notices: string[] = [];
    const { gates, ctx, helpers } = makeGates({ pipeline: true, approvals: [true], notices });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('beta'));
    expect(decision.ok).toBe(true);
    expect(helpers.getWorkflowStageRuntimeSnapshot().currentStageIndex).toBe(1);
    expect(notices.join('\n')).toContain('event: transition_approved');
  });

  test('denies invalid unknown target agents', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('unknown-agent'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('not registered');
  });

  test('denies past stage calls after advancing', async () => {
    const { gates, ctx } = makeGates({ pipeline: true, approvals: [true] });
    expect((await gates.gatePipelineSubagent(ctx, spawn('beta'))).ok).toBe(true);
    const decision = await gates.gatePipelineSubagent(ctx, spawn('alpha'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('past workflow stage');
  });

  test('denies next stage approval when confirm UI is unavailable', async () => {
    const { gates } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent({}, spawn('beta'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('ui.confirm');
  });

  test('blocks future stage in fresh sessions', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('gamma'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('future workflow stage');
  });

  test('resumed matching next stage uses recovery before normal transition', async () => {
    const notices: string[] = [];
    const { gates, ctx, helpers } = makeGates({ pipeline: true, resumed: true, recoveryStageIndex: 1, approvals: [true], notices });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('beta'));
    expect(decision.ok).toBe(true);
    expect(helpers.getWorkflowStageRuntimeSnapshot().currentStageIndex).toBe(1);
    expect(helpers.getWorkflowStageRuntimeSnapshot().recoveryConsumed).toBe(true);
    expect(notices.join('\n')).toContain('event: recovery_confirmed');
    expect(notices.join('\n')).not.toContain('event: transition_approved');
  });

  test('allows resumed future stage only when recovery candidate matches', async () => {
    const mismatch = makeGates({ pipeline: true, resumed: true, recoveryStageIndex: 1 });
    expect((await mismatch.gates.gatePipelineSubagent(mismatch.ctx, spawn('gamma'))).ok).toBe(false);

    const match = makeGates({ pipeline: true, resumed: true, recoveryStageIndex: 2, approvals: [true] });
    const decision = await match.gates.gatePipelineSubagent(match.ctx, spawn('gamma'));
    expect(decision.ok).toBe(true);
    expect(match.helpers.getWorkflowStageRuntimeSnapshot().currentStageIndex).toBe(2);
    expect(match.helpers.getWorkflowStageRuntimeSnapshot().recoveryConsumed).toBe(true);
  });
});
