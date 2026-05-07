/**
 * Orchestration Gate.
 *
 * Requires the LLM to declare "ORCHESTRATION: <decision>" before calling
 * the `task` tool. This ensures the orchestrator consciously decides on
 * delegation vs self-execution rather than defaulting to one or the other.
 */

import { createDeclarationGate } from './gate-factory';

const INSTRUCTION = `[OrchestrationGate]
Before calling the task tool, your response MUST include an orchestration declaration:
> "ORCHESTRATION: <decision>"

Valid decisions:
- "ORCHESTRATION: delegate to <agent>" — delegates to a specialist (fixer, explorer, oracle, etc.)
- "ORCHESTRATION: self" — you will do this yourself without delegation
- "ORCHESTRATION: background <agent>" — delegates as a background task

Examples:
- ORCHESTRATION: delegate to fixer
- ORCHESTRATION: self
- ORCHESTRATION: background explorer
- ORCHESTRATION: delegate to council`;

const BLOCK_MESSAGE =
  '[OrchestrationGate] Your last response did not include an "ORCHESTRATION:" declaration.\n' +
  'Before calling the task tool, add "ORCHESTRATION: <decision>" to your response.\n' +
  'Valid values: delegate to <agent>, self, background <agent>.';

export function createOrchestrationGateHook() {
  return createDeclarationGate({
    name: 'orchestration',
    checkPattern: /^\s*ORCHESTRATION:\s/m,
    instruction: INSTRUCTION,
    gatedTools: ['task'],
    blockMessage: BLOCK_MESSAGE,
    requirePrefixFromFirstMessage: false,
  });
}
