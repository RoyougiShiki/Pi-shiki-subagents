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
    setToolScope(['read', 'write', 'edit'], 'mode', 'standard-dev', { roles: ['读', '写'] });

    const snapshot = getToolScope();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tools.has('read')).toBe(true);
    expect(snapshot!.tools.has('write')).toBe(true);
    expect(snapshot!.tools.has('edit')).toBe(true);
    expect(snapshot!.source).toBe('mode');
    expect(snapshot!.sourceName).toBe('standard-dev');
  });

  test('isToolAllowed checks snapshot', () => {
    setToolScope(['read', 'write'], 'mode', 'standard-dev');

    expect(isToolAllowed('read')).toBe(true);
    expect(isToolAllowed('write')).toBe(true);
    expect(isToolAllowed('bash')).toBe(false);
  });

  test('isToolAllowed returns false when no snapshot', () => {
    expect(isToolAllowed('read')).toBe(false);
  });

  test('auditPayloadTools detects consistency', () => {
    setToolScope(['read', 'write', 'edit'], 'mode', 'standard-dev');

    const result = auditPayloadTools(['read', 'write', 'edit']);
    expect(result.consistent).toBe(true);
    expect(result.missingInPayload).toHaveLength(0);
    expect(result.extraInPayload).toHaveLength(0);
  });

  test('auditPayloadTools detects missing in payload', () => {
    setToolScope(['read', 'write', 'edit'], 'mode', 'standard-dev');

    const result = auditPayloadTools(['read', 'write']);
    expect(result.consistent).toBe(false);
    expect(result.missingInPayload).toEqual(['edit']);
  });

  test('auditPayloadTools detects extra in payload', () => {
    setToolScope(['read', 'write'], 'mode', 'standard-dev');

    const result = auditPayloadTools(['read', 'write', 'bash']);
    expect(result.consistent).toBe(false);
    expect(result.extraInPayload).toEqual(['bash']);
  });

  test('resetToolScope clears snapshot', () => {
    setToolScope(['read'], 'mode', 'standard-dev');
    expect(getToolScope()).not.toBeNull();

    resetToolScope();
    expect(getToolScope()).toBeNull();
  });

  // ── 防回退测试 ──────────────────────────────────────────────────────

  test('Case A: tool_call decision depends only on snapshot, not mode config', () => {
    // 设置 snapshot 为 standard-dev 的工具集
    setToolScope(['read', 'write', 'todo'], 'mode', 'standard-dev');

    // 即使之后 mode 配置变了（比如切到 fallback），snapshot 不变
    // isToolAllowed 仍然基于原始 snapshot
    expect(isToolAllowed('read')).toBe(true);
    expect(isToolAllowed('write')).toBe(true);
    expect(isToolAllowed('todo')).toBe(true);
    expect(isToolAllowed('bash')).toBe(false); // fallback 有 bash，但 snapshot 没有

    // 再次设置 snapshot（模拟 mode 切换）
    setToolScope(['read', 'write', 'edit', 'bash'], 'mode', 'fallback');

    // 现在 bash 应该被允许了
    expect(isToolAllowed('bash')).toBe(true);
    expect(isToolAllowed('todo')).toBe(false); // fallback 没有 todo
  });

  test('Case B: auditPayloadTools detects mismatch and returns audit info', () => {
    // 设置 snapshot
    setToolScope(['read', 'write'], 'mode', 'standard-dev');

    // payload 比 snapshot 多了 bash，少了 write
    const payloadTools = ['read', 'bash'];
    const result = auditPayloadTools(payloadTools);

    expect(result.consistent).toBe(false);
    expect(result.snapshotTools).toEqual(['read', 'write']);
    expect(result.payloadTools).toEqual(['read', 'bash']);
    expect(result.missingInPayload).toEqual(['write']);
    expect(result.extraInPayload).toEqual(['bash']);
  });
});
