import { createGate } from './gate-factory';

const INSTRUCTION = `[IntentGate]
在调用任何工具前，先说明你理解用户这条消息真正想要什么，以及接下来准备如何推进。
这一步不是为了补格式，而是为了避免在理解不清时直接执行。
可接受的声明格式：
- "Intent: <分类> → <行动方向>" — 说明当前意图判断与推进方式
- "AWAITING_APPROVAL: <方案>" — 提交方案等待用户批准
- "READY: <已掌握信息>" — 已完成上下文分析确认就绪
- "READY: need to check ..." — 还需要确认信息
- "ORCHESTRATION: <决策>" — 编排决策

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[IntentGate] 你还没有先说明你对用户真实意图的理解。\n' +
  '如果没先确认这一点就调用工具，容易在理解偏差下直接执行。\n' +
  '请先在回复开头写出你的判断，例如："Intent: investigation → inspect the repo"，然后再继续。';

export function createIntentGateHook(options?: {
  isRalphLoopActive?: () => boolean;
}) {
  return createGate({
    name: 'intent',
    checkPattern: /^\s*(Intent|APPROVED|AWAITING_APPROVAL|READY|ORCHESTRATION|DONE):\s/m,
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
