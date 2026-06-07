import { describe, expect, test } from 'bun:test';
import { parseJsonc, stripJsonComments } from './jsonc';

describe('jsonc parser', () => {
  test('preserves strings ending with escaped backslashes before comments', () => {
    const parsed = parseJsonc<{ path: string; next: boolean }>(`{
      "path": "C:\\\\", // trailing comment after escaped backslash
      "next": true,
    }`);

    expect(parsed).toEqual({ path: 'C:\\', next: true });
  });

  test('strips trailing commas outside strings only', () => {
    const cleaned = stripJsonComments(`{
      "literal": ",}",
      "items": ["a,]",],
    }`);

    expect(JSON.parse(cleaned)).toEqual({ literal: ',}', items: ['a,]'] });
  });
});
