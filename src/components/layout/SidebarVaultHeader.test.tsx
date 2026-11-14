import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import { SidebarVaultHeader } from './SidebarVaultHeader';

describe('SidebarVaultHeader', () => {
  const closeVault = vi.fn();
  const openVaultManager = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({
      vault: { id: 'v', name: 'Notes', path: '/home/me/notes', lastOpened: 0, isEncrypted: false },
      closeVault,
    } as never);
    useUiStore.setState({ openVaultManager } as never);
  });

  it('closes the vault from the vault menu, returning to the start screen', async () => {
    render(<SidebarVaultHeader />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Vault menu: Notes' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Close vault/ }));
    expect(closeVault).toHaveBeenCalled();
  });

  it('opens the vault manager from the vault menu', async () => {
    render(<SidebarVaultHeader />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Vault menu: Notes' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Vault manager/ }));
    expect(openVaultManager).toHaveBeenCalled();
  });
});
