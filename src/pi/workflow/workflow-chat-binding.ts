import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ChildProcess } from 'node:child_process';
import type { StageEvent } from '../../core/workflow-types';
import type { WorkflowManager } from '../workflow/workflow-manager';

export function bindWorkflowChatBridge(args: {
  manager: WorkflowManager;
  hub: {
    getMeeting(id: string): unknown;
    registerChat(
      id: string,
      name: string,
      participant: { name: string; agentType: string; proc: ChildProcess },
      onUserMessage?: (message: string) => Promise<{ response?: string; error?: string } | void>,
      chatStatus?: { scope?: 'workflow' | 'pool' | 'standalone'; state?: 'working' | 'waiting' | 'idle' | 'failed' | 'dead' | 'done'; startedAt?: number; fallbackRecommended?: boolean },
    ): unknown;
    updateChatStatus(id: string, patch: { state?: 'working' | 'waiting' | 'idle' | 'failed' | 'dead' | 'done'; fallbackRecommended?: boolean }): void;
  };
  getPoolProcess: (id: string) => ChildProcess | undefined;
  autoOpenChat: (meetingId: string, displayName: string, ctx: ExtensionContext) => void;
  getSessionCtx: () => ExtensionContext | null;
  notify?: (message: string, level?: 'info' | 'warning' | 'error' | 'success') => void;
  setStatus?: (key: string, value: string) => void;
  clearStatus?: (key: string) => void;
  sendAgentMessage?: (content: string) => void;
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
          }, (message) => args.manager.sendUserMessage(message), {
            scope: 'workflow',
            state: 'working',
            startedAt: Date.now(),
          });
        }
      }
    }

    if (event.type === 'message') {
      args.hub.updateChatStatus(event.poolId, { state: 'idle' });
    }

    if (event.type === 'waiting_user') {
      args.hub.updateChatStatus(event.poolId, { state: 'waiting' });
      args.setStatus?.('workflow-stage', `Workflow waiting: ${event.agent}`);
      args.notify?.(`Workflow stage waiting for user input: ${event.agent}`, 'info');
    }

    if (event.type === 'transition_approval') {
      args.hub.updateChatStatus(event.poolId, { state: 'done' });
      args.setStatus?.('workflow-stage', `Approval required: ${event.agent}`);
      console.log(`[wf-test] transition_approval event: agent=${event.agent}, nextStage=${event.nextStage}`);
      try {
        args.sendAgentMessage?.(`Workflow stage ${event.agent} completed. Approval required before continuing to ${event.nextStage ?? 'next stage'}.`);
        console.log(`[wf-test] sendAgentMessage called ok`);
      } catch (e) {
        console.error(`[wf-test] sendAgentMessage failed:`, e);
      }
    }

    if (event.type === 'complete') {
      args.hub.updateChatStatus(event.poolId, { state: 'done' });
    }

    if (event.type === 'workflow_complete') {
      args.clearStatus?.('workflow-stage');
      args.sendAgentMessage?.(`Workflow completed: ${event.workflow}`);
    }

    if (event.type === 'error' && event.poolId) {
      args.hub.updateChatStatus(event.poolId, { state: 'failed', fallbackRecommended: true });
      args.setStatus?.('workflow-stage', `Workflow failed: ${event.agent}`);
      args.sendAgentMessage?.(`Workflow failed: ${event.error}`);
    }
  });
}
