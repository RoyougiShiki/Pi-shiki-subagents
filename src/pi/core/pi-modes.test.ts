import { describe, expect, test } from 'bun:test';
import { MODE_MESSAGE_TYPES, emitModeSwitched, runWithModeSwitchOrigin } from './pi-modes';
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
