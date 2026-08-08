import * as fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { discoverAgents } from '../../adapters/agent-discovery';
import {
  checkDelegationAllowed,
  parseAllowedSubagentsEnv,
} from '../../adapters/delegation-rules';
import { loadPluginConfig } from '../../config/loader';
import { readPiNativeConfigObject } from '../../config/pi-native';
import {
  type AvailableModelRef,
  formatModelRef,
  getActivePresetName,
  getPresetPack,
  isModelAvailable,
  parseModelRef,
  resolveRoleSubagentModelId,
} from '../preset/preset-model-resolution';
import {
  getPool,
  type PoolAgentInfo,
  type PoolAgentRecord,
  resolveDelegationCaller,
} from './subagent-pool';
import type { SubagentToolAction } from './subagent-run-detail-view';
import { buildOmoSubagentToolDetails } from './subagent-run-tool-details';
import {
  renderOmoSubagentCall,
  renderOmoSubagentResult,
} from './subagent-run-tool-renderer';
import { ensureSubagentRunWidgetRegistered } from './subagent-run-widget';
import {
  SUBAGENT_POOL_ACTION,
  SUBAGENT_POOL_ACTIONS,
} from './subagent-tool-actions';

function buildDetails(
  action: SubagentToolAction,
  runId?: string,
  focusRun = false,
) {
  return buildOmoSubagentToolDetails(
    getPool().getRunTreeView({ maxRecentLines: 10 }),
    {
      action,
      runId,
      focusRun,
      eventLimit: 10,
      maxChildren: 5,
      maxDepth: 2,
      maxRoots: 5,
    },
  );
}

function emptyDetails(action: SubagentToolAction, runId?: string) {
  return buildDetails(action, runId, false);
}

async function listAvailableModels(ctx: any): Promise<AvailableModelRef[]> {
  try {
    const available = await ctx?.modelRegistry?.getAvailable?.();
    if (!Array.isArray(available)) return [];
    return available
      .map((model: any) => ({
        provider: String(model?.provider ?? ''),
        id: String(model?.id ?? ''),
      }))
      .filter((model: AvailableModelRef) => model.provider && model.id);
  } catch {
    return [];
  }
}

function loadEffectivePresetConfig(cwd: string) {
  const piNative = readPiNativeConfigObject();
  const shared = loadPluginConfig(cwd, { quiet: true }) as Record<
    string,
    unknown
  >;
  return {
    preset:
      (typeof piNative.preset === 'string' && piNative.preset) ||
      (typeof shared.preset === 'string' && shared.preset) ||
      undefined,
    presets: {
      ...((shared.presets as Record<string, any>) ?? {}),
      ...((piNative.presets as Record<string, any>) ?? {}),
    },
  };
}

async function resolveSpawnModelId(args: {
  ctx: any;
  role: string;
  explicitModel?: string;
  cwd: string;
}): Promise<{ ok: true; modelId?: string } | { ok: false; error: string }> {
  const config = loadEffectivePresetConfig(args.cwd);
  const pack = getPresetPack(config, getActivePresetName(config));
  const mainModelId = formatModelRef(args.ctx?.model);
  const resolved = resolveRoleSubagentModelId({
    role: args.role,
    explicitModel: args.explicitModel,
    pack,
    mainModelId,
  });
  if (!resolved.modelId) {
    return {
      ok: false,
      error:
        'No model available for subagent spawn. Set the main session model in Pi, or add a preset subagent/role override via /preset.',
    };
  }
  const available = await listAvailableModels(args.ctx);
  if (available.length > 0 && !isModelAvailable(resolved.modelId, available)) {
    const parsed = parseModelRef(resolved.modelId);
    return {
      ok: false,
      error: `Model "${resolved.modelId}" from ${resolved.source} is unavailable in Pi. Use /preset to clear or reselect the override${parsed ? '' : ''}.`,
    };
  }
  // Also require registry.find when possible
  const parsed = parseModelRef(resolved.modelId);
  if (parsed && args.ctx?.modelRegistry?.find) {
    const found = args.ctx.modelRegistry.find(parsed.provider, parsed.model);
    if (!found) {
      return {
        ok: false,
        error: `Model "${resolved.modelId}" from ${resolved.source} was not found in the model registry. Use /preset to clear or reselect the override.`,
      };
    }
  }
  return { ok: true, modelId: resolved.modelId };
}

