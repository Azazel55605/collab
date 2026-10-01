import * as React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { TooltipProvider } from '../components/ui/tooltip';
import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../lib/deck/fixture';
import { readDeck, reconcileDeck, writeDeck } from '../lib/deck/liveDeckDocument';
import type { LiveDeckSession } from '../lib/deck/liveDeckSession';
import { serializeDeck } from '../lib/deck/validate';
import { createEmptySheetDocument, serializeSheetDocument } from '../lib/sheet/document';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import type { DeckDocument } from '../types/deck';
import type { VaultMeta } from '../types/vault';

import DeckView from './DeckView';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
  readAssetDataUrl: vi.fn(),
  importData: vi.fn(),
  listFiles: vi.fn(),
  deletePermanently: vi.fn(),
  live: false,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../lib/vaultClient', () => ({
  createVaultClient: vi.fn(() => ({
    kind: 'local',
    capabilities: { filesystemWatch: true, nativeFilesystem: false },
    runtime: { externalAssetImport: { importData: clientMocks.importData } },
    readDocument: clientMocks.readDocument,
    writeDocument: clientMocks.writeDocument,
    readAssetDataUrl: clientMocks.readAssetDataUrl,
    listFiles: clientMocks.listFiles,
    deletePermanently: clientMocks.deletePermanently,
    ...(clientMocks.live
      ? { resolveLiveSession: async () => ({ serverUrl: 'x', vaultId: 'v', fileId: 'f' }) }
      : {}),
  })),
}));

// A live room on a real Y.Doc with the real deck codec; "the peer" is a second
// Y.Doc kept in sync by hand, as the server relay would.
const liveMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));
vi.mock('../lib/deck/liveDeckSession', () => ({ openLiveDeckSession: liveMocks.open }));

// jsdom never decodes images; report a size instead.
vi.mock('../lib/deck/images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/deck/images')>();
  return {
    ...actual,
    describeImage: (path: string, dataUrl: string) =>
      actual.describeImage(path, dataUrl, async () => ({ width: 400, height: 200 })),
  };
});

vi.mock('../lib/vaultReplica', () => ({
  onReplicaMutated: vi.fn(() => () => {}),
  replicaMutationAffectsPath: vi.fn(() => false),
}));

const tauriMocks = vi.hoisted(() => ({
  showExportDialog: vi.fn(),
  writeDownloadedFile: vi.fn(),
}));
vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>();
  return {
    ...actual,
    tauriCommands: {
      ...actual.tauriCommands,
      showExportDialog: tauriMocks.showExportDialog,
      writeDownloadedFile: tauriMocks.writeDownloadedFile,
    },
  };
});

// jsdom has no OffscreenCanvas; any bytes stand in for a page image.
vi.mock('../lib/deck/exportPdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/deck/exportPdf')>();
  return {
    ...actual,
    canvasRasterizer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  };
});

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMocks }));

// Radix menus open on pointer sequences jsdom does not model; render inline.
vi.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: React.ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div role="radiogroup" data-value={value}>
      {React.Children.map(children, (child) =>
        React.isValidElement<{ value: string }>(child)
          ? React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
              onSelectValue: onValueChange,
            })
          : child,
      )}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    value,
    onSelectValue,
  }: {
    children: React.ReactNode;
    value: string;
    onSelectValue?: (value: string) => void;
  }) => (
    <button type="button" role="menuitemradio" onClick={() => onSelectValue?.(value)}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuShortcut: () => null,
}));

vi.mock('../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuShortcut: () => null,
  ContextMenuSub: () => null,
  ContextMenuSubContent: () => null,
  ContextMenuSubTrigger: () => null,
}));

const PATH = 'Talks/Fixture.deck';
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

/** Stage size the jsdom stubs report, and the fit zoom it produces. */
const STAGE = { width: 1_000, height: 600 };
const FIT = Math.min((STAGE.width - 96) / 1_280, (STAGE.height - 96) / 720);
/** Deck units → client pixels (jsdom lays the slide out at the client origin). */
const client = (units: number) => (units / 75) * FIT;

function serve(content: string | DeckDocument) {
  clientMocks.readDocument.mockResolvedValue({
    content: typeof content === 'string' ? content : serializeDeck(content),
    version: '1',
  });
}

function renderView() {
  return render(
    <TooltipProvider>
      <DeckView relativePath={PATH} />
    </TooltipProvider>,
  );
}

async function openDeck() {
  renderView();
  await screen.findByText('Slide 1 of 5');
}

const canvas = () => screen.getByLabelText('Slide canvas');
const stage = () => screen.getByTestId('deck-stage');
const menuItem = (name: string) => screen.getAllByRole('menuitem', { name })[0];

function key(target: Element, keyName: string, options: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(target, { key: keyName, ...options });
}

/** Saves and returns the deck as written. */
async function savedDeck(): Promise<DeckDocument> {
  clientMocks.writeDocument.mockClear();
  key(canvas(), 's', { ctrlKey: true });
  await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
  const calls = clientMocks.writeDocument.mock.calls;
  return JSON.parse(calls[calls.length - 1][1] as string) as DeckDocument;
}

