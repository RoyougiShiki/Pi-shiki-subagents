import type { ExtensionAPI, ExtensionContext, AgentSession } from '@earendil-works/pi-coding-agent';
import type { StageEvent } from '../../core/workflow-types';
import type { WorkflowManager } from '../workflow/workflow-manager';

export function bindWorkflowChatBridge(args: {
  manager: WorkflowManager;
  hub: {
    getMeeting(id: string): unknown;
    registerChat(
      id: string,
      name: string,
      participant: { name: string; agentType: string; session: AgentSession },
      onUserMessage?: (message: string) => Promise<{ response?: string; error?: string } | void>,
      chatStatus?: { scope?: 'workflow' | 'pool' | 'standalone'; state?: 'working' | 'waiting' | 'idle' | 'failed' | 'dead' | 'done'; startedAt?: number; fallbackRecommended?: boolean },
    ): unknown;
    updateChatStatus(id: string, patch: { state?: 'working' | 'waiting' | 'idle' | 'failed' | 'dead' | 'done'; fallbackRecommended?: boolean }): void;
  };
  getPoolSession: (id: string) => AgentSession | undefined;
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
        const session = args.getPoolSession(event.poolId);
        if (session) {
          args.hub.registerChat(event.poolId, event.agent, {
            name: event.agent,
            agentType: event.agent,
            session,
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
      try {
        const summary = event.output?.summary?.slice(0, 500) || '';
        const prefix = `Stage ${event.agent} completed. Approval required before ${event.nextStage ?? 'next stage'}.`;
        args.sendAgentMessage?.(summary ? `${prefix}\n\nResult:\n${summary}` : prefix);
      } catch (e) {
        console.error(`[chat-binding] sendAgentMessage failed:`, e);
      }
    }

    if (event.type === 'complete') {
      args.hub.updateChatStatus(event.poolId, { state: 'done' });
    }

    if (event.type === 'workflow_complete') {
      args.clearStatus?.('workflow-stage');
      const summary = event.output?.summary ? event.output.summary.slice(0, 300) : '';
      const msg = summary
        ? `Workflow completed: ${event.workflow}\n\nResult:\n${summary}`
        : `Workflow completed: ${event.workflow}`;
      args.sendAgentMessage?.(msg);
    }

    if (event.type === 'error' && event.poolId) {
      args.hub.updateChatStatus(event.poolId, { state: 'failed', fallbackRecommended: true });
      args.setStatus?.('workflow-stage', `Workflow failed: ${event.agent}`);
      args.sendAgentMessage?.(`Workflow failed: ${event.error}`);
    }
  });
}
