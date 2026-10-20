import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../types/vault';

import { EMPTY_LINK_PREVIEW, resolveMarkdownLinkPreview } from './markdownLinkPreview';

const paths = [
  'report.md',
  'budget.sheet',
  'slides.deck',
  'drawing.ink',
  'board.canvas',
  'tasks.kanban',
  'circuit.logic',
  'spec.pdf',
  'photo.png',
  'a file #1.md',
  'unknown.zip',
  '100%.md',
  'literal%20.md',
];
const files = paths.map((name): NoteFile => ({
  relativePath: `Docs/${name}`,
  name,
  extension: name.split('.').pop()!,
  isFolder: false,
  modifiedAt: 0,
  size: 1,
}));

function resolve(href: string, options = { enabled: true, webEnabled: true }, wiki = false) {
  const link = document.createElement('span');
  link.className = wiki ? 'cm-lp-wikilink' : 'cm-lp-link';
  if (wiki) link.dataset.path = href;
  else link.dataset.url = href;
  return resolveMarkdownLinkPreview(link, 'Notes/start.md', files, options);
}

describe('Markdown link previews', () => {
  it.each(paths.slice(0, 7))('reuses document previews for %s', (path) => {
    expect(resolve(`../Docs/${path}`).file).toEqual({
      relativePath: `Docs/${path}`,
      type: 'document',
    });
    expect(resolve(`Docs/${path}`, undefined, true).file?.relativePath).toBe(`Docs/${path}`);
  });

  it('supports PDF and image links without embedding them in the note', () => {
    expect(resolve('../Docs/spec.pdf#page=2').file).toEqual({
      relativePath: 'Docs/spec.pdf',
      type: 'pdf',
    });
    expect(resolve('../Docs/photo.png').file).toEqual({
      relativePath: 'Docs/photo.png',
      type: 'image',
    });
  });

  it('resolves URL-encoded paths and encoded fragment characters as filenames', () => {
    expect(resolve('../Docs/a%20file%20%231.md#heading').file?.relativePath).toBe(
      'Docs/a file #1.md',
    );
  });

  it('keeps existing literal-percent filenames usable', () => {
    expect(resolve('../Docs/100%.md').file?.relativePath).toBe('Docs/100%.md');
    expect(resolve('../Docs/literal%20.md').file?.relativePath).toBe('Docs/literal%20.md');
    expect(resolve('../Docs/literal%2520.md').file?.relativePath).toBe('Docs/literal%20.md');
  });

  it('recognizes reading-view links and nested label elements', () => {
    const anchor = document.createElement('a');
    anchor.href = '../Docs/budget.sheet';
    const label = document.createElement('strong');
    anchor.append(label);
    const result = resolveMarkdownLinkPreview(label, 'Notes/start.md', files, {
      enabled: true,
      webEnabled: false,
    });
    expect(result.file?.relativePath).toBe('Docs/budget.sheet');
    expect(result.anchor).toBe(anchor);
  });

  it('keeps vault previews independent of the website-fetching switch', () => {
    expect(resolve('../Docs/report.md', { enabled: true, webEnabled: false }).file).toBeTruthy();
    expect(resolve('https://example.com', { enabled: true, webEnabled: false })).toBe(
      EMPTY_LINK_PREVIEW,
    );
    expect(resolve('https://example.com').url).toBe('https://example.com');
    expect(resolve('../Docs/report.md', { enabled: false, webEnabled: true })).toBe(
      EMPTY_LINK_PREVIEW,
    );
  });

  it.each([
    '../Docs/missing.md',
    '../Docs/unknown.zip',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://example.com/spec.pdf?token=private',
    '../Docs/%E0%A4%A',
  ])('does not read arbitrary local paths or treat an external URL as a vault file: %s', (href) => {
    expect(resolve(href).file).toBeNull();
  });
});
