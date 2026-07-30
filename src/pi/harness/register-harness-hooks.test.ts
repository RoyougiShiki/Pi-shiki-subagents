import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHarnessHooks } from './register-harness-hooks';

type HookName = 'turn_start' | 'tool_result' | 'message_end';
type HookMap = Partial<Record<HookName, Function[]>>;

function createPiMock() {
  const hooks: HookMap = {};
  return {
    hooks,
    pi: {
      on(name: HookName, handler: Function) {
        hooks[name] = [...(hooks[name] ?? []), handler];
      },
    },
  };
}

function createCtx(entries: unknown[] = [], sessionId = 's1') {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    notifications,
    ctx: {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => '/tmp/session.json',
        getEntries: () => entries,
      },
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
      },
    },
  };
}

describe('register-harness-hooks', () => {
  test('registers budget and verifier hooks without message_end completion audit', () => {
    const { pi, hooks } = createPiMock();

    registerHarnessHooks(pi as any, {});

    expect(hooks.tool_result).toHaveLength(1);
    expect(hooks.message_end ?? []).toHaveLength(0);
  });

  test('normalizes grep exit 1 through tool_result hook', async () => {
    const { pi, hooks } = createPiMock();
    const { ctx } = createCtx();
    registerHarnessHooks(pi as any, {});

    const result = await hooks.tool_result?.[0]?.(
      {
        toolName: 'bash',
        toolCallId: 'call-1',
        input: { command: 'grep missing file.txt' },
        content: [
          { type: 'text', text: '(no output)\nCommand exited with code 1' },
        ],
        isError: true,
        details: { ok: true },
      },
      ctx as any,
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: 'No matches found' }],
      details: { ok: true },
      isError: false,
    });
  });

  test('normalizes piped grep exit 1 through tool_result hook', async () => {
    const { pi, hooks } = createPiMock();
    const { ctx } = createCtx();
    registerHarnessHooks(pi as any, {});

    const result = await hooks.tool_result?.[0]?.(
      {
        toolName: 'bash',
        toolCallId: 'call-1',
        input: { command: 'cat file.txt | grep missing' },
        content: [
          { type: 'text', text: '(no output)\nCommand exited with code 1' },
        ],
        isError: true,
        details: { ok: true },
      },
      ctx as any,
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: 'No matches found' }],
      details: { ok: true },
      isError: false,
    });
  });

  test('captures verifier verdict notifications without completion audit warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omo-verdict-pass-'));
    try {
      const { pi, hooks } = createPiMock();
      const { ctx, notifications } = createCtx([], 'verdict-pass-audit');
      const runtime = registerHarnessHooks(pi as any, {
        config: {
          toolResultBudget: { storageBaseDir: dir },
        },
      });

      await hooks.tool_result?.[0]?.(
        {
          toolName: 'edit',
          toolCallId: 'edit-1',
          input: { path: 'file.ts' },
          content: [{ type: 'text', text: 'edited' }],
          isError: false,
        },
        ctx as any,
      );
      await runtime.ingestPoolCompleted(
        {
          agentName: 'reviewer',
          response:
            'Command run: bun test\nOutput observed: pass\nResult: PASS\nVERDICT: PASS',
        },
        ctx as any,
      );

      expect(
        notifications.some((item) =>
          item.message.includes('verifier verdict captured: PASS'),
        ),
      ).toBe(true);
      expect(
        notifications.some((item) => item.message.includes('完成审计提醒')),
      ).toBe(false);
      expect(hooks.message_end ?? []).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('persists recovered evidence summary from tool results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omo-evidence-summary-reload-'));
    try {
      const first = createPiMock();
      const firstCtx = createCtx([], 'evidence-summary-session').ctx;
      registerHarnessHooks(first.pi as any, {
        config: {
          toolResultBudget: { storageBaseDir: dir },
        },
      });
      await first.hooks.tool_result?.[0]?.(
        {
          toolName: 'edit',
          toolCallId: 'edit-before-reload',
          input: { path: 'file.ts' },
          content: [{ type: 'text', text: 'edited' }],
          isError: false,
        },
        firstCtx as any,
      );

      expect(
        await readFile(
          join(dir, 'evidence-summary-session', '.evidence-summary.json'),
          'utf8',
        ),
      ).toContain('modification');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('serializes concurrent evidence summary updates', async () => {
    const dir = await mkdtemp(
      join(tmpdir(), 'omo-evidence-summary-concurrent-'),
    );
    try {
      const { pi, hooks } = createPiMock();
      const { ctx } = createCtx([], 'evidence-summary-concurrent');
      registerHarnessHooks(pi as any, {
        config: {
          toolResultBudget: { storageBaseDir: dir },
        },
      });

      await Promise.all([
        hooks.tool_result?.[0]?.(
          {
            toolName: 'edit',
            toolCallId: 'edit-concurrent',
            input: { path: 'file.ts' },
            content: [{ type: 'text', text: 'edited' }],
            isError: false,
          },
          ctx as any,
        ),
        hooks.tool_result?.[0]?.(
          {
            toolName: 'bash',
            toolCallId: 'test-concurrent',
            input: { command: 'bun test' },
            content: [{ type: 'text', text: 'pass' }],
            isError: false,
          },
          ctx as any,
        ),
      ]);

      const persisted = await readFile(
        join(dir, 'evidence-summary-concurrent', '.evidence-summary.json'),
        'utf8',
      );
      expect(persisted).toContain('modification');
      expect(persisted).toContain('test_success');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reapplies persisted tool result budget state after hook reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omo-register-budget-'));
    try {
      const first = createPiMock();
      const firstCtx = createCtx([], 'persisted-session').ctx;
      registerHarnessHooks(first.pi as any, {
        config: {
          toolResultBudget: {
            enabled: true,
            storageBaseDir: dir,
            thresholds: { default: 3 },
            previewChars: 2,
          },
        },
      });

      const firstResult = await first.hooks.tool_result?.[0]?.(
        {
          toolName: 'bash',
          toolCallId: 'call-large',
          input: { command: 'printf abcdef' },
          content: [{ type: 'text', text: 'abcdef' }],
          isError: false,
        },
        firstCtx as any,
      );

      expect(firstResult?.content?.[0]?.text).toContain(
        'Preview (first 2 chars)',
      );
      expect(
        await readFile(
          join(dir, 'persisted-session', '.budget-state.json'),
          'utf8',
        ),
      ).toContain('call-large');

      const second = createPiMock();
      const secondCtx = createCtx([], 'persisted-session').ctx;
      registerHarnessHooks(second.pi as any, {
        config: {
          toolResultBudget: {
            enabled: true,
            storageBaseDir: dir,
            thresholds: { default: 3 },
            previewChars: 1,
          },
        },
      });

      const secondResult = await second.hooks.tool_result?.[0]?.(
        {
          toolName: 'bash',
          toolCallId: 'call-large',
          input: { command: 'printf abcdef' },
          content: [{ type: 'text', text: 'abcdef' }],
          isError: false,
        },
        secondCtx as any,
      );

      expect(secondResult?.content?.[0]?.text).toContain(
        'Preview (first 2 chars)',
      );
      expect(secondResult?.content?.[0]?.text).not.toContain(
        'Preview (first 1 chars)',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
