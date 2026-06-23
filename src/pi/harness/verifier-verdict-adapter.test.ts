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

  test("H5: FAIL verdict → modification_without_verification (verifier_fail is not verification)", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("FAIL")]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(summary.kinds).toContain("verifier_fail");
    // H5 后 completion_against_verifier_fail issue 已删；
    // verifier_fail 不算 verification，所以 modification 无验证仍触发单规则。
    expect(decision.issues.map((issue) => issue.id)).not.toContain("completion_against_verifier_fail");
    expect(decision.issues.map((issue) => issue.id)).toContain("modification_without_verification");
  });

  test("H5: PARTIAL verdict → allow (verifier_partial counts as verification)", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("PARTIAL")]);
    const decision = auditCompletion({ finalText: "已完成", evidence: summary });

    expect(summary.kinds).toContain("verification");
    expect(summary.kinds).toContain("verifier_partial");
    // H5 后 completion_against_verifier_partial issue 已删；
    // verifier_partial 算 verification，单规则不触发。
    expect(decision.issues.map((issue) => issue.id)).not.toContain("completion_against_verifier_partial");
    expect(decision.issues.map((issue) => issue.id)).not.toContain("modification_without_verification");
  });

  test("uses latest verdict", () => {
    const summary = applyVerifierVerdictsToEvidenceSummary(baseSummary, [verdict("FAIL", 1), verdict("PASS", 2)]);

    expect(summary.verifierVerdict).toBe("PASS");
    expect(summary.kinds).toContain("verifier_pass");
    expect(summary.kinds).not.toContain("verifier_fail");
  });
});
