import { describe, expect, test } from 'bun:test';
import { createWorkflowStageRuntime } from './workflow-stage-runtime';

describe('workflow stage runtime', () => {
  test('normalizes invalid initial stage index', () => {
    expect(createWorkflowStageRuntime({ initialStageIndex: -1 }).getCurrentStageIndex()).toBe(0);
    expect(createWorkflowStageRuntime({ initialStageIndex: 1.5 }).getCurrentStageIndex()).toBe(0);
  });

  test('advances only to the immediate next stage', () => {
    const runtime = createWorkflowStageRuntime({ workflowName: 'flow' });
    expect(runtime.advanceToNextStage({ workflowName: 'flow', fromStageIndex: 0, toStageIndex: 2, targetAgent: 'b' }).ok).toBe(false);
    const result = runtime.advanceToNextStage({ workflowName: 'flow', fromStageIndex: 0, toStageIndex: 1, fromStageId: 'a', toStageId: 'b', targetAgent: 'b', timestamp: 1 });
    expect(result.ok).toBe(true);
    expect(runtime.getCurrentStageIndex()).toBe(1);
    expect(runtime.getSnapshot().history[0]).toMatchObject({ type: 'transition_approved', toStageIndex: 1 });
  });

  test('blocks transition when from stage does not match cursor', () => {
    const runtime = createWorkflowStageRuntime({ initialStageIndex: 1 });
    expect(runtime.advanceToNextStage({ workflowName: 'flow', fromStageIndex: 0, toStageIndex: 1, targetAgent: 'b' }).ok).toBe(false);
  });

  test('confirms recovery only after resume and matching candidate', () => {
    const candidate = { workflowName: 'flow', stageIndex: 2, stageId: 'work', markerEvent: 'transition_approved' as const, source: 'session_marker' as const };
    const fresh = createWorkflowStageRuntime({ recoveryCandidate: candidate });
    expect(fresh.confirmRecovery({ workflowName: 'flow', stageIndex: 2, targetAgent: 'worker' }).ok).toBe(false);

    const runtime = createWorkflowStageRuntime({ sessionWasResumed: true, recoveryCandidate: candidate });
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 3, targetAgent: 'worker' }).ok).toBe(false);
    expect(runtime.confirmRecovery({ workflowName: 'other', stageIndex: 2, targetAgent: 'worker' }).ok).toBe(false);
    const result = runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 2, stageId: 'work', targetAgent: 'worker', timestamp: 2 });
    expect(result.ok).toBe(true);
    expect(runtime.getCurrentStageIndex()).toBe(2);
    expect(runtime.getSnapshot().history[0]).toMatchObject({ type: 'recovery_confirmed', stageIndex: 2 });
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 2, targetAgent: 'worker' }).ok).toBe(false);
  });

  test('setRecoveryContext clears candidate when not resumed', () => {
    const runtime = createWorkflowStageRuntime({ sessionWasResumed: true, recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' } });
    runtime.setRecoveryContext({ sessionWasResumed: false, recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' } });
    expect(runtime.getSnapshot().sessionWasResumed).toBe(false);
    expect(runtime.getSnapshot().recoveryCandidate).toBeUndefined();
  });

  test('records attempts append-only', () => {
    const runtime = createWorkflowStageRuntime();
    runtime.recordAttemptStarted({ workflowName: 'flow', stageIndex: 0, targetAgent: 'a', timestamp: 1 });
    runtime.recordAttemptStarted({ workflowName: 'flow', stageIndex: 0, targetAgent: 'a', timestamp: 2 });
    expect(runtime.getSnapshot().history).toHaveLength(2);
  });
});
