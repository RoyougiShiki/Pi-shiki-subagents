import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';

/**
 * Mock AgentSession that emits subscribe events.
 */
function createMockSession(name: string) {
  const listeners: Array<(event: any) => void> = [];
  return {
    name,
    steer: mock(() => Promise.resolve()),
    prompt: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
    subscribe: mock((cb: (event: any) => void) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    isStreaming: false,
    agent: {
      waitForIdle: mock(() => Promise.resolve()),
      state: { messages: [] },
    },
    abort: mock(() => Promise.resolve()),
    dispose: mock(() => {}),
    // Test helper: emit an event
    _emit(event: any) {
      for (const cb of listeners) cb(event);
    },
  };
}

/**
 * Simulate an agent_end event on a session
 */
function emitAgentEnd(session: any, text: string) {
  session._emit({
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    ],
  });
}

// We test the hub logic directly via exported functions
import { getHub, resetHub } from '../pi/meeting/pi-hub';

describe('pi-hub', () => {
  beforeEach(() => {
    resetHub();
  });
  afterEach(() => {
    resetHub();
  });

  test('registerMeeting creates a group discussion', () => {
    const hub = getHub();
    const session1 = createMockSession('alice');
    const session2 = createMockSession('bob');

    const meeting = hub.registerMeeting('test-1', 'Test Discussion', [
      { name: 'alice', agentType: 'search', session: session1 },
      { name: 'bob', agentType: 'oracle', session: session2 },
    ]);

    expect(meeting.id).toBe('test-1');
    expect(meeting.participants).toHaveLength(2);
    expect(meeting.status).toBe('active');
  });

  test('registerMeeting rejects duplicate ids', () => {
    const hub = getHub();
    const session = createMockSession('alice');
    hub.registerMeeting('dup', 'First', [
      { name: 'alice', agentType: 'search', session },
    ]);

    expect(() => {
      hub.registerMeeting('dup', 'Second', [
        { name: 'bob', agentType: 'oracle', session },
      ]);
    }).toThrow('already exists');
  });

  test('endMeeting marks meeting as ended', () => {
    const hub = getHub();
    const session = createMockSession('alice');
    hub.registerMeeting('end-test', 'End Test', [
      { name: 'alice', agentType: 'search', session },
    ]);

    hub.endMeeting('end-test', 'Final report');
    const meeting = hub.getMeeting('end-test');
    expect(meeting?.status).toBe('ended');
    expect(meeting?.report).toBe('Final report');
  });

  test('broadcast sends message to all participants', async () => {
    const hub = getHub();
    const session1 = createMockSession('alice');
    const session2 = createMockSession('bob');
    hub.registerMeeting('broadcast-test', 'Broadcast', [
      { name: 'alice', agentType: 'search', session: session1 },
      { name: 'bob', agentType: 'oracle', session: session2 },
    ]);

    await hub.broadcast('broadcast-test', 'Hello everyone!');

    expect(session1.prompt).toHaveBeenCalledWith('Hello everyone!');
    expect(session2.prompt).toHaveBeenCalledWith('Hello everyone!');
  });

  test('broadcast records message in meeting history', async () => {
    const hub = getHub();
    const session = createMockSession('alice');
    hub.registerMeeting('history-test', 'History', [
      { name: 'alice', agentType: 'search', session },
    ]);

    await hub.broadcast('history-test', 'Message 1');
    await hub.broadcast('history-test', 'Message 2', 'user');

    const meeting = hub.getMeeting('history-test');
    expect(meeting?.messages).toHaveLength(2);
    expect(meeting?.messages[0].content).toBe('Message 1');
    expect(meeting?.messages[1].from).toBe('user');
  });

  test('agent_end event records response in meeting', () => {
    const hub = getHub();
    const session = createMockSession('alice');
    const meeting = hub.registerMeeting('agent-end-test', 'Agent End', [
      { name: 'alice', agentType: 'search', session },
    ]);

    emitAgentEnd(session, 'Hello from alice');

    expect(meeting.messages).toHaveLength(1);
    expect(meeting.messages[0].from).toBe('alice');
    expect(meeting.messages[0].content).toBe('Hello from alice');
  });

  test('agent_end in group relays to other participants', () => {
    const hub = getHub();
    const session1 = createMockSession('alice');
    const session2 = createMockSession('bob');
    const meeting = hub.registerMeeting('relay-test', 'Relay', [
      { name: 'alice', agentType: 'search', session: session1 },
      { name: 'bob', agentType: 'oracle', session: session2 },
    ]);

    emitAgentEnd(session1, 'Alice opinion');

    expect(session2.prompt).toHaveBeenCalledWith(expect.stringContaining('Alice opinion'));
    expect(meeting.messages).toHaveLength(1);
  });

  test('onMessage callback receives new messages', () => {
    const hub = getHub();
    const session = createMockSession('alice');
    hub.registerMeeting('callback-test', 'Callback', [
      { name: 'alice', agentType: 'search', session },
    ]);

    const received: any[] = [];
    hub.onMessage('callback-test', (msg, meeting) => {
      received.push({ msg: msg.content, meetingName: meeting.name });
    });

    emitAgentEnd(session, 'Callback content');

    expect(received).toHaveLength(1);
    expect(received[0].msg).toBe('Callback content');
    expect(received[0].meetingName).toBe('Callback');
  });

  test('broadcast prefers onUserMessage for "You" messages', async () => {
    const hub = getHub();
    const session = createMockSession('chatty');
    const onUserMessage = mock(() => Promise.resolve({ response: 'thanks' }));
    hub.registerChat('user-chat', 'User Chat', {
      name: 'chatty',
      agentType: 'search',
      session,
    }, onUserMessage);

    await hub.broadcast('user-chat', 'User says hi', 'You');

    // onUserMessage should be called instead of session.prompt
    expect(onUserMessage).toHaveBeenCalledWith('User says hi');
    expect(session.prompt).not.toHaveBeenCalled();
  });
});
