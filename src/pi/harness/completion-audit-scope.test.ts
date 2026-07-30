import { describe, expect, test } from 'bun:test';
import type { ToolEvidence } from '../policy/tool-evidence-types';
import {
  hasModificationEvidence,
  selectCompletionAuditEvidence,
} from './completion-audit-scope';

function ev(toolName: string, success = true): ToolEvidence {
  return {
    toolName,
    toolCallId: `${toolName}-1`,
    args: {},
    timestamp: 1000,
    success,
  };
}

describe('completion-audit-scope', () => {
  test('detects successful write/edit modifications', () => {
    expect(hasModificationEvidence([ev('read')])).toBe(false);
    expect(hasModificationEvidence([ev('edit')])).toBe(true);
    expect(hasModificationEvidence([ev('write', false)])).toBe(false);
  });

  test('uses current turn window for read-only/advisory tool turn', () => {
    const sessionEvidences = [ev('edit'), ev('read')];
    const currentTurnEvidences = [ev('read')];

    const result = selectCompletionAuditEvidence({
      sessionId: 's1',
      sessionEvidences,
      currentTurnEvidences,
    });

    expect(result.scope.evidenceWindow).toBe('current_turn');
    expect(result.evidences).toEqual(currentTurnEvidences);
  });

  test('keeps session window when current turn modified files', () => {
    const sessionEvidences = [ev('edit'), ev('bash')];
    const currentTurnEvidences = [ev('edit')];

    const result = selectCompletionAuditEvidence({
      sessionId: 's1',
      sessionEvidences,
      currentTurnEvidences,
    });

    expect(result.scope.evidenceWindow).toBe('current_session');
    expect(result.evidences).toEqual(sessionEvidences);
  });

  test('keeps session window when no current turn evidence exists', () => {
    const sessionEvidences = [ev('edit')];

    const result = selectCompletionAuditEvidence({
      sessionId: 's1',
      sessionEvidences,
      currentTurnEvidences: [],
    });

    expect(result.scope.evidenceWindow).toBe('current_session');
    expect(result.evidences).toEqual(sessionEvidences);
  });

  test('forces session window for explicit completion claims', () => {
    const sessionEvidences = [ev('edit'), ev('read')];
    const currentTurnEvidences = [ev('read')];

    const result = selectCompletionAuditEvidence({
      sessionId: 's1',
      sessionEvidences,
      currentTurnEvidences,
      forceSessionWindow: true,
    });

    expect(result.scope.evidenceWindow).toBe('current_session');
    expect(result.scope.forceSessionWindow).toBe(true);
    expect(result.evidences).toEqual(sessionEvidences);
  });
});
