import { createGate } from './gate-factory';
import {
  INTENT_GATE_BLOCK_MESSAGE,
  INTENT_GATE_INSTRUCTION,
} from '../../core/workflow-templates';

export function createIntentGateHook(options?: {
  isRalphLoopActive?: () => boolean;
  instruction?: string;
  blockMessage?: string;
}) {
  return createGate({
    name: 'intent',
    checkPattern: /^\s*(Intent|APPROVED|AWAITING_APPROVAL|READY|ORCHESTRATION|DONE):\s/m,
    instruction: options?.instruction ?? INTENT_GATE_INSTRUCTION,
    gatedTools: [
      'edit', 'Write', 'write', 'apply_patch',
      'task', 'bash', 'question',
      'webfetch', 'todowrite',
      'vision_analyze',
    ],
    blockMessage: options?.blockMessage ?? INTENT_GATE_BLOCK_MESSAGE,
    oneShot: false,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
