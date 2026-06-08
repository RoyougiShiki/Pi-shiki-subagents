import { describe, expect, test, beforeEach } from 'bun:test';
import type { WorkflowsConfig } from '../../config/workflow-types';
import { consumePipelineDelegationGrant, resetPipelineDelegationGrantsForTests } from './pipeline-delegation-grants';
import { createToolCallGates, createWorkflowStageGateHelpers, SWITCH_MODE_APPROVAL_MESSAGE } from './tool-call-gates';
import type { WorkflowStageRecoveryCandidate } from './workflow-stage-runtime';

const workflows: WorkflowsConfig = {
  default: 'legacy-unused-flow',
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
  caller?: string;
  workflowName?: string | null;
  workflowsConfig?: WorkflowsConfig;
} = {}) {
  const helpers = createWorkflowStageGateHelpers({
    workflows: args.workflowsConfig ?? workflows,
    knownAgents: ['alpha', 'helper', 'beta', 'helper2', 'gamma'],
    getActiveWorkflowName: () => args.workflowName === undefined ? 'flow' : args.workflowName ?? undefined,
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
    getWorkflowStageGateConfigError: helpers.getWorkflowStageGateConfigError,
    getWorkflowStageRuntimeSnapshot: helpers.getWorkflowStageRuntimeSnapshot,
    advanceWorkflowStage: helpers.advanceWorkflowStage,
    confirmWorkflowStageRecovery: helpers.confirmWorkflowStageRecovery,
    recordWorkflowStageAttempt: helpers.recordWorkflowStageAttempt,
    notifyWorkflowStageGateSkipped: () => {},
    isCurrentModePipeline: () => args.pipeline === true,
    resolveDelegationCaller: () => args.caller,
    emitWorkflowStageNotice: (text) => args.notices?.push(text),
  });
  const ctx = { ui: { confirm: async () => approvals.shift() ?? true } };
  return { gates, ctx, helpers };
}

const spawn = (agent: string) => ({ pool: 'spawn', id: `id-${agent}`, agent, task: 'Do the task with explicit context.' });
const send = (id = 'existing-id') => ({ pool: 'send', id, message: 'Continue with the confirmed context.' });
const resume = (id = 'saved-id') => ({ pool: 'resume', id, message: 'Resume the saved work.' });

