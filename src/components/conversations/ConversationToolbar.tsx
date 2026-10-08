import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown, Search, Settings, UserPlus, X } from 'lucide-react';

import { tauriCommands } from '../../lib/tauri';
import type { ConversationAccount } from '../../types/conversation';
import type { UserDirectoryEntry } from '../../types/vault';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';

import { readRecentPeople, type RecentPerson, saveRecentPeople } from './ConversationPreferences';
import { NameAvatar } from './ConversationVisuals';

export type ChatAccount = ConversationAccount & {
  label: string;
  displayName?: string;
  username?: string;
  connected: boolean;
  serverAdmin?: boolean;
  hasAvatar?: boolean;
  avatarUpdatedAt?: string | null;
};
function accountName(account: ChatAccount) {
  return account.displayName || account.label.split(' · ')[0];
}
function serverName(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
function accountAddress(account: ChatAccount) {
  const host = serverName(account.serverUrl);
  return account.username ? `${account.username}@${host}` : host;
}
function AccountAvatar({ account, size }: { account: ChatAccount; size?: 'md' | 'lg' }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let alive = true;
    setImage(undefined);
    if (account.connected && account.hasAvatar)
      void tauriCommands
        .hostedAccountRequest<string>(
          account.serverUrl,
          'GET',
          `/api/v1/users/${account.accountId}/avatar`,
        )
        .then((data) => {
          if (alive) setImage(data);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [
    account.serverUrl,
    account.accountId,
    account.connected,
    account.hasAvatar,
    account.avatarUpdatedAt,
  ]);
  return <NameAvatar name={accountName(account)} picture={image} size={size} />;
}
export function AccountSwitcher({
  accounts,
  selected,
  select,
  openSettings,
}: {
  accounts: ChatAccount[];
  selected: ChatAccount;
  select: (account: ChatAccount) => void;
  openSettings?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="conversation-account" aria-label="Switch server account">
          <AccountAvatar
            key={JSON.stringify([selected.serverUrl, selected.accountId])}
            account={selected}
            size="lg"
          />
          <span>
            <strong>{accountName(selected)}</strong>
            <small>
              {serverName(selected.serverUrl)}
              {!selected.connected ? ' · offline' : ''}
            </small>
          </span>
          <ChevronDown size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="conversation-account-menu">
        {accounts.map((account) => {
          const current =
            account.serverUrl === selected.serverUrl && account.accountId === selected.accountId;
          return (
            <DropdownMenuItem
              key={JSON.stringify([account.serverUrl, account.accountId])}
              data-current={current || undefined}
              onSelect={() => select(account)}
            >
              <AccountAvatar account={account} size="lg" />
              <span>
                <strong>{accountName(account)}</strong>
                <small>
                  {accountAddress(account)}
                  {!account.connected ? ' · offline' : ''}
                </small>
              </span>
              {current && <Check size={16} aria-label="Current account" />}
            </DropdownMenuItem>
          );
        })}
        {openSettings && (
          <>
            <DropdownMenuSeparator className="conversation-menu-separator" />
            <DropdownMenuItem className="conversation-account-settings" onSelect={openSettings}>
              <Settings size={18} />
              Account settings
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function PeopleSearch({
  account,
  openPerson,
}: {
  account: ChatAccount;
  openPerson: (person: UserDirectoryEntry) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [rows, setRows] = useState<UserDirectoryEntry[]>([]);
  const [recent, setRecent] = useState(() =>
    readRecentPeople(account.serverUrl, account.accountId),
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setRows([]);
    setError('');
    setActive(-1);
    if (!focused || !account.connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void tauriCommands
        .hostedUserDirectory(account.serverUrl, query.trim(), account.accountId)
        .then((people) => {
          if (current) setRows(people.filter((person) => person.userId !== account.accountId));
        })
        .catch((reason) => {
          if (current) setError(String(reason));
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, focused, account.serverUrl, account.accountId, account.connected]);
  const showRecent = !query && recent.length > 0;
  const suggestions = showRecent
    ? rows.filter((row) => !recent.some((person) => person.userId === row.userId))
    : rows;
  // Keyboard navigation walks recent people first, then directory results.
  const options: RecentPerson[] = showRecent ? [...recent, ...suggestions] : suggestions;
  function remember(next: RecentPerson[]) {
    setRecent(next);
    saveRecentPeople(account.serverUrl, account.accountId, next);
  }
  async function choose(person: RecentPerson) {
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      await openPerson(person);
      if (!alive.current) return;
      remember(
        [
          { userId: person.userId, username: person.username, displayName: person.displayName },
          ...recent.filter((item) => item.userId !== person.userId),
        ].slice(0, 5),
      );
      setFocused(false);
      setQuery('');
      input.current?.blur();
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setOpening(false);
    }
  }
  function option(person: RecentPerson, index: number, isRecent: boolean) {
    const name = person.displayName || person.username;
    return (
      <div
        key={`${isRecent ? 'recent' : 'person'}-${person.userId}`}
        className={`conversation-person-row ${isRecent ? 'recent' : ''}`}
      >
        <Button
          id={`conversation-person-${index}`}
          role="option"
          aria-selected={active === index}
          variant="ghost"
          className="conversation-person"
          disabled={opening}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void choose(person)}
        >
          <NameAvatar name={name} size={isRecent ? 'sm' : 'md'} />
          <span>
            <strong>{name}</strong>
            {!isRecent && <small>@{person.username}</small>}
          </span>
          {!isRecent && <UserPlus size={16} aria-hidden="true" />}
        </Button>
        {isRecent && (
          <Button
            variant="ghost"
            size="icon"
            className="conversation-person-remove"
            aria-label={`Remove ${name} from recent searches`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => remember(recent.filter((item) => item.userId !== person.userId))}
          >
            <X size={14} />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      className="conversation-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Search size={18} aria-hidden="true" />
      <Input
        ref={input}
        role="combobox"
        aria-label="Search people on this server"
        aria-expanded={focused}
        aria-controls="conversation-people"
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `conversation-person-${active}` : undefined}
        placeholder="Search people on this server"
        value={query}
        maxLength={200}
        disabled={!account.connected}
        readOnly={opening}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setFocused(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setFocused(false);
            input.current?.blur();
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setFocused(true);
            setActive((value) =>
              options.length
                ? ((value < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : value) +
                    (event.key === 'ArrowDown' ? 1 : options.length - 1) +
                    options.length) %
                  options.length
                : -1,
            );
          }
          if (event.key === 'Enter' && options[active]) {
            event.preventDefault();
            void choose(options[active]);
          }
        }}
      />
      {focused && (
        <div
          className="conversation-search-results"
          id="conversation-people"
          role="listbox"
          aria-label="People"
        >
          {showRecent && (
            <div role="group" aria-label="Recent searches">
              <div className="conversation-search-heading">
                <strong>Recent searches</strong>
                <Button
                  variant="ghost"
                  className="conversation-search-clear"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => remember([])}
                >
                  Clear all
                </Button>
              </div>
              {recent.map((person, index) => option(person, index, true))}
            </div>
          )}
          <div role="group" aria-label={query ? 'People' : 'Suggestions'}>
            <div className="conversation-search-heading">
              <strong>{query ? 'People' : 'Suggestions'}</strong>
            </div>
            {opening && <p role="status">Opening chat…</p>}
            {loading && <p role="status">Searching…</p>}
            {error && <p role="alert">{error}</p>}
            {!loading && !error && !suggestions.length && <p>No people found.</p>}
            {suggestions.map((person, index) =>
              option(person, (showRecent ? recent.length : 0) + index, false),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
