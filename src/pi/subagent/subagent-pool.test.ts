import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentPool, type PoolEvent } from './subagent-pool';

function createFakeSession(messageContent: unknown) {
  const listeners: Array<(event: any) => void> = [];
  return {
    subscribe(cb: (event: any) => void) {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt(_message: string) {
      const message = { role: 'assistant', content: messageContent };
      for (const listener of [...listeners]) {
        listener({ type: 'message_end', message });
        listener({ type: 'agent_end', messages: [message] });
      }
    },
    async abort() {},
    dispose() {},
  };
}

function createPool(messageContent: unknown): AgentPool {
  return new AgentPool({
    sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pool-test-')),
    createSessionManager: () => ({}),
    createSession: (async () => ({
      session: createFakeSession(messageContent),
    })) as any,
  });
}

async function waitForCompletion(pool: AgentPool): Promise<PoolEvent> {
  return await new Promise((resolve) => {
    pool.onEvent((event) => {
      if (event.type === 'completed') resolve(event);
    });
  });
}

describe('AgentPool result capture', () => {
  test('captures assistant text when SDK message content is a string', async () => {
    const pool = createPool('完成：字符串结果已捕获。');
    const completion = waitForCompletion(pool);

    const spawned = await pool.spawn({
      id: 'string-result',
      name: 'string-result',
      agent: { name: 'search' } as any,
      task: 'summarize',
    });
    expect(spawned.error).toBeUndefined();

    const event = await completion;
    expect(event.response).toBe('完成：字符串结果已捕获。');
    expect(pool.getRegistryEntry('string-result')?.lastResponse).toBe(
      '完成：字符串结果已捕获。',
    );
  });

  test('stores a diagnostic result when no assistant text is captured', async () => {
    const pool = createPool([{ type: 'thinking', text: 'hidden only' }]);
    const completion = waitForCompletion(pool);

    const spawned = await pool.spawn({
      id: 'empty-result',
      name: 'empty-result',
      agent: { name: 'search' } as any,
      task: 'summarize',
    });
    expect(spawned.error).toBeUndefined();

    const event = await completion;
    expect(event.response).toContain('no assistant text was captured');
    expect(pool.getRegistryEntry('empty-result')?.lastResponse).toContain(
      'no assistant text was captured',
    );
  });
});
