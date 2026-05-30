import { describe, expect, test, beforeEach } from 'bun:test';
import {
  setToolScope,
  getToolScope,
  isToolAllowed,
  auditPayloadTools,
  resetToolScope,
} from './tool-scope-manager';

describe('ToolScopeManager', () => {
  beforeEach(() => {
    resetToolScope();
  });

  test('setToolScope writes snapshot', () => {
    setToolScope(['read', 'write', 'edit'], 'mode', 'coordinator', { roles: ['读', '写'] });

    const snapshot = getToolScope();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tools.has('read')).toBe(true);
    expect(snapshot!.tools.has('write')).toBe(true);
    expect(snapshot!.tools.has('edit')).toBe(true);
    expect(snapshot!.source).toBe('mode');
    expect(snapshot!.sourceName).toBe('coordinator');
  });

  test('isToolAllowed checks snapshot', () => {
    setToolScope(['read', 'write'], 'mode', 'coordinator');

    expect(isToolAllowed('read')).toBe(true);
    expect(isToolAllowed('write')).toBe(true);
    expect(isToolAllowed('bash')).toBe(false);
  });

  test('isToolAllowed returns false when no snapshot', () => {
    expect(isToolAllowed('read')).toBe(false);
  });

  test('auditPayloadTools detects consistency', () => {
    setToolScope(['read', 'write', 'edit'], 'mode', 'coordinator');

    const result = auditPayloadTools(['read', 'write', 'edit']);
    expect(result.consistent).toBe(true);
    expect(result.missingInPayload).toHaveLength(0);
    expect(result.extraInPayload).toHaveLength(0);
  });

  test('auditPayloadTools detects missing in payload', () => {
    setToolScope(['read', 'write', 'edit'], 'mode', 'coordinator');

    const result = auditPayloadTools(['read', 'write']);
    expect(result.consistent).toBe(false);
    expect(result.missingInPayload).toEqual(['edit']);
  });

  test('auditPayloadTools detects extra in payload', () => {
    setToolScope(['read', 'write'], 'mode', 'coordinator');

    const result = auditPayloadTools(['read', 'write', 'bash']);
    expect(result.consistent).toBe(false);
    expect(result.extraInPayload).toEqual(['bash']);
  });

  test('resetToolScope clears snapshot', () => {
    setToolScope(['read'], 'mode', 'coordinator');
    expect(getToolScope()).not.toBeNull();

    resetToolScope();
    expect(getToolScope()).toBeNull();
  });
});
