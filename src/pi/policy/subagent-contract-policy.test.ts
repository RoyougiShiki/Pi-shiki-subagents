import { describe, expect, test } from 'bun:test';
import { checkSubagentSpawnContract } from './subagent-contract-policy';

describe('SubagentContractPolicy', () => {
  test('allows non-spawn pool actions', () => {
    const result = checkSubagentSpawnContract({ pool: 'send', id: 'a1', task: '输出3条缺失信息' });
    expect(result.action).toBe('allow');
  });

  test('blocks objectless spawn task', () => {
    const result = checkSubagentSpawnContract({ pool: 'spawn', id: 'a1', agent: 'thinker', task: '输出3条缺失信息' });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('subagent_task_object_missing');
  });

  test('allows concrete spawn task', () => {
    const result = checkSubagentSpawnContract({
      pool: 'spawn',
      id: 'a1',
      agent: 'thinker',
      task: '针对“支付成功但库存未扣减”的问题，输出最多3条缺失信息；不要给解决方案。',
    });
    expect(result.action).toBe('allow');
  });
});
