import { createGate } from './gate-factory';

const INSTRUCTION = `[ApprovalGate]
当你不确定选哪个方案时，不要擅自决定——把方案提交给用户选择。
在回复文本开头写：
"AWAITING_APPROVAL: 方案摘要" — 提出方案等待用户批准
用户批准后：
"APPROVED: 选定的方案" — 确认用户选择，开始执行
当前方案完成时：
"DONE: 完成内容" — 标记完成，重置状态
也可以委托子代理审查不同方案后给出推荐。

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[ApprovalGate] 当前有待批准的方案，不能擅自决定。\n' +
  '你提出了需要用户决策的方案，请先等待用户选择，\n' +
  '然后在回复开头写 "APPROVED: <选定的方案>" 再继续执行。';

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
