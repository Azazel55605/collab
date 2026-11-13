import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '../../../store/uiStore';

import { VaultlessWorkspace } from './VaultlessWorkspace';

describe('VaultlessWorkspace', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'chats', isSettingsOpen: false } as never);
  });

  it('shows the start rail beside the page with the current destination marked', () => {
    render(
      <VaultlessWorkspace current="chats">
        <p>chat page</p>
      </VaultlessWorkspace>,
    );

    expect(screen.getByText('chat page')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Vaults' }).getAttribute('aria-current')).toBeNull();
    // The server list belongs to the vault list only.
    expect(screen.queryByRole('heading', { name: 'Servers' })).toBeNull();
  });

  it('navigates back to the vault list, across to databases, and opens settings', () => {
    render(
      <VaultlessWorkspace current="chats">
        <p>chat page</p>
      </VaultlessWorkspace>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Databases' }));
    expect(useUiStore.getState().activeView).toBe('databases');
    fireEvent.click(screen.getByRole('button', { name: 'Vaults' }));
    expect(useUiStore.getState().activeView).toBe('editor');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUiStore.getState().isSettingsOpen).toBe(true);
  });
});
