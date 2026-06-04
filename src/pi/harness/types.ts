export type HarnessDecisionAction = "allow" | "warn" | "block";

export interface HarnessIssue {
  id: string;
  action: Exclude<HarnessDecisionAction, "allow">;
  messageKey: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HarnessDecision {
  action: HarnessDecisionAction;
  issues: HarnessIssue[];
  injectedMessage?: string;
}

export interface HarnessMessageCatalog {
  verificationEvidence: {
    subagentPending: string;
    toolFailedWithoutRecovery: string;
    modificationWithoutVerification: string;
  };
  completionAuditor: {
    testPassWithoutEvidence: string;
    lintPassWithoutEvidence: string;
    typecheckPassWithoutEvidence: string;
    completionWithPendingSubagent: string;
    completionWithPendingTasks: string;
    completionAfterFailureWithoutAcknowledgement: string;
    completionAgainstVerifierFail: string;
    completionAgainstVerifierPartial: string;
    modificationWithoutVerification: string;
    finalReportWithoutAcknowledgingFailure: string;
    finalReportWithoutAcknowledgingUnverified: string;
    injectedHeader: string;
  };
  toolResultBudget: {
    persistedOutput: (args: {
      originalSize: number;
      filepath: string;
      previewSize: number;
      preview: string;
      hasMore: boolean;
    }) => string;
    clearedOutput: (args: { filepath?: string }) => string;
  };
}
