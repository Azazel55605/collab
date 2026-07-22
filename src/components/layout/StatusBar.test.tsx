import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StatusBar from './StatusBar';
import { useDocumentStatusStore } from '../../store/documentStatusStore';
import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';

vi.mock('../collaboration/PresenceBar', () => ({
  default: () => <span data-testid="presence-bar" />,
}));

vi.mock('./HostedConnectionStatus', () => ({
  default: () => <span data-testid="hosted-connection-status" />,
}));

vi.mock('./SyncStatusIndicator', () => ({
  default: () => <span data-testid="sync-indicator">Sync</span>,
}));

vi.mock('./CalendarSyncStatusIndicator', () => ({
  default: () => <span data-testid="calendar-sync-indicator" />,
}));

describe('StatusBar', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vault: { id: 'v1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
    } as never);
    useEditorStore.setState({
      openTabs: [{ relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' }],
      activeTabPath: 'Notes/a.md',
    } as never);
    useNoteIndexStore.setState({ notes: [] } as never);
    useDocumentStatusStore.setState({ statuses: {} });
  });

  afterEach(() => {
    cleanup();
    useDocumentStatusStore.setState({ statuses: {} });
  });

  it('renders active document status next to the sync indicator', () => {
    useDocumentStatusStore.getState().setDocumentStatus('Notes/a.md', { status: 'dirty' });

    render(<StatusBar />);

    const sync = screen.getByTestId('sync-indicator');
    const status = screen.getByText('Unsaved changes');
    expect(sync.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not show a saved pill for clean documents', () => {
    useDocumentStatusStore.getState().setDocumentStatus('Notes/a.md', { status: 'idle' });

    render(<StatusBar />);

    expect(screen.queryByText('Saved')).toBeNull();
  });
});
