import { createGate } from './gate-factory';

const INSTRUCTION = `[ApprovalGate]
当当前方案还需要用户决定时，不要替用户继续往下做决定。
这一步是为了避免在存在待确认方案时擅自执行。
在回复文本开头写：
"AWAITING_APPROVAL: 方案摘要" — 提出方案等待用户批准
用户批准后：
"APPROVED: 选定的方案" — 确认用户选择，开始执行
当前方案完成时：
"DONE: 完成内容" — 标记完成，重置状态
也可以委托子代理审查不同方案后给出推荐。

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[ApprovalGate] 你还没有先说明当前方案已经得到用户确认。\n' +
  '在存在待决策方案时继续执行，容易替用户擅自做决定。\n' +
  '请先等待确认，并在回复开头写 "APPROVED: <选定的方案>" 后再继续。';

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