describe('tool call workflow stage gates', () => {
  beforeEach(() => {
    resetPipelineDelegationGrantsForTests();
  });

  test('allows non-execution pool calls without stage checks', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, { pool: 'list' });
    expect(decision.ok).toBe(true);
  });

  test('blocks pipeline execution pool actions when workflow stage context is missing', async () => {
    const missingBinding = makeGates({ pipeline: true, workflowName: null });

    const sendDecision = await missingBinding.gates.gatePipelineSubagent(missingBinding.ctx, send());
    expect(sendDecision.ok).toBe(false);
    if (!sendDecision.ok) expect(sendDecision.reason).toContain('agents.<mode>.workflow');

    const resumeDecision = await missingBinding.gates.gatePipelineSubagent(missingBinding.ctx, resume());
    expect(resumeDecision.ok).toBe(false);
    if (!resumeDecision.ok) expect(resumeDecision.reason).toContain('agents.<mode>.workflow');
  });

  test('allows send and resume in pipeline modes with valid workflow binding', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    expect((await gates.gatePipelineSubagent(ctx, send())).ok).toBe(true);
    expect((await gates.gatePipelineSubagent(ctx, resume())).ok).toBe(true);
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

  test('blocks pipeline modes when workflow stage context is missing', async () => {
    const gates = createToolCallGates({
      getWorkflowStageGateContext: () => null,
      getWorkflowStageGateConfigError: () => 'missing workflow binding',
      getWorkflowStageRuntimeSnapshot: () => ({ currentStageIndex: 0, sessionWasResumed: false, recoveryConsumed: false, history: [] }),
      advanceWorkflowStage: () => ({ ok: false, reason: 'unused' }),
      confirmWorkflowStageRecovery: () => ({ ok: false, reason: 'unused' }),
      recordWorkflowStageAttempt: () => {},
      notifyWorkflowStageGateSkipped: () => {},
      isCurrentModePipeline: () => true,
      resolveDelegationCaller: () => 'caller',
    });
    const decision = await gates.gatePipelineSubagent({ ui: { confirm: async () => false } }, spawn('alpha'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('missing workflow binding');
  });

  test('bypasses workflow stage gate in non-pipeline modes', async () => {
    const { gates, ctx } = makeGates({ pipeline: false });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('gamma'));
    expect(decision.ok).toBe(true);
  });

  test('does not use workflows.default as a runtime fallback', async () => {
    const missingBinding = makeGates({
      pipeline: true,
      workflowName: null,
      workflowsConfig: {
        default: 'flow',
        list: workflows.list,
      },
    });
    const blocked = await missingBinding.gates.gatePipelineSubagent(missingBinding.ctx, spawn('alpha'));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('agents.<mode>.workflow');
  });

  test('resets stage cursor when the active mode workflow changes', async () => {
    let activeWorkflow = 'flow';
    const helpers = createWorkflowStageGateHelpers({
      workflows: {
        list: [
          ...workflows.list,
          {
            name: 'alt-flow',
            description: 'alternate synthetic flow',
            stages: [
              { id: 'alt-analysis', agent: 'alpha' },
              { id: 'alt-implementation', agent: 'beta' },
            ],
          },
        ],
      },
      knownAgents: ['alpha', 'helper', 'beta', 'helper2', 'gamma'],
      getActiveWorkflowName: () => activeWorkflow,
    });

    const gates = createToolCallGates({
      getWorkflowStageGateContext: helpers.getWorkflowStageGateContext,
      getWorkflowStageGateConfigError: helpers.getWorkflowStageGateConfigError,
      getWorkflowStageRuntimeSnapshot: helpers.getWorkflowStageRuntimeSnapshot,
      advanceWorkflowStage: helpers.advanceWorkflowStage,
      confirmWorkflowStageRecovery: helpers.confirmWorkflowStageRecovery,
      recordWorkflowStageAttempt: helpers.recordWorkflowStageAttempt,
      notifyWorkflowStageGateSkipped: () => {},
      isCurrentModePipeline: () => true,
      resolveDelegationCaller: () => 'caller',
    });

    expect((await gates.gatePipelineSubagent({ ui: { confirm: async () => true } }, spawn('beta'))).ok).toBe(true);
    expect(helpers.getWorkflowStageRuntimeSnapshot().currentStageIndex).toBe(1);

    activeWorkflow = 'alt-flow';
    const context = helpers.getWorkflowStageGateContext();
    expect(context?.workflowName).toBe('alt-flow');
    expect(context?.stageIndex).toBe(0);
    expect(context?.stage.id).toBe('alt-analysis');
  });

  test('mode workflow reset clears session recovery source state', async () => {
    let sessionWasResumed = true;
    let recoveryCandidate: WorkflowStageRecoveryCandidate | null = {
      workflowName: 'flow',
      stageIndex: 1,
      markerEvent: 'transition_approved' as const,
      source: 'session_marker' as const,
    };
    const helpers = createWorkflowStageGateHelpers({
      workflows,
      knownAgents: ['alpha', 'helper', 'beta', 'helper2', 'gamma'],
      getActiveWorkflowName: () => 'flow',
      getSessionRecoveryState: () => ({ sessionWasResumed, recoveryCandidate }),
      clearSessionRecoveryState: () => {
        sessionWasResumed = false;
        recoveryCandidate = null;
      },
    });

    expect(helpers.getWorkflowStageRuntimeSnapshot().recoveryCandidate?.stageIndex).toBe(1);
    helpers.resetWorkflowStageRuntime('flow');
    expect(helpers.getWorkflowStageRuntimeSnapshot().recoveryCandidate).toBeUndefined();
    expect(sessionWasResumed).toBe(false);
    expect(recoveryCandidate).toBeNull();
  });

  test('blocks pipeline modes when the bound workflow is unknown', async () => {
    const { gates, ctx } = makeGates({ pipeline: true, workflowName: 'missing-flow' });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('alpha'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('missing-flow');
  });

  test('treats disabled or hidden stage agents as invalid workflow config', async () => {
    const helpers = createWorkflowStageGateHelpers({
      workflows,
      knownAgents: ['helper', 'beta', 'helper2', 'gamma'],
      getActiveWorkflowName: () => 'flow',
    });
    const gates = createToolCallGates({
      getWorkflowStageGateContext: helpers.getWorkflowStageGateContext,
      getWorkflowStageGateConfigError: helpers.getWorkflowStageGateConfigError,
      getWorkflowStageRuntimeSnapshot: helpers.getWorkflowStageRuntimeSnapshot,
      advanceWorkflowStage: helpers.advanceWorkflowStage,
      confirmWorkflowStageRecovery: helpers.confirmWorkflowStageRecovery,
      recordWorkflowStageAttempt: helpers.recordWorkflowStageAttempt,
      notifyWorkflowStageGateSkipped: () => {},
      isCurrentModePipeline: () => true,
      resolveDelegationCaller: () => 'caller',
    });

    const decision = await gates.gatePipelineSubagent({ ui: { confirm: async () => true } }, spawn('alpha'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('references unknown agent "alpha"');
  });

  test('allows current stage without approval', async () => {
    const { gates, ctx } = makeGates({ pipeline: true, approvals: [false], caller: 'caller' });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('alpha'));
    expect(decision.ok).toBe(true);
  });

  test('does not issue pipeline grant when delegation caller is missing', async () => {
    const { gates, ctx } = makeGates({ pipeline: true, caller: undefined });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('alpha'));

    expect(decision.ok).toBe(true);
    expect(consumePipelineDelegationGrant({ caller: undefined, target: 'alpha', depth: 0 })).toBeUndefined();
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

  test('blocks later-stage helper agents before their workflow stage is active', async () => {
    const { gates, ctx } = makeGates({ pipeline: true });
    const decision = await gates.gatePipelineSubagent(ctx, spawn('helper2'));

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('next workflow stage');
      expect(decision.reason).toContain('not the stage primary agent');
    }
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

  test('agent switch_mode calls require user approval', async () => {
    const confirmations: Array<{ title: string; message: string }> = [];
    const { gates } = makeGates();
    const decision = await gates.gateSwitchMode({
      ui: {
        confirm: async (title: string, message: string) => {
          confirmations.push({ title, message });
          return true;
        },
      },
    }, { mode: 'target-mode' });

    expect(decision.ok).toBe(true);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].title).toBe(SWITCH_MODE_APPROVAL_MESSAGE.title);
    expect(confirmations[0].message).toContain(SWITCH_MODE_APPROVAL_MESSAGE.action);
    expect(confirmations[0].message).toContain('target-mode');
  });

  test('agent switch_mode calls are blocked when user rejects approval', async () => {
    const { gates } = makeGates();
    const decision = await gates.gateSwitchMode({ ui: { confirm: async () => false } }, { mode: 'target-mode' });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('用户拒绝');
  });

  test('agent switch_mode calls are blocked when approval UI is unavailable', async () => {
    const { gates } = makeGates();
    const decision = await gates.gateSwitchMode({}, { mode: 'target-mode' });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('ui.confirm');
  });

  test('switch_mode calls without target mode do not request approval', async () => {
    let confirmCalled = false;
    const { gates } = makeGates();
    const decision = await gates.gateSwitchMode({
      ui: {
        confirm: async () => {
          confirmCalled = true;
          return true;
        },
      },
    }, {});

    expect(decision.ok).toBe(true);
    expect(confirmCalled).toBe(false);
  });
});
