import { describe, expect, mock, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { StageEvent } from '../core/workflow-types';
import { bindWorkflowChatBridge } from './workflow-chat-binding';

describe('bindWorkflowChatBridge', () => {
  test('registers a private chat on running and routes user messages to workflow manager', async () => {
    const handlers: Array<(event: StageEvent) => void> = [];
    const sendUserMessage = mock(async (message: string) => ({ response: `ok:${message}` }));
    const registerChat = mock((_id: string, _name: string, _participant: any, onUserMessage?: (message: string) => Promise<any>) => ({ onUserMessage }));
    const manager = {
      onEvent(cb: (event: StageEvent) => void) {
        handlers.push(cb);
        return () => {};
      },
      sendUserMessage,
    };
    const hub = {
      getMeeting: mock(() => null),
      registerChat,
      updateChatStatus: mock(() => {}),
    };
    const proc = { pid: 1234 } as any;
    const getPoolProcess = mock(() => proc);
    const autoOpenChat = mock(() => {});
    const notify = mock(() => {});
    const setStatus = mock(() => {});
    const clearStatus = mock(() => {});
    let sessionCtx: ExtensionContext | null = null;

    bindWorkflowChatBridge({ manager: manager as any, hub: hub as any, getPoolProcess, autoOpenChat, getSessionCtx: () => sessionCtx, notify, setStatus, clearStatus });

    handlers[0]!({ type: 'running', agent: 'worker', stageId: 's1', poolId: 'p1' });

    expect(registerChat).toHaveBeenCalledTimes(1);
    expect(registerChat.mock.calls[0]![4]).toMatchObject({ scope: 'workflow', state: 'working' });
    const onUserMessage = registerChat.mock.calls[0]![3] as (message: string) => Promise<any>;
    const result = await onUserMessage('hello');
    expect(sendUserMessage).toHaveBeenCalledWith('hello');
    expect(result).toEqual({ response: 'ok:hello' });

    sessionCtx = {} as ExtensionContext;
    handlers[0]!({ type: 'message', agent: 'worker', stageId: 's1', poolId: 'p1', text: 'assistant says hi' });
    expect(hub.updateChatStatus).toHaveBeenCalledWith('p1', { state: 'idle' });
    expect(autoOpenChat).not.toHaveBeenCalled();

    handlers[0]!({ type: 'waiting_user', agent: 'worker', stageId: 's1', poolId: 'p1', output: { status: 'needs_user', summary: 'need input', context: '' } });
    expect(setStatus).toHaveBeenCalledWith('workflow-stage', 'Workflow waiting: worker');
    expect(notify).toHaveBeenCalledWith('Workflow stage waiting for user input: worker', 'info');

    handlers[0]!({ type: 'transition_approval', agent: 'worker', stageId: 's1', poolId: 'p1', output: { status: 'complete', summary: 'done', context: 'ctx' }, nextStage: 'oracle' });
    expect(notify).toHaveBeenCalledWith('Workflow stage completed: worker; approval required before oracle', 'info');

    handlers[0]!({ type: 'workflow_complete', workflow: 'wf' });
    expect(clearStatus).toHaveBeenCalledWith('workflow-stage');
  });

  test('does not register duplicate chat or auto-open without session context', () => {
    const handlers: Array<(event: StageEvent) => void> = [];
    const manager = {
      onEvent(cb: (event: StageEvent) => void) {
        handlers.push(cb);
        return () => {};
      },
      sendUserMessage: mock(async () => ({})),
    };
    const hub = {
      getMeeting: mock(() => ({ id: 'p1' })),
      registerChat: mock(() => ({})),
      updateChatStatus: mock(() => {}),
    };
    const getPoolProcess = mock(() => ({ pid: 1234 }));
    const autoOpenChat = mock(() => {});
    const notify = mock(() => {});
    const setStatus = mock(() => {});
    const clearStatus = mock(() => {});

    bindWorkflowChatBridge({ manager: manager as any, hub: hub as any, getPoolProcess, autoOpenChat, getSessionCtx: () => null, notify, setStatus, clearStatus });

    handlers[0]!({ type: 'running', agent: 'worker', stageId: 's1', poolId: 'p1' });
    handlers[0]!({ type: 'message', agent: 'worker', stageId: 's1', poolId: 'p1', text: 'assistant says hi' });

    expect(hub.registerChat).not.toHaveBeenCalled();
    expect(autoOpenChat).not.toHaveBeenCalled();
  });
});
