import { describe, expect, test } from 'bun:test';
import { resolveHarnessConfig } from './harness-config';
import {
  applyToolResultBudget,
  createToolResultBudgetState,
} from './tool-result-budget';

describe('harness config', () => {
  test('resolves default config without completion auditor runtime fields', () => {
    const resolved = resolveHarnessConfig();
    expect(resolved.messages.verificationEvidence.subagentPending).toContain(
      '子代理',
    );
    expect(resolved.toolResultBudget.enabled).toBe(false);
    expect((resolved as { completionAuditor?: unknown }).completionAuditor).toBe(
      undefined,
    );
  });

  test('overrides verification messages without changing budget logic', () => {
    const resolved = resolveHarnessConfig({
      messages: {
        verificationEvidence: {
          subagentPending: 'CUSTOM_SUBAGENT',
        },
      },
    });

    expect(resolved.messages.verificationEvidence.subagentPending).toBe(
      'CUSTOM_SUBAGENT',
    );
    expect(
      resolved.messages.verificationEvidence.toolFailedWithoutRecovery,
    ).toContain('工具失败');
  });

  test('ignores legacy completionAuditor config objects', () => {
    const resolved = resolveHarnessConfig({
      // @ts-expect-error legacy field intentionally ignored
      completionAuditor: {
        enabled: true,
        maxConsecutiveBlocks: 3,
        patterns: {
          testPass: ['CUSTOM_TEST_OK'],
        },
      },
    });

    expect((resolved as { completionAuditor?: unknown }).completionAuditor).toBe(
      undefined,
    );
  });

  test('resolves tool result template', async () => {
    const resolved = resolveHarnessConfig({
      messages: {
        toolResultBudget: {
          persistedOutputTemplate: 'SAVED:{filepath}:{originalSize}:{preview}',
        },
      },
      toolResultBudget: {
        thresholds: { default: 3 },
      },
    });

    const state = createToolResultBudgetState();
    const result = await applyToolResultBudget(
      { toolName: 'bash', toolCallId: 'call-1', content: 'abcdef' },
      {
        state,
        thresholds: resolved.toolResultBudget.thresholds,
        messages: resolved.messages,
        storage: { baseDir: '/tmp/omo-harness-config-test', sessionId: 's1' },
        previewChars: 2,
      },
    );

    expect(result.action).toBe('persist');
    expect(result.content).toContain('SAVED:');
    expect(result.content).toContain(':6:');
  });

  test('uses thresholds from config', () => {
    const resolved = resolveHarnessConfig({
      toolResultBudget: {
        thresholds: {
          default: 100_000,
          byTool: { grep: 50_000 },
        },
      },
    });

    expect(resolved.toolResultBudget.thresholds.default).toBe(100_000);
    expect(resolved.toolResultBudget.thresholds.byTool?.grep).toBe(50_000);
    expect(resolved.toolResultBudget.thresholds.byTool?.bash).toBeUndefined();
  });
});
