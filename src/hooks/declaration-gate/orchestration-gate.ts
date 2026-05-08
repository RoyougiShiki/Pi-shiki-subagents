import { createGate } from './gate-factory';

const INSTRUCTION = `[OrchestrationGate]
在调用 task 工具前，回复文本中必须声明编排决策：
"ORCHESTRATION: self" — 自己做
"ORCHESTRATION: delegate to <agent>" — 委托给子代理
"ORCHESTRATION: background <agent>" — 后台任务

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[OrchestrationGate] 声明必须写在回复文本中，不是思考或代码块里。\n' +
  '在回复文本中写 "ORCHESTRATION: <决策>" 后再调 task 工具。\n' +
  '可选：self / delegate to <agent> / background <agent>';

export function createOrchestrationGateHook(options?: {
  isRalphLoopActive?: () => boolean;
}) {
  return createGate({
    name: 'orchestration',
    checkPattern: /^\s*ORCHESTRATION:\s/m,
    instruction: INSTRUCTION,
    gatedTools: ['task'],
    blockMessage: BLOCK_MESSAGE,
    oneShot: false,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
