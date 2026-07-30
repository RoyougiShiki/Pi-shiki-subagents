import { beforeEach, describe, expect, test } from 'bun:test';
import {
  auditPayloadTools,
  getToolScope,
  isToolAllowed,
  resetToolScope,
  setToolScope,
} from './tool-scope-manager';

describe('tool scope manager', () => {
  beforeEach(() => resetToolScope());

  test('records the broad main-session scope', () => {
    setToolScope(['read', 'write', 'edit', 'bash'], 'main', 'main', {
      tools: ['*'],
    });

    const snapshot = getToolScope();

    expect(snapshot?.source).toBe('main');
    expect(snapshot?.sourceName).toBe('main');
    expect(isToolAllowed('bash')).toBe(true);
    expect(isToolAllowed('omo_subagent')).toBe(false);
  });

  test('audits payload differences without changing runtime permissions', () => {
    setToolScope(['read', 'write'], 'main', 'main');

    expect(auditPayloadTools(['read', 'bash'])).toMatchObject({
      consistent: false,
      missingInPayload: ['write'],
      extraInPayload: ['bash'],
    });
  });

  test('clears the snapshot on shutdown', () => {
    setToolScope(['read'], 'main', 'main');
    resetToolScope();
    expect(getToolScope()).toBeNull();
  });
});
