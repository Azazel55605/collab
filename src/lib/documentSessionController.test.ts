import { describe, expect, it, vi } from 'vitest';

import {
  compareDocumentVersions,
  createExclusiveSaveRunner,
  DocumentSessionController,
  type DocumentSessionControllerOptions,
  type DocumentWriteOutcome,
  type RemoteCandidate,
} from './documentSessionController';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Test harness: documents are plain strings (serialize/deserialize are identity)
 * so the controller can be exercised without React Flow, CodeMirror, or any
 * specific document format — the Phase 1 acceptance requirement.
 */
interface HarnessOverrides extends Partial<DocumentSessionControllerOptions<string>> {
  /**
   * Resolves the write outcome. `writes` is always recorded by the harness
   * regardless, so gated writes stay observable. Defaults to accepting the write
   * and echoing content as the new version token.
   */
  resolveWrite?: (args: {
    content: string;
    expectedVersion: string | null;
    baseContent?: string;
  }) => Promise<DocumentWriteOutcome>;
}

function makeController({ resolveWrite, ...overrides }: HarnessOverrides = {}) {
  const applied: RemoteCandidate<string>[] = [];
  const writes: Array<{ content: string; expectedVersion: string | null; baseContent?: string }> =
    [];
  let scheduled: (() => void) | null = null;

  const options: DocumentSessionControllerOptions<string> = {
    serialize: (doc) => doc,
    deserialize: (content) => content,
    applyDocument: (candidate) => {
      applied.push(candidate);
    },
    write: async (args) => {
      writes.push(args);
      return resolveWrite
        ? resolveWrite(args)
        : ({ version: args.content } satisfies DocumentWriteOutcome);
    },
    schedule: (fn) => {
      scheduled = fn;
      return () => {
        if (scheduled === fn) scheduled = null;
      };
    },
    ...overrides,
  };

  const controller = new DocumentSessionController<string>(options);
  return {
    controller,
    applied,
    writes,
    hasScheduledAutosave: () => scheduled !== null,
    runScheduledAutosave: () => {
      const fn = scheduled;
      scheduled = null;
      fn?.();
    },
  };
}

describe('createExclusiveSaveRunner', () => {
  it('never runs two saves concurrently and coalesces to the latest', async () => {
    const runner = createExclusiveSaveRunner();
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = () =>
      new Promise<void>((resolve) => {
        order.push('first');
        releaseFirst = resolve;
      });
    const stale = () => {
      order.push('stale');
      return Promise.resolve();
    };
    const latest = () => {
      order.push('latest');
      return Promise.resolve();
    };

    const run = runner.run(first);
    runner.run(stale);
    runner.run(latest);
    expect(runner.isBusy()).toBe(true);

    releaseFirst();
    await run;
    expect(order).toEqual(['first', 'latest']);
    expect(runner.isBusy()).toBe(false);
  });
});

