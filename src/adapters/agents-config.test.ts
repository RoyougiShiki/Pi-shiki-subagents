import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('agent prompt/frontmatter consistency', () => {
  test('all adapter agent markdown files only keep name/description frontmatter and no legacy sentinels', () => {
    const dir = path.join(import.meta.dir, 'agents');
    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort();

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(content).toMatch(/^---\n(?:.|\n)*?\n---/);
      expect(content).toMatch(/^name:\s*\S+/m);
      expect(content).toMatch(/^description:\s*\S+/m);
      expect(content).not.toMatch(/^tools:/m);
      expect(content).not.toMatch(/^thinking:/m);
      expect(content).not.toContain('<<MODE:');
      expect(content).not.toContain('<<PHASE:');
    }
  });
});
