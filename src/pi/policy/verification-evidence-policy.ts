import { DEFAULT_HARNESS_MESSAGES } from '../harness/messages';
import type { HarnessMessageCatalog } from '../harness/types';

export interface VerificationEvidenceState {
  hasRead: boolean;
  hasModify: boolean;
  hasVerification: boolean;
  hasFailure: boolean;
  hasSubagentPending: boolean;
}

export interface VerificationEvidenceContext {
  afterToolFailure?: boolean;
  afterModification?: boolean;
  dependingOnSubagent?: boolean;
}

export interface VerificationEvidenceDecision {
  action: 'allow' | 'warn';
  reason?: string;
  messageKey?: keyof HarnessMessageCatalog['verificationEvidence'];
  hint?: string;
}

export interface VerificationEvidenceOptions {
  messages?: HarnessMessageCatalog['verificationEvidence'];
}

const allow = (): VerificationEvidenceDecision => ({ action: 'allow' });

const warn = (
  reason: string,
  messageKey: keyof HarnessMessageCatalog['verificationEvidence'],
  hint: string,
): VerificationEvidenceDecision => ({
  action: 'warn',
  reason,
  messageKey,
  hint,
});

/**
 * Verification Evidence Guard / Evidence Reminder.
 *
 * Pure policy: no text scanning, no UI, no Pi API, no global evidence reads.
 * The composition layer must pass a summarized evidence state.
 */
export function checkVerificationEvidence(
  state: VerificationEvidenceState,
  context: VerificationEvidenceContext = {},
  options: VerificationEvidenceOptions = {},
): VerificationEvidenceDecision {
  const messages =
    options.messages ?? DEFAULT_HARNESS_MESSAGES.verificationEvidence;

  if (context.dependingOnSubagent && state.hasSubagentPending) {
    return warn(
      'subagent_pending',
      'subagentPending',
      messages.subagentPending,
    );
  }

  if (
    (context.afterToolFailure || state.hasFailure) &&
    !state.hasVerification
  ) {
    return warn(
      'tool_failed_without_recovery',
      'toolFailedWithoutRecovery',
      messages.toolFailedWithoutRecovery,
    );
  }

  if (
    (context.afterModification || state.hasModify) &&
    state.hasModify &&
    !state.hasVerification
  ) {
    return warn(
      'modified_without_verification',
      'modificationWithoutVerification',
      messages.modificationWithoutVerification,
    );
  }

  return allow();
}
