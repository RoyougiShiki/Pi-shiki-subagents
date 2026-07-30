import { describe, expect, test } from 'bun:test';
import {
  findStalePresetSlots,
  formatModelRef,
  resolveRoleSubagentModelId,
  summarizePresetPack,
} from './preset-model-resolution';

describe('preset model resolution', () => {
  test('uses explicit model first', () => {
    expect(
      resolveRoleSubagentModelId({
        role: 'fixer',
        explicitModel: 'a/b',
        pack: { fixer: 'c/d', subagent: 'e/f' },
        mainModelId: 'g/h',
      }),
    ).toEqual({ modelId: 'a/b', source: 'explicit' });
  });

  test('falls through role → subagent → main', () => {
    expect(
      resolveRoleSubagentModelId({
        role: 'search',
        pack: {},
        mainModelId: 'main/provider',
      }).source,
    ).toBe('main');
  });

  test('formats main model refs', () => {
    expect(formatModelRef({ provider: 'dmxapi', id: 'glm5' })).toBe(
      'dmxapi/glm5',
    );
    expect(formatModelRef(undefined)).toBeUndefined();
  });

  test('summarizes empty packs as follow main', () => {
    expect(summarizePresetPack({})).toBe('跟随主模型');
  });

  test('detects stale slots', () => {
    expect(
      findStalePresetSlots(
        { subagent: 'missing/x', oracle: 'ok/y' },
        [{ provider: 'ok', id: 'y' }],
      ),
    ).toEqual([{ slot: 'subagent', modelId: 'missing/x' }]);
  });
});
