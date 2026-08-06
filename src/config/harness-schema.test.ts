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

  test('accepts subagent stall and prompt timeout limits', () => {
    const result = HarnessConfigSchema.safeParse({
      subagent: {
        stallTimeoutMs: 90000,
        promptTimeoutMs: 300000,
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.subagent?.stallTimeoutMs).toBe(90000);
    expect(result.data.subagent?.promptTimeoutMs).toBe(300000);
  });

  test('accepts stallTimeoutMs=0 to disable stall detection', () => {
    const result = HarnessConfigSchema.safeParse({
      subagent: {
        stallTimeoutMs: 0,
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects negative subagent timeout values', () => {
    const result = HarnessConfigSchema.safeParse({
      subagent: {
        stallTimeoutMs: -1,
      },
    });

    expect(result.success).toBe(false);
  });
});
