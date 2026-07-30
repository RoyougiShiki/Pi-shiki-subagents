/**
 * Harness Config — 配置解析
 *
 * 设计原则：
 * - 阈值来自 thresholds.ts（唯一真源）
 * - 文案可配置，但默认值来自 messages.ts
 * - completion auditor 已退役；不再解析启用路径
 *
 * 模块解耦：
 * - 不硬编码阈值，从 thresholds.ts 导入
 * - 不硬编码文案，从 messages.ts 导入
 */

import { DEFAULT_HARNESS_MESSAGES } from './messages';
import {
  DEFAULT_PREVIEW_CHARS,
  type UserThresholdConfig,
} from './thresholds';
import type { HarnessMessageCatalog } from './types';

// ─── Config Types ────────────────────────────────────────────────────────────

export interface HarnessMessageConfig {
  verificationEvidence?: Partial<HarnessMessageCatalog['verificationEvidence']>;
  /** Legacy; ignored. */
  completionAuditor?: unknown;
  toolResultBudget?: {
    persistedOutputTemplate?: string;
    clearedOutputTemplate?: string;
  };
}

export interface HarnessConfig {
  /** Legacy; ignored. */
  completionAuditor?: unknown;
  toolResultBudget?: {
    enabled?: boolean;
    thresholds?: {
      default?: number;
      byTool?: Record<string, number>;
    };
    previewChars?: number;
    storageBaseDir?: string;
  };
  messages?: HarnessMessageConfig;
}

export interface ResolvedHarnessConfig {
  messages: HarnessMessageCatalog;
  toolResultBudget: {
    enabled: boolean;
    /** 用户阈值配置（结构化，不合并系统默认） */
    thresholds: UserThresholdConfig;
    previewChars: number;
    storageBaseDir?: string;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderTemplate(
  template: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

function resolveMessages(config?: HarnessMessageConfig): HarnessMessageCatalog {
  const persistedTemplate = config?.toolResultBudget?.persistedOutputTemplate;
  const clearedTemplate = config?.toolResultBudget?.clearedOutputTemplate;

  return {
    verificationEvidence: {
      ...DEFAULT_HARNESS_MESSAGES.verificationEvidence,
      ...config?.verificationEvidence,
    },
    completionAuditor: {
      ...DEFAULT_HARNESS_MESSAGES.completionAuditor,
      ...((config?.completionAuditor &&
      typeof config.completionAuditor === 'object' &&
      config.completionAuditor) ||
        {}),
    },
    toolResultBudget: {
      persistedOutput: persistedTemplate
        ? (args) =>
            renderTemplate(persistedTemplate, {
              originalSize: args.originalSize,
              filepath: args.filepath,
              previewSize: args.previewSize,
              preview: args.preview,
              hasMore: args.hasMore,
            })
        : DEFAULT_HARNESS_MESSAGES.toolResultBudget.persistedOutput,
      clearedOutput: clearedTemplate
        ? (args) => renderTemplate(clearedTemplate, { filepath: args.filepath })
        : DEFAULT_HARNESS_MESSAGES.toolResultBudget.clearedOutput,
    },
  };
}

function resolveThresholds(
  config?: HarnessConfig['toolResultBudget'],
): UserThresholdConfig {
  // 不合并系统默认，只返回用户配置
  // getToolThreshold 会负责回退到系统默认
  return {
    byTool: config?.thresholds?.byTool,
    default: config?.thresholds?.default,
  };
}

// ─── Config Resolver ─────────────────────────────────────────────────────────

/**
 * 解析配置
 *
 * 唯一真源原则：
 * - 阈值默认值来自 thresholds.ts
 * - 文案默认值来自 messages.ts
 */
export function resolveHarnessConfig(
  config: HarnessConfig = {},
): ResolvedHarnessConfig {
  const messages = resolveMessages(config.messages);

  return {
    messages,
    toolResultBudget: {
      enabled: config.toolResultBudget?.enabled === true,
      thresholds: resolveThresholds(config.toolResultBudget),
      previewChars:
        config.toolResultBudget?.previewChars ?? DEFAULT_PREVIEW_CHARS,
      storageBaseDir: config.toolResultBudget?.storageBaseDir,
    },
  };
}
