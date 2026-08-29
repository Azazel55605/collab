import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInkDocument } from '../../../../src/lib/ink/document';
import { buildStroke } from '../../../../src/lib/ink/fixture';
import { addObject } from '../../../../src/lib/ink/operations';
import { INK_SCHEMA_VERSION } from '../../../../src/types/ink';
import { clearBackDismissStack, runTopBackDismiss } from '../lib/backStack';
import { serializeInk } from '../lib/ink';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import { useMobileStore } from '../state/store';

import { InkScreen } from './InkScreen';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverMock,
});

const SERVER = 'https://server.test';

const vault: HostedVault = {
  id: 'vault-1',
  name: 'Vault',
  role: 'editor',
  status: 'active',
  members: 1,
  storageBytes: 10,
  manifestSequence: 7,
  updatedAt: null,
  capabilities: ['vault.read', 'file.write'],
};

const file: HostedFileEntry = {
  id: 'ink-1',
  parentId: null,
  name: 'Ideas.ink',
  relativePath: 'Ideas.ink',
  kind: 'document',
  documentType: 'ink',
  state: 'active',
  updatedAt: null,
  sizeBytes: 200,
  contentHash: 'hash',
  revisionSequence: 3,
};

function drawingContent(strokes = 2): string {
  let document = createInkDocument({ name: 'Ideas', timestamp: '2026-07-30T00:00:00.000Z' });
  const pageId = document.pageOrder[0];
  const layerId = document.pages[pageId].scene.layerOrder[0];
  for (let index = 0; index < strokes; index += 1) {
    const page = document.pages[pageId];
    document = {
      ...document,
      pages: {
        ...document.pages,
        [pageId]: {
          ...page,
          scene: addObject(
            page.scene,
            buildStroke(`stroke-${index}`, layerId, {
              samples: 12,
              x: index * 2_000,
              y: 1_000,
              seed: index + 1,
            }),
          ).result,
        },
      },
    };
  }
  return serializeInk(document);
}

function selectVault(connected: boolean, role: HostedVault['role'] = 'editor') {
  useMobileStore.setState({
    selected: { serverUrl: SERVER, vault: { ...vault, role } },
    statuses: connected
      ? {
          [SERVER]: {
            connected: true,
            serverUrl: SERVER,
            allowInvalidCertificates: false,
            user: null,
            accessExpiresAt: null,
          },
        }
      : {},
    files: [file],
    activeSheet: { kind: 'drawing', fileId: file.id },
    replicas: {},
  } as never);
}

function mockServer(options: { revisions: string[]; queued?: unknown[]; content?: string }) {
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'hosted_vault_request') {
      const method = args?.method as string;
      if (method === 'GET') {
        return Promise.resolve({
          file: { ...file, currentRevision: { sequence: 3 } },
          content: options.content ?? drawingContent(),
        });
      }
      const body = args?.body as { content: string };
      options.revisions.push(body.content);
      return Promise.resolve({
        file: { ...file, currentRevision: { sequence: 4 } },
        content: body.content,
      });
    }
    if (command === 'replica_read_cached_document') {
      return Promise.resolve(options.content ?? drawingContent());
    }
    if (command === 'replica_cache_document') return Promise.resolve(null);
    if (command === 'replica_list_pending_operations') return Promise.resolve(options.queued ?? []);
    if (command === 'replica_enqueue_operation') return Promise.resolve({ id: 'op-1' });
    if (command === 'replica_remove_operation') return Promise.resolve(null);
    return Promise.reject(new Error(`unhandled ${command}`));
  });
}

/** Drags a pen across the surface, the way an S Pen would. */
function drawWithPen(host: HTMLElement, points: Array<[number, number]>) {
  host.setPointerCapture = vi.fn();
  host.hasPointerCapture = vi.fn(() => true);
  host.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(host, {
    pointerId: 1,
    pointerType: 'pen',
    clientX: points[0][0],
    clientY: points[0][1],
    pressure: 0.6,
    buttons: 1,
    isPrimary: true,
  });
  for (const [x, y] of points.slice(1)) {
    fireEvent.pointerMove(host, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: x,
      clientY: y,
      pressure: 0.6,
      buttons: 1,
    });
  }
  fireEvent.pointerUp(host, {
    pointerId: 1,
    pointerType: 'pen',
    clientX: points[points.length - 1][0],
    clientY: points[points.length - 1][1],
  });
}

