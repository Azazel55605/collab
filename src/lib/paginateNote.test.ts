import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_NOTE_PAGE_SETTINGS } from './notePageLayout';
import { paginateNote } from './paginateNote';

afterEach(() => vi.restoreAllMocks());

describe('rendered note pagination', () => {
  it('accepts an empty fractional-height Letter landscape body without generating blank pages', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('note-paper-body')
        ? Math.round(parseFloat(this.style.height))
        : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('note-paper-body')
        ? Math.max(this.clientHeight, this.textContent!.length)
        : 0;
    });
    const source = document.createElement('div');
    source.innerHTML = '<p>This must fit on one fractional-height page.</p>';
    const target = document.createElement('div');
    expect(
      paginateNote(source, target, {
        paper: 'letter',
        orientation: 'landscape',
        margins: 'normal',
      }),
    ).toBe(1);
    expect(target.querySelector('.note-paper-body')?.textContent).toBe(source.textContent);
  });
  it('preserves all text and inline markup while fragmenting oversized blocks', () => {
    // jsdom has no layout. A deterministic height model exercises fragmentation;
    // real line wrapping, tables and print geometry are checked in a browser.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('note-paper-body') ? this.textContent!.length * 10 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('note-paper-body') ? 970 : 0;
    });
    const source = document.createElement('div');
    source.innerHTML = `<div><div class="markdown-preview"><blockquote><p>${'Some words 👋 '.repeat(60)}<strong>the end</strong></p></blockquote></div></div>`;
    const target = document.createElement('div');
    document.body.append(source, target);
    const original = source.innerHTML;
    expect(paginateNote(source, target, DEFAULT_NOTE_PAGE_SETTINGS)).toBeGreaterThan(1);
    expect(
      Array.from(target.querySelectorAll('.note-paper-body'))
        .map((page) => page.textContent)
        .join(''),
    ).toBe(source.textContent);
    expect(target.querySelector('strong')?.textContent).toBe('the end');
    expect(source.innerHTML).toBe(original);
    expect(target.querySelectorAll('.note-paper').length).toBe(
      target.querySelectorAll('.note-paper-number').length,
    );
  });
  it('rebuilds pages without accumulating stale sheets or duplicate source IDs', () => {
    const source = document.createElement('div');
    source.innerHTML =
      '<div class="markdown-preview"><h1 id="title">Title</h1><p><a href="#title">Go back</a></p></div>';
    const target = document.createElement('div');
    paginateNote(source, target, DEFAULT_NOTE_PAGE_SETTINGS);
    paginateNote(source, target, DEFAULT_NOTE_PAGE_SETTINGS);
    expect(target.querySelectorAll('.note-paper')).toHaveLength(1);
    const id = target.querySelector('h1')!.id;
    expect(id).not.toBe('title');
    expect(target.querySelector('a')!.getAttribute('href')).toBe(`#${id}`);
  });
});
