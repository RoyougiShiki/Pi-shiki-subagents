import { describe, expect, test } from 'bun:test';
import { HarnessConfigSchema, PluginConfigSchema } from './schema';

describe('HarnessConfigSchema', () => {
  test('accepts budget and message config', () => {
    const result = HarnessConfigSchema.safeParse({
      toolResultBudget: {
        thresholds: {
          default: 1000,
          byTool: {
            bash: 2000,
          },
        },
        previewChars: 120,
        storageBaseDir: '~/.pi/tool-results',
      },
      messages: {
        verificationEvidence: {
          subagentPending: 'CUSTOM_SUBAGENT',
        },
        toolResultBudget: {
          persistedOutputTemplate: 'SAVED:{filepath}',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('ignores legacy completionAuditor config without failing', () => {
    const result = HarnessConfigSchema.safeParse({
      completionAuditor: {
        enabled: true,
        blockOnUnverifiedModification: true,
      },
      messages: {
        completionAuditor: {
          testPassWithoutEvidence: 'CUSTOM_TEST_PASS',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects unknown keys', () => {
    const result = HarnessConfigSchema.safeParse({
      unknown: true,
    });

    expect(result.success).toBe(false);
  });

  test('rejects invalid thresholds', () => {
    const result = HarnessConfigSchema.safeParse({
      toolResultBudget: {
        thresholds: {
          default: -1,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('is accepted by PluginConfigSchema', () => {
    const result = PluginConfigSchema.safeParse({
      harness: {
        toolResultBudget: {
          enabled: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.harness?.toolResultBudget?.enabled).toBe(true);
  });
});
