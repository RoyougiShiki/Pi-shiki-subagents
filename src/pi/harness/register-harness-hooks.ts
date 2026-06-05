import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import * as path from "node:path";
import { recordEvidence, type ToolEvidence } from "../policy/evidence-tracker";
import { auditEvidence } from "../policy/runtime-audit";
import {
  appendNudgeToModelFacingContent,
  applyToolResultBudget,
  applyVerifierVerdictsToEvidenceSummary,
  compilePatterns,
  createEvidenceSessionStore,
  DEFAULT_PATTERN_SOURCES,
  detectFinalRequestFromMessages,
  detectVerificationNudge,
  formatNudgeMessage,
  ingestVerifierVerdict,
  normalizeToolResult,
  resolveHarnessConfig,
  runHarnessAudit,
  selectCompletionAuditEvidence,
  toCompletionEvidenceSummary,
  updateTaskStateFromToolResult,
  type RuntimeTaskItem,
  type ResolvedHarnessConfig,
} from "../harness";
import type { HarnessConfig } from "../../config/schema";

export interface RegisterHarnessHooksOptions {
  config?: HarnessConfig;
}

export interface HarnessRuntimeHooks {
  ingestPoolCompleted(event: { agentName: string; response?: string }, ctx: ExtensionContext): void;
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

export function registerHarnessHooks(
  pi: ExtensionAPI,
  options: RegisterHarnessHooksOptions = {},
): HarnessRuntimeHooks {
  const harnessConfig: ResolvedHarnessConfig = resolveHarnessConfig(options.config);
  const harnessSessionId = createHarnessSessionId();
  const evidenceSessionStore = createEvidenceSessionStore();
  let currentTurnEvidences: ToolEvidence[] = [];
  let runtimeTasks: RuntimeTaskItem[] = [];

  function ingestPoolCompleted(event: { agentName: string; response?: string }, ctx: ExtensionContext): void {
    const sessionId = (ctx.sessionManager as any)?.getSessionId?.() ?? harnessSessionId;
    if (!event.response) return;

    const verdictIngestion = ingestVerifierVerdict({
      text: event.response,
      source: "subagent",
      verifier: event.agentName,
    });
    if (verdictIngestion.ingested && verdictIngestion.evidence) {
      evidenceSessionStore.recordVerifierVerdict(sessionId, verdictIngestion.evidence);
      try {
        ctx.ui.notify(
          `[harness] verifier verdict captured: ${verdictIngestion.evidence.verdict}`,
          verdictIngestion.evidence.verdict === "PASS" ? "info" : "warning",
        );
      } catch {}
    }
  }

  pi.on("turn_start", async (_event) => {
    currentTurnEvidences = [];
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const toolCallId = (event as any).toolCallId ?? "";
    const args = (event as any).input ?? (event as any).args ?? {};
    const content = (event as any).content ?? (event as any).result;
    const isError = Boolean((event as any).isError ?? (event as any).success === false);
    const exitCode = toolName === "bash" ? extractExitCodeFromContent(content) : undefined;

    if (!toolName) return;

    const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? harnessSessionId;
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
    recordEvidence(
      evidence.toolName,
      evidence.toolCallId,
      evidence.rawInput,
      normalized.modelFacingMessage,
      evidence.success,
      evidence.exitCode,
    );
    auditEvidence("recorded", toolName, toolCallId);
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

    let nudgeMessage: string | undefined;
    const taskState = updateTaskStateFromToolResult(runtimeTasks, {
      toolName,
      rawInput: args,
      contentText: extractTextFromContentParts(Array.isArray(normalized.modelFacingMessage) ? normalized.modelFacingMessage : [normalized.modelFacingMessage]),
    });
    if (taskState.changed) {
      const oldTasks = runtimeTasks;
      runtimeTasks = taskState.tasks;
      const hasVerifierVerdict = evidenceSessionStore.getVerifierVerdicts(sessionId).length > 0;
      const nudge = detectVerificationNudge(oldTasks, runtimeTasks);
      if (nudge.needed && !hasVerifierVerdict) {
        nudgeMessage = formatNudgeMessage(nudge.closedCount);
        try {
          (ctx as any)?.ui?.notify?.(`[harness] ${nudgeMessage}`, "warning");
        } catch {}
      }
    }

    let outputContent = appendNudgeToModelFacingContent(normalized.modelFacingMessage as any, nudgeMessage);
    const outputIsError = evidence.success ? false : isError;

    if (harnessConfig.toolResultBudget.enabled) {
      const outputParts = Array.isArray(outputContent)
        ? outputContent
        : typeof outputContent === "string"
          ? [{ type: "text", text: outputContent }]
          : [outputContent];
      const contentText = extractTextFromContentParts(outputParts);
      if (contentText.length > 0) {
        const storageBaseDir = harnessConfig.toolResultBudget.storageBaseDir ?? "~/.pi/tool-results";
        const expandedBaseDir = expandHomePath(storageBaseDir);
        const decision = await applyToolResultBudget(
          { toolName, toolCallId, content: contentText },
          {
            thresholds: harnessConfig.toolResultBudget.thresholds,
            previewChars: harnessConfig.toolResultBudget.previewChars,
            storage: { baseDir: expandedBaseDir, sessionId },
            messages: harnessConfig.messages,
          },
        );
        if (decision.action === "persist") {
          const persistedContent = replaceFirstTextInContent(outputParts, decision.content);
          return { content: persistedContent, details: (event as any).details, isError: outputIsError };
        }
      }
    }

    if (normalized.messageModified || outputIsError !== isError || nudgeMessage) {
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

    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const userAskedForFinal = detectFinalRequestFromMessages(entries);

    const patterns = compilePatterns(DEFAULT_PATTERN_SOURCES);
    const claimsCompletion = patterns.completion.some((p) => p.test(finalText));
    const isFinalReport = userAskedForFinal || claimsCompletion;
    if (!isFinalReport) return;

    const sessionId = (ctx.sessionManager as any)?.getSessionId?.() ?? harnessSessionId;
    const auditEvidenceSelection = selectCompletionAuditEvidence({
      sessionId,
      sessionEvidences: evidenceSessionStore.getEvidenceSnapshot(sessionId),
      currentTurnEvidences,
      forceSessionWindow: claimsCompletion,
    });
    const evidenceSummary = applyVerifierVerdictsToEvidenceSummary(
      toCompletionEvidenceSummary(auditEvidenceSelection.evidences),
      evidenceSessionStore.getVerifierVerdicts(sessionId),
    );

    const decision = runHarnessAudit(
      {
        finalText,
        evidenceSummary,
        userAskedForFinal,
      },
      {
        messages: harnessConfig.messages,
        completion: {
          blockOnUnverifiedModification: harnessConfig.completionAuditor.blockOnUnverifiedModification,
          patterns: harnessConfig.completionAuditor.patterns,
        },
      },
    );

    if (decision.action === "warn" && decision.issues.length > 0) {
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
