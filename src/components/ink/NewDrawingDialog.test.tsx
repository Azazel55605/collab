import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INK_PAGE_PRESETS } from '../../types/ink';
import { createInkDocument } from '../../lib/ink/document';
import NewDrawingDialog, { type NewDrawingChoice } from './NewDrawingDialog';

function open(onCreate: (choice: NewDrawingChoice) => void = vi.fn()) {
  render(<NewDrawingDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
}

afterEach(cleanup);

describe('NewDrawingDialog', () => {
  it('creates a blank fixed A4 page by default', () => {
    const onCreate = vi.fn();
    open(onCreate);
    fireEvent.click(screen.getByText('Create'));

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Untitled Drawing',
      mode: 'fixed',
      preset: 'a4',
      landscape: false,
      pattern: 'blank',
    });
  });

  it('carries the chosen paper, surface, and size through', () => {
    const onCreate = vi.fn();
    open(onCreate);

    fireEvent.change(screen.getByLabelText('Drawing name'), { target: { value: 'Lecture' } });
    fireEvent.click(screen.getByText('Ruled'));
    fireEvent.click(screen.getByText('Letter'));
    fireEvent.click(screen.getByText('Landscape'));
    fireEvent.click(screen.getByText('Create'));

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Lecture',
      mode: 'fixed',
      preset: 'letter',
      landscape: true,
      pattern: 'ruled',
    });
  });

  it('hides page sizes for an infinite canvas, which has none', () => {
    open();
    expect(screen.queryByLabelText('Page size')).toBeTruthy();
    fireEvent.click(screen.getByText('Infinite canvas'));
    expect(screen.queryByLabelText('Page size')).toBeNull();
  });

  it('submits on Enter from the name field', () => {
    const onCreate = vi.fn();
    open(onCreate);
    const input = screen.getByLabelText('Drawing name');
    fireEvent.change(input, { target: { value: 'Quick' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Quick' }));
  });

  it('reports the page dimensions and swaps them for landscape', () => {
    open();
    const portrait = `${Math.round(INK_PAGE_PRESETS.a4.width / 64)} x ${Math.round(
      INK_PAGE_PRESETS.a4.height / 64,
    )} pt`;
    expect(screen.getByText(portrait)).toBeTruthy();

    fireEvent.click(screen.getByText('Landscape'));
    const landscape = `${Math.round(INK_PAGE_PRESETS.a4.height / 64)} x ${Math.round(
      INK_PAGE_PRESETS.a4.width / 64,
    )} pt`;
    expect(screen.getByText(landscape)).toBeTruthy();
  });

  it('marks the current choice for assistive technology', () => {
    open();
    const paper = screen.getByRole('radio', { name: /Blank/ });
    expect(paper.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Graph'));
    expect(paper.getAttribute('aria-checked')).toBe('false');
  });
});

describe('the choices the dialog offers', () => {
  it('every paper and size it presents produces a document the schema accepts', () => {
    // The dialog is a set of literals; without this they can drift from the
    // schema and only fail when a user picks the one nobody tried.
    for (const pattern of ['blank', 'ruled', 'grid', 'dotted', 'staff', 'storyboard'] as const) {
      for (const preset of Object.keys(INK_PAGE_PRESETS) as Array<keyof typeof INK_PAGE_PRESETS>) {
        for (const mode of ['fixed', 'infinite'] as const) {
          const document = createInkDocument({
            name: 'Probe',
            mode,
            preset,
            background: { pattern },
            timestamp: '2026-01-01T00:00:00.000Z',
          });
          const page = document.pages[document.pageOrder[0]];
          expect(page.background.pattern).toBe(pattern);
          expect(page.mode).toBe(mode);
          expect(page.width).toBeGreaterThan(0);
          expect(page.height).toBeGreaterThan(0);
        }
      }
    }
  });
});
