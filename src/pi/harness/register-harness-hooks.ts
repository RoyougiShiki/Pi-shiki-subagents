import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ToolEvidence } from "../policy/tool-evidence-types";
import {
  applyToolResultBudget,
  applyVerifierVerdictsToEvidenceSummary,
  createEvidenceSessionStore,
  ingestVerifierVerdict,
  normalizeToolResult,
  resolveHarnessConfig,
  runHarnessAudit,
  selectCompletionAuditEvidence,
  type ResolvedHarnessConfig,
} from "../harness";
import { createToolResultBudgetState, type ToolResultBudgetState } from "./tool-result-budget-state";
import { loadBudgetState, saveBudgetState } from "./tool-result-budget-persistence";
import { loadVerifierVerdicts, saveVerifierVerdicts } from "./verifier-verdict-persistence";
import type { VerifierVerdictEvidence } from "./verifier-verdict-evidence";
import {
  createRecoveredEvidenceSummaryState,
  mergeRecoveredCompletionEvidenceSummary,
  updateRecoveredEvidenceSummaryState,
  toTemporalCompletionEvidenceSummary,
  type RecoveredEvidenceSummaryState,
} from "./evidence-summary-state";
import { loadEvidenceSummaryState, saveEvidenceSummaryState } from "./evidence-summary-persistence";
import type { HarnessConfig } from "../../config/schema";

export interface RegisterHarnessHooksOptions {
  config?: HarnessConfig;
}

export interface HarnessRuntimeHooks {
  ingestPoolCompleted(event: { agentName: string; response?: string }, ctx: ExtensionContext): Promise<void>;
}

function createHarnessSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function expandHomePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(homedir(), filepath.slice(1));
  }
  return filepath;
}

function stableSessionId(ctx: ExtensionContext, fallback: string): string {
  const sessionId = (ctx.sessionManager as any)?.getSessionId?.();
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
  const sessionFile = (ctx.sessionManager as any)?.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile.trim()) {
    return `file-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}`;
  }
  return fallback;
}

function extractTextFromContentParts(content: any[]): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

function replaceFirstTextInContent(content: any[], newText: string): any[] {
  if (!Array.isArray(content)) return [{ type: "text", text: newText }];
  const result = [...content];
  for (let i = 0; i < result.length; i++) {
    if (result[i]?.type === "text") {
      result[i] = { ...result[i], text: newText };
      return result;
    }
  }
  result.push({ type: "text", text: newText });
  return result;
}

function extractExitCodeFromContent(content: unknown): number | undefined {
  if (typeof content === "string") {
    const match = content.match(/Command exited with code (\d+)/);
    return match ? parseInt(match[1], 10) : undefined;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const match = part.text.match(/Command exited with code (\d+)/);
        return match ? parseInt(match[1], 10) : undefined;
      }
    }
  }
  return undefined;
}

function latestModificationTimestamp(evidences: readonly ToolEvidence[]): number | undefined {
  let latest: number | undefined;
  for (const evidence of evidences) {
    const toolName = evidence.toolName.trim().toLowerCase();
    if (toolName !== "edit" && toolName !== "write") continue;
    latest = latest === undefined ? evidence.timestamp : Math.max(latest, evidence.timestamp);
  }
  return latest;
}

function verifierVerdictsAfter(
  verdicts: readonly VerifierVerdictEvidence[],
  timestamp: number | undefined,
): VerifierVerdictEvidence[] {
  if (timestamp === undefined) return [...verdicts];
  return verdicts.filter((verdict) => verdict.timestamp > timestamp);
}

