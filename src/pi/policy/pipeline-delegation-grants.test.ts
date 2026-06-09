import { describe, expect, test, beforeEach } from 'bun:test';
import {
  consumePipelineDelegationGrant,
  issuePipelineDelegationGrant,
  resetPipelineDelegationGrantsForTests,
} from './pipeline-delegation-grants';

describe('pipeline delegation grants', () => {
  beforeEach(() => {
    resetPipelineDelegationGrantsForTests();
  });

  test('consumes a matching grant exactly once', () => {
    issuePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0, childAllowedSubagents: ['search'] });

    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })?.childAllowedSubagents).toEqual(['search']);
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })).toBeUndefined();
  });

  test('does not consume when caller target or depth mismatches', () => {
    issuePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 });

    expect(consumePipelineDelegationGrant({ caller: 'other', target: 'analyst', depth: 0 })).toBeUndefined();
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'dispatcher', depth: 0 })).toBeUndefined();
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 1 })).toBeUndefined();
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })).toBeTruthy();
  });

  test('does not issue grants without a concrete caller', () => {
    expect(issuePipelineDelegationGrant({ caller: undefined, target: 'analyst', depth: 0 })).toBeUndefined();
    expect(issuePipelineDelegationGrant({ caller: '   ', target: 'analyst', depth: 0 })).toBeUndefined();

    expect(consumePipelineDelegationGrant({ caller: undefined, target: 'analyst', depth: 0 })).toBeUndefined();
    expect(consumePipelineDelegationGrant({ caller: '   ', target: 'analyst', depth: 0 })).toBeUndefined();
  });

  test('prunes expired grants before consuming', async () => {
    issuePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0, ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })).toBeUndefined();
  });

  test('consumes only one matching grant when duplicates exist', () => {
    issuePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0, childAllowedSubagents: ['search'] });
    issuePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0, childAllowedSubagents: ['observer'] });

    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })?.childAllowedSubagents).toEqual(['search']);
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })?.childAllowedSubagents).toEqual(['observer']);
    expect(consumePipelineDelegationGrant({ caller: 'standard-dev', target: 'analyst', depth: 0 })).toBeUndefined();
  });
});
