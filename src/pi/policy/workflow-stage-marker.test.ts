import { describe, expect, test } from 'bun:test';
import {
  createWorkflowStageMarkerNotice,
  createWorkflowStageResumeNotice,
  formatWorkflowStageMarker,
  formatWorkflowStageResumeNotice,
  parseWorkflowStageMarkersFromEntries,
} from './workflow-stage-marker';

describe('workflow stage marker', () => {
  test('formats and parses a marker roundtrip', () => {
    const marker = formatWorkflowStageMarker({
      event: 'transition_approved',
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      stageAgent: 'alpha',
      targetAgent: 'alpha',
      timestamp: 123,
    });
    const parsed = parseWorkflowStageMarkersFromEntries([marker]);
    expect(parsed).toEqual({
      workflowName: 'flow',
      stageIndex: 2,
      stageId: 'implement',
      stageAgent: 'alpha',
      markerEvent: 'transition_approved',
      timestamp: 123,
      source: 'session_marker',
    });
  });

  test('parses the last valid marker', () => {
    const first = formatWorkflowStageMarker({ event: 'transition_approved', workflowName: 'flow', stageIndex: 1, targetAgent: 'a', timestamp: 1 });
    const second = formatWorkflowStageMarker({ event: 'recovery_confirmed', workflowName: 'flow', stageIndex: 3, stageId: 'review', targetAgent: 'b', timestamp: 2 });
    const parsed = parseWorkflowStageMarkersFromEntries([`${first}\n${second}`]);
    expect(parsed?.stageIndex).toBe(3);
    expect(parsed?.markerEvent).toBe('recovery_confirmed');
  });

  test('ignores malformed markers', () => {
    const malformed = `[workflow-stage-marker]\nversion: 1\nevent: invalid\nworkflow: flow\nstageIndex: 1\n[/workflow-stage-marker]`;
    const valid = formatWorkflowStageMarker({ event: 'transition_approved', workflowName: 'flow', stageIndex: 0, targetAgent: 'a', timestamp: 5 });
    const parsed = parseWorkflowStageMarkersFromEntries([malformed, valid]);
    expect(parsed?.stageIndex).toBe(0);
  });

  test('extracts marker text from common entry shapes', () => {
    const marker = formatWorkflowStageMarker({ event: 'transition_approved', workflowName: 'flow', stageIndex: 4, targetAgent: 'a', timestamp: 9 });
    expect(parseWorkflowStageMarkersFromEntries([{ message: { content: [{ type: 'text', text: marker }] } }])?.stageIndex).toBe(4);
    expect(parseWorkflowStageMarkersFromEntries([{ content: [{ type: 'text', text: marker }] }])?.stageIndex).toBe(4);
    expect(parseWorkflowStageMarkersFromEntries([{ content: marker }])?.stageIndex).toBe(4);
  });

  test('creates a short stage notice while preserving raw marker details', () => {
    const notice = createWorkflowStageMarkerNotice({
      event: 'transition_approved',
      workflowName: 'flow',
      stageIndex: 4,
      stageId: 'ship',
      stageAgent: 'alpha',
      targetAgent: 'alpha',
      timestamp: 9,
    });

    expect(notice.content).toBe('Workflow stage recorded: flow/ship -> alpha');
    expect(notice.content).not.toContain('[workflow-stage-marker]');
    expect(notice.details).toMatchObject({
      schema: 'pi.agent.event.v1',
      kind: 'workflow_stage_marker',
      fields: {
        event: 'transition_approved',
        workflowName: 'flow',
        stageIndex: 4,
        stageId: 'ship',
        stageAgent: 'alpha',
        targetAgent: 'alpha',
        timestamp: 9,
      },
    });
    expect(notice.details.rawText).toContain('[workflow-stage-marker]');
  });

  test('parses marker text from structured notice details', () => {
    const notice = createWorkflowStageMarkerNotice({
      event: 'transition_approved',
      workflowName: 'flow',
      stageIndex: 4,
      stageId: 'ship',
      stageAgent: 'alpha',
      targetAgent: 'alpha',
      timestamp: 9,
    });

    expect(parseWorkflowStageMarkersFromEntries([{ content: notice.content, details: notice.details }])?.stageIndex).toBe(4);
  });

  test('parses structured marker details without raw marker text', () => {
    const parsed = parseWorkflowStageMarkersFromEntries([
      {
        details: {
          schema: 'pi.agent.event.v1',
          kind: 'workflow_stage_marker',
          title: 'Workflow stage recorded',
          summary: 'short display',
          fields: {
            event: 'recovery_confirmed',
            workflowName: 'flow',
            stageIndex: 5,
            stageId: 'review',
            stageAgent: 'beta',
            targetAgent: 'beta',
            timestamp: 12,
          },
        },
      },
    ]);

    expect(parsed).toMatchObject({
      workflowName: 'flow',
      stageIndex: 5,
      stageId: 'review',
      stageAgent: 'beta',
      markerEvent: 'recovery_confirmed',
      timestamp: 12,
    });
  });

  test('ignores structured marker details with an unknown schema', () => {
    const parsed = parseWorkflowStageMarkersFromEntries([
      {
        details: {
          schema: 'other.schema.v1',
          kind: 'workflow_stage_marker',
          fields: {
            event: 'transition_approved',
            workflowName: 'flow',
            stageIndex: 5,
            targetAgent: 'beta',
            timestamp: 12,
          },
        },
      },
    ]);

    expect(parsed).toBeNull();
  });

  test('ignores markers older than the current session timestamp', () => {
    const parentMarker = formatWorkflowStageMarker({ event: 'transition_approved', workflowName: 'flow', stageIndex: 1, targetAgent: 'a', timestamp: 100 });
    const currentMarker = formatWorkflowStageMarker({ event: 'transition_approved', workflowName: 'flow', stageIndex: 2, targetAgent: 'b', timestamp: 200 });

    expect(parseWorkflowStageMarkersFromEntries([parentMarker], { minTimestamp: 150 })).toBeNull();
    expect(parseWorkflowStageMarkersFromEntries([parentMarker, currentMarker], { minTimestamp: 150 })?.stageIndex).toBe(2);
  });

  test('ignores legacy markers without timestamp when session timestamp filtering is enabled', () => {
    const legacyMarker = `[workflow-stage-marker]\nversion: 1\nevent: transition_approved\nworkflow: flow\nstageIndex: 1\nstageId: plan\nstageAgent: beta\ntargetAgent: beta\n[/workflow-stage-marker]`;

    expect(parseWorkflowStageMarkersFromEntries([legacyMarker], { minTimestamp: 150 })).toBeNull();
  });

  test('resume notice mentions candidate and recovery constraints', () => {
    const notice = formatWorkflowStageResumeNotice({ candidate: { workflowName: 'flow', stageIndex: 1, markerEvent: 'transition_approved', source: 'session_marker' } });
    expect(notice).toContain('[workflow-stage-resume]');
    expect(notice).toContain('flow');
    expect(notice).toContain('其他 future stage');
  });

  test('creates a short resume notice with detailed recovery context', () => {
    const notice = createWorkflowStageResumeNotice({
      candidate: { workflowName: 'flow', stageIndex: 1, stageId: 'fix', markerEvent: 'transition_approved', source: 'session_marker' },
    });

    expect(notice.content).toBe('Workflow resume context: flow/fix');
    expect(notice.content).not.toContain('[workflow-stage-resume]');
    expect(notice.details).toMatchObject({
      schema: 'pi.agent.event.v1',
      kind: 'workflow_stage_resume',
      fields: {
        hasRecoveryCandidate: true,
        candidate: {
          workflowName: 'flow',
          stageIndex: 1,
          stageId: 'fix',
          markerEvent: 'transition_approved',
        },
      },
    });
    expect(notice.details.rawText).toContain('[workflow-stage-resume]');
  });
});
