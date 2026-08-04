import { describe, expect, it } from 'vitest';

import { truncateMiddle, truncatePathForDisplay } from './paths';

describe('path display truncation', () => {
  it('leaves a path that already fits untouched', () => {
    expect(truncatePathForDisplay('Docs/report.md', 44)).toBe('Docs/report.md');
  });

  it('keeps the file name whole and cuts the leading folders', () => {
    const path = 'Projects/2026/Quarter-3/Reports/Regional/Europe/summary.md';

    const result = truncatePathForDisplay(path, 40);

    expect(result.length).toBeLessThanOrEqual(40);
    // The name identifies the entry, so it survives in full...
    expect(result.endsWith('/summary.md')).toBe(true);
    // ...and the path still shows where it starts.
    expect(result.startsWith('Projects/')).toBe(true);
    expect(result).toContain('…');
  });

  it('shortens the name from the middle when the name alone is too long', () => {
    const name = 'a-very-long-generated-export-file-name-2026.md';

    const result = truncatePathForDisplay(`Docs/${name}`, 24);

    expect(result.length).toBeLessThanOrEqual(24);
    // Both the start and the extension stay readable.
    expect(result.startsWith('a-very')).toBe(true);
    expect(result.endsWith('.md')).toBe(true);
  });

  it('handles a bare file name with no folders', () => {
    expect(truncatePathForDisplay('short.md', 44)).toBe('short.md');
    const result = truncatePathForDisplay('x'.repeat(80), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain('…');
  });

  it('never returns more characters than the budget allows', () => {
    const paths = [
      'a/b/c.md',
      'one/two/three/four/five/six/seven/eight/nine/ten/eleven.md',
      'Attachments/Scans/2026-08-04-invoice-from-a-supplier-with-a-long-name.pdf',
      'no-folders-but-extremely-long-single-segment-name-that-overflows.canvas',
    ];
    for (const path of paths) {
      for (const budget of [12, 20, 32, 44]) {
        expect(truncatePathForDisplay(path, budget).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('truncates plain labels from the middle', () => {
    expect(truncateMiddle('abcdefghij', 20)).toBe('abcdefghij');
    const result = truncateMiddle('abcdefghijklmnop', 9);
    expect(result).toHaveLength(9);
    expect(result).toBe('abcd…mnop');
  });
});
