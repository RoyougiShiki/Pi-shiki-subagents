import { describe, expect, test } from 'bun:test';
import { formatWorkflowStageMarker, formatWorkflowStageResumeNotice, parseWorkflowStageMarkersFromEntries } from './workflow-stage-marker';

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
});
