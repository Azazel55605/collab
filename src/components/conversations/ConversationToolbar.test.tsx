import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';

import {
  readChatLayout,
  readRecentSearches,
  saveChatLayout,
  saveRecentSearches,
} from './ConversationPreferences';
import { AccountSwitcher, PeopleSearch } from './ConversationToolbar';

vi.mock('../../lib/tauri', () => ({
  tauriCommands: { hostedUserDirectory: vi.fn(), hostedAccountRequest: vi.fn() },
}));
const account = {
  serverUrl: 'https://one.test',
  accountId: 'me',
  label: 'Me',
  connected: true,
  hasAvatar: true,
};
const person = { userId: 'other', username: 'other', displayName: 'Other' };
beforeEach(() => {
  localStorage.clear();
  vi.mocked(tauriCommands.hostedUserDirectory).mockResolvedValue([person]);
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValue('data:image/png;base64,YWJj');
});
it('opens a suggested person using the keyboard and records a scoped recent search', async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  render(<PeopleSearch account={account} openPerson={open} />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  await screen.findByRole('option', { name: /Other/ });
  expect(tauriCommands.hostedUserDirectory).toHaveBeenCalledWith('https://one.test', '', 'me');
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(open).toHaveBeenCalledWith(person));
  await waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('false'));
  expect(readRecentSearches('https://one.test', 'me')).toEqual(['Other']);
  expect(readRecentSearches('https://two.test', 'me')).toEqual([]);
  expect(readRecentSearches('https://one.test', 'another')).toEqual([]);
});
it('re-runs recent queries against the server rather than persisting stale directory results', async () => {
  saveRecentSearches(account.serverUrl, account.accountId, ['someone']);
  render(<PeopleSearch account={account} openPerson={vi.fn()} />);
  fireEvent.focus(screen.getByRole('combobox'));
  fireEvent.click(screen.getByRole('button', { name: 'someone' }));
  await waitFor(() =>
    expect(tauriCommands.hostedUserDirectory).toHaveBeenCalledWith(
      'https://one.test',
      'someone',
      'me',
    ),
  );
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('someone');
});
it('ignores a late directory response after the search changes', async () => {
  let resolve!: (people: (typeof person)[]) => void;
  vi.mocked(tauriCommands.hostedUserDirectory).mockImplementation((_server, query) =>
    query === ''
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve([{ ...person, displayName: 'New result' }]),
  );
  render(<PeopleSearch account={account} openPerson={vi.fn()} />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.change(input, { target: { value: 'new' } });
  await screen.findByRole('option', { name: /New result/ });
  resolve([person]);
  await waitFor(() => expect(screen.queryByRole('option', { name: /^OT Other/ })).toBeNull());
  expect(screen.getByRole('option', { name: /New result/ })).not.toBeNull();
});
it('keeps search failures visible and does not record a failed chat opening', async () => {
  render(
    <PeopleSearch
      account={account}
      openPerson={vi.fn().mockRejectedValue(new Error('Membership unavailable'))}
    />,
  );
  fireEvent.focus(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: /Other/ }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Membership unavailable');
  expect(readRecentSearches(account.serverUrl, account.accountId)).toEqual([]);
});
it('loads an authenticated avatar for the explicit server account and stops offline searches', async () => {
  render(
    <>
      <AccountSwitcher accounts={[account]} selected={account} select={vi.fn()} />
      <PeopleSearch account={{ ...account, connected: false }} openPerson={vi.fn()} />
    </>,
  );
  await waitFor(() =>
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      'https://one.test',
      'GET',
      '/api/v1/users/me/avatar',
    ),
  );
  expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true);
  expect(tauriCommands.hostedUserDirectory).not.toHaveBeenCalled();
});
it('persists the chat layout and safely bounds or discards malformed search storage', () => {
  saveChatLayout('separate');
  expect(readChatLayout()).toBe('separate');
  saveRecentSearches('server', 'account', ['1', '2', '3', '4', '5', '6']);
  expect(readRecentSearches('server', 'account')).toHaveLength(5);
  localStorage.setItem('collab.people-search:["server","account"]', 'broken');
  expect(readRecentSearches('server', 'account')).toEqual([]);
});