export interface ResumeSessionPlan {
  canResumeSession: boolean;
  resumeSessionFile?: string;
  resumeMessage?: string;
  successText: string;
}

export function planPoolResume(
  record: Pick<PoolAgentRecord, 'id' | 'agentName' | 'sessionFile'>,
  message: string | undefined,
  exists: (filePath: string) => boolean = fs.existsSync,
): ResumeSessionPlan {
  const sessionFile =
    typeof record.sessionFile === 'string' && record.sessionFile.trim()
      ? record.sessionFile
      : undefined;
  const canResumeSession = Boolean(sessionFile && exists(sessionFile));
  return {
    canResumeSession,
    resumeSessionFile: canResumeSession ? sessionFile : undefined,
    resumeMessage: canResumeSession ? message : undefined,
    successText: canResumeSession
      ? `✓ Agent "${record.id}" (${record.agentName}) resumed from saved session.`
      : `✓ Agent "${record.id}" (${record.agentName}) restarted from saved task context. No saved session file was available.`,
  };
}

export function selectPoolResultText(
  active: Pick<PoolAgentInfo, 'lastResponse'> | undefined,
  record: Pick<PoolAgentRecord, 'lastResponse'> | undefined,
): string {
  return active?.lastResponse || record?.lastResponse || '';
}

export function formatPoolResultContent(args: {
  id: string;
  agentName: string;
  response: string;
  errorMessage?: string;
}): string {
  const header = `Result from ${args.id} (${args.agentName}):`;
  const response = args.response.trim();
  const error = args.errorMessage?.trim();
  if (!error) return `${header}\n\n${response}`;
  const lines = [header, '', `Status: failed (${error})`];
  if (response) {
    lines.push('', 'Partial result captured before failure:', '', response);
  } else {
    lines.push('', 'No partial result was captured.');
  }
  return lines.join('\n');
}

export function checkPoolContinuationAllowed(args: {
  callerAgent?: string;
  targetAgent?: string;
  depth?: number;
  cwd?: string;
  allowedSubagents?: readonly string[];
  rules?: Record<string, readonly string[]>;
}):
  | { ok: true }
  | { ok: false; reason: string; allowedAgents?: readonly string[] } {
  const targetAgent = args.targetAgent?.trim();
  if (!targetAgent) {
    return {
      ok: false,
      reason: 'Saved or active pool agent has no target agent name.',
    };
  }
  const delegation = checkDelegationAllowed({
    caller: args.callerAgent,
    target: targetAgent,
    depth: args.depth,
    cwd: args.cwd,
    allowedSubagents: args.allowedSubagents,
    rules: args.rules,
  });
  if (delegation.allowed) return { ok: true };
  return {
    ok: false,
    reason:
      delegation.reason ??
      `Agent '${args.callerAgent ?? ''}' is not allowed to continue '${targetAgent}'.`,
    allowedAgents: delegation.allowedAgents,
  };
}

