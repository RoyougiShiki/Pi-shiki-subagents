import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-agent-discovery-'));
  fs.mkdirSync(path.join(root, '.pi', 'agents'), { recursive: true });
  return root;
}

describe('agent discovery', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('reads name/description from markdown frontmatter and body as prompt', async () => {
    const root = makeProject();
    const agentPath = path.join(root, '.pi', 'agents', 'custom-agent.md');
    fs.writeFileSync(
      agentPath,
      [
        '---',
        'name: custom-agent',
        'description: Custom Agent',
        '---',
        '',
        '# Body prompt',
      ].join('\n'),
    );

    const { discoverAgents } = await import('./agent-discovery');
    const agents = discoverAgents(root);
    const agent = agents.find((a) => a.name === 'custom-agent');

    expect(agent?.description).toBe('Custom Agent');
    expect(agent?.systemPrompt).toContain('# Body prompt');
  });

  test('uses JSON/default tools instead of markdown frontmatter tools', async () => {
    const root = makeProject();
    const agentPath = path.join(root, '.pi', 'agents', 'custom-oracle.md');
    fs.writeFileSync(
      agentPath,
      [
        '---',
        'name: custom-oracle',
        'description: Oracle Agent',
        'tools: [write, edit]',
        '---',
        '',
        'Prompt',
      ].join('\n'),
    );

    const { discoverAgents } = await import('./agent-discovery');
    const oracle = discoverAgents(root).find((a) => a.name === 'custom-oracle');

    expect(oracle?.tools).toBeUndefined();
  });

  test('uses runtime JSON model instead of markdown frontmatter model', async () => {
    const root = makeProject();
    const opencodeDir = path.join(root, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          oracle: { model: 'runtime/oracle-model' },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.pi', 'agents', 'oracle.md'),
      [
        '---',
        'name: oracle',
        'description: Oracle Agent',
        'model: markdown/ignored-model',
        '---',
        '',
        'Prompt',
      ].join('\n'),
    );

    const { resolveAgent } = await import('./agent-discovery');
    const oracle = resolveAgent(root, 'oracle');

    expect(oracle?.model).toBe('runtime/oracle-model');
  });

  test('discovers custom runtime agents with inline prompt content', async () => {
    const root = makeProject();
    const opencodeDir = path.join(root, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          janitor: {
            type: 'subagent',
            label: 'Janitor',
            model: 'runtime/janitor-model',
            prompt: 'Audit dead code and docs drift.',
          },
        },
      }),
    );

    const { resolveAgent } = await import('./agent-discovery');
    const janitor = resolveAgent(root, 'janitor');

    expect(janitor?.description).toBe('Janitor');
    expect(janitor?.model).toBe('runtime/janitor-model');
    expect(janitor?.systemPrompt).toBe('Audit dead code and docs drift.');
  });

  test('does not discover stale managed runtime agents without prompt content', async () => {
    const root = makeProject();
    const opencodeDir = path.join(root, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          worker: {
            type: 'subagent',
            delegates: ['fixer', 'oracle'],
            model: 'runtime/old-worker-model',
          },
        },
      }),
    );

    const { resolveAgent } = await import('./agent-discovery');

    expect(resolveAgent(root, 'worker')).toBeUndefined();
  });

  test('does not discover hidden agents from markdown or inline runtime prompts', async () => {
    const root = makeProject();
    const agentPath = path.join(root, '.pi', 'agents', 'hidden-worker.md');
    fs.writeFileSync(
      agentPath,
      [
        '---',
        'name: hidden-worker',
        'description: Hidden Worker',
        '---',
        '',
        'Hidden markdown prompt.',
      ].join('\n'),
    );
    const opencodeDir = path.join(root, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: {
          'hidden-worker': {
            type: 'subagent',
            hidden: true,
          },
          'hidden-inline': {
            type: 'subagent',
            model: 'runtime/hidden-inline-model',
            prompt: 'Hidden inline prompt.',
            hidden: true,
          },
        },
      }),
    );

    const { resolveAgent } = await import('./agent-discovery');

    expect(resolveAgent(root, 'hidden-worker')).toBeUndefined();
    expect(resolveAgent(root, 'hidden-inline')).toBeUndefined();
  });
});
