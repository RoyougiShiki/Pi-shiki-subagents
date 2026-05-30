import { describe, expect, test } from 'bun:test';
import { assessRisk, checkApproval, requiresApproval } from './approval-policy';

describe('ApprovalPolicy', () => {
  test('read tools are low risk', () => {
    expect(assessRisk('read', { path: '/foo' })).toBe('low');
  });

  test('grep tools are low risk', () => {
    expect(assessRisk('grep', { pattern: 'foo' })).toBe('low');
  });

  test('write tool is medium risk (requires approval)', () => {
    expect(assessRisk('write', { path: '/foo', content: 'bar' })).toBe('medium');
  });

  test('edit tool is medium risk (requires approval)', () => {
    expect(assessRisk('edit', { path: '/foo', content: 'bar' })).toBe('medium');
  });

  test('bash with safe command is low risk', () => {
    expect(assessRisk('bash', { command: 'ls -la' })).toBe('low');
  });

  test('bash with dangerous command is critical', () => {
    expect(assessRisk('bash', { command: 'rm -rf /' })).toBe('critical');
    expect(assessRisk('bash', { command: 'sudo rm -rf /' })).toBe('critical');
  });

  test('bash with write operation is high risk', () => {
    expect(assessRisk('bash', { command: 'echo foo > bar.txt' })).toBe('high');
  });

  test('bash with install command is medium risk', () => {
    expect(assessRisk('bash', { command: 'npm install foo' })).toBe('medium');
  });

  test('write to /etc is critical', () => {
    expect(assessRisk('write', { path: '/etc/passwd', content: 'foo' })).toBe('critical');
  });

  test('write to config file is high', () => {
    expect(assessRisk('write', { path: '/home/user/config.json', content: '{}' })).toBe('high');
  });

  test('checkApproval returns allow for low risk', () => {
    const result = checkApproval('read', { path: '/foo' });
    expect(result.action).toBe('allow');
  });

  test('checkApproval returns allow for medium risk', () => {
    const result = checkApproval('write', { path: '/foo', content: 'bar' });
    expect(result.action).toBe('allow');
  });

  test('checkApproval returns require_approval for critical risk', () => {
    const result = checkApproval('bash', { command: 'rm -rf /' });
    expect(result.action).toBe('require_approval');
    if (result.action === 'require_approval') {
      expect(result.riskLevel).toBe('critical');
    }
  });

  test('requiresApproval quick check', () => {
    expect(requiresApproval('read', {})).toBe(false);
    expect(requiresApproval('write', { path: '/foo', content: 'bar' })).toBe(false);
    expect(requiresApproval('bash', { command: 'rm -rf /' })).toBe(true);
  });
});
