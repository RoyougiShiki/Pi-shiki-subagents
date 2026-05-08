import { createGate } from './gate-factory';

const INSTRUCTION = `[IntentGate]
在调用任何工具前，回复文本必须以声明开头，表明你已理解用户需求并决定了行动方向。
可接受的声明格式：
- "UNDERSTOOD: <需求>" — 确认理解用户需求
- "AWAITING_APPROVAL: <方案>" — 提交方案等待用户批准
- "READY: confirmed" — 已完成上下文分析确认就绪
- "READY: need to check ..." — 还需要确认信息
- "ORCHESTRATION: <决策>" — 编排决策

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[IntentGate] 声明必须写在回复文本中，不是思考或代码块里。\n' +
  '在回复文本开头写入 ONE OF:\n' +
  '"UNDERSTOOD: <需求>" / "AWAITING_APPROVAL: <方案>" / "READY: confirmed" / "ORCHESTRATION: <决策>"\n' +
  '表明你已理解需求并决定行动方向后再调用工具。';

export function createIntentGateHook() {
  return createGate({
    name: 'intent',
    checkPattern: /^(UNDERSTOOD|APPROVED|AWAITING_APPROVAL|READY|ORCHESTRATION|DONE):\s/m,
    instruction: INSTRUCTION,
    gatedTools: [
      'edit', 'Write', 'write', 'apply_patch',
      'task', 'bash', 'question',
      'webfetch', 'todowrite', 'ast_grep_search', 'ast_grep_replace',
      'vision_analyze',
    ],
    blockMessage: BLOCK_MESSAGE,
    oneShot: true,
    startActive: true,
  });
}
