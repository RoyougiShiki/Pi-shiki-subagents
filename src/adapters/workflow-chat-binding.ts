import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ChildProcess } from 'node:child_process';
import type { StageEvent } from '../core/workflow-types';
import type { WorkflowManager } from './workflow-manager';

export function bindWorkflowChatBridge(args: {
  manager: WorkflowManager;
  hub: {
    getMeeting(id: string): unknown;
    registerChat(
      id: string,
      name: string,
      participant: { name: string; agentType: string; proc: ChildProcess },
      onUserMessage?: (message: string) => Promise<{ response?: string; error?: string } | void>,
    ): unknown;
  };
  getPoolProcess: (id: string) => ChildProcess | undefined;
  autoOpenChat: (meetingId: string, displayName: string, ctx: ExtensionContext) => void;
  getSessionCtx: () => ExtensionContext | null;
}): () => void {
  return args.manager.onEvent((event: StageEvent) => {
    if (event.type === 'running') {
      if (!args.hub.getMeeting(event.poolId)) {
        const proc = args.getPoolProcess(event.poolId);
        if (proc) {
          args.hub.registerChat(event.poolId, event.agent, {
            name: event.agent,
            agentType: event.agent,
            proc,
          }, (message) => args.manager.sendUserMessage(message));
        }
      }
    }

    if (event.type === 'message') {
      const sessionCtx = args.getSessionCtx();
      if (sessionCtx) args.autoOpenChat(event.poolId, event.agent, sessionCtx);
    }
  });
}
