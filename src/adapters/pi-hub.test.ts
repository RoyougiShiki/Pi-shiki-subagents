import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';

/**
 * Mock ChildProcess with piped stdio
 */
function createMockProc(name: string) {
  const stdin = new EventEmitter() as any;
  stdin.write = mock((_data: any, cb?: () => void) => { if (cb) cb(); return true; });

  const stdout = new EventEmitter() as any;
  const proc = new EventEmitter() as any;
  proc.name = name;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = mock(() => { proc.killed = true; proc.emit('close'); });
  return proc;
}

/**
 * Simulate an agent_end event on a process stdout
 */
function emitAgentEnd(proc: any, text: string) {
  const msg = {
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    ],
  };
  proc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
}

describe('Hub', () => {
  beforeEach(async () => {
    const mod = await import('./pi-hub');
    mod.resetHub();
  });

  test('registers a group meeting with participants', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const bob = createMockProc('bob');

    const meeting = freshHub.registerMeeting('meet-1', '架构讨论', [
      { name: 'Alice', agentType: 'explorer', proc: alice },
      { name: 'Bob', agentType: 'fixer', proc: bob },
    ]);

    expect(meeting.id).toBe('meet-1');
    expect(meeting.name).toBe('架构讨论');
    expect(meeting.type).toBe('group');
    expect(meeting.participants).toHaveLength(2);
    expect(meeting.status).toBe('active');
    expect(meeting.messages).toHaveLength(0);
  });

  test('registers a private chat with one participant', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const chat = freshHub.registerChat('chat-1', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    expect(chat.id).toBe('chat-1');
    expect(chat.type).toBe('chat');
    expect(chat.participants).toHaveLength(1);
  });

  test('broadcast sends message to all participants', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const bob = createMockProc('bob');
    freshHub.registerMeeting('meet-2', '测试', [
      { name: 'Alice', agentType: 'explorer', proc: alice },
      { name: 'Bob', agentType: 'fixer', proc: bob },
    ]);

    await freshHub.broadcast('meet-2', '大家好');

    expect(alice.stdin.write).toHaveBeenCalledTimes(1);
    expect(bob.stdin.write).toHaveBeenCalledTimes(1);

    const aliceCall = JSON.parse(alice.stdin.write.mock.calls[0][0]);
    expect(aliceCall.type).toBe('prompt');
    expect(aliceCall.message).toBe('大家好');
  });

  test('private chat can route user input through custom handler', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const handler = mock(async () => ({ response: 'ok' }));
    freshHub.registerChat('chat-handler', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    }, handler);

    await freshHub.broadcast('chat-handler', '补充信息');

    expect(handler).toHaveBeenCalledWith('补充信息');
    expect(alice.stdin.write).not.toHaveBeenCalled();
  });

  test('broadcast stores message in history', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    freshHub.registerChat('chat-2', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    await freshHub.broadcast('chat-2', '你好');

    const meeting = freshHub.getMeeting('chat-2')!;
    expect(meeting.messages).toHaveLength(1);
    expect(meeting.messages[0].from).toBe('You');
    expect(meeting.messages[0].content).toBe('你好');
  });

  test('agent_end from participant stdout creates message', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    freshHub.registerChat('chat-3', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    // Simulate Alice's response
    emitAgentEnd(alice, '这是回复');

    const meeting = freshHub.getMeeting('chat-3')!;
    expect(meeting.messages).toHaveLength(1);
    expect(meeting.messages[0].from).toBe('Alice');
    expect(meeting.messages[0].content).toBe('这是回复');
  });

  test('onMessage subscriber receives new messages', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    freshHub.registerChat('chat-4', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    const received: any[] = [];
    freshHub.onMessage('chat-4', (msg: any, _m: any) => {
      received.push(msg);
    });

    await freshHub.broadcast('chat-4', '你好');
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('你好');
  });

  test('messages are isolated between different meetings', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const bob = createMockProc('bob');
    const charlie = createMockProc('charlie');

    freshHub.registerChat('chat-a', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });
    freshHub.registerMeeting('meet-b', '群聊', [
      { name: 'Bob', agentType: 'fixer', proc: bob },
      { name: 'Charlie', agentType: 'oracle', proc: charlie },
    ]);

    await freshHub.broadcast('chat-a', '私密消息');
    await freshHub.broadcast('meet-b', '群聊消息');

    const chatA = freshHub.getMeeting('chat-a')!;
    const meetB = freshHub.getMeeting('meet-b')!;

    expect(chatA.messages).toHaveLength(1);
    expect(chatA.messages[0].content).toBe('私密消息');

    expect(meetB.messages).toHaveLength(1);
    expect(meetB.messages[0].content).toBe('群聊消息');
  });

  test('endMeeting sets status to ended and stores report', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    freshHub.registerChat('chat-5', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    freshHub.endMeeting('chat-5', '最终报告');

    const meeting = freshHub.getMeeting('chat-5')!;
    expect(meeting.status).toBe('ended');
    expect(meeting.report).toBe('最终报告');
  });

  test('broadcast does nothing to ended meeting', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    freshHub.registerChat('chat-6', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });

    freshHub.endMeeting('chat-6');
    await freshHub.broadcast('chat-6', '再见');

    const meeting = freshHub.getMeeting('chat-6')!;
    expect(meeting.messages).toHaveLength(0);
  });

  test('getActiveMeetings only returns active ones', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const bob = createMockProc('bob');

    freshHub.registerChat('active-1', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });
    freshHub.registerChat('ended-1', 'Bob', {
      name: 'Bob', agentType: 'fixer', proc: bob,
    });
    freshHub.endMeeting('ended-1');

    const active = freshHub.getActiveMeetings();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('active-1');
  });

  test('getAllMeetings returns all meetings', async () => {
    const mod = await import('./pi-hub');
    const freshHub = mod.getHub();

    const alice = createMockProc('alice');
    const bob = createMockProc('bob');

    freshHub.registerChat('m1', 'Alice', {
      name: 'Alice', agentType: 'explorer', proc: alice,
    });
    freshHub.registerChat('m2', 'Bob', {
      name: 'Bob', agentType: 'fixer', proc: bob,
    });

    const all = freshHub.getAllMeetings();
    expect(all).toHaveLength(2);
  });
});
