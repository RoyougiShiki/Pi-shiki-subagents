import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MODE_MESSAGE_TYPES, emitModeSessionNotice, emitModeSwitched, runWithModeSwitchOrigin, validateActiveModeWorkflow, validateModeAllowlist, validateModeWorkflowBinding } from './pi-modes';
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
    expect(sent[0].message.content).toContain('[workflow] none');
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
    setToolScope(['omo_subagent'], 'mode', 'coordinator');

    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    } as any;

    emitModeSessionNotice(pi, 'started', 'coordinator');

    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe(MODE_MESSAGE_TYPES.sessionStarted);
    expect(sent[0].message.content).toContain('[workflow] standard-dev');
    expect(sent[0].message.details.workflow).toBe('standard-dev');
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
    expect(validateActiveModeWorkflow({ list: [{ name: 'standard-dev' }] })).toBeNull();
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
