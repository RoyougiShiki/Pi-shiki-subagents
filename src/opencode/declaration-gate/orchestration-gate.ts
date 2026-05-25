import { createGate } from './gate-factory';
import {
  ORCHESTRATION_GATE_BLOCK_MESSAGE,
  ORCHESTRATION_GATE_INSTRUCTION,
} from '../../opencode/workflow-templates';

export function createOrchestrationGateHook(options?: {
  isRalphLoopActive?: () => boolean;
  instruction?: string;
  blockMessage?: string;
}) {
  return createGate({
    name: 'orchestration',
    checkPattern: /^\s*ORCHESTRATION:\s/m,
    instruction: options?.instruction ?? ORCHESTRATION_GATE_INSTRUCTION,
    gatedTools: ['task'],
    blockMessage: options?.blockMessage ?? ORCHESTRATION_GATE_BLOCK_MESSAGE,
    oneShot: false,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
