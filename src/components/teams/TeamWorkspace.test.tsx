import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { TeamRequest } from '../../types/team';

import { TeamWorkspace } from './TeamWorkspace';

function setup(owner = false, serverAdmin = false) {
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path === '')
      return [
        { id: 'team', name: 'Engineering', role: owner ? 'owner' : 'member', archived: false },
      ];
    if (method === 'GET' && path.endsWith('/channels'))
      return [
        { id: 'public', name: 'General', private: false, archived: false, libraryVaultId: null },
        { id: 'private', name: 'Design', private: true, archived: false, libraryVaultId: 'vault' },
      ];
    if (method === 'GET' && path.endsWith('/members'))
      return [
        { userId: 'me', displayName: 'Alice', role: owner ? 'owner' : 'member', active: true },
        { userId: 'bob', displayName: 'Bob', role: 'member', active: true },
      ];
    return undefined;
  });
  const open = vi.fn();
  const directory = vi.fn().mockResolvedValue([{ userId: 'bob', displayName: 'Bob' }]);
  const props = {
    request: request as TeamRequest,
    directory,
    channelMembers: vi
      .fn()
      .mockResolvedValue([{ userId: 'me', displayName: 'Alice', role: 'owner', active: true }]),
    serverAdmin,
    accountId: 'me',
    connected: true,
    openChannel: open,
  };
  return { request, open, directory, props };
}
it('opens authorized channels without exposing owner/admin controls to a member', async () => {
  const { props, open } = setup();
  render(<TeamWorkspace {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Engineering/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Private · Design' }));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'private', libraryVaultId: 'vault' }),
  );
  expect(screen.queryByText('Create team')).toBeNull();
  expect(screen.queryByText('Create channel')).toBeNull();
  expect(screen.queryByText('Make owner')).toBeNull();
});
it('shows team creation only to server admins and uses the selected server identity', async () => {
  const { props, request } = setup(false, true);
  render(<TeamWorkspace {...props} />);
  fireEvent.change(screen.getByLabelText('New team name'), { target: { value: 'Research' } });
  fireEvent.change(screen.getByLabelText('Find a person'), { target: { value: 'bob' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Bob' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('POST', '', { name: 'Research', ownerId: 'bob' }),
  );
});
it('owners create private channels and restore an archived team', async () => {
  const { props, request } = setup(true);
  render(<TeamWorkspace {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Engineering/ }));
  await screen.findByRole('button', { name: 'Private · Design' });
  fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'Planning' } });
  fireEvent.click(screen.getByRole('button', { name: 'Private channel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('POST', '/team/channels', {
      name: 'Planning',
      private: true,
      members: [],
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Archive team' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('PATCH', '/team', { name: 'Engineering', archived: true }),
  );
});
it('clears names and membership controls when the server revokes team access', async () => {
  const { props, request } = setup(true);
  const view = render(<TeamWorkspace {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Engineering/ }));
  await screen.findByRole('button', { name: 'Private · Design' });
  view.rerender(<TeamWorkspace {...props} connected={false} />);
  expect(screen.queryByRole('button', { name: 'Private · Design' })).toBeNull();
  expect(screen.queryByText('Alice · owner')).toBeNull();
  request.mockRejectedValue(new Error('Membership revoked'));
  view.rerender(<TeamWorkspace {...props} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Engineering · owner')).toBeNull();
});

it('fetches private channel membership only when its controls are opened', async () => {
  const { props, request } = setup(true);
  render(<TeamWorkspace {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Engineering/ }));
  await screen.findByRole('button', { name: 'Private · Design' });
  expect(props.channelMembers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Manage Design'));
  await screen.findByRole('button', { name: 'Remove from channel' });
  expect(props.channelMembers).toHaveBeenCalledWith('private');
  fireEvent.click(screen.getByRole('button', { name: 'Invite to channel' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('POST', '/team/channels/private/members', {
      userId: 'bob',
      role: 'member',
    }),
  );
});
