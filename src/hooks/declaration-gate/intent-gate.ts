import { createGate } from './gate-factory';

const INSTRUCTION = `[IntentGate]
在调用任何工具前，你的回复文本必须以 "UNDERSTOOD: <用户需求>" 开头，
确认你已理解用户的需求。

声明必须写在回复文本中，不是思考或代码块里。`;

const BLOCK_MESSAGE =
  '[IntentGate] 声明必须写在回复文本中，不是思考或代码块里。\n' +
  '在回复文本开头写 "UNDERSTOOD: <需求描述>"，确认已理解用户需求。';

export function createIntentGateHook() {
  return createGate({
    name: 'intent',
    checkPattern: /^UNDERSTOOD:\s/m,
    instruction: INSTRUCTION,
    gatedTools: [
      'edit', 'Write', 'write', 'apply_patch',
      'task', 'read', 'grep', 'glob', 'bash', 'question',
      'webfetch', 'todowrite', 'ast_grep_search', 'ast_grep_replace',
      'vision_analyze',
    ],
    blockMessage: BLOCK_MESSAGE,
    oneShot: false,
  });
}
