import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentStatusStore } from '../../store/documentStatusStore';
import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';

import StatusBar from './StatusBar';

vi.mock('../collaboration/PresenceBar', () => ({
  default: () => <span data-testid="presence-bar" />,
}));

const syncCenterProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./SyncCenter', () => ({
  default: (props: unknown) => {
    syncCenterProps.current = props;
    return <span data-testid="sync-center">Sync</span>;
  },
}));

vi.mock('../notifications/NotificationCenter', () => ({
  default: () => <span data-testid="notification-center" />,
}));

describe('StatusBar', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vault: { id: 'v1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
    } as never);
    useEditorStore.setState({
      openTabs: [
        { relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' },
      ],
      activeTabPath: 'Notes/a.md',
    } as never);
    useNoteIndexStore.setState({ notes: [] } as never);
    useDocumentStatusStore.setState({ statuses: {} });
  });

  afterEach(() => {
    cleanup();
    useDocumentStatusStore.setState({ statuses: {} });
  });

  it('hands the active document to the sync center, between people and notifications', () => {
    useDocumentStatusStore.getState().setDocumentStatus('Notes/a.md', { status: 'conflict' });

    render(<StatusBar />);

    expect(syncCenterProps.current).toMatchObject({
      document: { relativePath: 'Notes/a.md', status: { status: 'conflict' } },
    });
    const presence = screen.getByTestId('presence-bar');
    const sync = screen.getByTestId('sync-center');
    const bell = screen.getByTestId('notification-center');
    expect(presence.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sync.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves document save status to the document header', () => {
    useDocumentStatusStore.getState().setDocumentStatus('Notes/a.md', { status: 'dirty' });

    render(<StatusBar />);

    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });
});
