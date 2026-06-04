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
const DEFAULT_VERIFICATION_TOOLS = new Set<string>();

const COMMAND_START = String.raw`(?:^|(?:&&|\|\||;)\s*)`;
const PACKAGE_RUNNER = String.raw`(?:bun|npm|pnpm|yarn)`;

const TEST_COMMAND_PATTERN = new RegExp(
  String.raw`${COMMAND_START}(?:(?:${PACKAGE_RUNNER})\s+(?:run\s+)?(?:test|spec|vitest|jest|mocha)\b|npx\s+(?:vitest|jest|mocha)\b|(?:vitest|jest|mocha|pytest)\b|go\s+test\b|cargo\s+test\b|mvn\s+test\b|gradle\s+test\b)`,
  "i",
);
const LINT_COMMAND_PATTERN = new RegExp(
  String.raw`${COMMAND_START}(?:(?:${PACKAGE_RUNNER})\s+(?:run\s+)?(?:lint|eslint|biome\s+check)\b|npx\s+(?:eslint|biome)\b|eslint\b|biome\s+check\b|ruff\s+check\b|flake8\b)`,
  "i",
);
const TYPECHECK_COMMAND_PATTERN = new RegExp(
  String.raw`${COMMAND_START}(?:(?:${PACKAGE_RUNNER})\s+(?:run\s+)?(?:typecheck|type-check|tsc|vue-tsc)\b|npx\s+(?:tsc|vue-tsc)\b|tsc\s+(?:--noEmit|-b)\b|vue-tsc\b)`,
  "i",
);

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

function addCommandVerificationKinds(kinds: Set<CompletionEvidenceKind>, commandText: string, suffix: "success" | "failure"): boolean {
  let matched = false;
  if (TEST_COMMAND_PATTERN.test(commandText)) {
    addKind(kinds, `test_${suffix}`);
    matched = true;
  }
  if (LINT_COMMAND_PATTERN.test(commandText)) {
    addKind(kinds, `lint_${suffix}`);
    matched = true;
  }
  if (TYPECHECK_COMMAND_PATTERN.test(commandText)) {
    addKind(kinds, `typecheck_${suffix}`);
    matched = true;
  }
  return matched;
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
      addCommandVerificationKinds(kinds, commandText, "failure");
      continue;
    }

    if (modificationTools.has(toolName)) {
      addKind(kinds, "modification");
      modifiedFileCount += 1;
    }

    const hasVerificationTool = verificationTools.has(toolName);
    const hasVerificationCommand = addCommandVerificationKinds(kinds, commandText, "success");
    if (hasVerificationTool || hasVerificationCommand) {
      addKind(kinds, "verification");
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
