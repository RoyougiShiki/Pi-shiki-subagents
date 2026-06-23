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
    expect(fresh.confirmRecovery({ workflowName: 'flow', stageIndex: 2, targetAgent: 'dispatcher' }).ok).toBe(false);

    const runtime = createWorkflowStageRuntime({ sessionWasResumed: true, recoveryCandidate: candidate });
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 3, targetAgent: 'dispatcher' }).ok).toBe(false);
    expect(runtime.confirmRecovery({ workflowName: 'other', stageIndex: 2, targetAgent: 'dispatcher' }).ok).toBe(false);
    const result = runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 2, stageId: 'work', targetAgent: 'dispatcher', timestamp: 2 });
    expect(result.ok).toBe(true);
    expect(runtime.getCurrentStageIndex()).toBe(2);
    expect(runtime.getSnapshot().history[0]).toMatchObject({ type: 'recovery_confirmed', stageIndex: 2 });
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 2, targetAgent: 'dispatcher' }).ok).toBe(false);
  });

  test('setRecoveryContext clears candidate when not resumed', () => {
    const runtime = createWorkflowStageRuntime({ sessionWasResumed: true, recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' } });
    runtime.setRecoveryContext({ sessionWasResumed: false, recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' } });
    expect(runtime.getSnapshot().sessionWasResumed).toBe(false);
    expect(runtime.getSnapshot().recoveryCandidate).toBeUndefined();
  });

  test('reset clears recovery context by default', () => {
    const runtime = createWorkflowStageRuntime({
      sessionWasResumed: true,
      recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' },
    });
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 1, targetAgent: 'dispatcher' }).ok).toBe(true);

    runtime.reset({ workflowName: 'flow', initialStageIndex: 0 });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionWasResumed).toBe(false);
    expect(snapshot.recoveryCandidate).toBeUndefined();
    expect(snapshot.recoveryConsumed).toBe(false);
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 1, targetAgent: 'dispatcher' }).ok).toBe(false);
  });

  test('reset can preserve recovery context for internal workflow alignment', () => {
    const runtime = createWorkflowStageRuntime({
      sessionWasResumed: true,
      recoveryCandidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' },
    });

    runtime.reset({ workflowName: 'flow', initialStageIndex: 0, preserveRecoveryContext: true });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionWasResumed).toBe(true);
    expect(snapshot.recoveryCandidate?.workflowName).toBe('flow');
    expect(runtime.confirmRecovery({ workflowName: 'flow', stageIndex: 1, targetAgent: 'dispatcher' }).ok).toBe(true);
  });

  test('records attempts append-only', () => {
    const runtime = createWorkflowStageRuntime();
    runtime.recordAttemptStarted({ workflowName: 'flow', stageIndex: 0, targetAgent: 'a', poolId: 'a-1', timestamp: 1 });
    runtime.recordAttemptStarted({ workflowName: 'flow', stageIndex: 0, targetAgent: 'a', poolId: 'a-2', timestamp: 2 });
    expect(runtime.getSnapshot().history).toHaveLength(2);
    expect(runtime.getSnapshot().history[0]).toMatchObject({ type: 'attempt_started', poolId: 'a-1' });
  });

  test('records approved work package boundary by pool id and task', () => {
    const runtime = createWorkflowStageRuntime();

    expect(runtime.approveWorkPackage({
      workflowName: 'flow',
      stageIndex: 0,
      targetAgent: 'dispatcher',
      poolId: '',
      task: 'Do the task',
    }).ok).toBe(false);

    const result = runtime.approveWorkPackage({
      workflowName: 'flow',
      stageIndex: 0,
      stageId: 'fix',
      targetAgent: 'dispatcher',
      poolId: 'fix-1',
      task: 'Do the task',
      timestamp: 3,
    });

    expect(result.ok).toBe(true);
    expect(runtime.getSnapshot().approvedWorkPackage).toEqual({
      workflowName: 'flow',
      stageIndex: 0,
      stageId: 'fix',
      targetAgent: 'dispatcher',
      poolId: 'fix-1',
      task: 'Do the task',
    });
    expect(runtime.getSnapshot().history[0]).toMatchObject({
      type: 'work_package_approved',
      poolId: 'fix-1',
      task: 'Do the task',
    });
  });

  test('records bounded review verdict rounds and marks exhausted failures', () => {
    const runtime = createWorkflowStageRuntime({ workflowName: 'flow', initialStageIndex: 2 });
    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      targetAgent: 'oracle',
      poolId: 'review-1',
      timestamp: 3,
    });

    const first = runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'FAIL',
      maxReviewRounds: 2,
      timestamp: 4,
    });
    expect(first).toMatchObject({
      ok: true,
      rounds: 1,
      maxReviewRounds: 2,
      lastVerdict: 'FAIL',
      exhausted: false,
    });

    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      targetAgent: 'oracle',
      poolId: 'review-2',
    });
    const second = runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      poolId: 'review-2',
      verifierAgent: 'oracle',
      verdict: 'PARTIAL',
      maxReviewRounds: 2,
      timestamp: 5,
    });
    expect(second).toMatchObject({
      ok: true,
      rounds: 2,
      lastVerdict: 'PARTIAL',
      exhausted: true,
    });
    expect(runtime.getSnapshot().reviewLoop).toMatchObject({
      workflowName: 'flow',
      stageIndex: 2,
      rounds: 2,
      exhausted: true,
    });
    expect(runtime.getSnapshot().history.at(-1)).toMatchObject({
      type: 'review_verdict_recorded',
      round: 2,
      exhausted: true,
    });
  });

  test('rejects review verdicts for unknown, mismatched, or repeated pool ids', () => {
    const runtime = createWorkflowStageRuntime({ workflowName: 'flow', initialStageIndex: 1 });
    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 1,
      stageId: 'implement',
      targetAgent: 'oracle',
      poolId: 'review-1',
    });

    expect(runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 1,
      stageId: 'implement',
      poolId: 'missing',
      verifierAgent: 'oracle',
      verdict: 'PASS',
      maxReviewRounds: 2,
    }).ok).toBe(false);

    expect(runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 1,
      stageId: 'other',
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'PASS',
      maxReviewRounds: 2,
    }).ok).toBe(false);

    const recorded = runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 1,
      stageId: 'implement',
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'PASS',
      maxReviewRounds: 2,
    });
    expect(recorded.ok).toBe(true);
    expect(runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 1,
      stageId: 'implement',
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'PASS',
      maxReviewRounds: 2,
    }).ok).toBe(false);
  });

  test('keeps exhausted review loops sticky until stage reset', () => {
    const runtime = createWorkflowStageRuntime({ workflowName: 'flow' });
    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 0,
      targetAgent: 'oracle',
      poolId: 'review-1',
    });
    expect(runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 0,
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'FAIL',
      maxReviewRounds: 1,
    })).toMatchObject({ ok: true, exhausted: true });

    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 0,
      targetAgent: 'oracle',
      poolId: 'review-2',
    });
    const latePass = runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 0,
      poolId: 'review-2',
      verifierAgent: 'oracle',
      verdict: 'PASS',
      maxReviewRounds: 1,
    });
    expect(latePass.ok).toBe(false);
    expect(runtime.getSnapshot().reviewLoop).toMatchObject({
      lastVerdict: 'FAIL',
      exhausted: true,
    });
  });

  test('clears review loop state when advancing stage', () => {
    const runtime = createWorkflowStageRuntime();
    runtime.recordAttemptStarted({
      workflowName: 'flow',
      stageIndex: 0,
      targetAgent: 'oracle',
      poolId: 'review-1',
    });
    runtime.recordReviewVerdict({
      workflowName: 'flow',
      stageIndex: 0,
      poolId: 'review-1',
      verifierAgent: 'oracle',
      verdict: 'FAIL',
      maxReviewRounds: 1,
    });
    expect(runtime.getSnapshot().reviewLoop?.exhausted).toBe(true);

    expect(runtime.advanceToNextStage({
      workflowName: 'flow',
      fromStageIndex: 0,
      toStageIndex: 1,
      targetAgent: 'next',
    }).ok).toBe(true);
    expect(runtime.getSnapshot().reviewLoop).toBeUndefined();
  });
});
