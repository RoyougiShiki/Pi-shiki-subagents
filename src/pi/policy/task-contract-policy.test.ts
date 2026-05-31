import { describe, expect, test } from 'bun:test';
import { checkTaskContract } from './task-contract-policy';

describe('TaskContractPolicy', () => {
  test('allows read without task contract', () => {
    const result = checkTaskContract({ kind: 'read' });
    expect(result.action).toBe('allow');
  });

  test('allows safe bash without task contract', () => {
    const result = checkTaskContract({ kind: 'bash_safe' });
    expect(result.action).toBe('allow');
  });

  test('blocks write without minimal contract', () => {
    const result = checkTaskContract({ kind: 'write', goal: 'update config' });
    expect(result.action).toBe('block');
    expect(result.missing).toContain('nextStep');
    expect(result.missing).toContain('stopConditions');
  });

  test('allows write with minimal contract', () => {
    const result = checkTaskContract({
      kind: 'write',
      goal: 'update config',
      nextStep: 'edit the known config file',
      stopConditions: ['config path missing', 'tests fail'],
    });
    expect(result.action).toBe('allow');
  });

  test('blocks risky bash without stop conditions', () => {
    const result = checkTaskContract({
      kind: 'bash_risky',
      goal: 'install dependency',
      nextStep: 'run install command',
    });
    expect(result.action).toBe('block');
    expect(result.missing).toContain('stopConditions');
  });

  test('blocks subagent spawn with missing task', () => {
    const result = checkTaskContract({ kind: 'subagent_spawn' });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('subagent_task_missing');
  });

  test('blocks objectless subagent task', () => {
    const result = checkTaskContract({ kind: 'subagent_spawn', subagentTask: '输出3条缺失信息' });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('subagent_task_object_missing');
  });

  test('allows concrete subagent task with object and output', () => {
    const result = checkTaskContract({
      kind: 'subagent_spawn',
      subagentTask: '针对“支付成功但库存未扣减”的问题，输出最多3条缺失信息；不要给解决方案。',
    });
    expect(result.action).toBe('allow');
  });

  test('warns when subagent task has object but unclear output', () => {
    const result = checkTaskContract({
      kind: 'subagent_spawn',
      subagentTask: '调查支付成功但库存未扣减的问题',
    });
    expect(result.action).toBe('warn');
    expect(result.reason).toBe('subagent_task_output_unclear');
  });
});
