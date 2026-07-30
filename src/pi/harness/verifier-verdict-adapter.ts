import type {
  CompletionEvidenceKind,
  CompletionEvidenceSummary,
} from './completion-auditor';
import type { VerifierVerdictEvidence } from './verifier-verdict-evidence';

function addKind(
  kinds: Set<CompletionEvidenceKind>,
  kind: CompletionEvidenceKind,
): void {
  kinds.add(kind);
}

function latestVerdict(
  verdicts: readonly VerifierVerdictEvidence[],
): VerifierVerdictEvidence | undefined {
  return [...verdicts].sort((a, b) => a.timestamp - b.timestamp).at(-1);
}

export function applyVerifierVerdictsToEvidenceSummary(
  summary: CompletionEvidenceSummary,
  verdicts: readonly VerifierVerdictEvidence[],
): CompletionEvidenceSummary {
  if (verdicts.length === 0) return summary;

  const latest = latestVerdict(verdicts);
  if (!latest) return summary;

  const kinds = new Set(summary.kinds);
  if (latest.verdict === 'PASS') {
    addKind(kinds, 'verification');
    addKind(kinds, 'verifier_pass');
  } else if (latest.verdict === 'FAIL') {
    addKind(kinds, 'verifier_fail');
  } else {
    addKind(kinds, 'verification');
    addKind(kinds, 'verifier_partial');
  }

  return {
    ...summary,
    kinds: [...kinds],
    verifierVerdict: latest.verdict,
    verifierSummary: latest.summary,
  };
}
