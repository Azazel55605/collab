import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { INK_SCHEMA_VERSION } from '../types/ink';
import { createInkDocument, serializeInkDocument } from '../lib/ink/document';
import { addObject } from '../lib/ink/operations';
import { buildStroke } from '../lib/ink/fixture';
import type { VaultMeta } from '../types/vault';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../lib/vaultClient', () => ({
  createVaultClient: vi.fn(() => ({
    kind: 'local',
    capabilities: { filesystemWatch: true },
    readDocument: clientMocks.readDocument,
    writeDocument: clientMocks.writeDocument,
  })),
}));

vi.mock('../lib/vaultReplica', () => ({
  onReplicaMutated: vi.fn(() => () => {}),
  replicaMutationAffectsPath: vi.fn(() => false),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMocks }));

import InkView from './InkView';

const LOCAL_VAULT: VaultMeta = {
  id: 'vault-1',
  path: '/vault',
  name: 'Vault',
  isEncrypted: false,
  lastOpened: 0,
};

const HOSTED_VIEWER_VAULT: VaultMeta = {
  id: 'vault-2',
  path: 'hosted://vault-2',
  name: 'Hosted',
  isEncrypted: false,
  lastOpened: 0,
  kind: 'hosted',
  serverUrl: 'https://example.test',
  hostedVaultId: 'vault-2',
  role: 'viewer',
};

const PATH = 'Sketches/Ideas.ink';

function drawingContent(options: { strokes?: number; pages?: number } = {}) {
  let document = createInkDocument({ name: 'Ideas', timestamp: '2026-01-01T00:00:00.000Z' });
  const pageId = document.pageOrder[0];
  const layerId = document.pages[pageId].scene.layerOrder[0];

  for (let index = 0; index < (options.strokes ?? 2); index += 1) {
    const stroke = buildStroke(`stroke-${index}`, layerId, {
      samples: 12,
      x: index * 2_000,
      y: 1_000,
      seed: index + 1,
    });
    const page = document.pages[pageId];
    document = {
      ...document,
      pages: { ...document.pages, [pageId]: { ...page, scene: addObject(page.scene, stroke).result } },
    };
  }
  return serializeInkDocument(document);
}

function setVault(vault: VaultMeta) {
  useVaultStore.setState({ vault, fileTree: [] } as never);
}

async function openDrawing() {
  render(<InkView relativePath={PATH} />);
  await screen.findByTestId('ink-canvas-host');
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.readDocument.mockResolvedValue({ content: drawingContent(), version: '1' });
  clientMocks.writeDocument.mockResolvedValue({ version: '2' });
  setVault(LOCAL_VAULT);
  useEditorStore.setState({
    openTabs: [{ relativePath: PATH, title: 'Ideas', isDirty: false, savedHash: null, type: 'ink' }],
    activeTabPath: PATH,
    inkViewStates: {},
  } as never);

  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;

  // jsdom does not implement ResizeObserver, which the canvas host uses to
  // learn its own size.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

afterEach(cleanup);

describe('InkView', () => {
  it('opens a drawing and reports its page and stroke counts', async () => {
    await openDrawing();
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    expect(screen.getByText('2 strokes')).toBeTruthy();
  });

  it('surfaces a read failure instead of rendering an empty surface', async () => {
    clientMocks.readDocument.mockRejectedValue(new Error('vault unavailable'));
    render(<InkView relativePath={PATH} />);
    await screen.findByText(/vault unavailable/);
  });

  it('reports a document it cannot parse rather than showing a blank page', async () => {
    clientMocks.readDocument.mockResolvedValue({ content: '{ not json', version: '1' });
    render(<InkView relativePath={PATH} />);
    await screen.findByText(/could not be opened/i);
  });

  it('adds a page, marks the tab dirty, and saves the new page', async () => {
    await openDrawing();
    fireEvent.click(screen.getByText('Add page'));

    await screen.findByText('Page 2 of 2');
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
    const written = JSON.parse(clientMocks.writeDocument.mock.calls[0][1] as string);
    expect(written.pageOrder).toHaveLength(2);
  });

  it('deletes a page but never the last one', async () => {
    await openDrawing();
    // A drawing with one page cannot lose it: a document with no pages has
    // nowhere to draw, and the normalizer would invent one on reload.
    expect(screen.getByText('Delete page').closest('button')?.disabled).toBe(true);

    fireEvent.click(screen.getByText('Add page'));
    await screen.findByText('Page 2 of 2');
    expect(screen.getByText('Delete page').closest('button')?.disabled).toBe(false);

    fireEvent.click(screen.getByText('Delete page'));
    await screen.findByText('Page 1 of 1');
  });

  it('never writes for a hosted viewer', async () => {
    setVault(HOSTED_VIEWER_VAULT);
    await openDrawing();

    expect(screen.getByText('Add page').closest('button')?.disabled).toBe(true);
    expect(screen.getByText('Save').closest('button')?.disabled).toBe(true);
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('opens a newer-schema drawing read-only and says so', async () => {
    // Rewriting it would silently strip whatever the newer build stored.
    const newer = JSON.parse(drawingContent());
    newer.schemaVersion = INK_SCHEMA_VERSION + 1;
    clientMocks.readDocument.mockResolvedValue({
      content: JSON.stringify(newer),
      version: '1',
    });

    await openDrawing();
    await screen.findByText(/written by a newer version/i);
    expect(screen.getByText('Add page').closest('button')?.disabled).toBe(true);
  });

  it('surfaces repairs applied while opening rather than hiding them', async () => {
    const damaged = JSON.parse(drawingContent());
    const pageId = damaged.pageOrder[0];
    damaged.pages[pageId].scene.objects['stroke-0'].layerId = 'deleted-layer';
    clientMocks.readDocument.mockResolvedValue({
      content: JSON.stringify(damaged),
      version: '1',
    });

    await openDrawing();
    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalled());
  });

  it('remembers the page and viewport per tab, without touching the document', async () => {
    await openDrawing();
    fireEvent.click(screen.getByText('Add page'));
    await screen.findByText('Page 2 of 2');

    await waitFor(() => {
      const state = useEditorStore.getState().inkViewStates[PATH];
      expect(state?.pageId).toBeTruthy();
    });

    // View state is device-local: it must never reach the saved document.
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
    const written = clientMocks.writeDocument.mock.calls[0][1] as string;
    expect(written).not.toContain('originX');
    expect(written).not.toContain('zoom');
  });

  it('zooms with the toolbar and reports the level', async () => {
    await openDrawing();
    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await screen.findByText('150%');
    fireEvent.click(screen.getByLabelText('Zoom out'));
    await screen.findByText('100%');
  });

  it('pans without changing the document', async () => {
    await openDrawing();
    const host = screen.getByTestId('ink-canvas-host');
    // jsdom has no pointer capture.
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 40, clientY: 60 });
    fireEvent.pointerUp(host, { pointerId: 1 });

    await waitFor(() => {
      const state = useEditorStore.getState().inkViewStates[PATH];
      expect(state?.originX).toBeGreaterThan(0);
    });
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });
});
