/**
 * Thin Pi runtime for pi-shiki-subagents.
 *
 * The runtime owns subagent sessions, mechanical tool boundaries, result
 * budgeting, and a small set of explicit utilities. Task workflows live in
 * skills and user instructions rather than a mode or stage state machine.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  PRESET_MODEL_SLOT_NAMES,
  PRIMARY_AGENT_NAME,
} from '../../config/constants';
import { stripJsonComments } from '../../config/jsonc';
import { deepMerge, loadPluginConfig } from '../../config/loader';
import {
  readPiNativeConfigObject,
  getPiNativeConfigPath as resolvePiNativeConfigPath,
} from '../../config/pi-native';
import {
  ensureAgentFiles,
  getPiAgentsDirForSync,
} from '../agents/managed-agent-files';
import type { OmniMoConfig, PiCouncilParticipantConfig } from '../config-types';
import { registerHarnessHooks } from '../harness/register-harness-hooks';
import { AGENT_PROMPTS } from '../meeting/pi-agents';
import {
  formatPiCouncilResults,
  type PiCouncilParticipant,
  type PiCouncilRunResult,
  resolvePiCouncilParticipants,
  runPiCouncilParticipant,
} from '../meeting/pi-council';
import type { PiMeetingResult } from '../meeting/pi-meeting';
import { formatPiMeetingResult, runPiMeeting } from '../meeting/pi-meeting';
import {
  getToolScope,
  isToolAllowed,
  resetToolScope,
  setToolScope,
} from '../policy/tool-scope-manager';
import {
  type AvailableModelRef,
  findStalePresetSlots,
  getActivePresetName,
  getPresetPack,
  listPresetNames,
  parseModelRef,
  setPresetSlot,
  summarizePresetPack,
} from '../preset/preset-model-resolution';
import { isModelPlaceholder, parsePiModelId } from '../preset/preset-switch';
import {
  getPool,
  initPoolAllToolNamesResolver,
  initPoolLimits,
  initPoolModelResolver,
  type PoolAgentInfo,
  resetPool,
} from '../subagent/subagent-pool';
import { registerPoolNoticeBridge } from '../subagent/subagent-pool-notice-bridge';
import { ensureSubagentRunWidgetRegistered } from '../subagent/subagent-run-widget';
import { registerSubagentTool } from '../subagent/subagent-tool';

export {
  ensureAgentFiles,
  getPiAgentsDirForSync,
} from '../agents/managed-agent-files';
export type {
  OmniMoConfig,
  PiCouncilConfig,
  PiCouncilParticipantConfig,
} from '../config-types';
export { AGENT_PROMPTS } from '../meeting/pi-agents';
export {
  formatPiCouncilResults,
  resolvePiCouncilParticipants,
} from '../meeting/pi-council';
export {
  formatPiMeetingResult,
  normalizePiMeetingBackend,
  normalizePiMeetingMaxRounds,
  normalizePiMeetingObjective,
} from '../meeting/pi-meeting';
export { parsePiModelId } from '../preset/preset-switch';

const PRESET_MODEL_SUBCOMMAND = 'model';
const DANGEROUS_BASH_PATTERNS = [
  /^sudo\s/i,
  /^rm\s+-rf\s+\/\s*$/i,
  /^rm\s+-rf\s+\/\*/i,
  /^rm\s+-rf\s+~\s*$/i,
  /^rm\s+-rf\s+~\/*/i,
  /^:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i,
] as const;

export function stripJsonCommentsSafely(raw: string): string {
  return stripJsonComments(raw);
}

export function getPiAgentDirForConfig(): string {
  return getAgentDir();
}

function readPiNativeConfig(): OmniMoConfig | null {
  const config = readPiNativeConfigObject(getPiAgentDirForConfig());
  return Object.keys(config).length > 0 ? (config as OmniMoConfig) : null;
}

function getPiNativeConfigPath(): string {
  return resolvePiNativeConfigPath(getPiAgentDirForConfig());
}

function writePiNativeConfig(config: OmniMoConfig): void {
  const configPath = getPiNativeConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function persistPresetSelectionToPiNativeConfig(
  presetName: string,
  effectiveConfig: OmniMoConfig,
): void {
  const nativeConfig = readPiNativeConfig() ?? {};
  nativeConfig.preset = presetName;
  if (
    !nativeConfig.presets?.[presetName] &&
    effectiveConfig.presets?.[presetName]
  ) {
    nativeConfig.presets ??= {};
    nativeConfig.presets[presetName] = effectiveConfig.presets[presetName];
  }
  writePiNativeConfig(nativeConfig);
}

export function loadOmniMoConfig(cwd = process.cwd()): OmniMoConfig | null {
  const piNativeConfig = readPiNativeConfig();
  const sharedConfig = loadPluginConfig(cwd, { quiet: true }) as OmniMoConfig;
  const config = deepMerge(
    (piNativeConfig as Record<string, unknown>) ?? undefined,
    Object.keys(sharedConfig).length > 0
      ? (sharedConfig as Record<string, unknown>)
      : undefined,
  ) as OmniMoConfig | undefined;
  return config && Object.keys(config).length > 0 ? config : null;
}

function normalizeModelReference(model: string): string | undefined {
  const parsed = parsePiModelId(model) ?? parseModelRef(model);
  return parsed ? `${parsed.provider}/${parsed.model}` : undefined;
}

function asPresetPack(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

async function listAvailableModelRefs(
  ctx: ExtensionContext,
): Promise<AvailableModelRef[]> {
  try {
    const available = await (ctx.modelRegistry as any).getAvailable?.();
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

function groupModelsByProvider(
  models: readonly AvailableModelRef[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model.id);
    map.set(model.provider, list);
  }
  for (const [provider, ids] of map) {
    map.set(
      provider,
      [...new Set(ids)].sort((a, b) => a.localeCompare(b)),
    );
  }
  return map;
}

function ensureNativePresetsShell(
  native: OmniMoConfig,
  names: string[],
): OmniMoConfig {
  native.presets ??= {};
  for (const name of names) {
    if (!native.presets[name] || typeof native.presets[name] !== 'object') {
      native.presets[name] = {};
    } else {
      // Coerce values to string slots only
      native.presets[name] = asPresetPack(native.presets[name]);
    }
  }
  return native;
}

function getAllToolNames(pi: ExtensionAPI): string[] {
  try {
    return pi
      .getAllTools()
      .map((tool: any) => tool?.name)
      .filter((name: unknown): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

function applyMainToolScope(pi: ExtensionAPI): void {
  const tools = getAllToolNames(pi);
  pi.setActiveTools(tools);
  setToolScope(tools, 'main', PRIMARY_AGENT_NAME, {
    tools: ['*'],
  });
}

function createCouncilTool(config: OmniMoConfig | null) {
  // 显式 details 类型：meeting 分支带 result，isolated 分支带 results，其余不带，统一联合避免推断分裂
  type CouncilToolDetails = {
    mode: string;
    question: string;
    result?: PiMeetingResult;
    results?: PiCouncilRunResult[];
  };

  return {
    name: 'omo_council',
    label: 'OMO Council',
    promptSnippet:
      'Run independent model perspectives on one explicit question (isolated or meeting).',
    promptGuidelines: [
      'Use omo_council when you need multiple independent viewpoints or adversarial cross-checks on one explicit question; pass a self-contained question.',
    ],
    description: 'Run independent model perspectives for an explicit question.',
    parameters: Type.Object({
      question: Type.String({ description: 'Question or task to analyze' }),
      mode: Type.Optional(
        Type.String({ description: 'isolated (default) | meeting' }),
      ),
      preset: Type.Optional(
        Type.String({ description: 'Council preset name' }),
      ),
      objective: Type.Optional(
        Type.String({ description: 'Meeting objective' }),
      ),
      maxRounds: Type.Optional(
        Type.Integer({ description: 'Meeting rounds, 1..5' }),
      ),
      maxDurationMs: Type.Optional(
        Type.Number({ description: 'Meeting timeout in milliseconds' }),
      ),
      includeTranscript: Type.Optional(
        Type.Boolean({ description: 'Include meeting transcript' }),
      ),
      backend: Type.Optional(Type.String({ description: 'session | pool' })),
      participants: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.Optional(Type.String()),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
            prompt: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        question: string;
        mode?: string;
        preset?: string;
        objective?: string;
        maxRounds?: number;
        maxDurationMs?: number;
        includeTranscript?: boolean;
        backend?: string;
        participants?: PiCouncilParticipantConfig[];
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<CouncilToolDetails>> {
      const mode = params.mode ?? 'isolated';
      if (mode === 'meeting') {
        const meeting = await runPiMeeting({
          question: params.question,
          preset: params.preset,
          participants: params.participants,
          objective: params.objective,
          maxRounds: params.maxRounds,
          maxDurationMs: params.maxDurationMs,
          includeTranscript: params.includeTranscript,
          backend: params.backend,
          ctx,
          config,
        });
        if (meeting.error || !meeting.result) {
          return {
            content: [
              {
                type: 'text' as const,
                text: meeting.error ?? 'Meeting failed without a result.',
              },
            ],
            details: { mode, question: params.question },
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: formatPiMeetingResult(meeting.result),
            },
          ],
          details: { mode, question: params.question, result: meeting.result },
        };
      }
      if (mode !== 'isolated') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unsupported council mode "${mode}".`,
            },
          ],
          details: { mode, question: params.question },
        };
      }

      const resolved = resolvePiCouncilParticipants({
        config,
        preset: params.preset,
        participants: params.participants,
      });
      if (resolved.error) {
        return {
          content: [{ type: 'text' as const, text: resolved.error }],
          details: { mode, question: params.question },
        };
      }
      const timeoutMs = config?.council?.timeout ?? 180000;
      const runOne = (participant: PiCouncilParticipant) =>
        runPiCouncilParticipant({
          participant,
          question: params.question,
          ctx,
          timeoutMs,
        });
      const results: PiCouncilRunResult[] =
        config?.council?.councillor_execution_mode === 'serial'
          ? []
          : await Promise.all(resolved.participants.map(runOne));
      if (results.length === 0) {
        for (const participant of resolved.participants)
          results.push(await runOne(participant));
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: formatPiCouncilResults(params.question, results),
          },
        ],
        details: { mode, question: params.question, results },
      };
    },
  };
}

function parsePiSyncArgs(args: string): string[] | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (const token of tokens) {
    if (token === 'check') result.push('--check');
    else if (token === 'write') result.push('--write');
    else if (token === 'typecheck') result.push('--typecheck');
    else if (token === 'test') result.push('--test');
    else if (token === 'build') result.push('--build');
    else if (token === 'skip-schema') result.push('--skip-schema');
    else if (token === 'restart-hint') result.push('--restart-hint');
    else if (token.startsWith('--')) result.push(token);
    else return null;
  }
  return result;
}

function runPiSyncCommand(args: string): { ok: boolean; output: string } {
  const parsedArgs = parsePiSyncArgs(args);
  if (!parsedArgs) {
    return {
      ok: false,
      output:
        'Usage: /pi-sync [check|write|typecheck|test|build|skip-schema|restart-hint]',
    };
  }
  const scriptPath = path.join(process.cwd(), 'scripts', 'pi-dev-sync.ts');
  const result = spawnSync('bun', ['run', scriptPath, ...parsedArgs], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: process.env,
  });
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    ok: !result.error && result.status === 0,
    output: result.error ? `${output}\n${result.error.message}`.trim() : output,
  };
}

export default function omniMoPiExtension(pi: ExtensionAPI) {
  const envKeys = [
    'OMO_SUB_AGENT',
    'OMO_AGENT_NAME',
    'OMO_PARENT_AGENT_NAME',
    'OMO_SUBAGENT_DEPTH',
    'OMO_ALLOWED_SUBAGENTS',
    'OMO_AGENT_ID',
  ];
  for (const key of envKeys) delete process.env[key];

  let config = loadOmniMoConfig();
  let currentPreset = config?.preset ?? 'default';
  const harnessRuntime = registerHarnessHooks(pi, { config: config?.harness });

  pi.on('session_start', async (_event, ctx) => {
    config = loadOmniMoConfig();
    currentPreset = config?.preset ?? currentPreset;
    ensureAgentFiles();
    applyMainToolScope(pi);
    initPoolModelResolver((modelId) => {
      const parsed = parsePiModelId(modelId);
      return parsed
        ? ctx.modelRegistry.find(parsed.provider, parsed.model)
        : undefined;
    });
    initPoolAllToolNamesResolver(() => getAllToolNames(pi));
    initPoolLimits({
      stallTimeoutMs: config?.harness?.subagent?.stallTimeoutMs,
      promptTimeoutMs: config?.harness?.subagent?.promptTimeoutMs,
    });
    try {
      ensureSubagentRunWidgetRegistered(ctx, getPool(), { force: true });
    } catch {}
    registerPoolNoticeBridge({
      pool: getPool(),
      pi,
      ctx,
      harnessRuntime,
    });
  });

  pi.on('tool_call', async (event) => {
    const toolName = (event as any).toolName;
    const input = (event as any).input;
    if (!toolName) return;

    const scope = getToolScope();
    if (scope && !isToolAllowed(toolName)) {
      return {
        block: true,
        reason: `Tool "${toolName}" is outside the active ${scope.sourceName} tool scope.`,
      };
    }

    if (toolName !== 'bash' || typeof input?.command !== 'string') return;
    const command = input.command.trim();
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          block: true,
          reason: `Blocked dangerous bash command matching ${pattern}.`,
        };
      }
    }
  });

  pi.registerTool(createCouncilTool(config));
  registerSubagentTool(pi);

  pi.registerCommand('preset', {
    description:
      'Open preset switcher/editor for optional subagent model overrides. Does not change the main model.',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          ' /preset requires an interactive UI (TUI or PiWeb dialogs).',
          'error',
        );
        return;
      }

      config = loadOmniMoConfig();
      currentPreset = getActivePresetName(config, currentPreset);

      const available = await listAvailableModelRefs(ctx);
      const presetNames = listPresetNames(config);
      if (presetNames.length === 0) {
        ctx.ui.notify(
          'No presets configured. Add presets.<name> objects in ~/.pi/agent/pi-shiki-subagents.json',
          'warning',
        );
        return;
      }

      const labelForPreset = (name: string): string => {
        const pack = asPresetPack(getPresetPack(config, name));
        const stale = findStalePresetSlots(pack, available);
        const active = name === currentPreset ? ' (当前)' : '';
        const summary = summarizePresetPack(pack);
        const staleMark =
          stale.length > 0
            ? ` ⚠️ ${stale.map((item) => `${item.slot}=${item.modelId}`).join(', ')}`
            : '';
        return `${name}${active} · ${summary}${staleMark}`;
      };

      const EDIT = '__edit__';
      const firstChoices = [...presetNames.map(labelForPreset), '编辑覆盖…'];
      const first = await ctx.ui.select('预设（子代理模型策略）', firstChoices);
      if (!first) return;

      const selectedPreset =
        first === '编辑覆盖…'
          ? EDIT
          : presetNames.find((name) => labelForPreset(name) === first);
      if (!selectedPreset) return;

      if (selectedPreset !== EDIT) {
        const pack = asPresetPack(getPresetPack(config, selectedPreset));
        const stale = findStalePresetSlots(pack, available);
        if (stale.length > 0) {
          const action = await ctx.ui.select(
            `预设「${selectedPreset}」含不可用覆盖`,
            [
              '清除失效覆盖后切换',
              '编辑该预设',
              '仍然切换（可能 spawn 失败）',
              '取消',
            ],
          );
          if (!action || action === '取消') return;
          if (action === '编辑该预设') {
            await editPresetOverrides(selectedPreset, ctx, available);
            config = loadOmniMoConfig();
            currentPreset = getActivePresetName(config, currentPreset);
            return;
          }
          if (action === '清除失效覆盖后切换') {
            const native = ensureNativePresetsShell(
              readPiNativeConfig() ?? { presets: {} },
              presetNames,
            );
            let packNext = asPresetPack(native.presets?.[selectedPreset]);
            for (const item of stale) {
              packNext = setPresetSlot(
                packNext,
                item.slot,
                undefined,
              ) as Record<string, string>;
            }
            native.presets![selectedPreset] = packNext;
            native.preset = selectedPreset;
            writePiNativeConfig(native);
            currentPreset = selectedPreset;
            config = loadOmniMoConfig();
            ctx.ui.notify(
              `已切换到「${selectedPreset}」，并清除失效覆盖。\n${summarizePresetPack(packNext)}`,
              'info',
            );
            return;
          }
          // fall through: still switch
        }

        const native = ensureNativePresetsShell(
          readPiNativeConfig() ?? { presets: {} },
          presetNames,
        );
        native.preset = selectedPreset;
        if (!native.presets?.[selectedPreset]) {
          native.presets![selectedPreset] = asPresetPack(
            getPresetPack(config, selectedPreset),
          );
        }
        writePiNativeConfig(native);
        currentPreset = selectedPreset;
        config = loadOmniMoConfig();
        const packAfter = asPresetPack(getPresetPack(config, selectedPreset));
        ctx.ui.notify(
          `已切换到「${selectedPreset}」\n- 主模型不变（请用 Pi /model）\n- 子代理策略: ${summarizePresetPack(packAfter)}`,
          'info',
        );
        return;
      }

      // Edit flow
      const target =
        presetNames.length === 1
          ? presetNames[0]
          : await ctx.ui
              .select(
                '选择要编辑的预设',
                presetNames.map((name) => labelForPreset(name)),
              )
              .then((label) =>
                label
                  ? presetNames.find((name) => labelForPreset(name) === label)
                  : undefined,
              );
      if (!target) return;
      await editPresetOverrides(target, ctx, available);
      config = loadOmniMoConfig();
      currentPreset = getActivePresetName(config, currentPreset);
    },
  });

  async function editPresetOverrides(
    presetName: string,
    ctx: ExtensionContext,
    available: AvailableModelRef[],
  ): Promise<void> {
    const slotChoices = [
      ...PRESET_MODEL_SLOT_NAMES.map((slot) => {
        const pack = asPresetPack(
          getPresetPack(loadOmniMoConfig(), presetName),
        );
        const current = pack[slot];
        const stale =
          current &&
          findStalePresetSlots({ [slot]: current }, available).length > 0;
        return current
          ? `${slot} = ${current}${stale ? ' ⚠️' : ''}`
          : `${slot} （未设置）`;
      }),
      '清除全部覆盖（跟随主模型）',
      '返回',
    ];
    const chosen = await ctx.ui.select(
      `编辑预设「${presetName}」覆盖`,
      slotChoices,
    );
    if (!chosen || chosen === '返回') return;

    const native = ensureNativePresetsShell(
      readPiNativeConfig() ?? { presets: {} },
      listPresetNames(loadOmniMoConfig()),
    );
    let pack = asPresetPack(native.presets?.[presetName]);

    if (chosen.startsWith('清除全部覆盖')) {
      native.presets![presetName] = {};
      writePiNativeConfig(native);
      ctx.ui.notify(`「${presetName}」已清空，子代理将跟随主模型。`, 'info');
      return;
    }

    const slot = PRESET_MODEL_SLOT_NAMES.find(
      (name) =>
        chosen.startsWith(`${name} `) ||
        chosen.startsWith(`${name}=`) ||
        chosen.startsWith(name),
    );
    if (!slot) return;

    const slotAction = await ctx.ui.select(`槽位 ${slot}`, [
      '选择模型',
      '清除此覆盖',
      '取消',
    ]);
    if (!slotAction || slotAction === '取消') return;
    if (slotAction === '清除此覆盖') {
      pack = setPresetSlot(pack, slot, undefined) as Record<string, string>;
      native.presets![presetName] = pack;
      writePiNativeConfig(native);
      ctx.ui.notify(`已清除 ${presetName}.${slot}`, 'info');
      return;
    }

    if (available.length === 0) {
      ctx.ui.notify(
        '当前没有可用模型。请先在 Pi 中配置/登录模型提供商。',
        'error',
      );
      return;
    }

    const byProvider = groupModelsByProvider(available);
    const providers = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
    const provider = await ctx.ui.select('选择 provider', providers);
    if (!provider) return;
    const models = byProvider.get(provider) ?? [];
    const modelId = await ctx.ui.select(
      `选择 ${provider} 模型`,
      models.map((id) => `${provider}/${id}`),
    );
    if (!modelId) return;
    const normalized = normalizeModelReference(modelId);
    if (!normalized || isModelPlaceholder(normalized)) {
      ctx.ui.notify('无效的模型 id', 'error');
      return;
    }
    pack = setPresetSlot(pack, slot, normalized) as Record<string, string>;
    native.presets![presetName] = pack;
    writePiNativeConfig(native);
    ctx.ui.notify(`已保存 ${presetName}.${slot} = ${normalized}`, 'info');
  }

  pi.registerCommand('pi-sync', {
    description: 'Synchronize or check the Pi development environment.',
    handler: async (args, ctx) => {
      const result = runPiSyncCommand(args);
      ctx.ui.notify(
        result.output || (result.ok ? 'Pi sync completed.' : 'Pi sync failed.'),
        result.ok ? 'info' : 'error',
      );
    },
  });

  pi.registerCommand('pool-status', {
    description: 'Show active subagent pool state.',
    handler: async (_args, ctx) => {
      const agents = getPool().list();
      const text =
        agents.length === 0
          ? 'Pool is empty.'
          : agents
              .map(
                (agent: PoolAgentInfo) =>
                  `${agent.id} (${agent.agentName}) - ${agent.status}, ${agent.messageCount} messages`,
              )
              .join('\n');
      ctx.ui.notify(text, 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    await resetPool();
    resetToolScope();
  });

  console.error(
    `[pi-shiki-subagents] Thin Pi runtime loaded. Preset: ${currentPreset} (subagent overrides only; main model uses Pi controls)`,
  );
}
