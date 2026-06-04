import { describe, expect, test } from "bun:test";
import { ingestVerifierVerdict } from "./verifier-verdict-evidence";

const PASS_TEXT = `
### Check: tests pass
**Command run:**
  bun test
**Output observed:**
  10 pass
**Result: PASS**

VERDICT: PASS
`;

const FAIL_TEXT = `
VERDICT: FAIL
The verifier found a regression.
`;

describe("verifier-verdict-evidence", () => {
  test("ingests PASS verdict evidence", () => {
    const result = ingestVerifierVerdict({
      text: PASS_TEXT,
      source: "subagent",
      verifier: "reviewer",
      now: () => 123,
    });

    expect(result.ingested).toBe(true);
    expect(result.evidence).toMatchObject({
      source: "subagent",
      verdict: "PASS",
      verifier: "reviewer",
      timestamp: 123,
    });
    expect(result.evidence?.parsed.hasCommandRun).toBe(true);
  });

  test("uses fail details as summary", () => {
    const result = ingestVerifierVerdict({ text: FAIL_TEXT, source: "manual" });

    expect(result.ingested).toBe(true);
    expect(result.evidence?.verdict).toBe("FAIL");
    expect(result.evidence?.summary).toContain("regression");
  });

  test("ignores text without verdict", () => {
    const result = ingestVerifierVerdict({ text: "looks fine", source: "subagent" });

    expect(result.ingested).toBe(false);
    expect(result.evidence).toBeUndefined();
  });
});
