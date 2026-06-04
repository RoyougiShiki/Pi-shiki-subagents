import { describe, expect, test } from "bun:test";
import { auditCompletion } from "./completion-auditor";
import { applyVerifierVerdictsToEvidenceSummary } from "./verifier-verdict-adapter";
import type { CompletionEvidenceSummary } from "./completion-auditor";
import type { VerifierVerdictEvidence } from "./verifier-verdict-evidence";

const baseSummary: CompletionEvidenceSummary = {
  kinds: ["modification"],
  modifiedFileCount: 1,
};

function verdict(verdict: "PASS" | "FAIL" | "PARTIAL", timestamp = 1): VerifierVerdictEvidence {
  return {
    source: "subagent",
    verdict,
    summary: `${verdict} summary`,
    rawText: `VERDICT: ${verdict}`,
    parsed: {
      verdict,
      checkBlocks: [],
      hasCommandRun: false,
      hasOutputObserved: false,
    },
    timestamp,
  };
}

describe("verifier-verdict-adapter", () => {
  test("PASS verdict satisfies modification verification", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("PASS")]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(summary.kinds).toContain("verification");
    expect(summary.kinds).toContain("verifier_pass");
    expect(decision.issues.map((issue) => issue.id)).not.toContain("modification_without_verification");
  });

  test("FAIL verdict warns on completion claim", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("FAIL")]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(summary.kinds).toContain("verifier_fail");
    expect(decision.issues.map((issue) => issue.id)).toContain("completion_against_verifier_fail");
  });

  test("PARTIAL verdict warns on unconditional completion claim", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("PARTIAL")]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(summary.kinds).toContain("verification");
    expect(summary.kinds).toContain("verifier_partial");
    expect(decision.issues.map((issue) => issue.id)).toContain("completion_against_verifier_partial");
    expect(decision.issues.map((issue) => issue.id)).not.toContain("modification_without_verification");
  });

  test("uses latest verdict", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("FAIL", 1), verdict("PASS", 2)]);

    expect(summary.verifierVerdict).toBe("PASS");
    expect(summary.kinds).toContain("verifier_pass");
    expect(summary.kinds).not.toContain("verifier_fail");
  });
});
