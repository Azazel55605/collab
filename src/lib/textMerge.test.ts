import { describe, expect, it } from 'vitest';

import { mergeText } from './textMerge';

describe('mergeText', () => {
  const base = 'line1\nline2\nline3\n';

  it('returns the other side when one side is unchanged from base', () => {
    const theirs = 'line1\nline2 changed\nline3\n';
    expect(mergeText(base, base, theirs)).toBe(theirs);
    expect(mergeText(base, theirs, base)).toBe(theirs);
  });

  it('returns the content when both sides made the identical edit', () => {
    const both = 'line1\nline2 same\nline3\n';
    expect(mergeText(base, both, both)).toBe(both);
  });

  it('merges non-overlapping edits on different lines', () => {
    const ours = 'line1 mine\nline2\nline3\n';
    const theirs = 'line1\nline2\nline3 theirs\n';
    expect(mergeText(base, ours, theirs)).toBe('line1 mine\nline2\nline3 theirs\n');
  });

  it('returns null when both sides edit the same line differently', () => {
    const ours = 'line1 A\nline2\nline3\n';
    const theirs = 'line1 B\nline2\nline3\n';
    expect(mergeText(base, ours, theirs)).toBeNull();
  });

  it('merges disjoint insertions', () => {
    const ours = 'line0\nline1\nline2\nline3\n';
    const theirs = 'line1\nline2\nline3\nline4\n';
    expect(mergeText(base, ours, theirs)).toBe('line0\nline1\nline2\nline3\nline4\n');
  });
  it.each([
    ['a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n', 'A\nB\nc\n'],
    ['a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n', null],
    ['a\nb\n', 'x\na\nb\n', 'y\na\nb\n', null],
    ['a\nb\nc\n', 'a\nX\nb\nc\n', 'a\nc\n', 'a\nX\nc\n'],
    ['a\nb\nc', 'A\nb\nc', 'a\nb\nc\n', 'A\nb\nc\n'],
    ['é\n重复\nend', 'É\n重复\nend', 'é\n重复\nEND', 'É\n重复\nEND'],
    ['a\nb\na\nb\n', 'A\nb\na\nb\n', 'a\nb\na\nB\n', 'A\nb\na\nB\n'],
    ['a\nb\nc\nd\n', 'A\nb\nc\nD\n', 'a\nB\nc\nd\n', 'A\nB\nc\nD\n'],
    ['', 'ours', 'theirs', null],
  ])('reconciles line edits without losing content (%#)', (original, local, remote, expected) => {
    expect(mergeText(original, local, remote)).toBe(expected);
    expect(mergeText(original, remote, local)).toBe(expected);
  });
});