describe('DocumentSessionController', () => {
  it('starts idle and skips the first autosave after load', () => {
    const { controller, hasScheduledAutosave } = makeController();
    controller.load('a', 'v1');

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.version).toBe('v1');
    // Load establishes the baseline without marking dirty, so nothing autosaves.
    expect(hasScheduledAutosave()).toBe(false);

    // A change that matches the saved content is not dirty either.
    controller.markLocalChange('a');
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(hasScheduledAutosave()).toBe(false);
  });

  it('marks dirty and schedules autosave on a real local change', () => {
    const { controller, hasScheduledAutosave } = makeController();
    controller.load('a', 'v1');
    controller.markLocalChange('b');

    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().status).toBe('dirty');
    expect(hasScheduledAutosave()).toBe(true);
  });

  it('serializes overlapping saves and coalesces the trailing save to the latest content', async () => {
    const gates: Array<() => void> = [];
    const { controller, writes } = makeController({
      resolveWrite: async (args) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { version: args.content };
      },
    });

    controller.load('a', 'a');
    controller.markLocalChange('b');
    const first = controller.requestSave('manual'); // starts write('b')
    controller.markLocalChange('c');
    controller.requestSave('manual'); // queued while busy
    controller.markLocalChange('d');
    controller.requestSave('manual'); // coalesced → newest content 'd'

    await flush();
    expect(writes.map((w) => w.content)).toEqual(['b']);
    expect(controller.getSnapshot().saving).toBe(true);

    gates[0](); // finish write('b'); trailing coalesced save runs next
    await flush();
    expect(writes.map((w) => w.content)).toEqual(['b', 'd']);
    // The trailing save carries the version returned by the prior write as its
    // optimistic base, never a stale one.
    expect(writes[1].expectedVersion).toBe('b');

    gates[1]();
    await first;
    expect(controller.getSnapshot().saving).toBe(false);
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.getSnapshot().status).toBe('saved');
    expect(controller.version).toBe('d');
  });

  it('rejects stale remote candidates (same or older version)', () => {
    const { controller, applied } = makeController();
    controller.load('a', 'v1');

    expect(
      controller.handleRemoteCandidate({
        document: 'a',
        content: 'a',
        version: 'v1',
        source: 'rest',
      }),
    ).toBe('stale');
    // Only the initial load applied a document; the stale candidate added none.
    expect(applied).toHaveLength(1);
    expect(controller.getSnapshot().currentContent).toBe('a');
  });

  it('uses an injected version comparator to reject older versions', () => {
    const { controller } = makeController({
      compareVersions: (a, b) => Number(a) - Number(b),
    });
    controller.load('a', '5');

    expect(
      controller.handleRemoteCandidate({
        document: 'x',
        content: 'x',
        version: '4',
        source: 'cache',
      }),
    ).toBe('stale');
    expect(
      controller.handleRemoteCandidate({
        document: 'y',
        content: 'y',
        version: '6',
        source: 'cache',
      }),
    ).toBe('applied');
    expect(controller.version).toBe('6');
  });

  it('compares hosted revision sequences numerically and keeps local hashes opaque', () => {
    expect(compareDocumentVersions('4', '5')).toBeLessThan(0);
    expect(compareDocumentVersions('6', '5')).toBeGreaterThan(0);
    expect(compareDocumentVersions('hash-b', 'hash-a')).toBeGreaterThan(0);
    expect(compareDocumentVersions('hash-a', 'hash-a')).toBe(0);
  });

  it('auto-applies a newer remote candidate while clean', () => {
    const { controller, applied } = makeController();
    controller.load('a', 'v1');

    const decision = controller.handleRemoteCandidate({
      document: 'b',
      content: 'b',
      version: 'v2',
      source: 'rest',
    });

    expect(decision).toBe('applied');
    expect(applied[applied.length - 1]).toMatchObject({ content: 'b', version: 'v2' });
    expect(controller.getSnapshot()).toMatchObject({
      currentContent: 'b',
      loadedVersion: 'v2',
      dirty: false,
      lastAppliedRemoteVersion: 'v2',
    });
  });

  it('queues a remote candidate while dirty and never replaces local content', () => {
    const { controller, applied } = makeController();
    controller.load('a', 'v1');
    controller.markLocalChange('local-edit');

    const decision = controller.handleRemoteCandidate({
      document: 'remote',
      content: 'remote',
      version: 'v2',
      source: 'rest',
    });

    expect(decision).toBe('queued');
    expect(controller.getSnapshot().currentContent).toBe('local-edit');
    expect(controller.getSnapshot().status).toBe('remote-pending');
    expect(controller.getSnapshot().pendingRemote).toMatchObject({ content: 'remote' });
    // The queued candidate is not applied to the view until requested (only the
    // initial load applied a document).
    expect(applied).toHaveLength(1);
  });

  it('applyRemoteNow adopts the pending remote; discardRemoteCandidate keeps local', () => {
    const first = makeController();
    first.controller.load('a', 'v1');
    first.controller.markLocalChange('mine');
    first.controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });
    first.controller.applyRemoteNow();
    expect(first.controller.getSnapshot().currentContent).toBe('theirs');
    expect(first.controller.getSnapshot().dirty).toBe(false);
    expect(first.applied[first.applied.length - 1]).toMatchObject({ content: 'theirs' });

    const second = makeController();
    second.controller.load('a', 'v1');
    second.controller.markLocalChange('mine');
    second.controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });
    second.controller.discardRemoteCandidate();
    expect(second.controller.getSnapshot().currentContent).toBe('mine');
    expect(second.controller.getSnapshot().pendingRemote).toBeNull();
    expect(second.controller.getSnapshot().status).toBe('dirty');
  });

  it('never reloads while a local save is in flight (queues instead)', async () => {
    const gates: Array<() => void> = [];
    const { controller } = makeController({
      resolveWrite: async (args) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { version: args.content };
      },
    });
    controller.load('a', 'a');
    controller.markLocalChange('b');
    const save = controller.requestSave('manual');
    await flush();
    expect(controller.getSnapshot().saving).toBe(true);

    const decision = controller.handleRemoteCandidate({
      document: 'c',
      content: 'c',
      version: 'c',
      source: 'rest',
    });
    expect(decision).toBe('queued');
    expect(controller.getSnapshot().pendingRemote).toMatchObject({ content: 'c' });

    gates[0]();
    await save;
  });

  it('pauses autosave on conflict and resumes only after explicit resolution', async () => {
    const { controller, hasScheduledAutosave, runScheduledAutosave } = makeController({
      resolveWrite: async () => ({
        version: '',
        conflict: { theirContent: 'theirs', theirVersion: 'v2', baseContent: 'a' },
      }),
    });

    controller.load('a', 'v1');
    controller.markLocalChange('mine');
    expect(hasScheduledAutosave()).toBe(true);
    runScheduledAutosave();
    await flush();

    expect(controller.getSnapshot().conflicted).toBe(true);
    expect(controller.getSnapshot().status).toBe('conflict');
    expect(controller.getSnapshot().conflict).toMatchObject({
      theirContent: 'theirs',
      ourContent: 'mine',
    });

    // Further edits while conflicted must not schedule autosave.
    controller.markLocalChange('mine-2');
    expect(hasScheduledAutosave()).toBe(false);

    // Resolving keep-local rebases onto their version and resumes autosave.
    controller.resolveConflict('keep-local');
    expect(controller.getSnapshot().conflicted).toBe(false);
    expect(controller.version).toBe('v2');
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(hasScheduledAutosave()).toBe(true);
  });

  it('resolveConflict load-remote discards local edits and adopts remote', async () => {
    const { controller, applied } = makeController({
      resolveWrite: async () => ({
        version: '',
        conflict: { theirContent: 'theirs', theirVersion: 'v2' },
      }),
    });
    controller.load('a', 'v1');
    controller.markLocalChange('mine');
    await controller.requestSave('manual');

    controller.resolveConflict('load-remote');
    expect(controller.getSnapshot().conflicted).toBe(false);
    expect(controller.getSnapshot().currentContent).toBe('theirs');
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.version).toBe('v2');
    expect(applied[applied.length - 1]).toMatchObject({ content: 'theirs', version: 'v2' });
  });

  it('surfaces an offline-queued write without advancing the version', async () => {
    const { controller } = makeController({
      resolveWrite: async () => ({ version: '', offlineQueued: true }),
    });
    controller.load('a', 'v1');
    controller.markLocalChange('mine');
    await controller.requestSave('manual');

    expect(controller.getSnapshot().offlineQueued).toBe(true);
    expect(controller.getSnapshot().status).toBe('offline-queued');
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.version).toBe('v1');
  });

  it('clears queued optimistic cache echoes when a save is queued offline', async () => {
    let release!: () => void;
    const { controller } = makeController({
      resolveWrite: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { version: '2', offlineQueued: true };
      },
      compareVersions: compareDocumentVersions,
    });
    controller.load('base', '1');
    controller.markLocalChange('mine');
    const save = controller.requestSave('manual');
    await flush();

    expect(
      controller.handleRemoteCandidate({
        document: 'mine',
        content: 'mine',
        version: '2',
        source: 'cache',
      }),
    ).toBe('queued');

    release();
    await save;
    expect(controller.getSnapshot().offlineQueued).toBe(true);
    expect(controller.getSnapshot().pendingRemote).toBeNull();
    expect(controller.getSnapshot().currentContent).toBe('mine');
    expect(controller.version).toBe('1');
  });

  it('disables REST autosave and ignores foreign remote candidates while live', () => {
    let live = true;
    const { controller, writes } = makeController({ isLive: () => live });
    controller.load('a', 'v1');
    controller.markLocalChange('b');

    // No autosave scheduling and no manual save while a live session owns the doc.
    void controller.requestSave('manual');
    expect(writes).toHaveLength(0);

    // Non-live remote candidates are ignored while live.
    expect(
      controller.handleRemoteCandidate({
        document: 'c',
        content: 'c',
        version: 'v9',
        source: 'rest',
      }),
    ).toBe('ignored');

    // A live candidate is authoritative and applied even with the same version.
    expect(
      controller.handleRemoteCandidate({
        document: 'live',
        content: 'live',
        version: 'v1',
        source: 'live',
      }),
    ).toBe('applied');
    expect(controller.getSnapshot().currentContent).toBe('live');

    live = false;
  });

  it('reports live connection state in the status vocabulary', () => {
    const { controller } = makeController();
    controller.load('a', 'v1');
    controller.setLiveState('live-connected');
    expect(controller.getSnapshot().status).toBe('live-connected');
    controller.setLiveState('live-reconnecting');
    expect(controller.getSnapshot().status).toBe('live-reconnecting');
    controller.setLiveState(null);
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('handleExternalMutation re-reads through the injected reader and routes the candidate', async () => {
    const read = vi.fn().mockResolvedValue({ content: 'fresh', version: 'v2' });
    const { controller, applied } = makeController({ read });
    controller.load('a', 'v1');

    const decision = await controller.handleExternalMutation('cache');
    expect(read).toHaveBeenCalledTimes(1);
    expect(decision).toBe('applied');
    expect(applied[applied.length - 1]).toMatchObject({
      content: 'fresh',
      version: 'v2',
      source: 'cache',
    });
  });

  it('treats a failing external re-read as nothing-to-apply (no unhandled rejection)', async () => {
    const read = vi
      .fn()
      .mockRejectedValue(new Error('Decryption failed — incorrect password or corrupted file'));
    const { controller } = makeController({ read });
    controller.load('a', 'v1');

    await expect(controller.handleExternalMutation('cache')).resolves.toBe('ignored');
    // The session baseline is untouched by the failed re-read.
    expect(controller.getSnapshot().currentContent).toBe('a');
    expect(controller.version).toBe('v1');
  });

  it('merges a dirty remote candidate when a merge function is provided', () => {
    const { controller, applied } = makeController({
      mergeRemote: ({ local, remote }) => ({
        document: `${local}+${remote}`,
        content: `${local}+${remote}`,
      }),
    });
    controller.load('base', 'v1');
    controller.markLocalChange('local');

    const decision = controller.handleRemoteCandidate({
      document: 'remote',
      content: 'remote',
      version: 'v2',
      source: 'rest',
    });

    expect(decision).toBe('merged');
    expect(controller.getSnapshot().currentContent).toBe('local+remote');
    expect(controller.version).toBe('v2');
    expect(applied[applied.length - 1]).toMatchObject({ content: 'local+remote' });
  });
});

