import { describe, expect, test } from 'bun:test';
import { createApprovalGateHook } from './approval-gate';

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
  hook: ReturnType<typeof createApprovalGateHook>,
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

describe('createApprovalGateHook', () => {
  test('inactive default => pass', async () => {
    const hook = createApprovalGateHook();
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [makeMsg('user', 'hi')] },
    );
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('AWAITING_APPROVAL blocks edit', async () => {
    const hook = createApprovalGateHook();
    const o = {
      messages: [
        makeMsg('user', 'a'),
        makeMsg('assistant', 'AWAITING_APPROVAL: plan'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('blocked');
    expect(await callTool(hook, 'write')).toBe('blocked');
    expect(await callTool(hook, 'bash')).toBe('passed');
  });

  test('APPROVED opens gate', async () => {
    const hook = createApprovalGateHook();
    let o = {
      messages: [
        makeMsg('user', 'a'),
        makeMsg('assistant', 'AWAITING_APPROVAL: plan'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('blocked');
    o = {
      messages: [
        makeMsg('user', 'b'),
        makeMsg('assistant', 'APPROVED: plan A'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('DONE resets', async () => {
    const hook = createApprovalGateHook();
    let o = {
      messages: [
        makeMsg('user', 'go'),
        makeMsg('assistant', 'APPROVED: do it'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
    o = {
      messages: [
        makeMsg('user', 'd'),
        makeMsg('assistant', 'DONE: done'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
  });

  test('ralph loop bypasses', async () => {
    let active = true;
    const hook = createApprovalGateHook({ isRalphLoopActive: () => active });
    const o = {
      messages: [
        makeMsg('user', 'a'),
        makeMsg('assistant', 'AWAITING_APPROVAL: plan'),
      ],
    };
    await hook['experimental.chat.messages.transform']({}, o);
    expect(await callTool(hook, 'edit')).toBe('passed');
    active = false;
    expect(await callTool(hook, 'edit')).toBe('blocked');
  });

  test('injects instruction', async () => {
    const hook = createApprovalGateHook();
    const userMsg = makeMsg('user', 'hi');
    await hook['experimental.chat.messages.transform'](
      {},
      { messages: [makeMsg('system', ''), userMsg] },
    );
    expect((userMsg.parts as any)[0].text).toContain('[ApprovalGate]');
  });
});
