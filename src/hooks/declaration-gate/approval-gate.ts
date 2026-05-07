/**
 * Approval Gate.
 *
 * Requires the LLM to declare "APPROVED:" at the start of a line before
 * calling edit/write tools. The LLM uses semantic understanding to decide
 * when the user has given the go-ahead (whether by selecting an option,
 * saying "ok", "好", or simply asking for implementation).
 *
 * Negative: "NOT_APPROVED" — explicitly marks as not approved, blocking
 * further tool calls until the user clarifies.
 */

import { createDeclarationGate } from './gate-factory';

const INSTRUCTION = `[ApprovalGate]
Before calling any edit/write tool, your response MUST begin with one of these declarations:
- "APPROVED: <brief description>" — the user has given you the go-ahead to implement
- "NOT_APPROVED" — the user has not yet decided or is still discussing

Wait for the user to choose before declaring APPROVED. False APPROVED declarations will
cause tool execution errors and wasted effort.`;

const BLOCK_MESSAGE =
  '[ApprovalGate] Your last response did not declare APPROVED: before calling edit/write tools.\n' +
  'Respond with "APPROVED: <description>" first, then call the tool.\n' +
  'If the user has not yet approved, respond with "NOT_APPROVED" and wait for their decision.';

export function createApprovalGateHook(options?: {
  isRalphLoopActive?: () => boolean;
  fetchCurrentAsstText?: (sessionId: string) => Promise<string | null>;
}) {
  return createDeclarationGate({
    name: 'approval',
    checkPattern: /^\s*APPROVED:\s/m,
    notPattern: /^\s*NOT_APPROVED\b/m,
    instruction: INSTRUCTION,
    gatedTools: ['edit', 'Write', 'write', 'apply_patch'],
    blockMessage: BLOCK_MESSAGE,
    isRalphLoopActive: options?.isRalphLoopActive,
    fetchCurrentAsstText: options?.fetchCurrentAsstText,
  });
}
