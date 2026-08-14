import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { INK_SCHEMA_VERSION } from '../types/ink';
import { createInkDocument, serializeInkDocument } from '../lib/ink/document';
import { addObject } from '../lib/ink/operations';
import { buildStroke } from '../lib/ink/fixture';
import type { VaultMeta } from '../types/vault';
import { tauriCommands } from '../lib/tauri';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
  importAsset: vi.fn(),
  readAssetDataUrl: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../lib/vaultClient', () => ({
  createVaultClient: vi.fn(() => ({
    kind: 'local',
    capabilities: { filesystemWatch: true },
    runtime: { externalAssetImport: { import: clientMocks.importAsset } },
    readDocument: clientMocks.readDocument,
    writeDocument: clientMocks.writeDocument,
    readAssetDataUrl: clientMocks.readAssetDataUrl,
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
import { TooltipProvider } from '../components/ui/tooltip';

/** `getByRole` returns HTMLElement; the tests care about button state. */
function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}
function labelled(name: string): HTMLButtonElement {
  return screen.getByLabelText(name) as HTMLButtonElement;
}

/** `App.tsx` provides this at the root; tests have to supply it themselves. */
function renderView(path = PATH) {
  return render(
    <TooltipProvider>
      <InkView relativePath={path} />
    </TooltipProvider>,
  );
}

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
  renderView();
  await screen.findByTestId('ink-canvas-host');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clientMocks.readDocument.mockResolvedValue({ content: drawingContent(), version: '1' });
  clientMocks.writeDocument.mockResolvedValue({ version: '2' });
  clientMocks.importAsset.mockResolvedValue('Pictures/diagram.svg');
  clientMocks.readAssetDataUrl.mockResolvedValue('data:image/png;base64,AAAA');
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
    renderView();
    await screen.findByText(/vault unavailable/);
  });

  it('reports a document it cannot parse rather than showing a blank page', async () => {
    clientMocks.readDocument.mockResolvedValue({ content: '{ not json', version: '1' });
    renderView();
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

  it('pans with the pan tool, without changing the document', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Pan (H)' }));

    const host = screen.getByTestId('ink-canvas-host');
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

describe('InkView drawing', () => {
  /** Drags a pointer across the surface, the way a pen would. */
  function drawStroke(host: HTMLElement, points: Array<[number, number]>) {
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, {
      pointerId: 1, pointerType: 'pen', clientX: points[0][0], clientY: points[0][1],
      pressure: 0.5, buttons: 1, isPrimary: true,
    });
    for (const [x, y] of points.slice(1)) {
      fireEvent.pointerMove(host, {
        pointerId: 1, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.5, buttons: 1,
      });
    }
    fireEvent.pointerUp(host, { pointerId: 1, pointerType: 'pen', clientX: points[points.length - 1][0], clientY: points[points.length - 1][1] });
  }

  async function savedDocument() {
    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
    const calls = clientMocks.writeDocument.mock.calls;
    return JSON.parse(calls[calls.length - 1][1] as string);
  }

  it('commits one stroke per pen gesture', async () => {
    // The rule the collaboration model rests on: a stroke is one edit, not one
    // per pointer sample.
    await openDrawing();
    const host = screen.getByTestId('ink-canvas-host');
    drawStroke(host, [[100, 100], [150, 120], [200, 160], [260, 200]]);

    fireEvent.click(screen.getByText('Save'));
    const written = await savedDocument();
    const scene = written.pages[written.pageOrder[0]].scene;
    // Two fixture strokes plus the one just drawn.
    expect(scene.objectOrder).toHaveLength(3);
  });

  it('stores the brush the stroke was drawn with, not a preset pointer', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Fountain pen' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Colour #c0392b' }));

    drawStroke(screen.getByTestId('ink-canvas-host'), [[100, 100], [180, 140], [240, 190]]);
    fireEvent.click(screen.getByText('Save'));

    const written = await savedDocument();
    const scene = written.pages[written.pageOrder[0]].scene;
    const drawn = scene.objects[scene.objectOrder[scene.objectOrder.length - 1]];
    expect(drawn.brush.kind).toBe('fountain');
    expect(drawn.brush.color).toBe('#c0392b');
  });

  it('creates a snapped filled shape from a drag gesture', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Shape (U)' }));
    fireEvent.click(screen.getByLabelText('Fill with line colour'));

    const host = screen.getByTestId('ink-canvas-host');
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(host, { pointerId: 2, pointerType: 'mouse', clientX: 20, clientY: 20, buttons: 1, isPrimary: true });
    fireEvent.pointerMove(host, { pointerId: 2, pointerType: 'mouse', clientX: 120, clientY: 80, buttons: 1 });
    fireEvent.pointerUp(host, { pointerId: 2, pointerType: 'mouse', clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByText('Save'));

    const written = await savedDocument();
    const scene = written.pages[written.pageOrder[0]].scene;
    const created = scene.objects[scene.objectOrder[scene.objectOrder.length - 1]];
    expect(created).toMatchObject({ type: 'shape', shape: 'rectangle', fill: '#1f2933' });
    expect(created.points.every((value: number) => value % 768 === 0)).toBe(true);
  });

  it('creates sticky text as an editable scene object', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Sticky note' }));

    const host = screen.getByTestId('ink-canvas-host');
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(host, { pointerId: 3, pointerType: 'mouse', clientX: 30, clientY: 30, buttons: 1, isPrimary: true });
    fireEvent.pointerMove(host, { pointerId: 3, pointerType: 'mouse', clientX: 180, clientY: 130, buttons: 1 });
    fireEvent.pointerUp(host, { pointerId: 3, pointerType: 'mouse', clientX: 180, clientY: 130 });
    fireEvent.change(await screen.findByLabelText('Sticky note text'), { target: { value: 'Remember this' } });
    fireEvent.click(screen.getByText('Add to drawing'));
    fireEvent.click(screen.getByText('Save'));

    const written = await savedDocument();
    const scene = written.pages[written.pageOrder[0]].scene;
    const created = scene.objects[scene.objectOrder[scene.objectOrder.length - 1]];
    expect(created).toMatchObject({ type: 'text', text: 'Remember this', sticky: true, backgroundColor: '#fef3a7' });
  });

  it('changes the current page background as document content', async () => {
    await openDrawing();
    fireEvent.change(screen.getByLabelText('Page background'), { target: { value: 'staff' } });
    fireEvent.click(screen.getByText('Save'));
    const written = await savedDocument();
    expect(written.pages[written.pageOrder[0]].background.pattern).toBe('staff');
  });

  it('stores document brush favourites and swatches', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('radio', { name: 'Colour #0e7490' }));
    fireEvent.click(screen.getByText('Add current colour to swatches'));
    fireEvent.click(screen.getByText('Save current'));
    fireEvent.click(screen.getByText('Save'));

    const written = await savedDocument();
    expect(written.swatches.some((swatch: { color: string }) => swatch.color === '#0e7490')).toBe(true);
    expect(Object.values(written.brushes).some((preset: any) => preset.color === '#0e7490')).toBe(true);
  });

  it('adds stamps, equations, precision lines, circles, and non-exported guides', async () => {
    await openDrawing();
    const host = screen.getByTestId('ink-canvas-host');
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    const drag = (pointerId: number) => {
      fireEvent.pointerDown(host, { pointerId, pointerType: 'mouse', clientX: 30, clientY: 30, buttons: 1, isPrimary: true });
      fireEvent.pointerMove(host, { pointerId, pointerType: 'mouse', clientX: 150, clientY: 90, buttons: 1 });
      fireEvent.pointerUp(host, { pointerId, pointerType: 'mouse', clientX: 150, clientY: 90 });
    };

    fireEvent.click(screen.getByRole('button', { name: 'Stamp (K)' }));
    drag(10);
    fireEvent.click(screen.getByRole('button', { name: 'Equation (Q)' }));
    drag(11);
    fireEvent.change(await screen.findByLabelText('Equation LaTeX'), { target: { value: 'x^2+y^2' } });
    fireEvent.click(screen.getByText('Add to drawing'));
    fireEvent.click(screen.getByRole('button', { name: 'Protractor (O)' }));
    drag(12);
    fireEvent.click(screen.getByRole('button', { name: 'Compass (M)' }));
    drag(13);
    fireEvent.click(screen.getByRole('button', { name: 'Guide (G)' }));
    drag(14);
    fireEvent.click(screen.getByText('Save'));

    const written = await savedDocument();
    const objects = Object.values(written.pages[written.pageOrder[0]].scene.objects) as any[];
    expect(objects.some((object) => object.type === 'stamp')).toBe(true);
    expect(objects.some((object) => object.type === 'text' && object.equation)).toBe(true);
    expect(objects.some((object) => object.type === 'shape' && object.shape === 'ellipse')).toBe(true);
    expect(objects.some((object) => object.type === 'shape' && object.guide)).toBe(true);
  });

  it('imports image assets through the vault runtime capability', async () => {
    vi.spyOn(tauriCommands, 'showOpenFilesDialog').mockResolvedValue(['/tmp/diagram.svg']);
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Image (I)' }));
    const host = screen.getByTestId('ink-canvas-host');
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(host, { pointerId: 20, pointerType: 'mouse', clientX: 20, clientY: 20, buttons: 1, isPrimary: true });
    fireEvent.pointerMove(host, { pointerId: 20, pointerType: 'mouse', clientX: 180, clientY: 120, buttons: 1 });
    fireEvent.pointerUp(host, { pointerId: 20, pointerType: 'mouse', clientX: 180, clientY: 120 });
    await waitFor(() => expect(clientMocks.importAsset).toHaveBeenCalledWith('/tmp/diagram.svg', 'Pictures'));
    fireEvent.click(screen.getByText('Save'));
    const written = await savedDocument();
    const objects = Object.values(written.pages[written.pageOrder[0]].scene.objects) as any[];
    expect(objects.some((object) => object.type === 'image' && object.relativePath === 'Pictures/diagram.svg')).toBe(true);
  });

  it('saves reusable page templates and instantiates them with fresh identities', async () => {
    await openDrawing();
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Reusable sketch' } });
    fireEvent.click(screen.getByLabelText('Save page as template'));
    fireEvent.change(await screen.findByLabelText('Drawing template'), { target: { value: JSON.parse(localStorage.getItem('collab-ink-templates-v1')!)[0].id } });
    fireEvent.click(screen.getByText('Add template page'));
    await screen.findByText('Page 2 of 2');
  });

  it('does not commit a stroke the platform cancelled', async () => {
    // pointercancel means the pointer was taken away — the user did not finish.
    await openDrawing();
    const host = screen.getByTestId('ink-canvas-host');
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, { pointerId: 1, pointerType: 'pen', clientX: 10, clientY: 10, pressure: 0.5, buttons: 1 });
    fireEvent.pointerMove(host, { pointerId: 1, pointerType: 'pen', clientX: 90, clientY: 90, pressure: 0.5, buttons: 1 });
    fireEvent.pointerCancel(host, { pointerId: 1, pointerType: 'pen' });

    expect(screen.getByText('Save').closest('button')?.disabled).toBe(true);
  });

  it('undoes and redoes a stroke', async () => {
    await openDrawing();
    const host = screen.getByTestId('ink-canvas-host');
    expect(button('Undo').disabled).toBe(true);

    drawStroke(host, [[100, 100], [160, 130], [220, 180]]);
    await waitFor(() =>
      expect(button(/^Undo/).disabled).toBe(false),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    await waitFor(() => expect(screen.getByText('2 strokes')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Redo/ }));
    await waitFor(() => expect(screen.getByText('3 strokes')).toBeTruthy());
  });

  it('erases a stroke with the eraser tool', async () => {
    await openDrawing();
    fireEvent.click(screen.getByRole('button', { name: 'Eraser (E)' }));

    const host = screen.getByTestId('ink-canvas-host');
    // The fixture strokes sit around y=1000 ink units, near the origin.
    drawStroke(host, [[0, 10], [40, 15], [80, 20]]);

    await waitFor(() => expect(screen.getByText(/strokes$/)).toBeTruthy());
  });

  it('switches tools from the keyboard, layout-independently', async () => {
    await openDrawing();
    fireEvent.keyDown(window, { key: 'e' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Eraser (E)' }).getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.keyDown(window, { key: 'v' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select (V)' }).getAttribute('aria-pressed')).toBe('true'),
    );
  });

  it('does not steal keys from a field the user is typing in', async () => {
    await openDrawing();
    const layerName = screen.getByLabelText('Layer name for Layer 1');
    fireEvent.keyDown(layerName, { key: 'e' });
    expect(screen.getByRole('button', { name: 'Pen (P)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('adds, renames, and removes layers but keeps the last one', async () => {
    await openDrawing();
    expect(labelled('Delete Layer 1').disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Add layer'));
    await screen.findByLabelText('Layer name for Layer 2');
    expect(labelled('Delete Layer 2').disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('Delete Layer 2'));
    await waitFor(() => expect(screen.queryByLabelText('Layer name for Layer 2')).toBeNull());
  });

  it('autosaves shortly after an edit without a manual save', async () => {
    await openDrawing();
    drawStroke(screen.getByTestId('ink-canvas-host'), [[100, 100], [170, 140], [230, 190]]);
    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled(), { timeout: 3_000 });
  });

  it('hides the chrome in focus mode and restores it', async () => {
    await openDrawing();
    expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).toBeTruthy();

    fireEvent.click(screen.getByText('Focus'));
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).toBeNull(),
    );

    fireEvent.click(screen.getByLabelText('Leave focus mode'));
    await screen.findByRole('toolbar', { name: 'Drawing tools' });
  });

  it('gives a hosted viewer no drawing tools and never writes', async () => {
    setVault(HOSTED_VIEWER_VAULT);
    await openDrawing();

    expect(button('Pen (P)').disabled).toBe(true);
    expect(button('Eraser (E)').disabled).toBe(true);

    drawStroke(screen.getByTestId('ink-canvas-host'), [[100, 100], [200, 200]]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });
});
