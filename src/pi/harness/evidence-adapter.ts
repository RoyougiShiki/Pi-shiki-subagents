import type { ToolEvidence } from "../policy/tool-evidence-types";
import type { VerificationEvidenceState } from "../policy/verification-evidence-policy";
import { interpretCommandSemantic, type CommandSemanticConfig } from "../policy/command-semantics";
import type { CompletionEvidenceKind, CompletionEvidenceSummary } from "./completion-auditor";

export interface EvidenceAdapterOptions {
  pendingSubagentCount?: number;
  pendingTaskCount?: number;
  commandTextResolver?: (evidence: ToolEvidence) => string | undefined;
  verificationToolNames?: readonly string[];
  modificationToolNames?: readonly string[];
  commandSemantics?: CommandSemanticConfig;
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
const DIFF_CHECK_COMMAND_PATTERN = new RegExp(
  String.raw`${COMMAND_START}git\s+diff\s+--check\b`,
  "i",
);

const TEST_SUCCESS_OUTPUT_PATTERN = /\b(?:targeted-tests|tests?):\s*exit=0\b/i;
const TYPECHECK_SUCCESS_OUTPUT_PATTERN = /\btypecheck:\s*exit=0\b/i;
const LINT_SUCCESS_OUTPUT_PATTERN = /\blint:\s*exit=0\b/i;
const DIFF_CHECK_SUCCESS_OUTPUT_PATTERN = /\bdiff-check(?:-git)?:\s*exit=0\b/i;
const TEST_FAILURE_OUTPUT_PATTERN = /\b(?:targeted-tests|tests?):\s*exit=(?!0\b)\d+\b/i;
const TYPECHECK_FAILURE_OUTPUT_PATTERN = /\btypecheck:\s*exit=(?!0\b)\d+\b/i;
const LINT_FAILURE_OUTPUT_PATTERN = /\blint:\s*exit=(?!0\b)\d+\b/i;

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function getCommandText(evidence: ToolEvidence, resolver?: EvidenceAdapterOptions["commandTextResolver"]): string {
  const resolved = resolver?.(evidence);
  if (resolved) return resolved;
  const command = evidence.args.command ?? evidence.args.cmd ?? evidence.args.script ?? evidence.args.code;
  if (typeof command === "string") return command;
  const commands = evidence.args.commands;
  if (Array.isArray(commands)) {
    return commands
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).command === "string") {
          return (item as Record<string, string>).command;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.content ?? record.output ?? record.stdout ?? record.stderr;
    if (typeof text === "string") return text;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
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

function addGenericVerificationKind(kinds: Set<CompletionEvidenceKind>, commandText: string, suffix: "success" | "failure"): boolean {
  if (!DIFF_CHECK_COMMAND_PATTERN.test(commandText)) return false;
  if (suffix === "success") addKind(kinds, "verification");
  return true;
}

function addOutputVerificationKinds(kinds: Set<CompletionEvidenceKind>, text: string): boolean {
  let matched = false;
  if (TEST_SUCCESS_OUTPUT_PATTERN.test(text)) {
    addKind(kinds, "test_success");
    matched = true;
  }
  if (TYPECHECK_SUCCESS_OUTPUT_PATTERN.test(text)) {
    addKind(kinds, "typecheck_success");
    matched = true;
  }
  if (LINT_SUCCESS_OUTPUT_PATTERN.test(text)) {
    addKind(kinds, "lint_success");
    matched = true;
  }
  if (DIFF_CHECK_SUCCESS_OUTPUT_PATTERN.test(text)) {
    addKind(kinds, "verification");
    matched = true;
  }
  if (matched) addKind(kinds, "verification");
  return matched;
}

interface OutputFailureKinds {
  test: boolean;
  lint: boolean;
  typecheck: boolean;
}

function outputFailureKinds(text: string): OutputFailureKinds {
  return {
    test: TEST_FAILURE_OUTPUT_PATTERN.test(text),
    lint: LINT_FAILURE_OUTPUT_PATTERN.test(text),
    typecheck: TYPECHECK_FAILURE_OUTPUT_PATTERN.test(text),
  };
}

function hasOutputFailure(failure: OutputFailureKinds): boolean {
  return failure.test || failure.lint || failure.typecheck;
}

function removeKind(kinds: Set<CompletionEvidenceKind>, kind: CompletionEvidenceKind): void {
  kinds.delete(kind);
}

function timestampAfter(left: number | undefined, right: number | undefined): boolean {
  return left !== undefined && right !== undefined && left > right;
}

function isWaitOnlyInfrastructureCommand(commandText: string): boolean {
  return /^\s*(?:sleep\s+\d+|wait)(?:\s*(?:;|&&)\s*echo\s+[\w -]+)?\s*$/i.test(commandText);
}

function isInfrastructureFailure(commandText: string, text: string): boolean {
  return isWaitOnlyInfrastructureCommand(commandText) && /Request timed out|MCP error/i.test(text);
}

function canInferSuccessFromCommandText(toolName: string, evidence: ToolEvidence): boolean {
  return toolName === "bash" || evidence.exitCode === 0;
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
  let lastVerificationAt: number | undefined;
  let lastToolFailureAt: number | undefined;
  let lastTestSuccessAt: number | undefined;
  let lastTestFailureAt: number | undefined;
  let lastLintSuccessAt: number | undefined;
  let lastLintFailureAt: number | undefined;
  let lastTypecheckSuccessAt: number | undefined;
  let lastTypecheckFailureAt: number | undefined;
  for (const evidence of evidences) {
    const toolName = normalizeToolName(evidence.toolName);
    const commandText = getCommandText(evidence, options.commandTextResolver);
    const outputText = resultText(evidence.result);
    const outputFailures = outputFailureKinds(outputText);

    // 使用 command semantics 重新判断 bash 错误
    // grep/rg 返回 1 不是错误，find 返回 1 不是错误
    let effectiveSuccess = evidence.success;
    if (!evidence.success && toolName === "bash" && evidence.exitCode !== undefined) {
      const semantic = interpretCommandSemantic(commandText, evidence.exitCode, options.commandSemantics);
      if (!semantic.isError) {
        effectiveSuccess = true; // 命令语义说这不是错误
      }
    }

    if (!effectiveSuccess) {
      if (hasOutputFailure(outputFailures)) {
        failedToolCount += 1;
        addKind(kinds, "tool_failure");
        lastToolFailureAt = evidence.timestamp;
        if (outputFailures.test) {
          addKind(kinds, "test_failure");
          lastTestFailureAt = evidence.timestamp;
        }
        if (outputFailures.lint) {
          addKind(kinds, "lint_failure");
          lastLintFailureAt = evidence.timestamp;
        }
        if (outputFailures.typecheck) {
          addKind(kinds, "typecheck_failure");
          lastTypecheckFailureAt = evidence.timestamp;
        }
        continue;
      }
      if (isInfrastructureFailure(commandText, outputText)) continue;
      failedToolCount += 1;
      addKind(kinds, "tool_failure");
      lastToolFailureAt = evidence.timestamp;
      const matchedFailure = addCommandVerificationKinds(kinds, commandText, "failure");
      if (matchedFailure && TEST_COMMAND_PATTERN.test(commandText)) lastTestFailureAt = evidence.timestamp;
      if (matchedFailure && LINT_COMMAND_PATTERN.test(commandText)) lastLintFailureAt = evidence.timestamp;
      if (matchedFailure && TYPECHECK_COMMAND_PATTERN.test(commandText)) lastTypecheckFailureAt = evidence.timestamp;
      continue;
    }

    if (modificationTools.has(toolName)) {
      addKind(kinds, "modification");
      modifiedFileCount += 1;
    }

    if (hasOutputFailure(outputFailures)) {
      failedToolCount += 1;
      addKind(kinds, "tool_failure");
      lastToolFailureAt = evidence.timestamp;
      if (outputFailures.test) {
        addKind(kinds, "test_failure");
        lastTestFailureAt = evidence.timestamp;
      }
      if (outputFailures.lint) {
        addKind(kinds, "lint_failure");
        lastLintFailureAt = evidence.timestamp;
      }
      if (outputFailures.typecheck) {
        addKind(kinds, "typecheck_failure");
        lastTypecheckFailureAt = evidence.timestamp;
      }
    }

    const hasVerificationTool = verificationTools.has(toolName);
    const canInferCommandSuccess = canInferSuccessFromCommandText(toolName, evidence);
    let hasVerificationCommand = false;
    if (canInferCommandSuccess && TEST_COMMAND_PATTERN.test(commandText) && !outputFailures.test) {
      addKind(kinds, "test_success");
      lastTestSuccessAt = evidence.timestamp;
      hasVerificationCommand = true;
    }
    if (canInferCommandSuccess && LINT_COMMAND_PATTERN.test(commandText) && !outputFailures.lint) {
      addKind(kinds, "lint_success");
      lastLintSuccessAt = evidence.timestamp;
      hasVerificationCommand = true;
    }
    if (canInferCommandSuccess && TYPECHECK_COMMAND_PATTERN.test(commandText) && !outputFailures.typecheck) {
      addKind(kinds, "typecheck_success");
      lastTypecheckSuccessAt = evidence.timestamp;
      hasVerificationCommand = true;
    }
    const hasGenericVerificationCommand = canInferCommandSuccess && addGenericVerificationKind(kinds, commandText, "success");
    const hasOutputVerification = addOutputVerificationKinds(kinds, outputText);
    if (hasVerificationTool || hasVerificationCommand || hasGenericVerificationCommand || hasOutputVerification) {
      addKind(kinds, "verification");
      lastVerificationAt = evidence.timestamp;
      if (TEST_SUCCESS_OUTPUT_PATTERN.test(outputText)) lastTestSuccessAt = evidence.timestamp;
      if (LINT_SUCCESS_OUTPUT_PATTERN.test(outputText)) lastLintSuccessAt = evidence.timestamp;
      if (TYPECHECK_SUCCESS_OUTPUT_PATTERN.test(outputText)) lastTypecheckSuccessAt = evidence.timestamp;
    }
  }

  if (timestampAfter(lastTestSuccessAt, lastTestFailureAt)) removeKind(kinds, "test_failure");
  if (timestampAfter(lastLintSuccessAt, lastLintFailureAt)) removeKind(kinds, "lint_failure");
  if (timestampAfter(lastTypecheckSuccessAt, lastTypecheckFailureAt)) removeKind(kinds, "typecheck_failure");
  if (timestampAfter(lastVerificationAt, lastToolFailureAt)) removeKind(kinds, "tool_failure");
  if (!["tool_failure", "test_failure", "lint_failure", "typecheck_failure"].some((kind) => kinds.has(kind as CompletionEvidenceKind))) {
    failedToolCount = 0;
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
