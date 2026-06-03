import type { ToolEvidence } from "../policy/evidence-tracker";
import type { VerificationEvidenceState } from "../policy/verification-evidence-policy";
import type { CompletionEvidenceKind, CompletionEvidenceSummary } from "./completion-auditor";

export interface EvidenceAdapterOptions {
  pendingSubagentCount?: number;
  pendingTaskCount?: number;
  commandTextResolver?: (evidence: ToolEvidence) => string | undefined;
  verificationToolNames?: readonly string[];
  modificationToolNames?: readonly string[];
}

const DEFAULT_MODIFICATION_TOOLS = new Set(["write", "edit"]);
const DEFAULT_VERIFICATION_TOOLS = new Set(["bash"]);

const TEST_COMMAND_PATTERN = /\b(test|spec|vitest|jest|mocha|pytest|bun\s+test|npm\s+test|pnpm\s+test|yarn\s+test)\b/i;
const LINT_COMMAND_PATTERN = /\b(lint|biome\s+check|eslint)\b/i;
const TYPECHECK_COMMAND_PATTERN = /\b(typecheck|type-check|tsc\s+(?:--noEmit|-b)|vue-tsc)\b/i;

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function getCommandText(evidence: ToolEvidence, resolver?: EvidenceAdapterOptions["commandTextResolver"]): string {
  const resolved = resolver?.(evidence);
  if (resolved) return resolved;
  const command = evidence.args.command ?? evidence.args.cmd ?? evidence.args.script;
  return typeof command === "string" ? command : "";
}

function addKind(kinds: Set<CompletionEvidenceKind>, kind: CompletionEvidenceKind): void {
  kinds.add(kind);
}

export function toCompletionEvidenceSummary(
  evidences: readonly ToolEvidence[],
  options: EvidenceAdapterOptions = {},
): CompletionEvidenceSummary {
  const kinds = new Set<CompletionEvidenceKind>();
  const modificationTools = new Set((options.modificationToolNames ?? [...DEFAULT_MODIFICATION_TOOLS]).map(normalizeToolName));
  const verificationTools = new Set((options.verificationToolNames ?? [...DEFAULT_VERIFICATION_TOOLS]).map(normalizeToolName));
  let failedToolCount = 0;
  let modifiedFileCount = 0;

  for (const evidence of evidences) {
    const toolName = normalizeToolName(evidence.toolName);
    const commandText = getCommandText(evidence, options.commandTextResolver);

    if (!evidence.success) {
      failedToolCount += 1;
      addKind(kinds, "tool_failure");
      if (TEST_COMMAND_PATTERN.test(commandText)) addKind(kinds, "test_failure");
      if (LINT_COMMAND_PATTERN.test(commandText)) addKind(kinds, "lint_failure");
      if (TYPECHECK_COMMAND_PATTERN.test(commandText)) addKind(kinds, "typecheck_failure");
      continue;
    }

    if (modificationTools.has(toolName)) {
      addKind(kinds, "modification");
      modifiedFileCount += 1;
    }

    if (verificationTools.has(toolName)) {
      addKind(kinds, "verification");
      if (TEST_COMMAND_PATTERN.test(commandText)) addKind(kinds, "test_success");
      if (LINT_COMMAND_PATTERN.test(commandText)) addKind(kinds, "lint_success");
      if (TYPECHECK_COMMAND_PATTERN.test(commandText)) addKind(kinds, "typecheck_success");
    }
  }

  if ((options.pendingSubagentCount ?? 0) > 0) addKind(kinds, "subagent_pending");

  return {
    kinds: [...kinds],
    pendingSubagentCount: options.pendingSubagentCount,
    pendingTaskCount: options.pendingTaskCount,
    failedToolCount,
    modifiedFileCount,
  };
}

export function toVerificationEvidenceState(summary: CompletionEvidenceSummary): VerificationEvidenceState {
  return {
    hasRead: false,
    hasModify: summary.kinds.includes("modification"),
    hasVerification:
      summary.kinds.includes("verification") ||
      summary.kinds.includes("test_success") ||
      summary.kinds.includes("lint_success") ||
      summary.kinds.includes("typecheck_success"),
    hasFailure:
      summary.kinds.includes("tool_failure") ||
      summary.kinds.includes("test_failure") ||
      summary.kinds.includes("lint_failure") ||
      summary.kinds.includes("typecheck_failure"),
    hasSubagentPending: (summary.pendingSubagentCount ?? 0) > 0 || summary.kinds.includes("subagent_pending"),
  };
}
