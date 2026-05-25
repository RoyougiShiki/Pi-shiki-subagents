import { describe, expect, test } from 'bun:test';
import { createClarifyGateHook } from './clarify-gate';

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
  hook: ReturnType<typeof createClarifyGateHook>,
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

describe('createClarifyGateHook', () => {
  test('first turn injects instruction', async () => {
    const hook = createClarifyGateHook();
    const userMsg = makeMsg('user', 'help');
    const output = { messages: [makeMsg('system', ''), userMsg] };
    await hook['experimental.chat.messages.transform']({}, output);
    expect((userMsg.parts as any)[0].text).toContain('[ReadinessGate]');
  });

  test('READY: confirmed opens gate', async () => {
    const hook = createClarifyGateHook();
    let o = { messages: [makeMsg('system', ''), makeMsg('user', 'hi')] };
    await hook['experimental.chat.messages.transform']({}, o);
    o = {
      messages: [makeMsg('user', 'ready'), makeMsg('assistant', 'READY: confirmed')],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('READY: with custom description opens gate', async () => {
    const hook = createClarifyGateHook();
    let o = { messages: [makeMsg('system', ''), makeMsg('user', 'hi')] };
    await hook['experimental.chat.messages.transform']({}, o);
    o = {
      messages: [
        makeMsg('user', 'ready'),
        makeMsg('assistant', 'READY: 检查完 SVN 状态，所有依赖已确认'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('3 need-to-check rounds block edit', async () => {
    const hook = createClarifyGateHook();
    let o = { messages: [makeMsg('system', ''), makeMsg('user', 'hi')] };
    await hook['experimental.chat.messages.transform']({}, o);
    for (let i = 0; i < 2; i++) {
      o = {
        messages: [
          makeMsg('user', 'x'),
          makeMsg('assistant', 'READY: need to check'),
        ],
      };
      await hook['experimental.chat.messages.transform']({}, o);
      expect(await callTool(hook, 'edit')).toBe('passed');
    }
    o = {
      messages: [
        makeMsg('user', 'x'),
        makeMsg('assistant', 'READY: need to check'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('blocked');
    expect(await callTool(hook, 'read')).toBe('passed');
  });

  test('DONE resets', async () => {
    const hook = createClarifyGateHook();
    let o = { messages: [makeMsg('system', ''), makeMsg('user', 'hi')] };
    await hook['experimental.chat.messages.transform']({}, o);
    for (let i = 0; i < 3; i++) {
      o = {
        messages: [
          makeMsg('user', 'x'),
          makeMsg('assistant', 'READY: need to check'),
        ],
      };
      await hook['experimental.chat.messages.transform']({}, o);
    }
    expect(await callTool(hook, 'edit')).toBe('blocked');
    o = {
      messages: [makeMsg('user', 'd'), makeMsg('assistant', 'DONE: done')],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('non-orchestrator skipped', async () => {
    const hook = createClarifyGateHook();
    const userMsg = makeMsg('user', 'hi', 'explorer');
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [makeMsg('system', ''), userMsg] },
    );
    expect((userMsg.parts as any)[0].text).not.toContain('[ReadinessGate]');
  });

  test('ralph loop bypasses', async () => {
    let active = true;
    const hook = createClarifyGateHook({ isRalphLoopActive: () => active });
    let o = { messages: [makeMsg('system', ''), makeMsg('user', 'hi')] };
    await hook['experimental.chat.messages.transform']({}, o);
    for (let i = 0; i < 3; i++) {
      o = {
        messages: [
          makeMsg('user', 'x'),
          makeMsg('assistant', 'READY: need to check'),
        ],
      };
      await hook['experimental.chat.messages.transform']({}, o);
    }
    expect(await callTool(hook, 'edit')).toBe('passed');
    active = false;
    expect(await callTool(hook, 'edit')).toBe('blocked');
  });
});
