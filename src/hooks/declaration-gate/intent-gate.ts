/**
 * Intent Gate.
 *
 * Requires the LLM to declare "Intent: [...]" in its response before
 * calling any tools. This ensures the LLM has classified the user's true
 * intent and chosen a routing decision before taking action.
 *
 * This replaces the old soft-reminder IntentGuard with hard enforcement.
 */

import { createDeclarationGate } from './gate-factory';

const INSTRUCTION = `[IntentGate]
Before calling any tool, your response MUST contain an intent declaration on its own line:
> "Intent: [classification] → [routing decision]"

Examples:
- Intent: [research] → explore
- Intent: [implementation] → delegate to fixer
- Intent: [evaluation] → propose and wait for confirmation
- Intent: [fix] → diagnose then fix
- Intent: [investigation] → explore then report

Keep it one line. Then act accordingly.`;

const BLOCK_MESSAGE =
  '[IntentGate] Your last response did not include an "Intent: [...]" declaration.\n' +
  'Add "Intent: [classification] → [routing decision]" to your response, then call the tool.\n' +
  'See the IntentGate section in your instructions for valid classifications.';

export function createIntentGateHook() {
  return createDeclarationGate({
    name: 'intent',
    checkPattern: /Intent:\s*\[/,
    instruction: INSTRUCTION,
    gatedTools: [
      'edit',
      'Write',
      'write',
      'apply_patch',
      'task',
      'read',
      'grep',
      'glob',
      'bash',
      'question',
      'webfetch',
      'todowrite',
      'ast_grep_search',
      'ast_grep_replace',
      'vision_analyze',
    ],
    blockMessage: BLOCK_MESSAGE,
    requirePrefixFromFirstMessage: false,
  });
}
