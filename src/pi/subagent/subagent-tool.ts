import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from '../../adapters/agent-discovery';
import {
  checkDelegationAllowed,
  parseAllowedSubagentsEnv,
} from '../../adapters/delegation-rules';
import { consumePipelineDelegationGrant } from '../policy/pipeline-delegation-grants';
import {
  getPool,
  resolveDelegationCaller,
  type PoolAgentInfo,
} from './subagent-pool';
import { buildOmoSubagentToolDetails } from './subagent-run-tool-details';
import {
  renderOmoSubagentCall,
  renderOmoSubagentResult,
} from './subagent-run-tool-renderer';
import type { SubagentToolAction } from './subagent-run-detail-view';
import { ensureSubagentRunWidgetRegistered } from './subagent-run-widget';

function buildDetails(action: SubagentToolAction, runId?: string, focusRun = false) {
  return buildOmoSubagentToolDetails(getPool().getRunTreeView({ maxRecentLines: 10 }), {
    action,
    runId,
    focusRun,
    eventLimit: 10,
    maxChildren: 5,
    maxDepth: 2,
    maxRoots: 5,
  });
}

function emptyDetails(action: SubagentToolAction, runId?: string) {
  return buildDetails(action, runId, false);
}


export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'omo_subagent',
    label: 'OMO Subagent',
    description: [
      '通过 pool 模式委托子代理。用法：',
      '  spawn: { pool: "spawn", id, agent, task }',
      '  send: { pool: "send", id, message }',
      '  list: { pool: "list" }',
      '  listSaved: { pool: "listSaved" } — 查看可恢复会话',
      '  resume: { pool: "resume", id } — 恢复任务上下文',
      '  kill: { pool: "kill", id }',
      '',
      '协议（实现无关）：',
      '  - spawn 提交任务后即进入异步执行；默认下一步是等待完成通知。',
      '  - send 仅用于向已存在会话追加指令，不是 spawn 后默认动作。',
      '  - 会话处于运行态时不要重复提交同类请求；收到 busy/reject 先降级或询问用户。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (for single mode)' },
        task: { type: 'string', description: 'Task prompt (for single mode)' },
        pool: {
          type: 'string',
          description: 'Pool action: spawn | send | list | kill',
        },
        id: {
          type: 'string',
          description: 'Pool agent ID (for spawn/send/kill)',
        },
        message: {
          type: 'string',
          description: 'Message for pool send action',
        },
        model: { type: 'string', description: 'Model override' },
      },
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        ensureSubagentRunWidgetRegistered(ctx, getPool());
      } catch {}
      const cwd = ctx.cwd;
      const agents = discoverAgents(cwd);

      const callerAgent = resolveDelegationCaller();
      const callerDepth =
        Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? '0', 10) || 0;
      const allowedSubagents = parseAllowedSubagentsEnv(
        process.env.OMO_ALLOWED_SUBAGENTS,
      );
      const callerRunId = process.env.OMO_AGENT_ID?.trim() || undefined;

      const requireDelegationAllowed = (
        targetAgent: string,
        childAllowedSubagents?: readonly string[],
      ):
        | { ok: true; childAllowedSubagents?: readonly string[] }
        | { ok: false; response: any } => {
        const delegation = checkDelegationAllowed({
          caller: callerAgent,
          target: targetAgent,
          depth: callerDepth,
          cwd,
          allowedSubagents: childAllowedSubagents ?? allowedSubagents,
        });
        if (delegation.allowed) return { ok: true, childAllowedSubagents };
        const allowed = delegation.allowedAgents?.length
          ? delegation.allowedAgents.join(', ')
          : '(none)';
        return {
          ok: false,
          response: {
            content: [
              {
                type: 'text',
                text: `${delegation.reason}. Allowed agents: ${allowed}`,
              },
            ],
            details: emptyDetails('spawn'),
            isError: true,
          },
        };
      };

      if (params.pool) {
        const pool = getPool();
        if (params.pool === 'spawn') {
          if (!params.id || !params.agent || !params.task) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'pool spawn requires id, agent, and task',
                },
              ],
              details: emptyDetails('spawn', params.id),
              isError: true,
            };
          }
          const agentCfg = agents.find((a) => a.name === params.agent);
          if (!agentCfg) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Agent "${params.agent}" not found. Available: ${agents.map((a) => a.name).join(', ')}`,
                },
              ],
              details: emptyDetails('spawn', params.id),
              isError: true,
            };
          }
          let pipelineGrantAllowedSubagents: readonly string[] | undefined;
          const grant = consumePipelineDelegationGrant({
            caller: callerAgent,
            target: params.agent,
            depth: callerDepth,
          });
          if (grant) {
            pipelineGrantAllowedSubagents = grant.childAllowedSubagents;
          } else {
            const delegation = requireDelegationAllowed(params.agent);
            if (!delegation.ok) return delegation.response;
          }
          const spawnResult = await pool.spawn({
            id: params.id,
            name: params.id,
            agent: agentCfg,
            task: params.task,
            model: params.model || agentCfg.model,
            cwd,
            parentAgent: callerAgent,
            parentRunId: callerRunId,
            depth: callerDepth + 1,
            allowedSubagents: pipelineGrantAllowedSubagents ?? allowedSubagents,
          });
          if (spawnResult.error) {
            return {
              content: [
                { type: 'text', text: `✗ Spawn failed: ${spawnResult.error}` },
              ],
              details: buildDetails('spawn', params.id, true),
              isError: true,
            };
          }
          const successText = `✓ Pool agent "${params.id}" (${params.agent}) spawned. Initial task started asynchronously; wait for completion notification.`;
          return {
            content: [
              {
                type: 'text',
                text: successText,
              },
            ],
            details: buildDetails('spawn', params.id, true),
          };
        }

        if (params.pool === 'send') {
          if (!params.id || !params.message) {
            return {
              content: [
                { type: 'text', text: 'pool send requires id and message' },
              ],
              details: emptyDetails('send', params.id),
              isError: true,
            };
          }

          const current = pool
            .list()
            .find((a: PoolAgentInfo) => a.id === params.id);
          if (
            current &&
            (current.status === 'starting' || current.status === 'streaming')
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Agent "${params.id}" is running (${current.status}). Do not submit another request now; wait for completion notification.\n[guard] 下一步：等待完成后再继续，或先向用户确认是否改为降级方案。`,
                },
              ],
              details: buildDetails('send', params.id, true),
              isError: true,
            };
          }

          const result = await pool.sendPrompt(params.id, params.message);
          if (result.error) {
            return {
              content: [{ type: 'text', text: `✗ ${result.error}` }],
              details: buildDetails('send', params.id, true),
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `Response from ${params.id}:\n\n${result.response}`,
              },
            ],
            details: buildDetails('send', params.id, true),
          };
        }

        if (params.pool === 'list') {
          const list = pool.list();
          if (list.length === 0)
            return {
              content: [{ type: 'text', text: 'Pool is empty.' }],
              details: emptyDetails('list'),
            };
          const lines = list.map(
            (a: PoolAgentInfo) =>
              `  ${a.status === 'dead' ? '✗' : '●'} ${a.id} (${a.agentName}) — ${a.status}, ${a.messageCount} msgs, model: ${a.model}`,
          );
          return {
            content: [
              {
                type: 'text',
                text: `Pool agents (${list.length}):\n${lines.join('\n')}`,
              },
            ],
            details: buildDetails('list'),
          };
        }

        if (params.pool === 'kill') {
          if (!params.id)
            return {
              content: [{ type: 'text', text: 'pool kill requires id' }],
              details: emptyDetails('kill'),
              isError: true,
            };
          const ok = await pool.kill(params.id);
          return {
            content: [
              {
                type: 'text',
                text: ok
                  ? `✓ Killed "${params.id}"`
                  : `✗ Agent "${params.id}" not found`,
              },
            ],
            details: buildDetails('kill', params.id, true),
          };
        }

        if (params.pool === 'listSaved') {
          const entries = pool.listRegistryEntries();
          if (entries.length === 0)
            return {
              content: [{ type: 'text', text: 'No saved sub-agent sessions.' }],
              details: emptyDetails('listSaved'),
            };
          const lines = entries.map(
            (r) => `  ${r.id} (${r.agentName}) — ${r.task.slice(0, 100)}`,
          );
          return {
            content: [
              {
                type: 'text',
                text: `Saved sessions (${entries.length}):\n${lines.join('\n')}`,
              },
            ],
            details: buildDetails('listSaved'),
          };
        }

        if (params.pool === 'resume') {
          if (!params.id)
            return {
              content: [{ type: 'text', text: 'resume requires id' }],
              details: emptyDetails('resume'),
              isError: true,
            };
          const entries = pool.listRegistryEntries();
          const record = entries.find((r) => r.id === params.id);
          if (!record)
            return {
              content: [
                {
                  type: 'text',
                  text: `Saved session "${params.id}" not found`,
                },
              ],
              details: emptyDetails('resume', params.id),
              isError: true,
            };
          const agentCfg = agents.find((a) => a.name === record.agentName);
          if (!agentCfg)
            return {
              content: [
                {
                  type: 'text',
                  text: `Agent "${record.agentName}" not found. Cannot resume.`,
                },
              ],
              details: emptyDetails('resume', params.id),
              isError: true,
            };
          const resumeResult = await pool.spawn({
            id: record.id,
            name: record.name,
            agent: agentCfg,
            task: record.task,
            model: params.model || agentCfg.model,
            cwd: record.cwd || cwd,
            parentAgent: resolveDelegationCaller(),
            parentRunId: callerRunId,
            depth:
              (Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? '0', 10) ||
                0) + 1,
            allowedSubagents: parseAllowedSubagentsEnv(
              process.env.OMO_ALLOWED_SUBAGENTS,
            ),
          });
          if (resumeResult.error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✗ Resume failed: ${resumeResult.error}`,
                },
              ],
              details: buildDetails('resume', record.id, true),
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `✓ Agent "${record.id}" (${record.agentName}) resumed with task context.`,
              },
            ],
            details: buildDetails('resume', record.id, true),
          };
        }
      }

      if (params.agent && params.task) {
        const agentCfg = agents.find((a) => a.name === params.agent);
        if (!agentCfg)
          return {
            content: [
              {
                type: 'text',
                text: `Agent "${params.agent}" not found. Available: ${agents.map((a) => a.name).join(', ')}`,
              },
            ],
            details: emptyDetails('spawn'),
            isError: true,
          };
        return {
          content: [
            {
              type: 'text',
              text: `Single mode is disabled. Use pool spawn: { pool: "spawn", id: "...", agent: "${params.agent}", task: "..." }`,
            },
          ],
          details: emptyDetails('spawn'),
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: 'Invalid params. Use single (agent+task) or pool action.',
          },
        ],
        details: emptyDetails('list'),
        isError: true,
      };
    },
    renderCall(args, theme) {
      return renderOmoSubagentCall(args as Record<string, unknown>, theme);
    },
    renderResult(result, options, theme) {
      return renderOmoSubagentResult(result, options, theme);
    },
  });
}