describe('DocumentSessionController reconciliation API', () => {
  it('derives the reconciliation model from a queued pending remote', () => {
    const { controller } = makeController();
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });

    const recon = controller.getReconciliation();
    expect(recon).toEqual({
      kind: 'remote-pending',
      base: 'base',
      ours: 'mine',
      theirs: 'theirs',
      theirVersion: 'v2',
    });
  });

  it('derives the reconciliation model from a hard conflict', async () => {
    const { controller } = makeController({
      resolveWrite: async () => ({
        version: 'v1',
        conflict: { theirContent: 'server', baseContent: 'base', theirVersion: 'v2' },
      }),
    });
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    await controller.requestSave('manual');

    const recon = controller.getReconciliation();
    expect(recon).toEqual({
      kind: 'conflict',
      base: 'base',
      ours: 'mine',
      theirs: 'server',
      theirVersion: 'v2',
    });
    expect(controller.getSnapshot().status).toBe('conflict');
  });

  it('loadRemote adopts the pending remote and clears dirty state', () => {
    const { controller, applied } = makeController();
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });

    controller.loadRemote();
    expect(controller.getReconciliation()).toBeNull();
    expect(controller.getSnapshot().currentContent).toBe('theirs');
    expect(controller.isDirty).toBe(false);
    expect(applied[applied.length - 1]).toMatchObject({ content: 'theirs', version: 'v2' });
  });

  it('keepMine rebases a pending remote onto the remote version so the next save overwrites cleanly', () => {
    const { controller, hasScheduledAutosave } = makeController();
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });

    controller.keepMine();
    const snap = controller.getSnapshot();
    expect(snap.pendingRemote).toBeNull();
    // Version advanced to theirs, but local content is preserved and still dirty
    // against it, so the queued autosave will overwrite v2 (base = their content).
    expect(snap.loadedVersion).toBe('v2');
    expect(snap.lastSavedContent).toBe('theirs');
    expect(snap.currentContent).toBe('mine');
    expect(snap.dirty).toBe(true);
    expect(hasScheduledAutosave()).toBe(true);
  });

  it('saveMineAsNew persists local content then adopts the remote', async () => {
    const { controller, applied } = makeController();
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });

    const persisted: string[] = [];
    await controller.saveMineAsNew(async (local) => {
      persisted.push(local);
    });

    expect(persisted).toEqual(['mine']);
    expect(controller.getReconciliation()).toBeNull();
    expect(controller.getSnapshot().currentContent).toBe('theirs');
    expect(applied[applied.length - 1]).toMatchObject({ content: 'theirs' });
  });

  it('saveMineAsNew leaves reconciliation intact when persist fails', async () => {
    const { controller } = makeController();
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    controller.handleRemoteCandidate({
      document: 'theirs',
      content: 'theirs',
      version: 'v2',
      source: 'rest',
    });

    await expect(
      controller.saveMineAsNew(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(controller.getReconciliation()).not.toBeNull();
    expect(controller.getSnapshot().currentContent).toBe('mine');
  });
});
