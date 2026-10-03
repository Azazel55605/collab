import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../../../../src/lib/deck/fixture';
import type { DeckInteraction } from '../../../../src/lib/liveAwareness';
import type { DeckDocument } from '../../../../src/types/deck';
import { clearBackDismissStack, runTopBackDismiss } from '../lib/backStack';
import type { MobileLiveDeckSession } from '../lib/liveNote';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import { useMobileStore } from '../state/store';

import { DeckScreen } from './DeckScreen';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const openLive = vi.fn<() => Promise<MobileLiveDeckSession | null>>(async () => null);
vi.mock('../lib/liveNote', async (original) => ({
  ...(await original<typeof import('../lib/liveNote')>()),
  openMobileLiveDeckSession: () => openLive(),
}));

const SIZE = { width: 412, height: 700 };
const descriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

const SERVER = 'https://server.test';
const vault: HostedVault = {
  id: 'vault-1',
  name: 'Vault',
  role: 'viewer',
  status: 'active',
  members: 1,
  storageBytes: 10,
  manifestSequence: 7,
  updatedAt: null,
  capabilities: ['vault.read'],
};
const file: HostedFileEntry = {
  id: 'deck-1',
  parentId: null,
  name: 'Talk.deck',
  relativePath: 'Talk.deck',
  kind: 'document',
  documentType: 'deck',
  state: 'active',
  updatedAt: null,
  sizeBytes: 200,
  contentHash: 'hash',
  revisionSequence: 3,
};
const image: HostedFileEntry = {
  ...file,
  id: 'img-1',
  name: 'deck-fixture.png',
  relativePath: FIXTURE_IMAGE_PATH,
  kind: 'asset',
  documentType: null,
};
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fixture(): DeckDocument {
  const deck = buildFixtureDeck();
  deck.slides['slide-2'].speakerNotes = {
    paragraphs: [{ id: 'n1', runs: [{ kind: 'text', text: 'Mention the offline replica.' }] }],
  };
  return deck;
}

function selectVault(connected: boolean, files: HostedFileEntry[] = [file, image]) {
  useMobileStore.setState({
    selected: { serverUrl: SERVER, vault },
    statuses: connected
      ? {
          [SERVER]: {
            connected: true,
            serverUrl: SERVER,
            allowInvalidCertificates: false,
            user: { id: 'user-1', username: 'ada', displayName: 'Ada' },
            accessExpiresAt: null,
          },
        }
      : {},
    files,
    activeSheet: { kind: 'presentation', fileId: file.id },
    replicas: {},
  } as never);
}

function mockServer(options: { cached?: string | null; network?: boolean } = {}) {
  const content = JSON.stringify(fixture());
  invoke.mockImplementation((command: string) => {
    if (command === 'hosted_vault_request') {
      return options.network === false
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ file: { ...file, currentRevision: { sequence: 3 } }, content });
    }
    if (command === 'replica_read_cached_document') {
      return Promise.resolve(options.cached === undefined ? content : options.cached);
    }
    if (command === 'hosted_vault_asset_data_url') return Promise.resolve(PNG);
    if (command === 'replica_read_cached_asset') return Promise.resolve(null);
    if (command === 'replica_cache_document' || command === 'replica_cache_asset') {
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`unhandled ${command}`));
  });
}

beforeEach(() => {
  sessionStorage.clear();
  clearBackDismissStack();
  openLive.mockImplementation(async () => null);
  for (const name of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => (name === 'clientWidth' ? SIZE.width : SIZE.height),
    });
  }
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

