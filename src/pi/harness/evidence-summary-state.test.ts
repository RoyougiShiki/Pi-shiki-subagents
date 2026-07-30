import { describe, expect, test } from 'bun:test';
import {
  createRecoveredEvidenceSummaryState,
  fromRecoveredEvidenceSummaryJson,
  mergeRecoveredCompletionEvidenceSummary,
  toRecoveredEvidenceSummaryJson,
  toTemporalCompletionEvidenceSummary,
  updateRecoveredEvidenceSummaryState,
} from './evidence-summary-state';

describe('evidence summary state', () => {
  test('records modification and filters stale verification after later modification', () => {
    let state = createRecoveredEvidenceSummaryState();
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'bash',
      toolCallId: 'test-1',
      args: { command: 'bun test' },
      result: 'pass',
      timestamp: 100,
      success: true,
    });
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'edit',
      toolCallId: 'edit-1',
      args: { path: 'file.ts' },
      result: 'edited',
      timestamp: 200,
      success: true,
    });

    const summary = mergeRecoveredCompletionEvidenceSummary(
      { kinds: [] },
      state,
    );

    expect(summary.kinds).toContain('modification');
    expect(summary.kinds).not.toContain('verification');
    expect(summary.kinds).not.toContain('test_success');
  });

  test('keeps verification when it follows modification', () => {
    let state = createRecoveredEvidenceSummaryState();
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'edit',
      toolCallId: 'edit-1',
      args: { path: 'file.ts' },
      result: 'edited',
      timestamp: 100,
      success: true,
    });
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'bash',
      toolCallId: 'test-1',
      args: { command: 'bun test' },
      result: 'pass',
      timestamp: 200,
      success: true,
    });

    const summary = mergeRecoveredCompletionEvidenceSummary(
      { kinds: [] },
      state,
    );

    expect(summary.kinds).toContain('modification');
    expect(summary.kinds).toContain('verification');
    expect(summary.kinds).toContain('test_success');
  });

  test('filters stale verification per kind', () => {
    let state = createRecoveredEvidenceSummaryState();
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'bash',
      toolCallId: 'lint-1',
      args: { command: 'bun run lint' },
      result: 'pass',
      timestamp: 100,
      success: true,
    });
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'edit',
      toolCallId: 'edit-1',
      args: { path: 'file.ts' },
      result: 'edited',
      timestamp: 200,
      success: true,
    });
    state = updateRecoveredEvidenceSummaryState(state, {
      toolName: 'bash',
      toolCallId: 'test-1',
      args: { command: 'bun test' },
      result: 'pass',
      timestamp: 300,
      success: true,
    });

    const summary = mergeRecoveredCompletionEvidenceSummary(
      { kinds: [] },
      state,
    );

    expect(summary.kinds).toContain('verification');
    expect(summary.kinds).toContain('test_success');
    expect(summary.kinds).not.toContain('lint_success');
  });

  test('applies temporal filtering to current evidence windows', () => {
    const summary = toTemporalCompletionEvidenceSummary([
      {
        toolName: 'bash',
        toolCallId: 'test-1',
        args: { command: 'bun test' },
        result: 'pass',
        timestamp: 100,
        success: true,
      },
      {
        toolName: 'edit',
        toolCallId: 'edit-1',
        args: { path: 'file.ts' },
        result: 'edited',
        timestamp: 200,
        success: true,
      },
    ]);

    expect(summary.kinds).toContain('modification');
    expect(summary.kinds).not.toContain('verification');
    expect(summary.kinds).not.toContain('test_success');
  });

  test('roundtrips persisted state', () => {
    const state = {
      kinds: ['modification' as const, 'tool_failure' as const],
      modifiedFileCount: 1,
      failedToolCount: 1,
      lastModifiedAt: 123,
      lastFailureAt: 456,
    };

    expect(
      fromRecoveredEvidenceSummaryJson(toRecoveredEvidenceSummaryJson(state)),
    ).toEqual(state);
    expect(
      fromRecoveredEvidenceSummaryJson({
        version: 2,
        kinds: [],
        modifiedFileCount: 0,
        failedToolCount: 0,
      }),
    ).toBeNull();
  });
});
