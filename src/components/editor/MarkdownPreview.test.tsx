import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('renders display math plot directives as preview widgets', async () => {
    useUiStore.setState({
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });

    render(<MarkdownPreview content={'$$\n%plot2d x=-10..10, samples=60\ny=\\sin(x)\n$$'} />);

    expect(await screen.findByText('2D plot')).toBeTruthy();
    expect(screen.getByText('y = \\sin(x)')).toBeTruthy();
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
});
