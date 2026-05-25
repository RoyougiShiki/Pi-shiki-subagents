import { describe, expect, test } from 'bun:test';
import { createIntentGateHook } from './intent-gate';

function makeMsg(
  role: string,
  text: string,
  agent?: string,
): Record<string, unknown> {
  return {
    info: { role, ...(agent ? { agent } : {}) },
    parts: text ? [{ type: 'text', text }] : [],
  };
}

async function callTool(
  hook: ReturnType<typeof createIntentGateHook>,
  tool: string,
): Promise<'passed' | 'blocked'> {
  const o = { args: {} };
  try {
    await hook['tool.execute.before']({ tool }, o);
    return 'passed';
  } catch {
    return 'blocked';
  }
}

describe('createIntentGateHook', () => {
  test('Intent: opens gate for normal tools', async () => {
    const hook = createIntentGateHook();
    const o = {
      messages: [
        makeMsg('user', 'inspect this repo'),
        makeMsg('assistant', 'Intent: investigation → inspect the repo'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'bash')).toBe('passed');
    expect(await callTool(hook, 'task')).toBe('passed');
  });

  test('specialized declarations still satisfy intent gate', async () => {
    const hook = createIntentGateHook();
    const cases = [
      'ORCHESTRATION: self',
      'READY: repo structure checked',
      'AWAITING_APPROVAL: plan A vs plan B',
      'APPROVED: use plan A',
      'DONE: finished',
    ];

    for (const text of cases) {
      const o = {
        messages: [makeMsg('user', 'do work'), makeMsg('assistant', text)],
      };
      await hook['experimental.chat.messages.transform']({}, o);
      expect(await callTool(hook, 'bash')).toBe('passed');
    }
  });

  test('old UNDERSTOOD: no longer satisfies intent gate', async () => {
    const hook = createIntentGateHook();
    const o = {
      messages: [
        makeMsg('user', 'do work'),
        makeMsg('assistant', 'UNDERSTOOD: proceed'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'bash')).toBe('blocked');
  });

  test('injects workflow-first instruction', async () => {
    const hook = createIntentGateHook();
    const userMsg = makeMsg('user', 'hi');
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [makeMsg('system', ''), userMsg] },
    );
    expect((userMsg.parts as { text: string }[])[0].text).toContain(
      '先说明你理解用户这条消息真正想要什么',
    );
  });
});
