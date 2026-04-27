import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Command } from '../ui/command';
import { CommandBarModeContent, CommandBarModeHints } from './CommandBarModeContent';
import type { RenderCtx } from './commandBarActions';

const writeText = vi.fn();

function makeCtx(overrides: Partial<RenderCtx> = {}): RenderCtx {
  return {
    notes: [],
    files: [],
    searchResults: [],
    activeView: 'editor',
    vault: { id: 'vault', name: 'Vault', path: '/vault', lastOpened: 0, isEncrypted: false },
    dateFormat: 'YYYY_MM_DD',
    openTab: vi.fn(),
    setActiveView: vi.fn(),
    openSettings: vi.fn(),
    refreshFileTree: vi.fn(async () => {}),
    setInput: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe('CommandBarModeContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('renders recent files in search mode with no query', () => {
    render(
      <Command>
        <CommandBarModeContent
          mode={{ type: 'search', query: '' }}
          ctx={makeCtx({
            files: [
              { name: 'Old.md', relativePath: 'Old.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
              { name: 'New.md', relativePath: 'New.md', extension: 'md', modifiedAt: 2, size: 1, isFolder: false },
            ],
          })}
        />
      </Command>
    );

    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getAllByText('New.md').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Old.md').length).toBeGreaterThan(0);
  });

  it('opens matching settings from search mode', () => {
    const openSettings = vi.fn();
    const close = vi.fn();

    render(
      <Command>
        <CommandBarModeContent
          mode={{ type: 'search', query: 'theme' }}
          ctx={makeCtx({ openSettings, close })}
        />
      </Command>
    );

    fireEvent.click(screen.getByText('Appearance'));

    expect(openSettings).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('copies the computed math result', () => {
    render(
      <Command>
        <CommandBarModeContent
          mode={{ type: 'math', expr: '2 + 2' }}
          ctx={makeCtx()}
        />
      </Command>
    );

    fireEvent.click(screen.getByText('2 + 2 = 4'));

    expect(writeText).toHaveBeenCalledWith('4');
  });

  it('shows the editor-only insert guard outside the editor view', () => {
    render(
      <Command>
        <CommandBarModeContent
          mode={{ type: 'insert', query: '' }}
          ctx={makeCtx({ activeView: 'canvas' })}
        />
      </Command>
    );

    expect(screen.getByText('Open a note first to insert snippets.')).toBeTruthy();
  });
});

describe('CommandBarModeHints', () => {
  it('highlights the active mode hint', () => {
    render(<CommandBarModeHints current="action" />);

    const hint = screen.getByText('> Action');
    expect(hint.className).toContain('bg-primary/20');
    expect(screen.getByText('Search').className).toContain('bg-muted/60');
  });
});
