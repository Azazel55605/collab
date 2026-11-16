import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeInkExportMetadata, makeInkExportSource } from '../../lib/ink/export';
import { buildLogicDiagramSvgDataUrl } from '../../lib/logicDiagramExport';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import { MarkdownPreview } from './MarkdownPreview';

const vaultClientMocks = vi.hoisted(() => ({
  readAssetDataUrl: vi.fn(),
}));

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({
    svg: '<svg viewBox="0 0 320 120"><text>Foreground or background sync</text></svg>',
  })),
}));

vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({
    readAssetDataUrl: vaultClientMocks.readAssetDataUrl,
  }),
}));

describe('MarkdownPreview', () => {
  beforeEach(() => {
    Object.assign(globalThis, { mermaid: mermaidMocks });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'mermaid');
    cleanup();
    vi.clearAllMocks();
  });

  it('renders content-derived render errors as literal text without injected elements', () => {
    const message = '<img src=x onerror="window.injected=true"><script>bad()</script>';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(MarkdownIt.prototype, 'render').mockImplementationOnce(() => {
      throw new Error(message);
    });
    const { container } = render(<MarkdownPreview content="broken fixture" />);
    expect(container.querySelector('pre')?.textContent).toContain(message);
    expect(container.querySelector('img, script, [onerror]')).toBeNull();
  });

  it('resolves wiki embeds and Markdown and HTML images after parsing, while leaving code and links intact', async () => {
    useVaultStore.setState({
      vault: {
        id: 'image-vault',
        name: 'Vault',
        path: '/vault',
        isEncrypted: false,
        lastOpened: 0,
      },
      fileTree: [],
    });
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    vaultClientMocks.readAssetDataUrl.mockResolvedValue(svg);
    const { container } = render(
      <MarkdownPreview
        currentDocumentRelativePath="Note.md"
        content={[
          '![[Pictures/Diagram.svg|Wiki diagram]]',
          '![Markdown diagram](<Pictures/Diagram with spaces.svg>)',
          '[Reference image]: Pictures/Diagram.svg',
          '![Reference diagram][Reference image]',
          '<img src="Pictures/Diagram.svg" alt="HTML diagram" />',
          String.raw`![Image]\(Semester 2/Digitaltechnik/clock.png) ![diagramm]\(Semester 2/Digitaltechnik/diagramm.png)`,
          '![Bare vault path](Pictures/Another diagram.svg)',
          '`![Example]\\(Pictures/Example image.png)`',
          '[[Pictures/Diagram.svg|Plain link]]',
          '`![[Pictures/Ignored.svg]]`',
        ].join('\n\n')}
      />,
    );
    for (const name of [
      'Wiki diagram',
      'Markdown diagram',
      'Reference diagram',
      'HTML diagram',
      'Image',
      'diagramm',
      'Bare vault path',
    ]) {
      const image = await screen.findByRole('img', { name });
      await waitFor(() => expect(image.getAttribute('src')).toBe(svg));
    }
    expect(vaultClientMocks.readAssetDataUrl).toHaveBeenCalledWith(
      'Pictures/Diagram with spaces.svg',
    );
    expect(vaultClientMocks.readAssetDataUrl).toHaveBeenCalledWith(
      'Semester 2/Digitaltechnik/clock.png',
    );
    expect(vaultClientMocks.readAssetDataUrl).toHaveBeenCalledWith(
      'Semester 2/Digitaltechnik/diagramm.png',
    );
    expect(vaultClientMocks.readAssetDataUrl).not.toHaveBeenCalledWith(
      'Pictures/Example image.png',
    );
    expect(vaultClientMocks.readAssetDataUrl).not.toHaveBeenCalledWith('Pictures/Ignored.svg');
    expect(screen.getByText('![[Pictures/Ignored.svg]]').tagName).toBe('CODE');
    expect(container.querySelector('.wikilink')?.textContent).toBe('Plain link');
  });

  it('renders display math plot directives as preview widgets', async () => {
    useUiStore.setState({
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });

    const { container } = render(
      <MarkdownPreview
        content={'$$\n%plot2d x=-10..10, samples=60\ny=\\sin(x)\n$$\n\nAfter the plot'}
        preserveBlankLines
      />,
    );

    expect(await screen.findByText('2D plot')).toBeTruthy();
    expect(screen.getByText('y = \\sin(x)')).toBeTruthy();
    expect(screen.getByText('After the plot')).toBeTruthy();
    expect(container.querySelector('.note-print-blank-line')).toBeNull();
  });

  it('preserves extra blank lines between print blocks without changing Markdown structure', () => {
    const content = [
      'First paragraph',
      '',
      'Second paragraph',
      '',
      '  ',
      '# Heading',
      '',
      '',
      '',
      '- List item',
      '',
      '',
      '```',
      'code before',
      '',
      '',
      'code after',
      '```',
    ].join('\n');
    const { container, rerender } = render(<MarkdownPreview content={content} />);
    expect(container.querySelector('.note-print-blank-line')).toBeNull();

    rerender(<MarkdownPreview content={content} preserveBlankLines />);
    const blocks = Array.from(container.querySelectorAll('.markdown-preview > div > *'));
    expect(blocks.map((block) => block.localName)).toEqual([
      'p',
      'p',
      'div',
      'h1',
      'div',
      'div',
      'ul',
      'div',
      'pre',
    ]);
    expect(container.querySelectorAll('.note-print-blank-line')).toHaveLength(4);
    expect(container.querySelector('ul')?.children).toHaveLength(1);
    expect(container.querySelector('pre')?.textContent).toBe('code before\n\n\ncode after\n');
  });

  it('renders Mermaid code fences and waits for the diagram', async () => {
    const onReady = vi.fn();
    render(
      <MarkdownPreview
        content={
          '```mermaid\nflowchart LR\nS["Foreground or background sync"] --> P["Snapshot"]\n```'
        }
        onReady={onReady}
      />,
    );

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeTruthy();
    expect(screen.getByText('Foreground or background sync')).toBeTruthy();
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('opens exported logic diagram images at their editable source when metadata is available', async () => {
    useUiStore.setState({
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });
    useVaultStore.setState({
      vault: {
        id: 'v1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
      fileTree: [
        {
          name: 'Notes',
          relativePath: 'Notes',
          isFolder: true,
          children: [
            { name: 'a.md', relativePath: 'Notes/a.md', isFolder: false, extension: 'md' },
          ],
        },
        {
          name: 'Diagrams',
          relativePath: 'Diagrams',
          isFolder: true,
          children: [
            {
              name: 'adder.logic',
              relativePath: 'Diagrams/adder.logic',
              isFolder: false,
              extension: 'logic',
            },
          ],
        },
        {
          name: 'Pictures',
          relativePath: 'Pictures',
          isFolder: true,
          children: [
            {
              name: 'adder.svg',
              relativePath: 'Pictures/adder.svg',
              isFolder: false,
              extension: 'svg',
            },
          ],
        },
      ],
    } as never);
    vaultClientMocks.readAssetDataUrl.mockResolvedValue(
      buildLogicDiagramSvgDataUrl(
        {
          schemaVersion: 1,
          kind: 'logic-diagram',
          diagramMode: 'logic',
          title: 'Adder',
          nodes: [],
          wires: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        'Diagrams/adder.logic',
      ),
    );
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');

    render(
      <MarkdownPreview
        content="![Adder](../Pictures/adder.svg)"
        currentDocumentRelativePath="Notes/a.md"
      />,
    );

    const image = await screen.findByRole('img');
    await waitFor(() =>
      expect(vaultClientMocks.readAssetDataUrl).toHaveBeenCalledWith('Pictures/adder.svg'),
    );
    fireEvent.click(image);

    expect(openTab).toHaveBeenCalledWith('Diagrams/adder.logic', 'adder', 'logic');
  });

  it('falls back to the image asset when exported logic source is missing', async () => {
    useUiStore.setState({
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });
    useVaultStore.setState({
      vault: {
        id: 'v1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
      fileTree: [
        {
          name: 'Notes',
          relativePath: 'Notes',
          isFolder: true,
          children: [
            { name: 'a.md', relativePath: 'Notes/a.md', isFolder: false, extension: 'md' },
          ],
        },
        {
          name: 'Pictures',
          relativePath: 'Pictures',
          isFolder: true,
          children: [
            {
              name: 'adder.svg',
              relativePath: 'Pictures/adder.svg',
              isFolder: false,
              extension: 'svg',
            },
          ],
        },
      ],
    } as never);
    vaultClientMocks.readAssetDataUrl.mockResolvedValue(
      buildLogicDiagramSvgDataUrl(
        {
          schemaVersion: 1,
          kind: 'logic-diagram',
          diagramMode: 'logic',
          title: 'Adder',
          nodes: [],
          wires: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        'Diagrams/missing.logic',
      ),
    );
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');

    render(
      <MarkdownPreview
        content="![Adder](../Pictures/adder.svg)"
        currentDocumentRelativePath="Notes/a.md"
      />,
    );

    const image = await screen.findByRole('img');
    await waitFor(() =>
      expect(vaultClientMocks.readAssetDataUrl).toHaveBeenCalledWith('Pictures/adder.svg'),
    );
    fireEvent.click(image);

    expect(openTab).toHaveBeenCalledWith('Pictures/adder.svg', 'adder', 'image');
  });

  it('reopens an exported ink page at its source region', async () => {
    useUiStore.setState({
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });
    useVaultStore.setState({
      vault: {
        id: 'v1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
      fileTree: [
        {
          name: 'Sketches',
          relativePath: 'Sketches',
          isFolder: true,
          children: [
            {
              name: 'ideas.ink',
              relativePath: 'Sketches/ideas.ink',
              isFolder: false,
              extension: 'ink',
            },
          ],
        },
        {
          name: 'Pictures',
          relativePath: 'Pictures',
          isFolder: true,
          children: [
            {
              name: 'ideas.svg',
              relativePath: 'Pictures/ideas.svg',
              isFolder: false,
              extension: 'svg',
            },
          ],
        },
      ],
    } as never);
    const source = makeInkExportSource('Sketches/ideas.ink', 'page-2', {
      minX: 120,
      minY: 240,
      maxX: 1_200,
      maxY: 1_400,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="collab-ink-export">${encodeInkExportMetadata(source)}</metadata></svg>`;
    vaultClientMocks.readAssetDataUrl.mockResolvedValue(`data:image/svg+xml;base64,${btoa(svg)}`);
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');

    render(
      <MarkdownPreview
        content="![Ideas](../Pictures/ideas.svg)"
        currentDocumentRelativePath="Notes/a.md"
      />,
    );

    const image = await screen.findByRole('img');
    await waitFor(() => expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml/));
    fireEvent.click(image);

    expect(openTab).toHaveBeenCalledWith('Sketches/ideas.ink', 'ideas', 'ink');
    expect(useEditorStore.getState().inkViewStates['Sketches/ideas.ink']).toEqual({
      pageId: 'page-2',
      originX: 120,
      originY: 240,
      zoom: 1,
    });
  });
});
