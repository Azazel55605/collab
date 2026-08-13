import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VaultMeta } from '../../types/vault';
import type { InkDocument } from '../../types/ink';
import { createInkDocument, serializeInkDocument } from './document';
import { addPage } from './operations';
import { createInkPage } from './document';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../vaultClient', () => ({
  createVaultClient: vi.fn(() => ({
    kind: 'local',
    capabilities: { filesystemWatch: true },
    readDocument: clientMocks.readDocument,
    writeDocument: clientMocks.writeDocument,
  })),
}));

vi.mock('../vaultReplica', () => ({
  onReplicaMutated: vi.fn(() => () => {}),
  replicaMutationAffectsPath: vi.fn(() => false),
}));

const conflictedCopy = vi.hoisted(() => ({ saveConflictedCopy: vi.fn() }));
vi.mock('../conflictedCopy', () => conflictedCopy);

import { useInkSession, type InkSession } from './useInkSession';

const LOCAL_VAULT: VaultMeta = {
  id: 'vault-1',
  path: '/vault',
  name: 'Vault',
  isEncrypted: false,
  lastOpened: 0,
};

const HOSTED_VIEWER_VAULT: VaultMeta = {
  ...LOCAL_VAULT,
  id: 'vault-2',
  path: 'hosted://vault-2',
  kind: 'hosted',
  serverUrl: 'https://example.test',
  hostedVaultId: 'vault-2',
  role: 'viewer',
};

const PATH = 'Sketches/Ideas.ink';

const markDirty = vi.fn();
const markSaved = vi.fn();

/** Renders the hook and exposes its latest value. */
function mountSession(vault: VaultMeta = LOCAL_VAULT) {
  const ref: { current: InkSession | null } = { current: null };
  function Probe() {
    ref.current = useInkSession({ vault, relativePath: PATH, markDirty, markSaved });
    return null;
  }
  render(<Probe />);
  return ref;
}

function content(name = 'Ideas') {
  return serializeInkDocument(
    createInkDocument({ name, timestamp: '2026-01-01T00:00:00.000Z' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.readDocument.mockResolvedValue({ content: content(), version: '1' });
  clientMocks.writeDocument.mockResolvedValue({ version: '2' });
});

afterEach(cleanup);

describe('useInkSession', () => {
  it('loads a drawing through the vault client', async () => {
    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    expect(clientMocks.readDocument).toHaveBeenCalledWith(PATH);
    expect(session.current?.readOnly).toBe(false);
    expect(session.current?.dirty).toBe(false);
  });

  it('marks the tab dirty on edit and clean again after a save', async () => {
    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());

    act(() => {
      session.current!.updateDocument((current: InkDocument) =>
        addPage(current, createInkPage('page-2')).result,
      );
    });
    await waitFor(() => expect(session.current?.dirty).toBe(true));
    expect(markDirty).toHaveBeenCalledWith(PATH);

    await act(async () => {
      await session.current!.save();
    });
    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
    expect(markSaved).toHaveBeenCalled();
  });

  it('passes the loaded version as the optimistic base', async () => {
    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    act(() => {
      session.current!.updateDocument((current) => addPage(current, createInkPage('p2')).result);
    });
    await act(async () => {
      await session.current!.save();
    });
    await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
    expect(clientMocks.writeDocument.mock.calls[0][2]).toBe('1');
  });

  it('stamps updatedAt on an edit so a save is distinguishable', async () => {
    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    const before = session.current!.document!.updatedAt;

    act(() => {
      session.current!.updateDocument((current) => addPage(current, createInkPage('p2')).result);
    });
    await waitFor(() => expect(session.current!.document!.updatedAt).not.toBe(before));
  });

  it('ignores edits and never writes for a hosted viewer', async () => {
    const session = mountSession(HOSTED_VIEWER_VAULT);
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    expect(session.current?.readOnly).toBe(true);

    act(() => {
      session.current!.updateDocument((current) => addPage(current, createInkPage('p2')).result);
    });
    expect(session.current?.dirty).toBe(false);

    await act(async () => {
      await session.current!.save();
    });
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('opens a newer-schema drawing read-only and does not hand it to the controller', async () => {
    const newer = JSON.parse(content());
    newer.schemaVersion = 99;
    newer.futureField = { keep: 'me' };
    clientMocks.readDocument.mockResolvedValue({
      content: JSON.stringify(newer),
      version: '1',
    });

    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    expect(session.current?.schemaSupport).toBe('newer');
    expect(session.current?.readOnly).toBe(true);
    // Untouched, so a later save can never strip what the newer build wrote.
    expect((session.current!.document as unknown as Record<string, unknown>).futureField)
      .toEqual({ keep: 'me' });

    act(() => {
      session.current!.updateDocument((current) => addPage(current, createInkPage('p2')).result);
    });
    await act(async () => {
      await session.current!.save();
    });
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('reports the repairs the normalizer applied while opening', async () => {
    const damaged = JSON.parse(content());
    const pageId = damaged.pageOrder[0];
    damaged.pages[pageId].scene.objects.orphan = {
      id: 'orphan',
      type: 'stroke',
      layerId: 'gone',
      brush: { kind: 'ballpoint', color: '#000', opacity: 1, width: 96, thinning: 0.5,
               smoothing: 0.5, streamline: 0.4, taperStart: 0, taperEnd: 0 },
      samples: { x: [0, 1], y: [0, 1] },
    };
    damaged.pages[pageId].scene.objectOrder = ['orphan'];
    clientMocks.readDocument.mockResolvedValue({
      content: JSON.stringify(damaged),
      version: '1',
    });

    const session = mountSession();
    await waitFor(() => expect(session.current?.warnings.length).toBeGreaterThan(0));
    // Repaired, not dropped — it is somebody's handwriting.
    expect(session.current!.document!.pages[
      session.current!.document!.pageOrder[0]
    ].scene.objects.orphan).toBeTruthy();
  });

  it('surfaces a parse failure as an error rather than an empty document', async () => {
    clientMocks.readDocument.mockResolvedValue({ content: 'not json at all', version: '1' });
    const session = mountSession();
    await waitFor(() => expect(session.current?.error).toBeTruthy());
    expect(session.current?.document).toBeNull();
  });

  it('does not silently text-merge a concurrent edit', async () => {
    // Interleaving two drawings' sample arrays would produce something that
    // parses and is not what either person drew. Phase 6 merges through the
    // CRDT; until then a real conflict has to be surfaced.
    clientMocks.writeDocument.mockResolvedValue({
      version: '1',
      conflict: { theirContent: content('Theirs') },
    });

    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    act(() => {
      session.current!.updateDocument((current) => addPage(current, createInkPage('p2')).result);
    });
    await act(async () => {
      await session.current!.save();
    });

    await waitFor(() => expect(session.current?.status).toBe('conflict'));
  });

  it('writes a conflicted copy through the shared helper', async () => {
    const session = mountSession();
    await waitFor(() => expect(session.current?.document).toBeTruthy());
    await act(async () => {
      await session.current!.saveMineAsNew('{"kind":"collab-ink"}');
    });
    expect(conflictedCopy.saveConflictedCopy).toHaveBeenCalled();
  });
});
