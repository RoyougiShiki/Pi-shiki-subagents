import { describe, expect, test } from 'bun:test';
import { createGate } from './gate-factory';
import type { GateConfig } from './gate-factory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  role: string,
  text: string,
  agent?: string,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    info: { role, ...(agent ? { agent } : {}) },
    parts: text ? [{ type: 'text', text }] : [],
  };
  return msg;
}

const TEST_INSTRUCTION = '[TestGate] declare or be blocked.';
const TEST_BLOCK = '[TestGate] blocked';

function oneShotFalseGate(overrides?: Partial<GateConfig>) {
  return createGate({
    name: 'test-oneshot-false',
    checkPattern: /^(UNDERSTOOD|APPROVED|READY|DONE):\s/m,
    instruction: TEST_INSTRUCTION,
    gatedTools: ['bash', 'edit', 'write'],
    blockMessage: TEST_BLOCK,
    oneShot: false,
    ...overrides,
  });
}

function oneShotTrueGate(overrides?: Partial<GateConfig>) {
  return createGate({
    name: 'test-oneshot-true',
    checkPattern: /^\s*APPROVED:\s/m,
    notPattern: /^\s*AWAITING_APPROVAL:\s/m,
    instruction: TEST_INSTRUCTION,
    gatedTools: ['bash', 'edit', 'write'],
    blockMessage: TEST_BLOCK,
    oneShot: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// oneShot=false — always checks last asst text
// ---------------------------------------------------------------------------

describe('oneShot=false gate', () => {
  test('no assistant message → tools pass', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [makeMsg('user', 'hello')],
    };
    // First transform saves lastMessages
    await gate['experimental.chat.messages.transform']({}, output);

    // No assistant → getAsst returns null → tool passes
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('last asst has declaration → tools pass', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'UNDERSTOOD: proceed'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('last asst has no declaration → tools blocked', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'just do it'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    try {
      await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).toContain(TEST_BLOCK);
    }
  });

  test('escape tools pass even without declaration', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'no declaration here'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    const escapeTools = ['read', 'grep', 'glob', 'skill'];
    for (const tool of escapeTools) {
      // Should not throw
      await gate['tool.execute.before']({ tool }, { args: {} });
    }
  });

  test('non-gated tools pass regardless', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'no declaration'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // task is not in gatedTools
    await gate['tool.execute.before']({ tool: 'task' }, { args: {} });
  });

  test('ralph loop active skips all checks', async () => {
    let ralphActive = true;
    const gate = oneShotFalseGate({
      isRalphLoopActive: () => ralphActive,
    });
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'no declaration'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // Should pass even though no declaration
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });

    // Deactivate ralph loop → now blocks
    ralphActive = false;
    try {
      await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
      expect.unreachable('should have thrown when ralph loop inactive');
    } catch (e: unknown) {
      expect((e as Error).message).toContain(TEST_BLOCK);
    }
  });

  test('DONE: is a valid declaration for oneShot=false', async () => {
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'DONE: task finished'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // DONE: matches checkPattern (it's in the alternation) → passes
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('instruction injected on first transform', async () => {
    const gate = oneShotFalseGate();
    const userMsg = makeMsg('user', 'hello');
    // Need at least 2 messages (msgs.length < 2 guard)
    const output = { messages: [makeMsg('system', ''), userMsg] };

    await gate['experimental.chat.messages.transform']({}, output);

    const parts = userMsg.parts as Array<{ type: string; text: string }>;
    expect(parts[0].text).toContain(TEST_INSTRUCTION);
  });

  test('instruction not re-injected on second transform', async () => {
    const gate = oneShotFalseGate();
    const userMsg = makeMsg('user', 'hello');
    const output = { messages: [userMsg] };

    await gate['experimental.chat.messages.transform']({}, output);
    await gate['experimental.chat.messages.transform']({}, output);

    // Instruction should only appear once
    const parts = userMsg.parts as Array<{ type: string; text: string }>;
    const first = parts[0].text.indexOf(TEST_INSTRUCTION);
    const last = parts[0].text.lastIndexOf(TEST_INSTRUCTION);
    expect(first).toBe(last);
  });

  test('getAsst scans only after first user message', async () => {
    // System prompts before first user should be ignored
    const gate = oneShotFalseGate();
    const output = {
      messages: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: '<Role>\nYou are...' }] },
        makeMsg('user', 'hello'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // No assistant after first user → getAsst returns null → pass
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('non-orchestrator agent skips transform', async () => {
    const gate = oneShotFalseGate();
    const userMsg = makeMsg('user', 'hello', 'explorer');
    // agent=explorer should skip instruction injection
    const output = { messages: [userMsg] };
    await gate['experimental.chat.messages.transform']({}, output);

    const parts = userMsg.parts as Array<{ type: string; text: string }>;
    // The agent check skips the entire transform, so no instruction injected
    expect(parts[0].text).not.toContain(TEST_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// oneShot=true — stateful approval gate
// ---------------------------------------------------------------------------

describe('oneShot=true gate', () => {
  test('inactive by default → tools pass', async () => {
    const gate = oneShotTrueGate();
    const output = {
      messages: [makeMsg('user', 'hello')],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // gateOpened=false, gatePending=false → pass
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('AWAITING_APPROVAL triggers pending → tools blocked', async () => {
    const gate = oneShotTrueGate();
    const output = {
      messages: [
        makeMsg('user', 'help'),
        makeMsg('assistant', 'AWAITING_APPROVAL: plan A vs plan B'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // gatePending=true → blocked
    try {
      await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).toContain(TEST_BLOCK);
    }
  });

  test('APPROVED opens gate → tools pass', async () => {
    const gate = oneShotTrueGate();

    // First transform: AWAITING
    let output = {
      messages: [
        makeMsg('user', 'help'),
        makeMsg('assistant', 'AWAITING_APPROVAL: plan A'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // Should be blocked
    try {
      await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).toContain(TEST_BLOCK);
    }

    // Second transform: APPROVED
    output = {
      messages: [
        makeMsg('user', 'use plan A'),
        makeMsg('assistant', 'APPROVED: plan A'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // Now gateOpened=true → pass
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('DONE resets gate state', async () => {
    const gate = oneShotTrueGate();

    // APPROVED
    let output = {
      messages: [
        makeMsg('user', 'go'),
        makeMsg('assistant', 'APPROVED: plan A'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} }); // pass

    // DONE
    output = {
      messages: [
        makeMsg('user', 'done'),
        makeMsg('assistant', 'DONE: finished'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // After DONE: gateOpened=false, gatePending=false → pass
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });

  test('startActive: true starts with gatePending', async () => {
    const gate = oneShotTrueGate({ startActive: true });
    const output = {
      messages: [makeMsg('user', 'hello')],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // With no assistant message, the oneShot logic doesn't run in transform
    // But startActive is checked in transform when there IS an assistant message
    // and the message doesn't match any pattern
    // For this test, add an assistant message that doesn't match anything
    const output2 = {
      messages: [
        makeMsg('user', 'hello'),
        makeMsg('assistant', 'some random text'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output2);

    try {
      await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
      expect.unreachable('should have thrown due to startActive');
    } catch (e: unknown) {
      expect((e as Error).message).toContain(TEST_BLOCK);
    }
  });

  test('non-orchestrator agent skips transform state update', async () => {
    const gate = oneShotTrueGate();
    // Use a non-matching asst text so tool.execute.before doesn't update state
    const output = {
      messages: [
        makeMsg('user', 'help', 'explorer'),
        makeMsg('assistant', 'some random text'),
      ],
    };
    await gate['experimental.chat.messages.transform']({}, output);

    // Transform skipped (agent=explorer), so gate still inactive → pass
    await gate['tool.execute.before']({ tool: 'bash' }, { args: {} });
  });
});
