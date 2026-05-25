import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createBackgroundTaskHook } from './index';

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

beforeEach(() => {
  globalThis.setInterval = mock(
    () => 1 as unknown as ReturnType<typeof setInterval>,
  );
  globalThis.clearInterval = mock(() => undefined);
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe('background-task hook', () => {
  test('missing session reuse explains fresh delegation path', async () => {
    const hook = createBackgroundTaskHook({
      client: {
        session: {
          prompt: mock(async () => undefined),
          promptAsync: mock(async () => undefined),
          create: mock(async () => ({ data: { id: 'child-session-1' } })),
          messages: mock(async () => ({ data: [] })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never);

    const result = await hook.tools.task.execute(
      {
        prompt: 'Continue lock review',
        session_id: 'ora-2',
      },
      { sessionID: 'parent-1' },
    );

    expect(result).toContain('Session ora-2 is not available for reuse.');
    expect(result).toContain('This does not mean the sub-agent is unavailable.');
    expect(result).toContain('start a fresh task');
    expect(result).toContain('task_id shortcuts, not session_id values');
  });

  test('task id input resolves to real child session id when resuming', async () => {
    const prompt = mock(async () => undefined);
    const promptAsync = mock(async () => undefined);
    const create = mock(async () => ({ data: { id: 'child-session-1' } }));

    const hook = createBackgroundTaskHook({
      client: {
        session: {
          prompt,
          promptAsync,
          create,
          messages: mock(async () => ({ data: [] })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never);

    const launchResult = await hook.tools.task.execute(
      {
        prompt: 'Initial lock review',
        subagent_type: 'oracle',
      },
      { sessionID: 'parent-1' },
    );
    expect(launchResult).toContain('task_id:');

    const taskId = String(launchResult).match(/task_id:\s*([^\s]+)/)?.[1];
    expect(taskId).toBeTruthy();

    const resumeResult = await hook.tools.task.execute(
      {
        prompt: 'Continue lock review',
        session_id: taskId,
      },
      { sessionID: 'parent-1' },
    );

    expect(prompt).toHaveBeenCalled();
    expect(prompt.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ path: { id: 'child-session-1' } }),
    );
    expect(resumeResult).toContain('session_id: child-session-1');
  });
});