export function registerHarnessHooks(
  pi: ExtensionAPI,
  options: RegisterHarnessHooksOptions = {},
): HarnessRuntimeHooks {
  const harnessConfig: ResolvedHarnessConfig = resolveHarnessConfig(options.config);
  const harnessSessionId = createHarnessSessionId();
  const evidenceSessionStore = createEvidenceSessionStore();
  let currentTurnEvidences: ToolEvidence[] = [];
  let budgetState: ToolResultBudgetState = createToolResultBudgetState();
  let budgetStateKey: string | undefined;
  let verifierVerdictsKey: string | undefined;
  let verifierVerdictsQueue: Promise<void> = Promise.resolve();
  let recoveredEvidenceSummaryState: RecoveredEvidenceSummaryState = createRecoveredEvidenceSummaryState();
  let recoveredEvidenceSummaryKey: string | undefined;
  // H7: 连续阻止计数器（message_end handler 维护，block +1，非 block 归零）
  let consecutiveBlocks = 0;
  let recoveredEvidenceSummaryQueue: Promise<void> = Promise.resolve();

  async function ensureRecoveredEvidenceSummaryLoaded(ctx: ExtensionContext): Promise<{ baseDir: string; sessionId: string }> {
    const storage = await resolveHarnessStateStorage(ctx);
    const key = `${storage.baseDir}\n${storage.sessionId}`;
    if (recoveredEvidenceSummaryKey !== key) {
      recoveredEvidenceSummaryState = await loadEvidenceSummaryState(storage.baseDir, storage.sessionId) ?? createRecoveredEvidenceSummaryState();
      recoveredEvidenceSummaryKey = key;
    }
    return storage;
  }

  async function withRecoveredEvidenceSummary<T>(
    ctx: ExtensionContext,
    action: (storage: { baseDir: string; sessionId: string }) => Promise<T>,
  ): Promise<T> {
    const run = recoveredEvidenceSummaryQueue.then(async () => {
      const storage = await ensureRecoveredEvidenceSummaryLoaded(ctx);
      return action(storage);
    });
    recoveredEvidenceSummaryQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function resolveHarnessStateStorage(ctx: ExtensionContext): Promise<{ baseDir: string; sessionId: string }> {
    const baseDir = expandHomePath(harnessConfig.toolResultBudget.storageBaseDir ?? "~/.pi/tool-results");
    return { baseDir, sessionId: stableSessionId(ctx, harnessSessionId) };
  }

  async function ensureVerifierVerdictsLoaded(ctx: ExtensionContext): Promise<{ baseDir: string; sessionId: string }> {
    const storage = await resolveHarnessStateStorage(ctx);
    const key = `${storage.baseDir}\n${storage.sessionId}`;
    if (verifierVerdictsKey !== key) {
      const verdicts = await loadVerifierVerdicts(storage.baseDir, storage.sessionId);
      evidenceSessionStore.hydrateVerifierVerdicts(storage.sessionId, verdicts ?? []);
      verifierVerdictsKey = key;
    }
    return storage;
  }

  async function withVerifierVerdicts<T>(
    ctx: ExtensionContext,
    action: (storage: { baseDir: string; sessionId: string }) => Promise<T>,
  ): Promise<T> {
    const run = verifierVerdictsQueue.then(async () => {
      const storage = await ensureVerifierVerdictsLoaded(ctx);
      return action(storage);
    });
    verifierVerdictsQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function resolveBudgetStorage(ctx: ExtensionContext): Promise<{ baseDir: string; sessionId: string }> {
    const baseDir = expandHomePath(harnessConfig.toolResultBudget.storageBaseDir ?? "~/.pi/tool-results");
    const sessionId = stableSessionId(ctx, harnessSessionId);
    const key = `${baseDir}\n${sessionId}`;
    if (budgetStateKey !== key) {
      budgetState = await loadBudgetState(baseDir, sessionId) ?? createToolResultBudgetState();
      budgetStateKey = key;
    }
    return { baseDir, sessionId };
  }

  async function ingestPoolCompleted(event: { agentName: string; response?: string }, ctx: ExtensionContext): Promise<void> {
    if (!event.response) return;

    const verdictIngestion = ingestVerifierVerdict({
      text: event.response,
      source: "subagent",
      verifier: event.agentName,
    });
    if (!verdictIngestion.ingested || !verdictIngestion.evidence) return;

    await withVerifierVerdicts(ctx, async (storage) => {
      evidenceSessionStore.recordVerifierVerdict(storage.sessionId, verdictIngestion.evidence!);
      const saved = await saveVerifierVerdicts(evidenceSessionStore.getVerifierVerdicts(storage.sessionId), storage.baseDir, storage.sessionId);
      try {
        const suffix = saved ? "" : " (persistence failed)";
        ctx.ui.notify(
          `[harness] verifier verdict captured: ${verdictIngestion.evidence!.verdict}${suffix}`,
          saved && verdictIngestion.evidence!.verdict === "PASS" ? "info" : "warning",
        );
      } catch {}
    });
  }

  pi.on("turn_start", async (_event, ctx) => {
    currentTurnEvidences = [];
    if (ctx) await withVerifierVerdicts(ctx, async () => undefined).catch(() => undefined);
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const toolCallId = (event as any).toolCallId ?? "";
    const args = (event as any).input ?? (event as any).args ?? {};
    const content = (event as any).content ?? (event as any).result;
    const isError = Boolean((event as any).isError ?? (event as any).success === false);
    const exitCode = toolName === "bash" ? extractExitCodeFromContent(content) : undefined;

    if (!toolName) return;

    const verifierStorage = await withVerifierVerdicts(ctx, async (storage) => storage);
    const sessionId = verifierStorage.sessionId;
    const sessionFile = (ctx as any)?.sessionManager?.getSessionFile?.();
    const sessionArtifactRef = sessionFile
      ? { kind: "session_file" as const, sessionId, path: sessionFile }
      : { kind: "session_entries" as const, sessionId };

    const normalized = normalizeToolResult({
      toolName,
      toolCallId,
      rawInput: args,
      modelFacingContent: content,
      isError,
      exitCode,
      sessionArtifactRef,
    });
    const evidence = normalized.evidence;

    evidenceSessionStore.recordEvidence(evidence);
    currentTurnEvidences = [
      ...currentTurnEvidences,
      {
        toolName: evidence.toolName,
        toolCallId: evidence.toolCallId,
        args: evidence.rawInput,
        result: normalized.modelFacingMessage,
        timestamp: evidence.timestamp,
        success: evidence.success,
        exitCode: evidence.exitCode,
      },
    ];
    await withRecoveredEvidenceSummary(ctx, async (storage) => {
      recoveredEvidenceSummaryState = updateRecoveredEvidenceSummaryState(recoveredEvidenceSummaryState, {
        toolName: evidence.toolName,
        toolCallId: evidence.toolCallId,
        args: evidence.rawInput,
        result: normalized.modelFacingMessage,
        timestamp: evidence.timestamp,
        success: evidence.success,
        exitCode: evidence.exitCode,
      });
      await saveEvidenceSummaryState(recoveredEvidenceSummaryState, storage.baseDir, storage.sessionId);
    });

    let outputContent = normalized.modelFacingMessage;
    const outputIsError = evidence.success ? false : isError;

    if (harnessConfig.toolResultBudget.enabled) {
      const outputParts = Array.isArray(outputContent)
        ? outputContent
        : typeof outputContent === "string"
          ? [{ type: "text", text: outputContent }]
          : [outputContent];
      const contentText = extractTextFromContentParts(outputParts);
      if (contentText.length > 0) {
        const budgetStorage = await resolveBudgetStorage(ctx);
        const decision = await applyToolResultBudget(
          { toolName, toolCallId, content: contentText },
          {
            state: budgetState,
            thresholds: harnessConfig.toolResultBudget.thresholds,
            previewChars: harnessConfig.toolResultBudget.previewChars,
            storage: budgetStorage,
            messages: harnessConfig.messages,
          },
        );
        await saveBudgetState(budgetState, budgetStorage.baseDir, budgetStorage.sessionId);
        if (decision.action === "persist" || decision.action === "reapply") {
          const persistedContent = replaceFirstTextInContent(outputParts, decision.content);
          return { content: persistedContent, details: (event as any).details, isError: outputIsError };
        }
      }
    }

    if (normalized.messageModified || outputIsError !== isError) {
      const returnedContent: any[] = Array.isArray(outputContent) ? outputContent : [outputContent];
      return {
        content: returnedContent,
        details: (event as any).details,
        isError: outputIsError,
      };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!harnessConfig.completionAuditor.enabled) return;

    const message = (event as any).message;
    if (message?.role !== "assistant") return;

    const finalText = extractTextFromContentParts(message?.content ?? []);
    if (!finalText) return;

    const verifierStorage = await withVerifierVerdicts(ctx, async (storage) => storage);
    const sessionId = verifierStorage.sessionId;
    await withRecoveredEvidenceSummary(ctx, async () => undefined);
    const auditEvidenceSelection = selectCompletionAuditEvidence({
      sessionId,
      sessionEvidences: evidenceSessionStore.getEvidenceSnapshot(sessionId),
      currentTurnEvidences,
      forceSessionWindow: true,
    });
    const latestRelevantModificationAt = Math.max(
      latestModificationTimestamp(auditEvidenceSelection.evidences) ?? -Infinity,
      recoveredEvidenceSummaryState.lastModifiedAt ?? -Infinity,
    );
    const currentEvidenceSummary = toTemporalCompletionEvidenceSummary(auditEvidenceSelection.evidences);
    const evidenceSummary = applyVerifierVerdictsToEvidenceSummary(
      mergeRecoveredCompletionEvidenceSummary(currentEvidenceSummary, recoveredEvidenceSummaryState),
      verifierVerdictsAfter(
        evidenceSessionStore.getVerifierVerdicts(sessionId),
        latestRelevantModificationAt === -Infinity ? undefined : latestRelevantModificationAt,
      ),
    );

    const decision = runHarnessAudit(
      {
        finalText,
        evidenceSummary,
      },
      {
        messages: harnessConfig.messages,
        completion: {
          blockOnUnverifiedModification: harnessConfig.completionAuditor.blockOnUnverifiedModification,
        },
        consecutiveBlocks,
        maxConsecutiveBlocks: harnessConfig.completionAuditor.maxConsecutiveBlocks,
      },
    );

    // H7: 连续阻止计数——block 累加，非 block 归零
    if (decision.action === "block") {
      consecutiveBlocks += 1;
    } else {
      consecutiveBlocks = 0;
    }

    if ((decision.action === "warn" || decision.action === "block") && decision.issues.length > 0) {
      const issueSummary = decision.issues.map(i => `• ${i.message}`).join("\n");
      try {
        ctx.ui.notify(`[harness] 完成审计提醒:\n${issueSummary}`, "warning");
      } catch {}
    }
  });

  return {
    ingestPoolCompleted,
  };
}
