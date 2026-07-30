import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_MCPS, parseList } from './agent-mcps';

describe('agent MCP helpers', () => {
  test('does not assign implicit MCP access to the thin runtime', () => {
    expect(DEFAULT_AGENT_MCPS).toEqual({});
  });

  test('expands wildcards and exclusions against available MCPs', () => {
    expect(parseList(['*', '!mcp2'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp3',
    ]);
    expect(parseList(['mcp1', 'mcp3'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp3',
    ]);
    expect(parseList(['!*'], ['mcp1', 'mcp2'])).toEqual([]);
  });
});
