import { describe, expect, test } from 'bun:test';
import { checkVerificationEvidence, type VerificationEvidenceState } from './verification-evidence-policy';

const baseState: VerificationEvidenceState = {
  hasRead: false,
  hasModify: false,
  hasVerification: false,
  hasFailure: false,
  hasSubagentPending: false,
};

describe('VerificationEvidencePolicy', () => {
  test('allows ordinary state with no relevant evidence pressure', () => {
    const result = checkVerificationEvidence(baseState);
    expect(result.action).toBe('allow');
  });

  test('warns when modified without verification', () => {
    const result = checkVerificationEvidence({ ...baseState, hasModify: true }, { afterModification: true });
    expect(result.action).toBe('warn');
    expect(result.reason).toBe('modified_without_verification');
    expect(result.hint).toContain('尚未验证');
  });

  test('allows modified state when verification evidence exists', () => {
    const result = checkVerificationEvidence({ ...baseState, hasModify: true, hasVerification: true }, { afterModification: true });
    expect(result.action).toBe('allow');
  });

  test('warns after tool failure without recovery evidence', () => {
    const result = checkVerificationEvidence({ ...baseState, hasFailure: true }, { afterToolFailure: true });
    expect(result.action).toBe('warn');
    expect(result.reason).toBe('tool_failed_without_recovery');
  });

  test('warns when depending on pending subagent', () => {
    const result = checkVerificationEvidence({ ...baseState, hasSubagentPending: true }, { dependingOnSubagent: true });
    expect(result.action).toBe('warn');
    expect(result.reason).toBe('subagent_pending');
  });

  test('does not scan natural language text', () => {
    // This policy intentionally receives only evidence state and context flags,
    // so phrases like “测试通过” cannot trigger it by themselves.
    const result = checkVerificationEvidence(baseState, { userAskedForFinal: true });
    expect(result.action).toBe('allow');
  });
});
