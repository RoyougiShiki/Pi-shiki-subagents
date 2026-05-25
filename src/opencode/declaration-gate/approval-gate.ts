import { createGate } from './gate-factory';
import {
  APPROVAL_GATE_BLOCK_MESSAGE,
  APPROVAL_GATE_INSTRUCTION,
} from '../../opencode/workflow-templates';

export function createApprovalGateHook(options?: {
  isRalphLoopActive?: () => boolean;
  instruction?: string;
  blockMessage?: string;
}) {
  return createGate({
    name: 'approval',
    checkPattern: /^\s*APPROVED:\s/m,
    notPattern: /^\s*AWAITING_APPROVAL:\s/m,
    instruction: options?.instruction ?? APPROVAL_GATE_INSTRUCTION,
    gatedTools: ['edit', 'Write', 'write', 'apply_patch'],
    blockMessage: options?.blockMessage ?? APPROVAL_GATE_BLOCK_MESSAGE,
    oneShot: true,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
