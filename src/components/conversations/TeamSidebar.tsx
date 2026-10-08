import { useEffect, useState } from 'react';

import { ChevronDown, ChevronRight, Hash, Settings2 } from 'lucide-react';

import { nativeTeamRequest } from '../../lib/teams';
import type { TeamChannel, TeamSummary } from '../../types/team';
import { Button } from '../ui/button';

import type { ChatAccount } from './ConversationToolbar';
import { NameAvatar } from './ConversationVisuals';

export function TeamSidebar({
  account,
  selected,
  open,
  manage,
  collapsible = true,
}: {
  account: ChatAccount;
  selected?: string;
  open: (id: string) => void;
  manage: () => void;
  /** The combined layout folds teams under a heading; the separate tab does not. */
  collapsible?: boolean;
}) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [folded, setCollapsed] = useState(false);
  const collapsed = collapsible && folded;
  const [channels, setChannels] = useState<TeamChannel[]>([]);
  const [after, setAfter] = useState<string>();
  const [error, setError] = useState('');
  // Polls refresh quietly; only the first load shows a loading line.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    let running = false;
    setChannels([]);
    setError('');
    if (!account.connected) {
      setTeams([]);
      return;
    }
    const request = nativeTeamRequest({
      serverUrl: account.serverUrl,
      accountId: account.accountId,
    });
    async function refresh() {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const list = await request<TeamSummary[]>(
          'GET',
          after ? `?after=${encodeURIComponent(after)}` : '',
        );
        const children =
          expanded && list.some((team) => team.id === expanded)
            ? await request<TeamChannel[]>('GET', `/${expanded}/channels`)
            : [];
        if (alive) {
          setTeams(list);
          setChannels(children);
          setError('');
          setLoaded(true);
        }
      } catch (reason) {
        if (alive) {
          setTeams([]);
          setChannels([]);
          setError(String(reason));
        }
      } finally {
        running = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [account.serverUrl, account.accountId, account.connected, expanded, after]);
  return (
    <nav className="conversation-team-nav" aria-label="Teams and channels">
      <header>
        <h2>
          {collapsible ? (
            <Button
              variant="ghost"
              className="conversation-team-toggle"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              Teams
            </Button>
          ) : (
            'Your teams'
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Manage teams"
          onClick={manage}
          disabled={!account.connected}
        >
          <Settings2 size={16} />
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!collapsed &&
        teams
          .filter((team) => !team.archived)
          .map((team) => (
            <div key={team.id}>
              <Button
                variant="ghost"
                className="conversation-team-row"
                aria-expanded={expanded === team.id}
                onClick={() => setExpanded((value) => (value === team.id ? null : team.id))}
              >
                <NameAvatar name={team.name} size="sm" square />
                <span>{team.name}</span>
              </Button>
              {expanded === team.id &&
                channels
                  .filter((channel) => !channel.archived)
                  .map((channel) => (
                    <Button
                      key={channel.id}
                      variant="ghost"
                      className="conversation-channel-row"
                      aria-pressed={selected === channel.id}
                      onClick={() => open(channel.id)}
                    >
                      <Hash size={16} />
                      <span>
                        {channel.name}
                        {channel.private ? ' · private' : ''}
                      </span>
                      {channel.unread > 0 && (
                        <span className="conversation-unread">{channel.unread}</span>
                      )}
                    </Button>
                  ))}
            </div>
          ))}
      {!collapsed && !loaded && !error && <p role="status">Loading teams…</p>}
      {!collapsed && loaded && !teams.length && !error && (
        <p className="conversation-sidebar-hint">No teams yet.</p>
      )}
      {after && (
        <Button variant="ghost" onClick={() => setAfter(undefined)}>
          First teams
        </Button>
      )}
      {teams.length === 100 && (
        <Button variant="ghost" onClick={() => setAfter(teams[teams.length - 1].id)}>
          More teams
        </Button>
      )}
    </nav>
  );
}
