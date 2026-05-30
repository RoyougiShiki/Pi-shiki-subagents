import { describe, expect, test } from 'bun:test';
import { checkClarification, shouldBlockForClarification } from './clarification-policy';

describe('ClarificationPolicy', () => {
  test('non-write tools always ready', () => {
    const result = checkClarification('read', { path: '/foo' });
    expect(result.ready).toBe(true);
  });

  test('write tool missing path blocks', () => {
    const result = checkClarification('write', { content: 'hello' });
    expect(result.ready).toBe(false);
    expect(result.missingFields?.[0]).toContain('path');
  });

  test('write tool missing content blocks', () => {
    const result = checkClarification('write', { path: '/foo' });
    expect(result.ready).toBe(false);
    expect(result.missingFields?.[0]).toContain('content');
  });

  test('write tool with all fields ready', () => {
    const result = checkClarification('write', { path: '/foo', content: 'hello', filePath: '/bar' });
    expect(result.ready).toBe(true);
  });

  test('edit tool missing path blocks', () => {
    const result = checkClarification('edit', { content: 'hello' });
    expect(result.ready).toBe(false);
  });

  test('bash tool missing command blocks', () => {
    const result = checkClarification('bash', {});
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain('command');
  });

  test('bash tool with command ready', () => {
    const result = checkClarification('bash', { command: 'ls', filePath: '/tmp' });
    expect(result.ready).toBe(true);
  });

  test('shouldBlockForClarification quick check', () => {
    expect(shouldBlockForClarification('read', {})).toBe(false);
    expect(shouldBlockForClarification('write', {})).toBe(true);
    expect(shouldBlockForClarification('write', { path: '/foo', content: 'bar', filePath: '/baz' })).toBe(false);
  });
});
