import { describe, expect, test } from 'bun:test';
import { HarnessConfigSchema, PluginConfigSchema } from './schema';

describe('HarnessConfigSchema', () => {
  test('accepts auditor, budget, and message config', () => {
    const result = HarnessConfigSchema.safeParse({
      completionAuditor: {
        blockOnUnverifiedModification: true,
        patterns: {
          testPass: ['CUSTOM_TEST_OK'],
        },
      },
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
        completionAuditor: {
          testPassWithoutEvidence: 'CUSTOM_TEST_PASS',
        },
        toolResultBudget: {
          persistedOutputTemplate: 'SAVED:{filepath}',
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
        completionAuditor: {
          blockOnUnverifiedModification: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.harness?.completionAuditor?.blockOnUnverifiedModification).toBe(true);
  });
});
