import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../components/ui/tooltip';
import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../lib/deck/fixture';
import { serializeDeck } from '../lib/deck/validate';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import type { DeckDocument } from '../types/deck';
import type { VaultMeta } from '../types/vault';

import DeckView from './DeckView';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
  readAssetDataUrl: vi.fn(),
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
    expect(screen.getByText('No speaker notes for this slide.')).toBeTruthy();
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
