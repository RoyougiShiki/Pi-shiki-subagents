import { createGate } from './gate-factory';

const INSTRUCTION = `[ApprovalGate]
方案评审：如果你提出了多个方案需要用户选择，在回复文本开头写：
"AWAITING_APPROVAL: 方案摘要"
用户批准后，在回复文本开头写：
"APPROVED: 选定的方案"
当前方案完成时，在回复文本开头写：
"DONE: 完成内容"
也可以委托子代理审查不同方案后给出推荐。

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[ApprovalGate] 声明必须写在回复文本中，不是思考或代码块里。\n' +
  '当前有待批准的方案，请先获取用户批准。\n' +
  '在回复文本开头写 "APPROVED: <方案>" 或继续等待用户选择。';

export function createApprovalGateHook(options?: {
  isRalphLoopActive?: () => boolean;
}) {
  return createGate({
    name: 'approval',
    checkPattern: /^\s*APPROVED:\s/m,
    notPattern: /^\s*AWAITING_APPROVAL:\s/m,
    instruction: INSTRUCTION,
    gatedTools: ['edit', 'Write', 'write', 'apply_patch'],
    blockMessage: BLOCK_MESSAGE,
    oneShot: true,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