export function registerSubagentTool(pi: ExtensionAPI): void {
  const poolActionDescription = `Pool action: ${SUBAGENT_POOL_ACTIONS.join(' | ')}`;

  pi.registerTool({
    name: 'omo_subagent',
    label: 'OMO Subagent',
    promptSnippet:
      'Delegate bounded work to isolated role subagents (search/fixer/oracle); main keeps control and only takes results back.',
    promptGuidelines: [
      'Use omo_subagent for noisy exploration, parallel independent subtasks, or role-isolated review/implementation; skip it when the main session can finish in a few steps.',
      'omo_subagent task must include goal, scope/paths, output format, and stop conditions in one shot; wait for pool_completed/pool_failed instead of polling list.',
    ],
    description: [
      'Delegate bounded subtasks to isolated role subagents. Main keeps user control and only takes results back.',
      '',
      'Use when:',
      '- exploration/search would flood main context with intermediate noise',
      '- independent directions can run in parallel',
      '- role isolation helps: search (read-only research) / fixer (implementation) / oracle (adversarial review)',
      '',
      'Do not use when:',
      '- main can finish in a few steps',
      '- work depends on unstated dialog state or needs continuous user clarification',
      '- task boundary is unclear or many agents would edit the same files',
      '',
      'task must include goal, scope/paths, output format, and stop conditions in one shot. Vague delegation is forbidden.',
      '',
      'Protocol:',
      '  spawn: { pool: "spawn", id, agent, task } → async; wait for pool_completed/pool_failed',
      '  send: only to an existing non-busy agent; not the default after spawn',
      '  list: reuse/debug snapshot; do not poll for completion',
      '  result / listSaved / resume / kill: fetch result, list resumable sessions, resume, or stop',
      '  on busy/reject: do not repeat the same request; degrade or ask the user',
    ].join('\n'),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: 'Subagent role name' })),
      task: Type.Optional(
        Type.String({ description: 'Task prompt for a pool agent' }),
      ),
      pool: Type.Optional(
        Type.String({
          description: poolActionDescription,
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: 'Pool agent ID (for spawn/send/kill)',
        }),
      ),
      message: Type.Optional(
        Type.String({
          description: 'Message for pool send/resume action',
        }),
      ),
      model: Type.Optional(Type.String({ description: 'Model override' })),
    }),

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
      ): { ok: true } | { ok: false; response: any } => {
        const delegation = checkDelegationAllowed({
          caller: callerAgent,
          target: targetAgent,
          depth: callerDepth,
          cwd,
          allowedSubagents,
        });
        if (delegation.allowed) return { ok: true };
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
        if (params.pool === SUBAGENT_POOL_ACTION.spawn) {
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
          const delegation = requireDelegationAllowed(params.agent);
          if (!delegation.ok) return delegation.response;
          const modelResolution = await resolveSpawnModelId({
            ctx,
            role: params.agent,
            explicitModel: params.model,
            cwd,
          });
          if (!modelResolution.ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✗ Spawn failed: ${modelResolution.error}`,
                },
              ],
              details: buildDetails('spawn', params.id, true),
              isError: true,
            };
          }
          const spawnResult = await pool.spawn({
            id: params.id,
            name: params.id,
            agent: agentCfg,
            task: params.task,
            model: modelResolution.modelId,
            cwd,
            parentAgent: callerAgent,
            parentRunId: callerRunId,
            depth: callerDepth + 1,
            allowedSubagents,
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
          const successText = [
            `✓ Pool agent "${params.id}" (${params.agent}) spawned. Initial task started asynchronously.`,
            'Default next step: wait for the completion notification (pool_completed / pool_failed follow-up).',
            'pool=list is allowed for reuse/debug, but do not poll list in a loop just to wait for completion; use pool=result if you need the full text after the notification.',
          ].join(' ');
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

        if (params.pool === SUBAGENT_POOL_ACTION.send) {
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
          const record = pool.getRegistryEntry(params.id);
          const targetAgent = current?.agentName ?? record?.agentName;
          if (current || record) {
            const continuation = checkPoolContinuationAllowed({
              callerAgent,
              targetAgent,
              depth: callerDepth,
              cwd,
              allowedSubagents,
            });
            if (!continuation.ok) {
              const allowed = continuation.allowedAgents?.length
                ? continuation.allowedAgents.join(', ')
                : '(none)';
              return {
                content: [
                  {
                    type: 'text',
                    text: `${continuation.reason}. Allowed agents: ${allowed}`,
                  },
                ],
                details: emptyDetails('send', params.id),
                isError: true,
              };
            }
          }
          if (
            current &&
            (current.status === 'starting' || current.status === 'streaming')
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Agent "${params.id}" is running (${current.status}). Do not submit another request now; wait for the completion notification.\n[guard] 下一步：等待完成通知后再继续，或先向用户确认是否改为降级方案。list 可用于排查，但不要用 list 轮询代替完成通知。`,
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

        if (params.pool === SUBAGENT_POOL_ACTION.list) {
          const list = pool.list();
          if (list.length === 0)
            return {
              content: [{ type: 'text', text: 'Pool is empty.' }],
              details: emptyDetails('list'),
            };
          const lines = list.map(
            (a: PoolAgentInfo) =>
              `  ${a.status === 'dead' || a.status === 'failed' ? '✗' : '●'} ${a.id} (${a.agentName}) — ${a.status}, ${a.messageCount} msgs, model: ${a.model}`,
          );
          const running = list.filter(
            (a: PoolAgentInfo) =>
              a.status === 'starting' || a.status === 'streaming',
          );
          const footer =
            running.length > 0
              ? `\n[note] ${running.length} agent(s) still running. Prefer waiting for pool_completed/pool_failed rather than re-calling list in a tight wait loop. list remains valid for reuse/debug snapshots.`
              : '\n[note] list is fine for discovering idle agents to reuse via send. Completion is normally delivered by notification; list is not required as a wait loop.';
          return {
            content: [
              {
                type: 'text',
                text: `Pool agents (${list.length}):\n${lines.join('\n')}${footer}`,
              },
            ],
            details: buildDetails('list'),
          };
        }

        if (params.pool === SUBAGENT_POOL_ACTION.kill) {
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

        if (params.pool === SUBAGENT_POOL_ACTION.listSaved) {
          const entries = pool.listRegistryEntries();
          if (entries.length === 0)
            return {
              content: [{ type: 'text', text: 'No saved sub-agent sessions.' }],
              details: emptyDetails('listSaved'),
            };
          const lines = entries.map((r) => {
            const status = r.status ?? 'saved';
            const preview = (r.lastResponse || r.errorMessage || r.task).slice(
              0,
              100,
            );
            return `  ${r.id} (${r.agentName}) — ${status}, ${r.messageCount ?? 0} msgs — ${preview}`;
          });
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

        if (params.pool === SUBAGENT_POOL_ACTION.result) {
          if (!params.id)
            return {
              content: [{ type: 'text', text: 'result requires id' }],
              details: emptyDetails('result'),
              isError: true,
            };
          const active = pool
            .list()
            .find((a: PoolAgentInfo) => a.id === params.id);
          const record = pool.getRegistryEntry(params.id);
          const response = selectPoolResultText(active, record);
          const errorMessage = record?.errorMessage;
          if (!active && !record)
            return {
              content: [
                {
                  type: 'text',
                  text: `Saved session "${params.id}" not found`,
                },
              ],
              details: emptyDetails('result', params.id),
              isError: true,
            };
          if (!response && !errorMessage)
            return {
              content: [
                {
                  type: 'text',
                  text: `No saved result for "${params.id}" yet.`,
                },
              ],
              details: buildDetails('result', params.id, true),
            };
          return {
            content: [
              {
                type: 'text',
                text: formatPoolResultContent({
                  id: params.id,
                  agentName:
                    record?.agentName ?? active?.agentName ?? 'unknown',
                  response,
                  errorMessage,
                }),
              },
            ],
            details: buildDetails('result', params.id, true),
            isError: Boolean(errorMessage && !response),
          };
        }

        if (params.pool === SUBAGENT_POOL_ACTION.resume) {
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
          const continuation = checkPoolContinuationAllowed({
            callerAgent,
            targetAgent: record.agentName,
            depth: callerDepth,
            cwd: record.cwd || cwd,
            allowedSubagents,
          });
          if (!continuation.ok) {
            const allowed = continuation.allowedAgents?.length
              ? continuation.allowedAgents.join(', ')
              : '(none)';
            return {
              content: [
                {
                  type: 'text',
                  text: `${continuation.reason}. Allowed agents: ${allowed}`,
                },
              ],
              details: emptyDetails('resume', params.id),
              isError: true,
            };
          }
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
          const resumePlan = planPoolResume(record, params.message);
          const modelResolution = await resolveSpawnModelId({
            ctx,
            role: record.agentName,
            explicitModel: params.model,
            cwd: record.cwd || cwd,
          });
          if (!modelResolution.ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✗ Resume failed: ${modelResolution.error}`,
                },
              ],
              details: buildDetails('resume', params.id, true),
              isError: true,
            };
          }
          const resumeResult = await pool.spawn({
            id: record.id,
            name: record.name,
            agent: agentCfg,
            task: record.task,
            model: modelResolution.modelId,
            cwd: record.cwd || cwd,
            parentAgent: resolveDelegationCaller(),
            parentRunId: callerRunId,
            depth:
              (Number.parseInt(process.env.OMO_SUBAGENT_DEPTH ?? '0', 10) ||
                0) + 1,
            allowedSubagents: parseAllowedSubagentsEnv(
              process.env.OMO_ALLOWED_SUBAGENTS,
            ),
            resumeSessionFile: resumePlan.resumeSessionFile,
            resumeMessage: resumePlan.resumeMessage,
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
                text: resumePlan.successText,
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
              text: `Use pool=spawn with id, agent, and task for "${params.agent}".`,
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
            text: 'Invalid parameters. Use a pool action.',
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
