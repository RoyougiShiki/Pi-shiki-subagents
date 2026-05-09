import { createGate } from './gate-factory';

const INSTRUCTION = `[OrchestrationGate]
每次需要执行任务前，先想清楚：这件事应该自己做，还是更适合委托给子代理？
这一步是为了避免还没做编排判断就直接推进任务。
在调 task 工具前，回复文本中必须声明编排决策：
"ORCHESTRATION: self" — 自己做
"ORCHESTRATION: delegate to <agent>" — 委托给子代理
"ORCHESTRATION: background <agent>" — 后台任务

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[OrchestrationGate] 你还没有先说明这件事应该自己做，还是更适合委托给子代理。\n' +
  '如果没先做这个编排判断，容易用低效方式推进任务。\n' +
  '请先在回复开头写出编排决策，例如："ORCHESTRATION: self"，然后再调 task 工具。';

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
