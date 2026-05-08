import { createGate } from './gate-factory';

const INSTRUCTION = `[OrchestrationGate]
每次需要执行任务前，先想清楚：这件事自己做更高效，还是派给子代理更合适？
在调 task 工具前，回复文本中必须声明编排决策：
"ORCHESTRATION: self" — 自己做
"ORCHESTRATION: delegate to <agent>" — 委托给子代理
"ORCHESTRATION: background <agent>" — 后台任务

声明表示你已经做了这个思考决策，无论选哪个都是合理的。
声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[OrchestrationGate] 缺少编排决策声明。\n' +
  '先想清楚当前工作适合自己做还是派给子代理，然后在回复中写：\n' +
  'ORCHESTRATION: self（自己做）或 ORCHESTRATION: delegate to <agent>（派活）\n' +
  '声明后再调 task 工具。';

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
