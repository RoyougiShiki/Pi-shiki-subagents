import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_WORKFLOWS } from '../../config/workflow-defaults';
import { MODE_MESSAGE_TYPES, emitModeSessionNotice, emitModeSwitched, normalizeManagedRuntimeConfig, runWithModeSwitchOrigin, validateActiveModeWorkflow, validateModeAllowlist, validateModeWorkflowBinding } from './pi-modes';
import { setToolScope, resetToolScope } from '../policy/tool-scope-manager';

describe('mode switch notices', () => {
  test('emitModeSwitched displays follow-up without triggering a model turn for user command switches', () => {
    resetToolScope();
    setToolScope(['read', 'write'], 'mode', 'target-mode');

    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    } as any;

    emitModeSwitched(pi, 'source-mode', 'target-mode', false);

    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe(MODE_MESSAGE_TYPES.switched);
    expect(sent[0].message.content).toContain('[mode] source-mode -> target-mode');
    expect(sent[0].message.content).toContain('[workflow] none (non-pipeline/rescue)');
    expect(sent[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: false });
  });

  test('emitModeSwitched can trigger a model turn for tool-call switches', () => {
    resetToolScope();
    setToolScope(['read'], 'mode', 'target-mode');

    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    } as any;

    emitModeSwitched(pi, 'source-mode', 'target-mode', true);

    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
  });

  test('emitModeSessionNotice shows the workflow bound to a pipeline mode', () => {
    resetToolScope();
    setToolScope(['omo_subagent'], 'mode', 'standard-dev');

    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    } as any;

    emitModeSessionNotice(pi, 'started', 'standard-dev');

    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe(MODE_MESSAGE_TYPES.sessionStarted);
    expect(sent[0].message.content).toContain('[workflow] standard-dev (stage-gated; next stage requires approval)');
    expect(sent[0].message.content).toContain('<MODE name="standard-dev">');
    expect(sent[0].message.content).toContain('标准开发主控 agent');
    expect(sent[0].message.details.workflow).toBe('standard-dev');
  });

  test('mode switch notices include the target mode prompt for the next turn', () => {
    resetToolScope();
    setToolScope(['omo_subagent'], 'mode', 'quick-fix');

    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    } as any;

    emitModeSwitched(pi, 'standard-dev', 'quick-fix', true);

    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain('<MODE name="quick-fix">');
    expect(sent[0].message.content).toContain('等待系统工作包审批');
    expect(sent[0].message.content).toContain('委托当前实现阶段主子代理做最小修复');
    expect(sent[0].message.content).not.toContain('不委托 analyst 或 worker');
  });

  test('runWithModeSwitchOrigin restores previous origin after scoped mode switch work', () => {
    const values: string[] = [];

    runWithModeSwitchOrigin('user_command', () => {
      values.push('outer');
      runWithModeSwitchOrigin('tool_call', () => {
        values.push('inner');
      });
      values.push('outer-after');
    });

    expect(values).toEqual(['outer', 'inner', 'outer-after']);
  });
});

describe('mode tool config parsing', () => {
  test('normalizes stale managed Pi-native modes and workflows', () => {
    const { config, changed } = normalizeManagedRuntimeConfig({
      workflows: {
        default: 'standard-dev',
        list: [
          {
            name: 'quick-fix',
            description: 'stale',
            stages: [
              { id: 'analyst', agent: 'analyst' },
              { id: 'worker', agent: 'worker' },
            ],
          },
          {
            name: 'custom-flow',
            description: 'Custom',
            stages: [{ id: 'custom', agent: 'custom-agent' }],
          },
        ],
      },
      agents: {
        coordinator: {
          type: 'mode',
          pipelineMode: true,
          label: 'old coordinator',
        },
        fallback: {
          type: 'mode',
          pipelineMode: false,
          requiresUserCommand: true,
        },
      },
    });

    expect(changed).toBe(true);
    expect(config.agents['standard-dev']).toMatchObject({
      type: 'mode',
      pipelineMode: true,
      workflow: 'standard-dev',
    });
    expect(config.agents['quick-fix']).toMatchObject({
      type: 'mode',
      pipelineMode: true,
      workflow: 'quick-fix',
    });
    expect(config.agents.coordinator).toBeUndefined();
    expect(config.agents._tool_groups).toBeUndefined();
    expect(config.agents.fallback.requiresUserCommand).toBe(true);
    expect(config.workflows.default).toBeUndefined();

    const quickFix = config.workflows.list.find((workflow: any) => workflow.name === 'quick-fix');
    expect(quickFix.stages.map((stage: any) => stage.agent)).toEqual(['fixer']);
    expect(quickFix.stages[0].requiresApproval).toBe(true);
    expect(config.workflows.list.some((workflow: any) => workflow.name === 'custom-flow')).toBe(true);
  });

  test('loads Pi-native jsonc tool groups for mode validation', async () => {
    const previousHome = process.env.HOME;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-pi-modes-jsonc-'));
    process.env.HOME = path.join(tempDir, 'home');
    const configDir = path.join(process.env.HOME, '.pi', 'agent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // Mode tool group override
        "_tool_groups": {
          "交互": ["ask_user_question",],
          "子代理": ["omo_subagent",],
        },
      }`,
    );

    try {
      expect(
        validateModeAllowlist(['ask_user_question', 'omo_subagent']),
      ).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('validates pipeline mode workflow binding without using workflows.default', () => {
    expect(validateActiveModeWorkflow({ list: DEFAULT_WORKFLOWS })).toBeNull();
  });

  test('reports pipeline mode missing workflow binding', () => {
    const err = validateModeWorkflowBinding({
      modeName: 'custom-pipeline',
      agent: { pipelineMode: true },
      workflows: { list: [{ name: 'standard-dev' }] },
    });
    expect(err).toContain('agents.custom-pipeline.workflow');
    expect(err).toContain('workflows.default is not used');
  });
});