async function showSlide(index: number) {
  fireEvent.pointerDown(screen.getAllByRole('option')[index], { button: 0 });
  await screen.findByText(`Slide ${index + 1} of 5`);
}

const sizeDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  serve(buildFixtureDeck());
  let version = 1;
  clientMocks.writeDocument.mockImplementation(async () => ({ version: String((version += 1)) }));
  clientMocks.readAssetDataUrl.mockResolvedValue(PIXEL);
  useVaultStore.setState({ vault: LOCAL_VAULT, fileTree: [] } as never);
  useEditorStore.setState({
    openTabs: [
      { relativePath: PATH, title: 'Fixture', isDirty: false, savedHash: null, type: 'deck' },
    ],
    activeTabPath: PATH,
    deckViewStates: {},
  } as never);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => STAGE.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => STAGE.height,
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(sizeDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

describe('DeckView: viewing', () => {
  it('opens a deck with a slide rail, section headings, and the slide on the stage', async () => {
    await openDeck();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    // The highlight encloses the 150 × 84 px thumbnail and the row's 4 px padding.
    expect(screen.getAllByRole('option')[0].style.height).toBe('92px');
    expect(screen.getByText('Introduction')).toBeTruthy();
    expect(screen.getByText('Objects')).toBeTruthy();
    expect(stage().innerHTML).toContain('Collab Presentations');
  });

  it('measures the stage that mounts once the deck has loaded', async () => {
    // Like the browser's: a detached element reports a zero size.
    const observers: Array<{ callback: ResizeObserverCallback; elements: Element[] }> = [];
    const original = window.ResizeObserver;
    window.ResizeObserver = class {
      private entry: { callback: ResizeObserverCallback; elements: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, elements: [] };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.elements.push(element);
      }
      unobserve() {}
      disconnect() {
        this.entry.elements = [];
      }
    } as unknown as typeof ResizeObserver;
    const tick = () =>
      act(() => {
        for (const { callback, elements } of observers) {
          const entries = elements.map((element) => ({
            target: element,
            contentRect: element.isConnected ? STAGE : { width: 0, height: 0 },
          }));
          if (entries.length > 0) {
            callback(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver);
          }
        }
      });
    try {
      await openDeck();
      tick();
      expect(screen.getByTestId('deck-stage')).toBeTruthy();
    } finally {
      window.ResizeObserver = original;
    }
  });

  it('navigates with the keyboard and the rail, and remembers the slide', async () => {
    await openDeck();
    key(canvas(), 'ArrowRight');
    expect(screen.getByText('Slide 2 of 5')).toBeTruthy();
    key(canvas(), 'End');
    expect(screen.getByText('Slide 5 of 5')).toBeTruthy();
    await showSlide(2);
    await waitFor(() =>
      expect(useEditorStore.getState().deckViewStates[PATH]?.slideId).toBe('slide-3'),
    );
  });

  it('restores the stored slide and panel state without writing it into the deck', async () => {
    useEditorStore.setState({
      deckViewStates: {
        [PATH]: {
          slideId: 'slide-4',
          zoom: 'fit',
          slideRailOpen: false,
          notesOpen: false,
          selectedElementIds: [],
        },
      },
    } as never);
    renderView();
    await screen.findByText('Slide 4 of 5');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('shows speaker notes for the current slide', async () => {
    await openDeck();
    fireEvent.click(screen.getByLabelText('Show speaker notes'));
    expect(screen.getByText('Click to add speaker notes.')).toBeTruthy();
    key(canvas(), 'ArrowRight');
    expect(screen.getByText('Stress that export never changes the backing format.')).toBeTruthy();
  });

  it('loads the images the deck uses', async () => {
    await openDeck();
    await waitFor(() =>
      expect(clientMocks.readAssetDataUrl).toHaveBeenCalledWith(FIXTURE_IMAGE_PATH),
    );
  });

  it('renders document text as text, never as markup', async () => {
    const deck = buildFixtureDeck();
    const title = deck.slides['slide-1'].elements['s1-title'];
    if (title.type !== 'text') throw new Error('fixture changed');
    title.text.content.paragraphs[0].runs = [
      { kind: 'text', text: '<img src=x onerror=alert(1)><script>alert(2)</script>' },
    ];
    serve(deck);
    await openDeck();
    expect(stage().querySelector('script, img, foreignObject')).toBeNull();
    expect(stage().textContent).toContain('<script>alert(2)</script>');
  });

  it('reports repairs made while opening', async () => {
    const deck = buildFixtureDeck();
    deck.slideOrder = ['slide-1', 'slide-2', 'slide-3', 'slide-4'];
    serve(deck);
    await openDeck();
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "slide 'slide-5' was missing from the slide order and was appended",
      expect.anything(),
    );
  });

  it('explains a deck it cannot open', async () => {
    serve('{"kind":"collab-ink","schemaVersion":1}');
    renderView();
    expect(await screen.findByText(/This presentation could not be opened/)).toBeTruthy();
  });

  it('opens a newer schema read-only without interpreting it', async () => {
    serve(JSON.stringify({ kind: 'collab-deck', schemaVersion: 7, future: true }));
    renderView();
    expect(await screen.findByText(/written by a newer version of Collab/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /New slide/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('is read-only for hosted viewers', async () => {
    useVaultStore.setState({ vault: HOSTED_VIEWER_VAULT } as never);
    await openDeck();
    expect((screen.getByRole('button', { name: /Insert/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    key(canvas(), 'a', { ctrlKey: true });
    key(canvas(), 'Delete');
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });
});

describe('DeckView: editing', () => {
  it('inserts a shape, selects it, and undoes and redoes the insert', async () => {
    await openDeck();
    fireEvent.click(menuItem('Rectangle'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByLabelText('Undo Insert')).toBeTruthy();

    key(canvas(), 'z', { ctrlKey: true });
    expect(screen.queryByText('1 selected')).toBeNull();
    let saved = await savedDeck();
    expect(Object.keys(saved.slides['slide-1'].elements)).toHaveLength(2);

    key(canvas(), 'z', { ctrlKey: true, shiftKey: true });
    saved = await savedDeck();
    expect(Object.keys(saved.slides['slide-1'].elements)).toHaveLength(3);
  });

  it('selects all, deletes, and restores with undo', async () => {
    await openDeck();
    await showSlide(2);
    key(canvas(), 'a', { ctrlKey: true });
    expect(screen.getByText('6 selected')).toBeTruthy();
    key(canvas(), 'Delete');
    expect((await savedDeck()).slides['slide-3'].elementOrder).toEqual([]);
    key(canvas(), 'z', { ctrlKey: true });
    expect((await savedDeck()).slides['slide-3'].elementOrder).toHaveLength(6);
  });

  it('nudges the selection with the arrow keys, ten points with Shift', async () => {
    await openDeck();
    await showSlide(4);
    key(canvas(), 'Tab'); // the title, first in paint order
    key(canvas(), 'Tab'); // then the chart
    key(canvas(), 'ArrowRight', { shiftKey: true });
    key(canvas(), 'ArrowDown');
    const chart = (await savedDeck()).slides['slide-5'].elements['s5-chart'];
    expect(chart.frame).toMatchObject({ x: 4_800 + 1_000, y: 14_000 + 100 });
  });

  it('crops an image from its edge after a double-click', async () => {
    await openDeck();
    await showSlide(2);
    const surface = screen.getByTestId('deck-stage-surface');
    // s3-image spans x 500–900 pt, y 140–365 pt.
    fireEvent.doubleClick(surface, { clientX: client(52_500), clientY: client(25_000) });
    expect(screen.queryByLabelText('Rotate')).toBeNull();
    const edge = screen.getByLabelText('Crop e');
    fireEvent.pointerDown(edge, { button: 0, clientX: client(90_000), clientY: client(25_000) });
    fireEvent.pointerMove(surface, { clientX: client(80_000), clientY: client(25_000) });
    fireEvent.pointerUp(surface, { clientX: client(80_000), clientY: client(25_000) });

    expect(screen.getByLabelText('Undo Crop')).toBeTruthy();
    const image = (await savedDeck()).slides['slide-3'].elements['s3-image'];
    expect(image.frame).toMatchObject({ x: 50_000, width: 30_000 });
    expect(image.type === 'image' && image.crop).toMatchObject({ right: 250 });

    key(canvas(), 'Escape');
    expect(screen.getByLabelText('Rotate')).toBeTruthy();
  });

  it('drags an element on the stage as one undoable move', async () => {
    await openDeck();
    await showSlide(2);
    const surface = screen.getByTestId('deck-stage-surface');
    // The centre of s3-card, then 70 screen pixels right; Alt skips snapping.
    const startX = client(4_800 + 13_000);
    const startY = client(14_000 + 7_000);
    fireEvent.pointerDown(surface, { button: 0, clientX: startX, clientY: startY, pointerId: 1 });
    fireEvent.pointerMove(surface, {
      clientX: startX + 35,
      clientY: startY,
      altKey: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(surface, {
      clientX: startX + 70,
      clientY: startY,
      altKey: true,
      pointerId: 1,
    });
    fireEvent.pointerUp(surface, { clientX: startX + 70, clientY: startY, pointerId: 1 });

    expect(screen.getByLabelText('Undo Move')).toBeTruthy();
    const moved = (await savedDeck()).slides['slide-3'].elements['s3-card'];
    expect(moved.frame!.x).toBe(4_800 + Math.round((70 / FIT) * 75));

    key(canvas(), 'z', { ctrlKey: true });
    expect((await savedDeck()).slides['slide-3'].elements['s3-card'].frame!.x).toBe(4_800);
  });

  it('marquee-selects from empty space', async () => {
    await openDeck();
    await showSlide(2);
    const surface = screen.getByTestId('deck-stage-surface');
    fireEvent.pointerDown(surface, {
      button: 0,
      // Clear of the title's bottom edge plus the 4-pixel hit slop.
      clientX: client(48_000),
      clientY: client(13_000),
      pointerId: 1,
    });
    fireEvent.pointerMove(surface, {
      clientX: client(92_000),
      clientY: client(48_000),
      pointerId: 1,
    });
    expect(screen.getByTestId('deck-marquee')).toBeTruthy();
    fireEvent.pointerUp(surface, {
      clientX: client(92_000),
      clientY: client(48_000),
      pointerId: 1,
    });
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('adds, duplicates, and deletes slides, never the last one', async () => {
    await openDeck();
    fireEvent.click(menuItem('Title and content'));
    expect(await screen.findByText('Slide 2 of 6')).toBeTruthy();
    const added = (await savedDeck()).slideOrder[1];

    const rail = screen.getByRole('listbox', { name: 'Slides' });
    key(rail, 'd', { ctrlKey: true });
    expect(await screen.findByText('Slide 3 of 7')).toBeTruthy();
    key(rail, 'Delete'); // the duplicate; the next slide becomes current
    key(rail, 'ArrowUp'); // back to the added slide
    key(rail, 'Delete');
    const saved = await savedDeck();
    expect(saved.slideOrder).toHaveLength(5);
    expect(saved.slideOrder).not.toContain(added);
  });

  it('groups a selection and ungroups it again', async () => {
    await openDeck();
    await showSlide(2);
    key(canvas(), 'a', { ctrlKey: true });
    key(canvas(), 'g', { ctrlKey: true });
    expect(screen.getByText('1 selected')).toBeTruthy();
    let saved = await savedDeck();
    expect(saved.slides['slide-3'].elementOrder).toHaveLength(1);
    key(canvas(), 'g', { ctrlKey: true, shiftKey: true });
    saved = await savedDeck();
    expect(saved.slides['slide-3'].elementOrder).toHaveLength(6);
  });

  it('copies and pastes elements through the clipboard events', async () => {
    await openDeck();
    await showSlide(2);
    key(canvas(), 'Tab');
    key(canvas(), 'Tab'); // s3-card
    const data = new Map<string, string>();
    const clipboardData = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    };
    act(() => {
      fireEvent.copy(canvas(), { clipboardData });
    });
    expect(data.get('text/plain')).toMatch(/^collab-deck-elements\/v1/);
    act(() => {
      fireEvent.paste(canvas(), { clipboardData });
    });
    const saved = await savedDeck();
    // Eight elements (the group counts its two children), plus the pasted card.
    expect(Object.keys(saved.slides['slide-3'].elements)).toHaveLength(9);
  });
});

describe('DeckView: text, placeholders, and design', () => {
  const editor = () => screen.getByTestId('deck-text-editor');
  function input(inputType: string, data: string | null = null) {
    act(() => {
      editor().dispatchEvent(
        new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }),
      );
    });
  }
  const runsOf = (deck: DeckDocument, slideId: string, elementId: string) => {
    const element = deck.slides[slideId].elements[elementId];
    if (element.type !== 'text') throw new Error('expected text');
    return element.text.content.paragraphs.flatMap((paragraph) => paragraph.runs);
  };

  it('edits a placeholder in place and undoes the whole edit as one step', async () => {
    await openDeck();
    key(canvas(), 'Tab'); // s1-title
    key(canvas(), 'Enter');
    expect(editor().textContent).toContain('Collab Presentations');
    // The stage stops drawing the text the editor now shows.
    expect(screen.getByTestId('deck-stage').querySelector('svg')?.textContent).not.toContain(
      'Collab Presentations',
    );
    input('insertText', ' 2026');
    expect(editor().textContent).toContain('Collab Presentations 2026');
    input('deleteContentBackward');
    key(editor(), 'Escape');
    expect(screen.queryByTestId('deck-text-editor')).toBeNull();
    const saved = await savedDeck();
    expect(runsOf(saved, 'slide-1', 's1-title')).toEqual([
      expect.objectContaining({ text: 'Collab Presentations 202' }),
    ]);
    expect(screen.getByLabelText('Undo Edit text')).toBeTruthy();
    key(canvas(), 'z', { ctrlKey: true });
    expect(runsOf(await savedDeck(), 'slide-1', 's1-title')).toEqual([
      expect.objectContaining({ text: 'Collab Presentations' }),
    ]);
  });

  it('types in italics after Ctrl+I on a caret, and splits paragraphs on Enter', async () => {
    await openDeck();
    key(canvas(), 'Tab');
    key(canvas(), 'Enter');
    key(editor(), 'i', { ctrlKey: true });
    input('insertText', '!');
    input('insertParagraph');
    input('insertText', 'Next');
    key(editor(), 'Escape');
    const element = (await savedDeck()).slides['slide-1'].elements['s1-title'];
    if (element.type !== 'text') throw new Error('expected text');
    const [first, second] = element.text.content.paragraphs;
    expect(first.runs).toEqual([
      expect.objectContaining({ text: 'Collab Presentations' }),
      expect.objectContaining({ text: '!', style: expect.objectContaining({ italic: true }) }),
    ]);
    expect(second.runs).toEqual([expect.objectContaining({ text: 'Next' })]);
  });

  it('formats a selected box from the toolbar', async () => {
    await openDeck();
    key(canvas(), 'Tab');
    const toolbar = screen.getByRole('toolbar', { name: 'Text formatting' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Italic' }));
    expect(runsOf(await savedDeck(), 'slide-1', 's1-title')).toEqual([
      expect.objectContaining({ style: expect.objectContaining({ italic: true }) }),
    ]);
    expect(screen.getByLabelText('Undo Format text')).toBeTruthy();
  });

  it('shows prompts in empty placeholders without saving them', async () => {
    await openDeck();
    fireEvent.click(menuItem('Title and content'));
    await screen.findByText('Slide 2 of 6');
    expect(stage().innerHTML).toContain('Click to add title');
    expect(screen.getAllByTestId('deck-placeholder-outline').length).toBeGreaterThanOrEqual(2);
    const saved = await savedDeck();
    expect(JSON.stringify(saved)).not.toContain('Click to add');
  });

  it('edits speaker notes', async () => {
    await openDeck();
    fireEvent.click(screen.getByLabelText('Show speaker notes'));
    fireEvent.click(screen.getByLabelText('Edit speaker notes'));
    expect(editor().getAttribute('aria-label')).toBe('Speaker notes');
    input('insertText', 'Remember the demo');
    key(editor(), 'Escape');
    const notes = (await savedDeck()).slides['slide-1'].speakerNotes;
    expect(notes?.paragraphs[0].runs).toEqual([{ kind: 'text', text: 'Remember the demo' }]);
    expect(screen.getByText('Remember the demo')).toBeTruthy();
  });

  it('applies a built-in design from the design panel, undoably', async () => {
    await openDeck();
    fireEvent.click(screen.getByLabelText('Show design panel'));
    fireEvent.click(screen.getByLabelText('Apply the Midnight design'));
    let saved = await savedDeck();
    expect(saved.themeId).toBe('theme-midnight');
    expect(saved.slideOrder).toHaveLength(5);
    key(canvas(), 'z', { ctrlKey: true });
    saved = await savedDeck();
    expect(saved.themeId).toBe(buildFixtureDeck().themeId);
  });

  it('edits layouts in the master view and adds placeholders to them', async () => {
    await openDeck();
    fireEvent.click(menuItem('Edit master and layouts'));
    expect(screen.getByRole('navigation', { name: 'Master and layouts' })).toBeTruthy();
    expect(screen.getByText(/Editing layout/)).toBeTruthy();
    const layoutId = buildFixtureDeck().slides['slide-1'].layoutId!;
    const before = Object.keys(buildFixtureDeck().layouts[layoutId].elements).length;
    fireEvent.click(menuItem('Footer placeholder'));
    const saved = await savedDeck();
    const added = Object.values(saved.layouts[layoutId].elements);
    expect(added).toHaveLength(before + 1);
    expect(added.some((element) => element.placeholder?.type === 'footer')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close master view' }));
    expect(screen.getByText('Slide 1 of 5')).toBeTruthy();
  });
});

describe('DeckView: objects and Collab data', () => {
  const file = (relativePath: string) => ({
    relativePath,
    name: relativePath.split('/').pop()!,
    extension: relativePath.split('.').pop()!,
    modifiedAt: 0,
    size: 1,
    isFolder: false,
  });

  function sheetContent() {
    const workbook = createEmptySheetDocument('Sales');
    const worksheet = workbook.worksheets[0];
    const put = (row: number, column: number, value: string | number) => {
      worksheet.cells[`${worksheet.rowOrder[row]}:${worksheet.columnOrder[column]}`] = { value };
    };
    put(0, 1, 'North');
    put(1, 0, 'Jan');
    put(1, 1, 7);
    put(2, 0, 'Feb');
    put(2, 1, 9);
    return serializeSheetDocument(workbook);
  }

  beforeEach(() => {
    const deckContent = serializeDeck(buildFixtureDeck());
    clientMocks.readDocument.mockImplementation(async (path: string) => ({
      content: path.endsWith('.sheet')
        ? sheetContent()
        : path.endsWith('.md')
          ? '# Plan\n\n- first\n- second'
          : deckContent,
      version: '1',
    }));
    clientMocks.importData.mockImplementation(
      async (_url: string, name: string, folder: string) => `${folder}/${name}`,
    );
    clientMocks.listFiles.mockResolvedValue([]);
    useVaultStore.setState({
      fileTree: [file('Data/Sales.sheet'), file('Notes/Plan.md'), file('Pictures/cat.png')],
      refreshFileTree: vi.fn(async () => {}),
    } as never);
  });

  it('inserts every kind of shape and arrow from the gallery', async () => {
    await openDeck();
    fireEvent.click(menuItem('Star'));
    fireEvent.click(menuItem('Arrow'));
    const saved = await savedDeck();
    const added = Object.values(saved.slides['slide-1'].elements);
    expect(added.some((element) => element.type === 'shape' && element.geometry === 'star5')).toBe(
      true,
    );
    expect(
      added.some((element) => element.type === 'line' && element.endArrow === 'triangle'),
    ).toBe(true);
  });

  it('formats a selected shape: fill, opacity, and shape', async () => {
    await openDeck();
    fireEvent.click(menuItem('Rectangle'));
    const toolbar = screen.getByRole('toolbar', { name: 'Object formatting' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Fill: Accent 2' }));
    fireEvent.click(within(toolbar).getByRole('menuitemradio', { name: '50%' }));
    fireEvent.click(within(toolbar).getAllByRole('menuitem', { name: 'Hexagon' })[0]);
    const saved = await savedDeck();
    const shape = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'shape',
    );
    expect(shape).toMatchObject({
      geometry: 'hexagon',
      opacity: 50,
      fill: { kind: 'solid', color: { kind: 'theme', token: 'accent2' } },
    });
  });

  it('inserts a table, types into a cell, and adds a row', async () => {
    await openDeck();
    fireEvent.click(menuItem('Table…'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Rows'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    expect(screen.getByText('1 selected')).toBeTruthy();
    key(canvas(), 'Enter');
    const editor = screen.getByTestId('deck-text-editor');
    expect(editor.getAttribute('aria-label')).toBe('Table cell');
    act(() => {
      editor.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'Region',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    key(editor, 'Escape');
    fireEvent.click(screen.getByRole('button', { name: 'Insert row below' }));
    const saved = await savedDeck();
    const table = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'table',
    );
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.rowOrder).toHaveLength(3);
    const first = table.cells[`${table.rowOrder[0]}:${table.columnOrder[0]}`];
    expect(first.text.content.paragraphs[0].runs).toEqual([
      expect.objectContaining({ text: 'Region' }),
    ]);
  });

  it('links a chart to a workbook range and refreshes it on request', async () => {
    await openDeck();
    fireEvent.click(menuItem('Bar chart'));
    fireEvent.click(screen.getByRole('button', { name: /Edit data/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Range'), { target: { value: 'A1:B3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Read range' }));
    await within(dialog).findByText(/Linked to Data\/Sales.sheet/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const saved = await savedDeck();
    const chart = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'chart',
    );
    expect(chart).toMatchObject({
      kind: 'bar',
      categories: ['Jan', 'Feb'],
      series: [{ name: 'North', values: [7, 9] }],
      source: { path: 'Data/Sales.sheet', range: 'A1:B3' },
    });
    // Reading happens only on request.
    const reads = clientMocks.readDocument.mock.calls.filter(
      ([path]) => path === 'Data/Sales.sheet',
    );
    expect(reads).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() =>
      expect(
        clientMocks.readDocument.mock.calls.filter(([path]) => path === 'Data/Sales.sheet'),
      ).toHaveLength(2),
    );
  });

  it('links a note with a generated preview and opens it', async () => {
    await openDeck();
    fireEvent.click(menuItem('Linked document…'));
    fireEvent.click(await screen.findByRole('option', { name: /Plan\.md/ }));
    await waitFor(() => expect(clientMocks.importData).toHaveBeenCalled());
    const [dataUrl, name, folder] = clientMocks.importData.mock.calls[0];
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(folder).toBe('Talks/Fixture assets');
    expect(name).toMatch(/^preview-embed-.*\.svg$/);
    await screen.findByText('1 selected');
    const saved = await savedDeck();
    const embed = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'embed',
    );
    expect(embed).toMatchObject({
      source: { path: 'Notes/Plan.md' },
      preview: { mediaType: 'image/svg+xml' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Open Plan\.md/ }));
    expect(
      useEditorStore.getState().openTabs.some((tab) => tab.relativePath === 'Notes/Plan.md'),
    ).toBe(true);
  });

  it('inserts an image from the vault at its aspect ratio', async () => {
    await openDeck();
    fireEvent.click(menuItem('Image…'));
    fireEvent.click(await screen.findByRole('option', { name: /cat\.png/ }));
    await screen.findByText('1 selected');
    const saved = await savedDeck();
    const image = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'image' && element.asset.path === 'Pictures/cat.png',
    );
    expect(image?.frame).toMatchObject({ width: 30_000, height: 15_000 });
  });

  it('drags one end of a selected line', async () => {
    await openDeck();
    fireEvent.click(menuItem('Line'));
    const surface = screen.getByTestId('deck-stage-surface');
    const end = screen.getByLabelText('Line end');
    fireEvent.pointerDown(end, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, {
      clientX: client(10_000),
      clientY: client(5_000),
      pointerId: 1,
    });
    fireEvent.pointerUp(surface, { clientX: client(10_000), clientY: client(5_000), pointerId: 1 });
    expect(screen.getByLabelText('Undo Move line end')).toBeTruthy();
    const saved = await savedDeck();
    const line = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'line',
    );
    expect(line?.type === 'line' && line.to).toEqual({ x: 10_000, y: 5_000 });
  });
});

describe('DeckView: presenting and export', () => {
  beforeEach(() => {
    clientMocks.listFiles.mockResolvedValue([]);
  });

  it('presents from this slide and returns the editor to the last slide shown', async () => {
    await openDeck();
    await showSlide(1);
    fireEvent.click(menuItem('From this slide'));
    expect(await screen.findByRole('dialog', { name: 'Slide show' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Slide show' })).toBeNull();
    await screen.findByText('Slide 3 of 5');
    // Presenting never changed the deck.
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('starts from the beginning with F5 and keeps ink only when asked', async () => {
    await openDeck();
    await showSlide(2);
    key(canvas(), 'F5');
    expect(await screen.findByRole('dialog', { name: 'Slide show' })).toBeTruthy();
    expect(screen.getByText('1 / 5')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const input = screen.getByTestId('deck-playback-input');
    fireEvent.pointerDown(input, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(input, { pointerId: 1, clientX: 250, clientY: 150 });
    fireEvent.pointerUp(input, { pointerId: 1, clientX: 250, clientY: 150 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByText('Keep ink annotations?')).toBeTruthy();
    clientMocks.importData.mockResolvedValueOnce('Talks/Fixture assets/ink.svg');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(clientMocks.importData).toHaveBeenCalled());
    const [dataUrl, name, folder] = clientMocks.importData.mock.calls[0];
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(folder).toBe('Talks/Fixture assets');
    expect(name).toMatch(/^ink-slide-1-.*\.svg$/);
    await screen.findByLabelText('Undo Keep ink annotations');
    const saved = await savedDeck();
    const ink = Object.values(saved.slides['slide-1'].elements).find(
      (element) => element.type === 'image' && element.name === 'Ink annotations',
    );
    expect(ink?.frame).toEqual({ x: 0, y: 0, width: 96_000, height: 54_000 });
  });

  it('exports a PDF through the save dialog without touching the deck', async () => {
    tauriMocks.showExportDialog.mockResolvedValue('/home/me/Fixture.pdf');
    tauriMocks.writeDownloadedFile.mockResolvedValue(undefined);
    await openDeck();
    fireEvent.click(screen.getByRole('button', { name: 'Export or print' }));
    fireEvent.click(await screen.findByRole('button', { name: /Export…/ }));
    await waitFor(() => expect(tauriMocks.writeDownloadedFile).toHaveBeenCalled());
    expect(tauriMocks.showExportDialog).toHaveBeenCalledWith('Fixture.pdf', {
      name: 'PDF',
      extensions: ['pdf'],
    });
    const [destination, base64] = tauriMocks.writeDownloadedFile.mock.calls[0];
    expect(destination).toBe('/home/me/Fixture.pdf');
    const pdf = atob(base64);
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Count 5');
    expect(pdf).toContain('/Title');
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });
});

describe('DeckView: live collaboration', () => {
  const LOCAL = Symbol('local');

  function room() {
    const doc = new Y.Doc();
    doc.clientID = 101;
    writeDeck(doc, buildFixtureDeck());
    const peer = new Y.Doc();
    peer.clientID = 202;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const awareness = new Awareness(doc);
    const peerAwareness = new Awareness(peer);
    const writes = vi.fn();
    const root = doc.getMap('doc');
    const session: LiveDeckSession = {
      doc,
      awareness,
      getStatus: () => 'connected',
      onStatus: () => () => {},
      discardOfflineState: vi.fn(),
      destroy: vi.fn(),
      readDeck: () => readDeck(doc),
      writeDeck: (deck) => {
        writes(deck);
        reconcileDeck(doc, deck, LOCAL);
      },
      onChange: (callback) => {
        const observer = (_events: unknown, transaction: Y.Transaction) => {
          if (transaction.origin !== LOCAL) callback(readDeck(doc)!);
        };
        root.observeDeep(observer);
        return () => root.unobserveDeep(observer);
      },
    };
    /** The peer edits its copy; the change is relayed to this client. */
    const peerEdit = (edit: (deck: DeckDocument) => void) => {
      const next = readDeck(peer) as unknown as DeckDocument;
      edit(next);
      reconcileDeck(peer, next);
      act(() => {
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
      });
    };
    const toPeer = () => Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
    const peerPresence = (deck: Record<string, unknown>) => {
      peerAwareness.setLocalState({
        user: { id: 'u-2', name: 'Robin', color: '#e11d48' },
        document: { kind: 'deck', relativePath: PATH },
        deck,
      });
      act(() => {
        applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peerAwareness, [202]), 'remote');
      });
    };
    return { doc, peer, session, writes, peerEdit, toPeer, peerPresence };
  }

  beforeEach(() => {
    clientMocks.live = true;
    clientMocks.listFiles.mockResolvedValue([]);
  });
  afterEach(() => {
    clientMocks.live = false;
  });

  async function openLive() {
    const live = room();
    liveMocks.open.mockResolvedValue(live.session);
    await openDeck();
    await waitFor(() => expect(liveMocks.open).toHaveBeenCalled());
    await act(async () => {});
    return live;
  }

  const editor = () => screen.getByTestId('deck-text-editor');
  const type = (data: string) =>
    act(() => {
      editor().dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

  it('edits go to the room, not to REST saves, and peers’ edits appear', async () => {
    const live = await openLive();
    key(canvas(), 'Tab');
    key(canvas(), 'Delete');
    await waitFor(() => expect(live.writes).toHaveBeenCalled());
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
    expect(
      Object.keys((readDeck(live.doc) as unknown as DeckDocument).slides['slide-1'].elements),
    ).not.toContain('s1-title');
    // A collaborator hides slide 4: the rail shows it at once.
    live.peerEdit((deck) => {
      deck.slides['slide-4'].hidden = true;
    });
    await waitFor(() => expect(screen.getByRole('img', { name: 'Slide 4, hidden' })).toBeTruthy());
  });

  it('keeps both people’s typing in one text box', async () => {
    const live = await openLive();
    key(canvas(), 'Tab'); // s1-title
    key(canvas(), 'Enter');
    // Caret at the end: type while the collaborator types at the start.
    type('!');
    live.peerEdit((deck) => {
      const element = deck.slides['slide-1'].elements['s1-title'];
      if (element.type !== 'text' && element.type !== 'shape') return;
      const run = element.text!.content.paragraphs[0].runs[0];
      if (run.kind === 'text') run.text = `Live ${run.text}`;
    });
    await waitFor(() => expect(editor().textContent).toBe('Live Collab Presentations!'));
    type('?');
    key(editor(), 'Escape');
    await waitFor(() => {
      const deck = readDeck(live.doc) as unknown as DeckDocument;
      const element = deck.slides['slide-1'].elements['s1-title'];
      const text =
        element.type === 'text' || element.type === 'shape'
          ? element
              .text!.content.paragraphs[0].runs.map((run) => (run.kind === 'text' ? run.text : ''))
              .join('')
          : '';
      expect(text).toBe('Live Collab Presentations!?');
    });
    // The peer receives the merged text too.
    live.toPeer();
    const peerDeck = readDeck(live.peer) as unknown as DeckDocument;
    expect(JSON.stringify(peerDeck.slides['slide-1'].elements['s1-title'])).toContain(
      'Live Collab Presentations!?',
    );
  });

  it('shows where collaborators are and what they have selected', async () => {
    const live = await openLive();
    live.peerPresence({ targetId: 'slide-1', selectedIds: ['s1-title'], presenting: false });
    await waitFor(() => expect(screen.getAllByTestId('deck-rail-peers').length).toBe(1));
    expect(screen.getByTestId('deck-peer-selection').textContent).toContain('Robin');
    live.peerPresence({
      targetId: 'slide-1',
      selectedIds: [],
      editing: { elementId: 's1-title' },
      presenting: false,
    });
    await waitFor(() =>
      expect(screen.getByTestId('deck-peer-selection').textContent).toContain('Robin is typing'),
    );
    live.peerPresence({ targetId: 'slide-3', presenting: true });
    expect(await screen.findByText('Robin is presenting')).toBeTruthy();
    // This client publishes its own place for the others.
    const mine = live.session.awareness.getLocalState() as { deck?: { targetId: string } };
    expect(mine.deck?.targetId).toBe('slide-1');
  });

  it('viewers follow the room but never write to it', async () => {
    useVaultStore.setState({ vault: HOSTED_VIEWER_VAULT } as never);
    const live = await openLive();
    key(canvas(), 'Tab');
    key(canvas(), 'Delete');
    live.peerEdit((deck) => {
      deck.slides['slide-2'].hidden = true;
    });
    await waitFor(() => expect(screen.getByRole('img', { name: 'Slide 2, hidden' })).toBeTruthy());
    expect(live.writes).not.toHaveBeenCalled();
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('never adopts a room that holds a different deck', async () => {
    const other = room();
    const foreign = new Y.Doc();
    const deck = buildFixtureDeck();
    deck.id = 'someone-else';
    writeDeck(foreign, deck);
    liveMocks.open.mockResolvedValue({ ...other.session, readDeck: () => readDeck(foreign) });
    await openDeck();
    await waitFor(() => expect(other.session.discardOfflineState).toHaveBeenCalled());
    // Still editable through REST.
    key(canvas(), 'Tab');
    key(canvas(), 'Delete');
    const saved = await savedDeck();
    expect(saved.slides['slide-1'].elements['s1-title']).toBeUndefined();
  });
});
