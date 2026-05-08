import { createGate } from './gate-factory';

const INSTRUCTION = `[IntentGate]
在调用任何工具前，先理解用户这条消息真正想要什么（包括隐含意图），
然后回复文本必须以声明开头，表明你已理解用户需求并决定了行动方向。
可接受的声明格式：
- "UNDERSTOOD: <需求>" — 确认你理解了用户真正的需求
- "AWAITING_APPROVAL: <方案>" — 提交方案等待用户批准
- "READY: <已掌握信息>" — 已完成上下文分析确认就绪
- "READY: need to check ..." — 还需要确认信息
- "ORCHESTRATION: <决策>" — 编排决策

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[IntentGate] 回复开头缺少意图声明。\n' +
  '每次回复前先问自己：用户这句话真正想要什么？我理解了用户的真实意图吗？\n' +
  '在回复文本开头写入声明，例如：\n' +
  '"UNDERSTOOD: <你理解的用户需求>" / "ORCHESTRATION: <决策>"\n' +
  '然后再调用工具。';

export function createIntentGateHook(options?: {
  isRalphLoopActive?: () => boolean;
}) {
  return createGate({
    name: 'intent',
    checkPattern: /^\s*(UNDERSTOOD|APPROVED|AWAITING_APPROVAL|READY|ORCHESTRATION|DONE):\s/m,
    instruction: INSTRUCTION,
    gatedTools: [
      'edit', 'Write', 'write', 'apply_patch',
      'task', 'bash', 'question',
      'webfetch', 'todowrite', 'ast_grep_search', 'ast_grep_replace',
      'vision_analyze',
    ],
    blockMessage: BLOCK_MESSAGE,
    oneShot: false,
    isRalphLoopActive: options?.isRalphLoopActive,
  });
}
