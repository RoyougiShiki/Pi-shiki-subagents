import { describe, expect, test } from 'bun:test';
import {
  auditCompletion,
  type CompletionEvidenceSummary,
} from './completion-auditor';

const emptyEvidence: CompletionEvidenceSummary = { kinds: [] };

describe('completion auditor', () => {
  // ─── 单规则：有修改 + 无验证 → warn/block ────────────────────────────────

  test('modification without verification → warn by default', () => {
    const result = auditCompletion({
      finalText: '我修改了文件。',
      evidence: { kinds: ['modification'], modifiedFileCount: 1 },
    });
    expect(result.action).toBe('warn');
    expect(result.issues.map((i) => i.id)).toContain(
      'modification_without_verification',
    );
    expect(result.injectedMessage).toContain('修改证据');
  });

  test('modification without verification → block when blockOnUnverifiedModification=true', () => {
    const result = auditCompletion(
      {
        finalText: '我修改了文件。',
        evidence: { kinds: ['modification'], modifiedFileCount: 1 },
      },
      { blockOnUnverifiedModification: true },
    );
    expect(result.action).toBe('block');
    expect(result.issues[0]?.id).toBe('modification_without_verification');
  });

  test('modification with test_success evidence → allow', () => {
    const result = auditCompletion({
      finalText: '修改完成，测试通过。',
      evidence: {
        kinds: ['modification', 'test_success'],
        modifiedFileCount: 1,
      },
    });
    expect(result.action).toBe('allow');
    expect(result.issues).toHaveLength(0);
  });

  test('modification with verification evidence → allow', () => {
    const result = auditCompletion({
      finalText: '修改完成。',
      evidence: {
        kinds: ['modification', 'verification'],
        modifiedFileCount: 1,
      },
    });
    expect(result.action).toBe('allow');
    expect(result.issues).toHaveLength(0);
  });

  // ─── 无修改不触发 ──────────────────────────────────────────────────────────

  test('no modification evidence → allow regardless of text', () => {
    // 模型说"完成了"但没改文件 → 不触发（不再扫模型自然语言）
    const result = auditCompletion({
      finalText: '全部完成，测试通过。',
      evidence: emptyEvidence,
    });
    expect(result.action).toBe('allow');
    expect(result.issues).toHaveLength(0);
  });

  test('neutral text with no modification → allow', () => {
    const result = auditCompletion({
      finalText: '我查看了一下当前情况。',
      evidence: emptyEvidence,
    });
    expect(result.action).toBe('allow');
    expect(result.issues).toHaveLength(0);
  });

  // ─── lint/typecheck 也算验证 ───────────────────────────────────────────────

  test('modification with lint_success evidence → allow', () => {
    const result = auditCompletion({
      finalText: '修改完成。',
      evidence: {
        kinds: ['modification', 'lint_success'],
        modifiedFileCount: 1,
      },
    });
    expect(result.action).toBe('allow');
  });

  test('modification with typecheck_success evidence → allow', () => {
    const result = auditCompletion({
      finalText: '修改完成。',
      evidence: {
        kinds: ['modification', 'typecheck_success'],
        modifiedFileCount: 1,
      },
    });
    expect(result.action).toBe('allow');
  });

  // ─── 自定义 messages ───────────────────────────────────────────────────────

  test('supports caller-provided modificationWithoutVerification message', () => {
    const result = auditCompletion(
      {
        finalText: '我修改了文件。',
        evidence: { kinds: ['modification'], modifiedFileCount: 1 },
      },
      {
        messages: {
          verificationEvidence: {
            subagentPending: 'V_SUB',
            toolFailedWithoutRecovery: 'V_FAIL',
            modificationWithoutVerification: 'V_MOD',
          },
          completionAuditor: {
            testPassWithoutEvidence: 'C_TEST',
            lintPassWithoutEvidence: 'C_LINT',
            typecheckPassWithoutEvidence: 'C_TYPE',
            completionWithPendingSubagent: 'C_SUB',
            completionWithPendingTasks: 'C_TASK',
            completionAfterFailureWithoutAcknowledgement: 'C_FAIL',
            completionAgainstVerifierFail: 'C_VFAIL',
            completionAgainstVerifierPartial: 'C_VPART',
            modificationWithoutVerification: 'CUSTOM_UNVERIFIED',
            finalReportWithoutAcknowledgingFailure: 'C_FFAIL',
            finalReportWithoutAcknowledgingUnverified: 'C_FUNVER',
            injectedHeader: 'CUSTOM_HEADER',
          },
          toolResultBudget: {
            persistedOutput: () => 'CUSTOM_PERSISTED',
            clearedOutput: () => 'CUSTOM_CLEARED',
          },
        },
      },
    );

    expect(result.action).toBe('warn');
    expect(result.injectedMessage).toContain('CUSTOM_HEADER');
    expect(result.injectedMessage).toContain('CUSTOM_UNVERIFIED');
  });
});
