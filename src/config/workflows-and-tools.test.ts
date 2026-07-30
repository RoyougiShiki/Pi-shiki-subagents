import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PluginConfigSchema } from './schema';

describe('thin runtime configuration', () => {
  test('rejects removed workflow and mode configuration fields', () => {
    expect(() =>
      PluginConfigSchema.parse({ $schema: 'https://example.test/schema.json' }),
    ).not.toThrow();
    expect(() =>
      PluginConfigSchema.parse({ workflows: { list: [] } }),
    ).toThrow();
    expect(() =>
      PluginConfigSchema.parse({
        agents: { legacy: { type: 'mode' } },
      }),
    ).toThrow();
    expect(() =>
      PluginConfigSchema.parse({
        agents: { legacy: { pipelineMode: true } },
      }),
    ).toThrow();
  });

  test('accepts the main session and role-scoped subagents', () => {
    const parsed = PluginConfigSchema.parse({
      agents: {
        main: { type: 'main', delegates: ['search', 'fixer', 'oracle'] },
        customReviewer: {
          type: 'subagent',
          model: 'example/reviewer',
          prompt: 'Review the supplied change.',
          tools: ['read'],
        },
      },
    });

    expect(parsed.agents?.main?.type).toBe('main');
    expect(parsed.agents?.customReviewer?.type).toBe('subagent');
  });

  test('ships one broad main session and three role-scoped subagents', () => {
    const configPath = path.join(
      import.meta.dir,
      '..',
      'adapters',
      'agents-default.json',
    );
    const defs = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      {
        type?: string;
        tools?: string[];
        roles?: string[];
        delegates?: string[];
        presetPrimary?: boolean;
      }
    >;

    expect(defs.main).toMatchObject({
      type: 'main',
      tools: ['*'],
      delegates: ['search', 'fixer', 'oracle'],
      presetPrimary: true,
    });
    expect(
      Object.keys(defs).filter((name) => defs[name]?.type === 'main'),
    ).toEqual(['main']);
    expect(
      Object.keys(defs)
        .filter((name) => defs[name]?.type === 'subagent')
        .sort(),
    ).toEqual(['fixer', 'oracle', 'search']);
    expect(defs.fixer?.roles).toContain('写');
    expect(defs.search?.roles).toContain('读');
    expect(defs.oracle?.roles).toContain('读');
  });
});
