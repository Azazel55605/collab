import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVaultStore } from '../../store/vaultStore';
import type { HostedVaultMember, HostedVaultMeta } from '../../types/vault';

import { HostedMembersPanel } from './HostedMembersPanel';

const membersCapability = {
  list: vi.fn(),
  searchDirectory: vi.fn(),
  add: vi.fn(),
  updateRole: vi.fn(),
  remove: vi.fn(),
  listTemplates: vi.fn(),
  setCapabilities: vi.fn(),
  setTemplate: vi.fn(),
  resetToRoleDefault: vi.fn(),
};

vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({ runtime: { members: membersCapability } }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Controllable effective identity so self-row guards can be exercised.
const identityRef = vi.hoisted(() => ({ userId: 'nobody' }));
vi.mock('../../lib/collabIdentity', () => ({
  useCollabIdentity: () => ({
    userId: identityRef.userId,
    userName: 'Me',
    userColor: '#ffffff',
    source: 'server' as const,
  }),
}));

const loadHostedVaults = vi.fn().mockResolvedValue(undefined);
vi.mock('../../store/serverStore', () => ({
  useServerStore: (selector: (state: { loadHostedVaults: typeof loadHostedVaults }) => unknown) =>
    selector({ loadHostedVaults }),
}));

function setVault(role: HostedVaultMeta['role'], capabilities: string[] = []) {
  useVaultStore.setState({
    vault: {
      kind: 'hosted',
      id: 'vault-1',
      hostedVaultId: 'vault-1',
      serverUrl: 'https://collab.example.test',
      name: 'Team Vault',
      path: 'hosted://vault-1',
      lastOpened: 1,
      isEncrypted: false,
      role,
      capabilities,
    } satisfies HostedVaultMeta,
  } as Partial<ReturnType<typeof useVaultStore.getState>> as never);
}

const owner: HostedVaultMember = {
  userId: 'user-1',
  username: 'alice',
  displayName: 'Alice',
  role: 'admin',
  owner: true,
  createdAt: '2026-06-11T08:00:00Z',
  capabilities: [],
};
const editor: HostedVaultMember = {
  userId: 'user-2',
  username: 'bob',
  displayName: 'Bob',
  role: 'editor',
  owner: false,
  createdAt: '2026-06-11T08:00:00Z',
  capabilities: ['vault.read', 'file.write', 'note.edit'],
};

describe('HostedMembersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identityRef.userId = 'nobody';
    membersCapability.list.mockResolvedValue([owner, editor]);
    membersCapability.searchDirectory.mockResolvedValue([]);
    membersCapability.add.mockResolvedValue(undefined);
    membersCapability.updateRole.mockResolvedValue(undefined);
    membersCapability.remove.mockResolvedValue(undefined);
    membersCapability.listTemplates.mockResolvedValue([
      {
        id: 'tpl-1',
        name: 'reviewer',
        description: null,
        isBuiltin: false,
        capabilities: ['vault.read'],
        createdAt: '',
        updatedAt: '',
      },
    ]);
    membersCapability.setCapabilities.mockResolvedValue(editor);
    membersCapability.setTemplate.mockResolvedValue(editor);
    membersCapability.resetToRoleDefault.mockResolvedValue(editor);
  });

  it('lists members and protects the owner row', async () => {
    setVault('admin', ['vault.manageMembers', 'vault.managePermissions']);
    render(<HostedMembersPanel />);

    expect(await screen.findByText('Alice')).not.toBeNull();
    expect(screen.getByText('Bob')).not.toBeNull();
    expect(screen.getByText('Owner')).not.toBeNull();
    // Owner cannot be removed; the non-owner member can.
    expect(screen.getByLabelText('Remove Bob')).not.toBeNull();
    expect(screen.queryByLabelText('Remove Alice')).toBeNull();
  });

  it('hides management controls for non-admin members', async () => {
    setVault('editor', []);
    render(<HostedMembersPanel />);

    expect(await screen.findByText('Bob')).not.toBeNull();
    expect(screen.queryByText('Add member')).toBeNull();
    expect(screen.queryByLabelText('Remove Bob')).toBeNull();
  });

  it('fails closed when an admin role is missing member-management capability tokens', async () => {
    setVault('admin', []);
    render(<HostedMembersPanel />);

    expect(await screen.findByText('Bob')).not.toBeNull();
    expect(screen.queryByText('Add member')).toBeNull();
    expect(screen.queryByLabelText('Remove Bob')).toBeNull();
    expect(screen.getByText(/do not currently have vault\.managePermissions/)).not.toBeNull();
    expect(screen.queryByLabelText('Edit permissions for Bob')).toBeNull();
  });

  it('searches the directory and adds a selected user', async () => {
    membersCapability.searchDirectory.mockResolvedValue([
      { userId: 'user-9', username: 'carol', displayName: 'Carol' },
    ]);
    setVault('admin', ['vault.manageMembers']);
    render(<HostedMembersPanel />);
    await screen.findByText('Bob');

    fireEvent.change(screen.getByPlaceholderText('Search users by name or username…'), {
      target: { value: 'car' },
    });
    const result = await screen.findByText(/Carol/);
    fireEvent.click(result);
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));

    await waitFor(() => expect(membersCapability.add).toHaveBeenCalledWith('user-9', 'editor'));
  });

  it('removes a member through the capability', async () => {
    setVault('admin', ['vault.manageMembers']);
    render(<HostedMembersPanel />);
    await screen.findByText('Bob');

    fireEvent.click(screen.getByLabelText('Remove Bob'));
    await waitFor(() => expect(membersCapability.remove).toHaveBeenCalledWith('user-2'));
  });

  it('saves a custom capability override through the editor', async () => {
    setVault('admin', ['vault.manageMembers', 'vault.managePermissions']);
    render(<HostedMembersPanel />);
    await screen.findByText('Bob');

    fireEvent.click(screen.getByLabelText('Edit permissions for Bob'));
    fireEvent.click(await screen.findByRole('button', { name: 'Custom' }));
    // Bob starts with [vault.read, file.write, note.edit]; toggle file.write off.
    fireEvent.click(screen.getByLabelText('file.write'));
    fireEvent.click(screen.getByRole('button', { name: /Save permissions/ }));

    await waitFor(() =>
      expect(membersCapability.setCapabilities).toHaveBeenCalledWith('user-2', [
        'vault.read',
        'note.edit',
      ]),
    );
  });

  it('assigns a permission template through the editor', async () => {
    setVault('admin', ['vault.manageMembers', 'vault.managePermissions']);
    render(<HostedMembersPanel />);
    await screen.findByText('Bob');

    fireEvent.click(screen.getByLabelText('Edit permissions for Bob'));
    fireEvent.click(await screen.findByRole('button', { name: 'Template' }));
    // Open the template select and pick the reviewer template.
    fireEvent.click(await screen.findByText('Select a template…'));
    fireEvent.click(await screen.findByText(/reviewer/));
    fireEvent.click(screen.getByRole('button', { name: /Save permissions/ }));

    await waitFor(() =>
      expect(membersCapability.setTemplate).toHaveBeenCalledWith('user-2', 'tpl-1'),
    );
  });

  it('resets a member to the role default through the editor', async () => {
    setVault('admin', ['vault.manageMembers', 'vault.managePermissions']);
    render(<HostedMembersPanel />);
    await screen.findByText('Bob');

    fireEvent.click(screen.getByLabelText('Edit permissions for Bob'));
    // The dialog defaults to "Role default" because Bob has no override.
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/ }));

    await waitFor(() =>
      expect(membersCapability.resetToRoleDefault).toHaveBeenCalledWith('user-2'),
    );
  });

  it('prevents an admin from removing their own management permissions', async () => {
    // A non-owner member who is the current user and holds the management caps.
    const selfManager: HostedVaultMember = {
      userId: 'self-1',
      username: 'sam',
      displayName: 'Sam',
      role: 'editor',
      owner: false,
      createdAt: '2026-06-11T08:00:00Z',
      capabilities: ['vault.read', 'vault.manageMembers', 'vault.managePermissions'],
      customCapabilities: ['vault.read', 'vault.manageMembers', 'vault.managePermissions'],
    };
    identityRef.userId = 'self-1';
    membersCapability.list.mockResolvedValue([owner, selfManager]);
    setVault('admin', ['vault.manageMembers', 'vault.managePermissions']);
    render(<HostedMembersPanel />);
    await screen.findByText('Sam');

    fireEvent.click(screen.getByLabelText('Edit permissions for Sam'));
    fireEvent.click(await screen.findByRole('button', { name: 'Custom' }));

    // The two management capabilities are locked on for the current user.
    const managePerms = screen.getByLabelText('vault.managePermissions') as HTMLButtonElement;
    const manageMembers = screen.getByLabelText('vault.manageMembers') as HTMLButtonElement;
    expect(managePerms.disabled).toBe(true);
    expect(manageMembers.disabled).toBe(true);
    expect(managePerms.getAttribute('data-state')).toBe('checked');

    // Toggling read off still leaves the management caps, so saving is allowed.
    fireEvent.click(screen.getByLabelText('vault.read'));
    fireEvent.click(screen.getByRole('button', { name: /Save permissions/ }));
    await waitFor(() =>
      expect(membersCapability.setCapabilities).toHaveBeenCalledWith('self-1', [
        'vault.manageMembers',
        'vault.managePermissions',
      ]),
    );
  });
});
