import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import { MarkdownLinkPreviews } from './MarkdownLinkPreviews';
import { useMarkdownLinkPreviews } from './useMarkdownLinkPreviews';

const mocks = vi.hoisted(() => ({
  document: vi.fn(),
  pdf: vi.fn(),
  asset: vi.fn(),
}));
vi.mock('../../lib/documentPreview', () => ({ getDocumentPreviewDataUrl: mocks.document }));
vi.mock('../../lib/pdfPreview', () => ({ getPdfPreviewDataUrl: mocks.pdf }));
vi.mock('../../lib/vaultClient', async (original) => ({
  ...(await original<typeof import('../../lib/vaultClient')>()),
  createVaultClient: () => ({ readAssetDataUrl: mocks.asset }),
}));

function Harness() {
  const { preview, move, clear } = useMarkdownLinkPreviews('Notes/start.md');
  return (
    <>
      <div onMouseMove={move} onMouseLeave={clear}>
        <a href="../Docs/budget.sheet">
          <strong>Budget</strong>
        </a>
        <a href="../Docs/spec.pdf">Spec</a>
        <a href="../Docs/photo.png">Photo</a>
      </div>
      <MarkdownLinkPreviews preview={preview} />
    </>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('Markdown shared file previews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ webPreviewsEnabled: false, hoverWebLinkPreviewsEnabled: true });
    useVaultStore.setState({
      vault: { id: 'test', path: '/vault', name: 'Test', isEncrypted: false, lastOpened: 0 },
      fileTree: ['budget.sheet', 'spec.pdf', 'photo.png'].map((name) => ({
        relativePath: `Docs/${name}`,
        name,
        extension: name.split('.').pop()!,
        isFolder: false,
        modifiedAt: 0,
        size: 1,
      })),
    });
    mocks.document.mockResolvedValue('data:image/svg+xml;base64,document');
    mocks.pdf.mockResolvedValue('data:image/png;base64,pdf');
    mocks.asset.mockResolvedValue('data:image/png;base64,image');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('waits before fetching and does not restart the delay as the mouse moves over a label', async () => {
    render(<Harness />);
    const label = screen.getByText('Budget');
    fireEvent.mouseMove(label);
    await advance(100);
    expect(mocks.document).not.toHaveBeenCalled();
    fireEvent.mouseMove(label);
    await advance(90);
    expect(mocks.document).toHaveBeenCalledOnce();
    expect(screen.getByRole('tooltip').getAttribute('data-preview-path')).toBe('Docs/budget.sheet');
    expect(screen.getByRole('tooltip').querySelector('img')?.getAttribute('src')).toContain(
      'document',
    );
  });

  it('cancels a short hover without reading files', async () => {
    render(<Harness />);
    fireEvent.mouseMove(screen.getByText('Budget'));
    await advance(80);
    fireEvent.mouseLeave(screen.getByText('Budget').closest('div')!);
    await advance(200);
    expect(mocks.document).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('uses existing PDF/image loaders and hides on scroll or when previews are disabled', async () => {
    render(<Harness />);
    fireEvent.mouseMove(screen.getByText('Spec'));
    await advance(200);
    expect(mocks.pdf).toHaveBeenCalledWith(expect.anything(), 'Docs/spec.pdf');
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseMove(screen.getByText('Photo'));
    await advance(200);
    expect(mocks.asset).toHaveBeenCalledWith('Docs/photo.png');
    act(() => useUiStore.setState({ hoverWebLinkPreviewsEnabled: false }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not publish a previous link’s result after hovering a new file', async () => {
    let finish!: (src: string) => void;
    mocks.document.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    fireEvent.mouseMove(screen.getByText('Budget'));
    await advance(200);
    fireEvent.mouseMove(screen.getByText('Photo'));
    await advance(200);
    await act(async () => finish('data:image/svg+xml;base64,stale'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.getAttribute('data-preview-path')).toBe('Docs/photo.png');
    expect(tooltip.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,image');
  });
});
