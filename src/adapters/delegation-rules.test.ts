import { describe, expect, test } from 'bun:test';
import {
  checkDelegationAllowed,
  parseAllowedSubagentsEnv,
} from './delegation-rules';

const rules = {
  main: ['search', 'fixer', 'oracle'],
  oracle: [],
  fixer: [],
  search: [],
};

describe('subagent delegation rules', () => {
  test('allows the main session to delegate to supported roles', () => {
    for (const target of rules.main) {
      expect(
        checkDelegationAllowed({ caller: 'main', target, rules }).allowed,
      ).toBe(true);
    }
  });

  test('blocks leaf delegation, unknown roles, and excessive nesting', () => {
    expect(
      checkDelegationAllowed({ caller: 'oracle', target: 'search', rules })
        .allowed,
    ).toBe(false);
    expect(
      checkDelegationAllowed({ caller: 'main', target: 'unknown', rules })
        .allowed,
    ).toBe(false);
    expect(
      checkDelegationAllowed({
        caller: 'main',
        target: 'search',
        depth: 2,
        rules,
      }).allowed,
    ).toBe(false);
  });

  test('allows a parent boundary to narrow its child delegates', () => {
    expect(
      checkDelegationAllowed({
        caller: 'main',
        target: 'oracle',
        allowedSubagents: ['oracle'],
        rules,
      }).allowed,
    ).toBe(true);
    expect(
      checkDelegationAllowed({
        caller: 'main',
        target: 'fixer',
        allowedSubagents: ['oracle'],
        rules,
      }).allowed,
    ).toBe(false);
  });

  test('parses inherited child-role limits', () => {
    expect(parseAllowedSubagentsEnv('oracle, fixer ,, search')).toEqual([
      'oracle',
      'fixer',
      'search',
    ]);
    expect(parseAllowedSubagentsEnv('')).toEqual([]);
    expect(parseAllowedSubagentsEnv(undefined)).toBeUndefined();
  });
});
