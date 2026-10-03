import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

interface Braces {
  (input: string, options?: { expand?: boolean }): string[];
  compile(input: string): string;
  expand(input: string): string[];
}

const require = createRequire(import.meta.url);
const braces = require('braces') as Braces;

describe('patched security dependencies', () => {
  it('rejects brace nesting before recursive walkers can exhaust the stack', () => {
    const input = `${'{'.repeat(101)}value${'}'.repeat(101)}`;

    expect(() => braces.compile(input)).toThrow(/exceeds max depth/);
    expect(() => braces.expand(input)).toThrow(/exceeds max depth/);
  });
});
