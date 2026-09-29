import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const sizeDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  serve(buildFixtureDeck());
  clientMocks.writeDocument.mockResolvedValue({ version: '2' });
  clientMocks.readAssetDataUrl.mockResolvedValue(PIXEL);
  useVaultStore.setState({ vault: LOCAL_VAULT, fileTree: [] } as never);
  useEditorStore.setState({
    openTabs: [
      { relativePath: PATH, title: 'Fixture', isDirty: false, savedHash: null, type: 'deck' },
    ],
    activeTabPath: PATH,
    deckViewStates: {},
  } as never);
  // jsdom lays nothing out; give the stage a size so the slide is fitted.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1_000,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  cleanup();
  for (const [key, descriptor] of Object.entries(sizeDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

describe('DeckView', () => {
  it('opens a deck with a slide rail, section headings, and a fitted stage', async () => {
    await openDeck();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getByText('Introduction')).toBeTruthy();
    expect(screen.getByText('Objects')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Slide 1 of 5' }).innerHTML).toContain(
      'Collab Presentations',
    );
  });

  it('navigates with the buttons, the keyboard, and the rail, and remembers the slide', async () => {
    await openDeck();
    fireEvent.click(screen.getByLabelText('Next slide'));
    expect(screen.getByText('Slide 2 of 5')).toBeTruthy();

    const surface = screen.getByRole('application', { name: 'Presentation slides' });
    fireEvent.keyDown(surface, { key: 'End' });
    expect(screen.getByText('Slide 5 of 5')).toBeTruthy();
    fireEvent.keyDown(surface, { key: 'ArrowUp' });
    expect(screen.getByText('Slide 4 of 5')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(screen.getByText('Slide 3 of 5')).toBeTruthy();
    await waitFor(() =>
      expect(useEditorStore.getState().deckViewStates[PATH]?.slideId).toBe('slide-3'),
    );
  });

  it('restores the stored slide and panel state instead of writing it into the deck', async () => {
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
    fireEvent.click(screen.getByLabelText('Next slide'));
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
    const stage = screen.getByRole('img', { name: 'Slide 1 of 5' });
    expect(stage.querySelector('script, img, foreignObject')).toBeNull();
    expect(stage.textContent).toContain('<script>alert(2)</script>');
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

  it('opens a newer schema read-only without trying to display it', async () => {
    serve(JSON.stringify({ kind: 'collab-deck', schemaVersion: 7, future: true }));
    renderView();
    expect(await screen.findByText(/written by a newer version of Collab/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is read-only for hosted viewers', async () => {
    useVaultStore.setState({ vault: HOSTED_VIEWER_VAULT } as never);
    await openDeck();
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
