import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkDelegationAllowed, parseAllowedSubagentsEnv } from './delegation-rules';

const rules = {
  worker: ['fixer', 'oracle'],
  implementer: ['fixer', 'oracle'],
  analyst: ['oracle'],
  oracle: [],
};

describe('pi delegation rules', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('allows configured stage agents to call leaf agents', () => {
    expect(checkDelegationAllowed({ caller: 'worker', target: 'fixer', depth: 1, rules }).allowed).toBe(true);
    expect(checkDelegationAllowed({ caller: 'implementer', target: 'oracle', depth: 1, rules }).allowed).toBe(true);
    expect(checkDelegationAllowed({ caller: 'analyst', target: 'oracle', depth: 1, rules }).allowed).toBe(true);
  });

  test('blocks leaf agents from spawning more subagents', () => {
    const result = checkDelegationAllowed({ caller: 'oracle', target: 'explorer', depth: 1, rules });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual([]);
  });

  test('blocks delegation beyond max depth', () => {
    const result = checkDelegationAllowed({ caller: 'worker', target: 'fixer', depth: 2, rules });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('max 2');
  });

  test('blocks unconfigured target for a configured caller', () => {
    const result = checkDelegationAllowed({ caller: 'worker', target: 'explorer', depth: 1, rules });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual(['fixer', 'oracle']);
  });

  test('stage allowedSubagents narrows configured delegates', () => {
    expect(checkDelegationAllowed({
      caller: 'worker',
      target: 'oracle',
      depth: 1,
      rules,
      allowedSubagents: ['oracle'],
    }).allowed).toBe(true);

    const result = checkDelegationAllowed({
      caller: 'worker',
      target: 'fixer',
      depth: 1,
      rules,
      allowedSubagents: ['oracle'],
    });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual(['oracle']);
  });

  test('stage allowedSubagents cannot expand configured delegates', () => {
    const result = checkDelegationAllowed({
      caller: 'worker',
      target: 'explorer',
      depth: 1,
      rules,
      allowedSubagents: ['oracle', 'explorer'],
    });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual(['oracle']);
  });

  test('empty stage allowedSubagents blocks all delegates', () => {
    const result = checkDelegationAllowed({
      caller: 'worker',
      target: 'oracle',
      depth: 1,
      rules,
      allowedSubagents: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.allowedAgents).toEqual([]);
  });

  test('blocks unknown caller by default', () => {
    const result = checkDelegationAllowed({ caller: 'custom', target: 'fixer', depth: 1, rules });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no delegation rule');
  });

  test('parses OMO_ALLOWED_SUBAGENTS env values', () => {
    expect(parseAllowedSubagentsEnv('oracle, fixer ,, explorer')).toEqual(['oracle', 'fixer', 'explorer']);
    expect(parseAllowedSubagentsEnv('')).toEqual([]);
    expect(parseAllowedSubagentsEnv(' , ')).toEqual([]);
    expect(parseAllowedSubagentsEnv(undefined)).toBeUndefined();
  });

  test('loads delegation rules from runtime config using the provided cwd', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-delegation-cwd-'));
    try {
      const projectDir = path.join(tempDir, 'project');
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
      delete process.env.OPENCODE_CONFIG_DIR;
      fs.writeFileSync(path.join(projectConfigDir, 'oh-my-opencode-slim.json'), JSON.stringify({
        agents: {
          worker: { delegates: ['oracle'] },
        },
      }));

      expect(checkDelegationAllowed({ caller: 'worker', target: 'oracle', depth: 1, cwd: projectDir }).allowed).toBe(true);
      expect(checkDelegationAllowed({ caller: 'worker', target: 'fixer', depth: 1, cwd: projectDir }).allowed).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
