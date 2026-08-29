import { useSyncExternalStore } from 'react';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DocumentSessionController,
  type DocumentWriteOutcome,
} from '../../lib/documentSessionController';

import { DocumentReconciler } from './DocumentReconciler';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function makeController(resolveWrite?: () => Promise<DocumentWriteOutcome>) {
  return new DocumentSessionController<string>({
    serialize: (d) => d,
    deserialize: (c) => c,
    applyDocument: () => {},
    write: async (args) => (resolveWrite ? resolveWrite() : { version: args.content }),
    // Immediate scheduler is irrelevant here; keep autosave inert.
    schedule: () => () => {},
  });
}

function Harness({
  controller,
  onSaveAsNew,
  readOnly,
}: {
  controller: DocumentSessionController<string>;
  onSaveAsNew?: (local: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return (
    <DocumentReconciler
      controller={controller}
      snapshot={snapshot}
      onSaveAsNew={onSaveAsNew}
      readOnly={readOnly}
    />
  );
}

function pendingRemote(controller: DocumentSessionController<string>) {
  controller.load('base', 'v1');
  controller.markLocalChange('mine');
  controller.handleRemoteCandidate({
    document: 'theirs',
    content: 'theirs',
    version: 'v2',
    source: 'rest',
  });
}

describe('DocumentReconciler', () => {
  afterEach(cleanup);

  it('shows only the status pill when there is nothing to reconcile', () => {
    const controller = makeController();
    controller.load('base', 'v1');
    render(<Harness controller={controller} />);
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull();
  });

  it('surfaces a Review affordance for a pending remote and opens a non-dismissible dialog', async () => {
    const controller = makeController();
    pendingRemote(controller);
    render(<Harness controller={controller} />);

    expect(screen.getByText('Remote changes available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    // Both versions are shown; the dialog names the state.
    expect(await screen.findByText('Your version')).toBeTruthy();
    expect(screen.getByText('Their version')).toBeTruthy();
    // "Load remote" and "Keep mine" resolution actions are present.
    expect(screen.getByRole('button', { name: 'Load remote' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeTruthy();
  });

  it('Load remote adopts the remote content and clears the reconciliation', async () => {
    const controller = makeController();
    pendingRemote(controller);
    render(<Harness controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load remote' }));

    await waitFor(() => expect(controller.getReconciliation()).toBeNull());
    expect(controller.getSnapshot().currentContent).toBe('theirs');
  });

  it('Keep mine rebases onto the remote version and closes the dialog', async () => {
    const controller = makeController();
    pendingRemote(controller);
    render(<Harness controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));

    await waitFor(() => expect(controller.getReconciliation()).toBeNull());
    const snap = controller.getSnapshot();
    expect(snap.loadedVersion).toBe('v2');
    expect(snap.currentContent).toBe('mine');
    expect(snap.dirty).toBe(true);
  });

  it('Save mine as new persists local content then adopts the remote', async () => {
    const controller = makeController();
    pendingRemote(controller);
    const persisted: string[] = [];
    render(
      <Harness
        controller={controller}
        onSaveAsNew={async (local) => {
          persisted.push(local);
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save mine as new' }));

    await waitFor(() => expect(persisted).toEqual(['mine']));
    expect(controller.getSnapshot().currentContent).toBe('theirs');
  });

  it('renders a conflict state distinctly', async () => {
    const controller = makeController(async () => ({
      version: 'v1',
      conflict: { theirContent: 'server', baseContent: 'base', theirVersion: 'v2' },
    }));
    controller.load('base', 'v1');
    controller.markLocalChange('mine');
    await controller.requestSave('manual');
    render(<Harness controller={controller} />);

    expect(screen.getByText('Conflict needs review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(await screen.findAllByText('Conflict needs review')).toHaveLength(2); // pill + dialog title
  });

  it('hides entirely for read-only views', () => {
    const controller = makeController();
    pendingRemote(controller);
    render(<Harness controller={controller} readOnly />);
    expect(screen.queryByText('Remote changes available')).toBeNull();
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull();
  });
});
