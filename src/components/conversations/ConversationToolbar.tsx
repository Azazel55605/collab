import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown, Clock, Search, X } from 'lucide-react';

import { tauriCommands } from '../../lib/tauri';
import type { ConversationAccount } from '../../types/conversation';
import type { UserDirectoryEntry } from '../../types/vault';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';

import { readRecentSearches, saveRecentSearches } from './ConversationPreferences';

export type ChatAccount = ConversationAccount & {
  label: string;
  displayName?: string;
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
function AccountAvatar({ account }: { account: ChatAccount }) {
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
  return (
    <Avatar>
      <AvatarImage src={image} alt="" />
      <AvatarFallback>{accountName(account).slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
export function AccountSwitcher({
  accounts,
  selected,
  select,
}: {
  accounts: ChatAccount[];
  selected: ChatAccount;
  select: (account: ChatAccount) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="conversation-account" aria-label="Switch server account">
          <AccountAvatar
            key={JSON.stringify([selected.serverUrl, selected.accountId])}
            account={selected}
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
        {accounts.map((account) => (
          <DropdownMenuItem
            key={JSON.stringify([account.serverUrl, account.accountId])}
            onSelect={() => select(account)}
          >
            <AccountAvatar account={account} />
            <span>
              <strong>{accountName(account)}</strong>
              <small>
                {serverName(account.serverUrl)}
                {!account.connected ? ' · offline' : ''}
              </small>
            </span>
            {account.serverUrl === selected.serverUrl &&
              account.accountId === selected.accountId && <Check size={16} />}
          </DropdownMenuItem>
        ))}
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
    readRecentSearches(account.serverUrl, account.accountId),
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
  async function choose(person: UserDirectoryEntry) {
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      await openPerson(person);
      if (!alive.current) return;
      const next = [query.trim() || person.displayName || person.username, ...recent]
        .filter((item, i, all) => all.indexOf(item) === i)
        .slice(0, 5);
      setRecent(next);
      saveRecentSearches(account.serverUrl, account.accountId, next);
      setFocused(false);
      setQuery('');
      input.current?.blur();
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setOpening(false);
    }
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
              rows.length
                ? ((value < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : value) +
                    (event.key === 'ArrowDown' ? 1 : rows.length - 1) +
                    rows.length) %
                  rows.length
                : -1,
            );
          }
          if (event.key === 'Enter' && rows[active]) {
            event.preventDefault();
            void choose(rows[active]);
          }
        }}
      />
      {focused && (
        <div className="conversation-search-results">
          {!query && recent.length > 0 && (
            <>
              <div className="conversation-search-heading">
                <strong>Recent searches</strong>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Clear recent searches"
                  onClick={() => {
                    setRecent([]);
                    saveRecentSearches(account.serverUrl, account.accountId, []);
                  }}
                >
                  <X size={14} />
                </Button>
              </div>
              {recent.map((term) => (
                <Button
                  key={term}
                  variant="ghost"
                  className="conversation-search-recent"
                  onClick={() => {
                    setQuery(term);
                    input.current?.focus();
                  }}
                >
                  <Clock size={14} />
                  {term}
                </Button>
              ))}
            </>
          )}
          <strong className="conversation-search-heading">
            {query ? 'People' : 'Suggestions'}
          </strong>
          {opening && <p role="status">Opening chat…</p>}
          {loading && <p role="status">Searching…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && !rows.length && <p>No people found.</p>}
          <div id="conversation-people" role="listbox" aria-label="People">
            {rows.map((person, index) => (
              <Button
                key={person.userId}
                id={`conversation-person-${index}`}
                role="option"
                aria-selected={active === index}
                variant="ghost"
                className="conversation-person"
                disabled={opening}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void choose(person)}
              >
                <Avatar>
                  <AvatarFallback>
                    {(person.displayName || person.username).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span>
                  <strong>{person.displayName || person.username}</strong>
                  <small>@{person.username}</small>
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
