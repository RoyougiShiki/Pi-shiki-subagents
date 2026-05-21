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
    const agentPath = path.join(root, '.pi', 'agents', 'custom-worker.md');
    fs.writeFileSync(agentPath, [
      '---',
      'name: custom-worker',
      'description: Worker Agent',
      '---',
      '',
      '# Body prompt',
    ].join('\n'));

    const { discoverAgents } = await import('./agent-discovery');
    const agents = discoverAgents(root);
    const worker = agents.find((a) => a.name === 'custom-worker');

    expect(worker?.description).toBe('Worker Agent');
    expect(worker?.systemPrompt).toContain('# Body prompt');
  });

  test('uses JSON/default tools instead of markdown frontmatter tools', async () => {
    const root = makeProject();
    const agentPath = path.join(root, '.pi', 'agents', 'custom-oracle.md');
    fs.writeFileSync(agentPath, [
      '---',
      'name: custom-oracle',
      'description: Oracle Agent',
      'tools: [write, edit]',
      '---',
      '',
      'Prompt',
    ].join('\n'));

    const { discoverAgents } = await import('./agent-discovery');
    const oracle = discoverAgents(root).find((a) => a.name === 'custom-oracle');

    expect(oracle?.tools).toBeUndefined();
  });

  test('uses runtime JSON model instead of markdown frontmatter model', async () => {
    const root = makeProject();
    const opencodeDir = path.join(root, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, 'oh-my-opencode-slim.json'), JSON.stringify({
      agents: {
        oracle: { model: 'runtime/oracle-model' },
      },
    }));
    fs.writeFileSync(path.join(root, '.pi', 'agents', 'oracle.md'), [
      '---',
      'name: oracle',
      'description: Oracle Agent',
      'model: markdown/ignored-model',
      '---',
      '',
      'Prompt',
    ].join('\n'));

    const { resolveAgent } = await import('./agent-discovery');
    const oracle = resolveAgent(root, 'oracle');

    expect(oracle?.model).toBe('runtime/oracle-model');
  });
});
