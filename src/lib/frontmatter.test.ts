import { describe, expect, it } from 'vitest';

import { getFrontmatterField, removeFrontmatterField, setFrontmatterField } from './frontmatter';

describe('frontmatter field helpers', () => {
  it('adds and updates frontmatter fields', () => {
    const withoutFrontmatter = 'Hello note';
    expect(setFrontmatterField(withoutFrontmatter, 'reviewStatus', 'draft'))
      .toBe('---\nreviewStatus: draft\n---\nHello note');

    const withFrontmatter = '---\ntitle: Note\n---\nHello note';
    expect(setFrontmatterField(withFrontmatter, 'reviewStatus', 'draft'))
      .toBe('---\ntitle: Note\nreviewStatus: draft\n---\nHello note');

    const updated = setFrontmatterField('---\nreviewStatus: draft\n---\nHello', 'reviewStatus', 'published');
    expect(getFrontmatterField(updated, 'reviewStatus')).toBe('published');
  });

  it('removes frontmatter fields and collapses empty frontmatter blocks', () => {
    expect(removeFrontmatterField('---\nreviewStatus: draft\n---\nHello', 'reviewStatus')).toBe('Hello');
    expect(removeFrontmatterField('---\ntitle: Note\nreviewStatus: draft\n---\nHello', 'reviewStatus'))
      .toBe('---\ntitle: Note\n---\nHello');
  });
});
