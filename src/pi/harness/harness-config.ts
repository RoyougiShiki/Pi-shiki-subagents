import { DEFAULT_HARNESS_MESSAGES } from "./messages";
import { DEFAULT_THRESHOLDS } from "./tool-result-budget";
import type { CompletionAuditorOptions, CompletionClaimPatterns } from "./completion-auditor";
import type { ToolResultBudgetOptions, ToolResultBudgetThresholds } from "./tool-result-budget";
import type { HarnessMessageCatalog } from "./types";

export interface HarnessMessageConfig {
  verificationEvidence?: Partial<HarnessMessageCatalog["verificationEvidence"]>;
  completionAuditor?: Partial<HarnessMessageCatalog["completionAuditor"]>;
  toolResultBudget?: {
    persistedOutputTemplate?: string;
    clearedOutputTemplate?: string;
  };
}

export type HarnessPatternConfig = Partial<Record<keyof CompletionClaimPatterns, readonly string[]>>;

export interface HarnessConfig {
  completionAuditor?: {
    enabled?: boolean;
    blockOnUnverifiedModification?: boolean;
    patterns?: HarnessPatternConfig;
  };
  toolResultBudget?: {
    enabled?: boolean;
    thresholds?: Partial<ToolResultBudgetThresholds> & { byTool?: Record<string, number> };
    previewChars?: number;
    storageBaseDir?: string;
  };
  messages?: HarnessMessageConfig;
}

export interface ResolvedHarnessConfig {
  messages: HarnessMessageCatalog;
  completionAuditor: CompletionAuditorOptions & { enabled: boolean };
  toolResultBudget: Omit<ToolResultBudgetOptions, "storage"> & {
    enabled: boolean;
    storageBaseDir?: string;
  };
}

function renderTemplate(template: string, values: Record<string, string | number | boolean | undefined>): string {
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
      ...config?.completionAuditor,
    },
    toolResultBudget: {
      persistedOutput: persistedTemplate
        ? (args) => renderTemplate(persistedTemplate, {
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

function compilePatterns(config?: HarnessPatternConfig): CompletionAuditorOptions["patterns"] {
  if (!config) return undefined;
  const out: Partial<CompletionClaimPatterns> = {};
  for (const key of Object.keys(config) as Array<keyof CompletionClaimPatterns>) {
    const sources = config[key];
    if (!sources) continue;
    out[key] = sources.map((source) => new RegExp(source, "i"));
  }
  return out;
}

function resolveThresholds(config?: HarnessConfig["toolResultBudget"]): ToolResultBudgetThresholds | undefined {
  if (!config?.thresholds) return undefined;
  const defaultThreshold = config.thresholds.default;
  return {
    // Note: DEFAULT_THRESHOLDS.default is the single source of truth
    default: typeof defaultThreshold === "number" ? defaultThreshold : DEFAULT_THRESHOLDS.default,
    byTool: config.thresholds.byTool,
  };
}

export function resolveHarnessConfig(config: HarnessConfig = {}): ResolvedHarnessConfig {
  const messages = resolveMessages(config.messages);
  return {
    messages,
    completionAuditor: {
      enabled: config.completionAuditor?.enabled === true,
      messages,
      blockOnUnverifiedModification: config.completionAuditor?.blockOnUnverifiedModification,
      patterns: compilePatterns(config.completionAuditor?.patterns),
    },
    toolResultBudget: {
      enabled: config.toolResultBudget?.enabled === true,
      messages,
      thresholds: resolveThresholds(config.toolResultBudget),
      previewChars: config.toolResultBudget?.previewChars,
      storageBaseDir: config.toolResultBudget?.storageBaseDir,
    },
  };
}