async function openDrawing() {
  render(<InkScreen file={file} />);
  await screen.findByTestId('ink-touch-canvas');
  return screen.getByTestId('ink-touch-canvas');
}

beforeEach(() => {
  invoke.mockReset();
  clearBackDismissStack();
  globalThis.sessionStorage?.clear();
  selectVault(true);
  mockServer({ revisions: [] });

  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 700,
    width: 400,
    height: 700,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

describe('InkScreen', () => {
  it('opens a drawing and reports its page and stroke counts', async () => {
    await openDrawing();
    expect(screen.getByText(/Page 1 of 1/)).toBeTruthy();
    expect(screen.getByText(/2 strokes/)).toBeTruthy();
  });

  it('commits one stroke per pen gesture and saves it', async () => {
    const revisions: string[] = [];
    mockServer({ revisions });

    const host = await openDrawing();
    drawWithPen(host, [
      [60, 120],
      [110, 160],
      [170, 220],
      [230, 280],
    ]);

    await waitFor(() => expect(revisions.length).toBeGreaterThan(0), { timeout: 3_000 });
    const saved = JSON.parse(revisions[revisions.length - 1]);
    const scene = saved.pages[saved.pageOrder[0]].scene;
    expect(scene.objectOrder).toHaveLength(3);
  });

  it('does not reload the drawing when a save replaces the file entry', async () => {
    // Saving calls `replaceFile`, which makes `FilesScreen` hand this screen a
    // *fresh* `HostedFileEntry` for the same document. Keying the load on that
    // object identity reloaded everything after every save — the canvas
    // flashed back to a spinner mid-drawing. So the rerender below passes a
    // structurally equal but distinct entry, which is exactly what a save does.
    mockServer({ revisions: [] });
    const view = render(<InkScreen file={file} />);
    await screen.findByTestId('ink-touch-canvas');

    const reads = () =>
      invoke.mock.calls.filter(
        (call) =>
          call[0] === 'hosted_vault_request' && (call[1] as { method?: string })?.method === 'GET',
      ).length;
    const before = reads();

    view.rerender(<InkScreen file={{ ...file, revisionSequence: 4 }} />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reads()).toBe(before);
    // And the surface never fell back to the loading state.
    expect(screen.getByTestId('ink-touch-canvas')).toBeTruthy();
    expect(screen.getByText(/2 strokes/)).toBeTruthy();
  });

  it('does reload when a genuinely different drawing is opened', async () => {
    mockServer({ revisions: [] });
    const view = render(<InkScreen file={file} />);
    await screen.findByTestId('ink-touch-canvas');

    const reads = () =>
      invoke.mock.calls.filter(
        (call) =>
          call[0] === 'hosted_vault_request' && (call[1] as { method?: string })?.method === 'GET',
      ).length;
    const before = reads();

    view.rerender(<InkScreen file={{ ...file, id: 'ink-2', name: 'Other.ink' }} />);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('undoes a stroke', async () => {
    const host = await openDrawing();
    drawWithPen(host, [
      [60, 120],
      [130, 180],
      [200, 250],
    ]);
    await waitFor(() => expect(screen.getByText(/3 strokes/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Undo'));
    await waitFor(() => expect(screen.getByText(/2 strokes/)).toBeTruthy());
  });

  it('pans with one finger rather than drawing with it', async () => {
    // A finger is how you move the page; a pen is how you mark it.
    const host = await openDrawing();
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, {
      pointerId: 5,
      pointerType: 'touch',
      clientX: 200,
      clientY: 400,
      isPrimary: true,
    });
    fireEvent.pointerMove(host, { pointerId: 5, pointerType: 'touch', clientX: 140, clientY: 340 });
    fireEvent.pointerUp(host, { pointerId: 5, pointerType: 'touch' });

    // Asserted on the stroke count, which updates on commit, rather than on a
    // save the 600 ms debounce would not have started yet.
    await waitFor(() => expect(screen.getByText(/2 strokes/)).toBeTruthy());
    expect(screen.queryByText(/3 strokes/)).toBeNull();
  });

  it('draws with a finger once the setting is on', async () => {
    const revisions: string[] = [];
    mockServer({ revisions });
    const host = await openDrawing();

    // The pen is already selected, so tapping it again opens its settings.
    fireEvent.click(screen.getByLabelText('Pen options'));
    fireEvent.click(await screen.findByRole('checkbox'));

    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(host, {
      pointerId: 6,
      pointerType: 'touch',
      clientX: 60,
      clientY: 120,
      isPrimary: true,
    });
    fireEvent.pointerMove(host, { pointerId: 6, pointerType: 'touch', clientX: 140, clientY: 200 });
    fireEvent.pointerMove(host, { pointerId: 6, pointerType: 'touch', clientX: 210, clientY: 280 });
    fireEvent.pointerUp(host, { pointerId: 6, pointerType: 'touch' });

    await waitFor(() => expect(screen.getByText(/3 strokes/)).toBeTruthy());
    await waitFor(() => expect(revisions.length).toBeGreaterThan(0), { timeout: 3_000 });
  });

  it('rejects a palm that lands while the pen is drawing', async () => {
    // The hand resting on the screen must not pan the page out from under the
    // stroke being written.
    const host = await openDrawing();
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: 60,
      clientY: 120,
      pressure: 0.6,
      buttons: 1,
    });
    const before = screen.getByText(/%$/).textContent;

    fireEvent.pointerDown(host, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 600 });
    fireEvent.pointerMove(host, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 500 });

    expect(screen.getByText(/%$/).textContent).toBe(before);
  });

  it('pinches to zoom with two fingers', async () => {
    const host = await openDrawing();
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(host, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 150,
      clientY: 300,
      isPrimary: true,
    });
    fireEvent.pointerDown(host, { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 300 });
    fireEvent.pointerMove(host, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    fireEvent.pointerMove(host, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 300 });

    await waitFor(() => expect(screen.getByText(/200%|1[5-9]\d%/)).toBeTruthy());
  });

  it("opens a tool's settings when its already-selected button is tapped again", async () => {
    await openDrawing();
    // The pen starts selected, so one more tap is the shortcut into its
    // settings rather than a no-op.
    fireEvent.click(screen.getByLabelText('Pen options'));
    await screen.findByRole('dialog', { name: 'Pen options' });
  });

  it('marks the tools that keep settings behind that second tap', async () => {
    // The gesture has to be advertised on the control, not be folklore.
    await openDrawing();
    expect(screen.getByLabelText('Pen options').querySelector('.ink-tool-more')).toBeTruthy();
    expect(screen.getByLabelText('Eraser').querySelector('.ink-tool-more')).toBeTruthy();
    // Pan has no settings, so it carries no mark that promises some.
    expect(screen.getByLabelText('Pan').querySelector('.ink-tool-more')).toBeNull();
  });

  it('renames the tool button once selected, so the second tap is announced', async () => {
    await openDrawing();
    expect(screen.queryByLabelText('Pen')).toBeNull();
    expect(screen.getByLabelText('Pen options')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Eraser'));
    await waitFor(() => expect(screen.getByLabelText('Eraser options')).toBeTruthy());
    expect(screen.getByLabelText('Pen')).toBeTruthy();
  });

  it('reports the current brush inside the settings it opens', async () => {
    await openDrawing();
    fireEvent.click(screen.getByLabelText('Pen options'));

    const dialog = await screen.findByRole('dialog', { name: 'Pen options' });
    // The selected brush and width are marked, so the panel says what is
    // currently in use rather than only offering choices.
    expect(dialog.querySelector('[role="radio"][aria-checked="true"]')).toBeTruthy();
  });

  it("builds its controls from the app's shared classes", async () => {
    // The guide's rule: extend the existing pattern rather than growing a
    // local mini-design-system inside one screen.
    await openDrawing();

    expect(screen.getByLabelText('Pen options').className).toContain('icon-button');
    expect(screen.getByLabelText('Undo').className).toContain('icon-button');
    // Chips are used inside the settings sheet.
    fireEvent.click(screen.getByLabelText('Pen options'));
    const brushSheet = await screen.findByRole('dialog', { name: 'Pen options' });
    expect(brushSheet.querySelector('.chip')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));

    fireEvent.click(screen.getByLabelText('Layers and pages'));
    const dialog = await screen.findByRole('dialog');
    // The app's own bottom-sheet shell, not a bespoke panel.
    expect(dialog.className).toContain('sheet');
    expect(dialog.closest('.sheet-backdrop')).toBeTruthy();
  });

  it('marks the active tool for assistive technology and by style', async () => {
    await openDrawing();
    expect(screen.getByLabelText('Pen options').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Pen options').className).toContain('active');

    fireEvent.click(screen.getByLabelText('Eraser'));
    await waitFor(() =>
      expect(screen.getByLabelText('Eraser options').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByLabelText('Pen').className).not.toContain('active');
  });

  it('closes an open panel on back before leaving the drawing', async () => {
    await openDrawing();
    fireEvent.click(screen.getByLabelText('Layers and pages'));
    await screen.findByRole('dialog');

    expect(runTopBackDismiss()).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Nothing left registered, so the next back press reaches the store.
    expect(runTopBackDismiss()).toBe(false);
  });

  it('restores the page and viewport after the process is recreated', async () => {
    // Android destroys and recreates the activity on rotation and on memory
    // pressure; losing the viewport makes the drawing feel like it reset.
    const host = await openDrawing();
    host.setPointerCapture = vi.fn();
    host.hasPointerCapture = vi.fn(() => true);
    host.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(host, {
      pointerId: 9,
      pointerType: 'touch',
      clientX: 300,
      clientY: 500,
      isPrimary: true,
    });
    fireEvent.pointerMove(host, { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 400 });
    fireEvent.pointerUp(host, { pointerId: 9, pointerType: 'touch' });

    await waitFor(() =>
      expect(globalThis.sessionStorage.getItem('collab.ink.viewState')).toContain('ink-1'),
    );
    const stored = JSON.parse(globalThis.sessionStorage.getItem('collab.ink.viewState')!);
    expect(stored['ink-1'].originX).toBeGreaterThan(0);
  });

  it('queues the drawing offline when there is no connection', async () => {
    selectVault(false);
    const revisions: string[] = [];
    mockServer({ revisions });

    const host = await openDrawing();
    drawWithPen(host, [
      [60, 120],
      [130, 180],
      [200, 250],
    ]);

    await waitFor(() => expect(screen.getByText(/sync when you reconnect/i)).toBeTruthy(), {
      timeout: 3_000,
    });
    // Nothing reached the server; the edit is in the pending queue instead.
    expect(revisions).toHaveLength(0);
  });

  it('gives a viewer no drawing tools and never writes', async () => {
    selectVault(true, 'viewer');
    const revisions: string[] = [];
    mockServer({ revisions });

    const host = await openDrawing();
    expect((screen.getByLabelText('Pen options') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Eraser') as HTMLButtonElement).disabled).toBe(true);

    drawWithPen(host, [
      [60, 120],
      [200, 250],
    ]);
    // Same reasoning: the stroke count is immediate, a save is debounced.
    await waitFor(() => expect(screen.getByText(/2 strokes/)).toBeTruthy());
    expect(screen.queryByText(/3 strokes/)).toBeNull();
    expect(revisions).toHaveLength(0);
  });

  it('opens a newer-schema drawing read-only and says so', async () => {
    const newer = JSON.parse(drawingContent());
    newer.schemaVersion = INK_SCHEMA_VERSION + 1;
    mockServer({ revisions: [], content: JSON.stringify(newer) });

    await openDrawing();
    await screen.findByText(/newer version of Collab/i);
    expect((screen.getByLabelText('Pen options') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a drawing it cannot parse instead of a blank page', async () => {
    mockServer({ revisions: [], content: '{ not json' });
    render(<InkScreen file={file} />);
    // The error is surfaced rather than presenting a blank page the user could
    // then draw on and save over the top of their work.
    await screen.findByText(/JSON/i);
    expect(screen.queryByTestId('ink-touch-canvas')).toBeNull();
  });
});
