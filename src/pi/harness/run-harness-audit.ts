import type { ToolEvidence } from "../policy/evidence-tracker";
import {
  checkVerificationEvidence,
  type VerificationEvidenceContext,
  type VerificationEvidenceState,
} from "../policy/verification-evidence-policy";
import { auditCompletion, type CompletionAuditorOptions, type CompletionEvidenceSummary } from "./completion-auditor";
import { toCompletionEvidenceSummary, toVerificationEvidenceState, type EvidenceAdapterOptions } from "./evidence-adapter";
import { DEFAULT_HARNESS_MESSAGES, buildInjectedGuardMessage } from "./messages";
import type { HarnessDecision, HarnessIssue, HarnessMessageCatalog } from "./types";

export interface HarnessAuditInput {
  finalText: string;
  evidences?: readonly ToolEvidence[];
  evidenceSummary?: CompletionEvidenceSummary;
  verificationState?: VerificationEvidenceState;
  verificationContext?: VerificationEvidenceContext;
  evidenceAdapter?: EvidenceAdapterOptions;
  userAskedForFinal?: boolean;
}

export interface HarnessAuditOptions {
  messages?: HarnessMessageCatalog;
  completion?: Omit<CompletionAuditorOptions, "messages">;
}

function toIssueFromVerification(
  reason: string,
  messageKey: string | undefined,
  message: string,
): HarnessIssue {
  return {
    id: reason,
    action: "warn",
    messageKey: messageKey ?? reason,
    message,
  };
}

export function runHarnessAudit(
  input: HarnessAuditInput,
  options: HarnessAuditOptions = {},
): HarnessDecision {
  const messages = options.messages ?? DEFAULT_HARNESS_MESSAGES;
  const evidenceSummary = input.evidenceSummary ?? toCompletionEvidenceSummary(input.evidences ?? [], input.evidenceAdapter);
  const verificationState = input.verificationState ?? toVerificationEvidenceState(evidenceSummary);
  const issues: HarnessIssue[] = [];

  const verificationDecision = checkVerificationEvidence(
    verificationState,
    input.verificationContext ?? { userAskedForFinal: input.userAskedForFinal },
    { messages: messages.verificationEvidence },
  );

  if (verificationDecision.action === "warn" && verificationDecision.reason && verificationDecision.hint) {
    issues.push(toIssueFromVerification(verificationDecision.reason, verificationDecision.messageKey, verificationDecision.hint));
  }

  const completionDecision = auditCompletion(
    {
      finalText: input.finalText,
      evidence: evidenceSummary,
      userAskedForFinal: input.userAskedForFinal,
    },
    {
      ...options.completion,
      messages,
    },
  );

  issues.push(...completionDecision.issues);

  const action = issues.some((item) => item.action === "block")
    ? "block"
    : issues.length > 0
      ? "warn"
      : "allow";

  return {
    action,
    issues,
    injectedMessage: buildInjectedGuardMessage(messages, issues),
  };
}