describe('DeckScreen', () => {
  it('lists slides as thumbnails with sections, opens one fitted, and shows its notes', async () => {
    selectVault(true);
    mockServer();
    render(<DeckScreen file={file} />);
    expect(await screen.findByText('5 slides')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Slide 1, section Introduction' })).toBeTruthy();
    // The image is read through the vault and drawn inline.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'hosted_vault_asset_data_url',
        expect.objectContaining({ fileId: 'img-1' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Slide 2' }));
    expect(screen.getByText('Slide 2 of 5')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Slide 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Speaker notes' }));
    expect(screen.getByText('Mention the offline replica.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByText('Slide 3 of 5')).toBeTruthy();
    expect(screen.getByText('No speaker notes for this slide.')).toBeTruthy();

    // Android back returns to the slide list before it closes the deck.
    act(() => {
      expect(runTopBackDismiss()).toBe(true);
    });
    expect(screen.getByText('5 slides')).toBeTruthy();
  });

  it('restores the slide and notes after Android recreates the screen', async () => {
    selectVault(true);
    mockServer();
    const first = render(<DeckScreen file={file} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Slide 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speaker notes' }));
    first.unmount();

    render(<DeckScreen file={file} />);
    expect(await screen.findByText('Slide 4 of 5')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Speaker notes' })).toBeTruthy();
  });

  it('presents with playback rules: hidden slides are skipped and the end exits', async () => {
    selectVault(true);
    mockServer();
    const deck = fixture();
    deck.slides['slide-2'].hidden = true;
    invoke.mockImplementation((command: string) =>
      command === 'hosted_vault_request'
        ? Promise.resolve({ file, content: JSON.stringify(deck) })
        : command === 'hosted_vault_asset_data_url'
          ? Promise.resolve(PNG)
          : Promise.resolve(null),
    );
    render(<DeckScreen file={file} />);
    fireEvent.click(await screen.findByRole('button', { name: /Present/ }));
    const show = screen.getByRole('dialog', { name: 'Slide show' });
    expect(show.textContent).toContain('1 / 4');
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByRole('img', { name: 'Slide 3' })).toBeTruthy();
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    }
    expect(screen.getByText('End of slide show. Tap to exit.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End show' }));
    expect(screen.queryByRole('dialog', { name: 'Slide show' })).toBeNull();
    expect(screen.getByText('Slide 5 of 5')).toBeTruthy();
  });

  it('plays object builds before advancing while presenting on the phone', async () => {
    selectVault(true);
    const deck = fixture();
    deck.slides['slide-1'].animations = [
      {
        id: 'animation-1',
        elementId: 's1-title',
        effect: 'fade',
        phase: 'entrance',
        trigger: 'click',
        durationMs: 500,
      },
    ];
    invoke.mockImplementation((command: string) =>
      command === 'hosted_vault_request'
        ? Promise.resolve({ file, content: JSON.stringify(deck) })
        : command === 'hosted_vault_asset_data_url'
          ? Promise.resolve(PNG)
          : Promise.resolve(null),
    );
    render(<DeckScreen file={file} />);
    fireEvent.click(await screen.findByRole('button', { name: /Present/ }));
    const show = screen.getByRole('dialog', { name: 'Slide show' });
    expect(show.querySelector('style')?.textContent).toContain('visibility:hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByRole('img', { name: 'Slide 1' })).toBeTruthy();
    expect(show.querySelector('style')?.textContent).toContain('deck-anim-fade-in');
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByRole('img', { name: 'Slide 2' })).toBeTruthy();
  });

  it('opens the offline copy when the server is unreachable and says when there is none', async () => {
    selectVault(false, [file]);
    mockServer();
    render(<DeckScreen file={file} />);
    expect(await screen.findByLabelText('Offline copy')).toBeTruthy();
    // The image is not in this device's files: a placeholder, and said so.
    expect(screen.getByText(/One image is not available on this device/)).toBeTruthy();

    useMobileStore.setState({ files: [file] } as never);
    mockServer({ cached: null });
    render(<DeckScreen file={{ ...file, id: 'deck-2' }} />);
    expect(
      await screen.findByText('This presentation is not cached for offline viewing.'),
    ).toBeTruthy();
  });

  it('drives a show running on the same account’s computer', async () => {
    selectVault(true);
    mockServer();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    openLive.mockImplementation(async () => ({
      awareness,
      readDeck: () => null,
      onChange: () => () => {},
      getStatus: () => 'connected',
      onStatus: () => () => {},
      destroy: () => {},
    }));
    render(<DeckScreen file={file} remoteShowId="show-9" />);
    await screen.findByText('5 slides');

    // The desktop presenter, signed in as the same account, with remote on.
    const desktop = new Awareness(new Y.Doc());
    desktop.setLocalState({
      user: { id: 'user-1', name: 'Ada', color: '#f00' },
      document: { kind: 'deck', relativePath: 'Talk.deck' },
      deck: {
        targetId: 'slide-2',
        presenting: true,
        show: {
          id: 'show-9',
          slideId: 'slide-2',
          position: 2,
          total: 5,
          blank: null,
          remote: true,
        },
      } satisfies DeckInteraction,
    });
    act(() => {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(desktop, [desktop.clientID]), 'remote');
    });
    expect(await screen.findByText('Showing slide 2 of 5')).toBeTruthy();
    expect(screen.getByText('Mention the offline replica.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Black screen' }));
    const published = awareness.getLocalState()?.deck as DeckInteraction;
    expect(published.remote).toEqual({
      showId: 'show-9',
      commands: [
        { seq: 1, action: 'next' },
        { seq: 2, action: 'black' },
      ],
    });
    expect(awareness.getLocalState()?.user).toMatchObject({ id: 'user-1' });

    const OriginalDeviceOrientationEvent = globalThis.DeviceOrientationEvent;
    class TestOrientationEvent extends Event {
      beta: number;
      gamma: number;
      constructor(beta: number, gamma: number) {
        super('deviceorientation');
        this.beta = beta;
        this.gamma = gamma;
      }
    }
    Object.defineProperty(globalThis, 'DeviceOrientationEvent', {
      configurable: true,
      value: TestOrientationEvent,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Motion laser' }));
    act(() => {
      window.dispatchEvent(new TestOrientationEvent(10, 5));
      window.dispatchEvent(new TestOrientationEvent(14, 9));
    });
    await waitFor(() =>
      expect((awareness.getLocalState()?.deck as DeckInteraction).remote?.pointer).toMatchObject({
        active: true,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop motion laser' }));
    Object.defineProperty(globalThis, 'DeviceOrientationEvent', {
      configurable: true,
      value: OriginalDeviceOrientationEvent,
    });

    // Another account's show is followed, never driven.
    desktop.setLocalStateField('user', { id: 'someone-else', name: 'Bo', color: '#00f' });
    act(() => {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(desktop, [desktop.clientID]), 'remote');
    });
    expect(await screen.findByText('Bo is presenting.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remote control' })).toBeNull();
  });

  it('requests an opted-in computer to start the open deck', async () => {
    selectVault(true);
    mockServer();
    const awareness = new Awareness(new Y.Doc());
    openLive.mockImplementation(async () => ({
      awareness,
      readDeck: () => null,
      onChange: () => () => {},
      getStatus: () => 'connected',
      onStatus: () => () => {},
      destroy: () => {},
    }));
    render(<DeckScreen file={file} />);
    await screen.findByText('5 slides');

    const desktop = new Awareness(new Y.Doc());
    desktop.setLocalState({
      user: { id: 'user-1', name: 'Ada’s laptop', color: '#f00' },
      document: { kind: 'deck', relativePath: 'Talk.deck' },
      deck: { targetId: 'slide-1', canStartPresentation: true } satisfies DeckInteraction,
    });
    act(() => {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(desktop, [desktop.clientID]), 'remote');
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Present there' }));
    const published = awareness.getLocalState()?.deck as DeckInteraction;
    expect(published.remote?.startRequest).toMatchObject({ targetClientId: desktop.clientID });
    expect(published.remote?.startRequest?.id).toEqual(expect.any(String));
  });
});
