// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

it('preserves every existing mono/math face and Unicode subset without duplicate legacy formats', async () => {
  const mono = await readFile(path.resolve('src/generated/mono-fonts.css'), 'utf8');
  const math = await readFile(path.resolve('src/generated/katex.css'), 'utf8');
  for (const family of ['fira-code', 'jetbrains-mono']) {
    const source = await readFile(
      path.resolve(`node_modules/@fontsource/${family}/index.css`),
      'utf8',
    );
    for (const match of source.matchAll(/files\/([^)]+\.woff2)/g)) expect(mono).toContain(match[1]);
    for (const match of source.matchAll(/unicode-range:([^;]+);/g)) {
      expect(mono.replace(/\s/g, '')).toContain(match[1].replace(/\s/g, ''));
    }
  }
  const katex = await readFile(path.resolve('node_modules/katex/dist/katex.min.css'), 'utf8');
  for (const match of katex.matchAll(/fonts\/([^)]+\.woff2)/g)) expect(math).toContain(match[1]);
  expect(mono + math).not.toMatch(/\.woff['")]|\.ttf['")]/);
  expect(mono).toContain("font-family: 'Pure Nerd Font'");
  expect(mono).toContain('font-display: swap');
});
