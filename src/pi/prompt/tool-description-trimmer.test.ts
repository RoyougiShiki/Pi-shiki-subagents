import { describe, expect, test } from 'bun:test';
import { trimProviderToolDescriptions, trimToolDescriptions } from './tool-description-trimmer';

describe('tool description trimmer', () => {
  test('hides and truncates line-format available tools', () => {
    const prompt = [
      'Intro',
      'Available tools:',
      '  - read: short',
      '  - bash: very long description',
      '  - secret: hidden description',
      '',
      'Outro',
    ].join('\n');

    expect(trimToolDescriptions(prompt, {
      hide: ['secret'],
      truncate: { bash: 4 },
    })).toBe([
      'Intro',
      'Available tools:',
      '  - read: short',
      '  - bash: very...',
      '',
      'Outro',
    ].join('\n'));
  });

  test('hides and truncates JSON tool schema blocks', () => {
    const prompt = [
      'Available Tool Schemas',
      '{',
      '  "name": "visible",',
      '  "description": "abcdef"',
      '}',
      '',
      '{',
      '  "name": "hidden",',
      '  "description": "secret"',
      '}',
    ].join('\n');

    const trimmed = trimToolDescriptions(prompt, {
      hide: ['hidden'],
      truncate: { visible: 3 },
    });

    expect(trimmed).toContain('"description": "abc..."');
    expect(trimmed).not.toContain('hidden');
  });

  test('trims provider function and functionDeclarations descriptions', () => {
    const payload: Record<string, any> = {
      tools: [
        { function: { name: 'keep', description: 'abcdef' } },
        { function: { name: 'hide', description: 'hidden' } },
        { functionDeclarations: [
          { name: 'gemini', description: 'uvwxyz' },
          { name: 'hide', description: 'hidden' },
        ] },
      ],
    };

    trimProviderToolDescriptions(payload, new Set(['hide']), { keep: 2, gemini: 3 }, 0);

    expect(payload.tools).toHaveLength(2);
    expect(payload.tools[0].function.description).toBe('ab...');
    expect(payload.tools[1].functionDeclarations).toEqual([
      { name: 'gemini', description: 'uvw...' },
    ]);
  });
});
