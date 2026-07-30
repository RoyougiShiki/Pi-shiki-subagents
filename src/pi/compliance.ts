/**
 * Lightweight compliance state & core functions for PI agent.
 *
 * Provides session-level state management, violation recording,
 * reset flow coordination, and the Intent-prefix check used
 * in message_end gate.
 *
 * Design:
 *  - Pure functions over a simple mutable object (no class, no DI).
 *  - Violation records carry a type, reason, and optional metadata.
 *  - Reset flow is a single boolean flag + count.
 *  - Intent prefix check is regex-based, only active for modes that
 *    explicitly require it.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ComplianceState = {
  violationCount: number;
  inReset: boolean;
  lastViolationAt: number | null;
};

export type ViolationType =
  | 'MISSING_INTENT_PREFIX'
  | 'TOOL_ENFORCEMENT_MISSED'
  | 'TOOL_BLOCKED'
  | 'RESET_FAILED';

export type ViolationRecord = {
  type: ViolationType;
  reason: string;
  at: number;
  metadata?: Record<string, unknown>;
};

// ─── State helpers ──────────────────────────────────────────────────────────

export function createComplianceState(): ComplianceState {
  return {
    violationCount: 0,
    inReset: false,
    lastViolationAt: null,
  };
}

/**
 * Record a violation, bumping the counter and updating the timestamp.
 * Mutates `state` in place (lightweight, no cloning).
 */
export function recordViolation(
  state: ComplianceState,
  v: ViolationRecord,
): void {
  state.violationCount++;
  state.lastViolationAt = v.at;
}

/**
 * Decide whether to enter the reset flow.
 * Currently triggers on every fresh violation (not already in reset).
 */
export function shouldTriggerReset(state: ComplianceState): boolean {
  return !state.inReset;
}

export function markResetStart(state: ComplianceState): void {
  state.inReset = true;
}

export function markResetEnd(state: ComplianceState): void {
  state.inReset = false;
}

// ─── Intent prefix check ────────────────────────────────────────────────────

const INTENT_PREFIX_RE = /^Intent:\s*\S/;

/**
 * Returns true when the first non-empty line of `text` matches
 * `Intent: <type>` (with at least one non-whitespace character after the colon).
 *
 * Handles leading whitespace before the Intent line.
 */
export function hasIntentPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  // Take first non-empty line
  const firstLine = trimmed.split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) return false;
  return INTENT_PREFIX_RE.test(firstLine.trim());
}

// ─── Reset instruction builder ──────────────────────────────────────────────

/**
 * Build a short structured reset message the assistant can output to
 * signal it has recognised the violation and is entering remediation.
 */
export function buildResetInstruction(v: ViolationRecord): string {
  return [
    `Intent: compliance-reset`,
    `Violation: ${v.type}`,
    `Reason: ${v.reason}`,
    `Fix Plan: Address the violation above by following the required format precisely.`,
  ].join('\n');
}
