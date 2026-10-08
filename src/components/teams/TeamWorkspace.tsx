import { useEffect, useRef, useState } from 'react';

import type {
  TeamChannel,
  TeamMember,
  TeamPerson,
  TeamRequest,
  TeamSummary,
} from '../../types/team';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

import './teams.css';

/** The same membership and channel controls are used by all three clients. */
export function TeamWorkspace({
  request,
  directory,
  channelMembers,
  serverAdmin,
  accountId,
  connected,
  openChannel,
  registerBack,
}: {
  request: TeamRequest;
  directory: (query: string) => Promise<TeamPerson[]>;
  channelMembers: (id: string) => Promise<TeamMember[]>;
  serverAdmin: boolean;
  accountId: string;
  connected: boolean;
  openChannel: (channel: TeamChannel) => void;
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [channels, setChannels] = useState<TeamChannel[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [privateChannel, setPrivate] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [person, setPerson] = useState('');
  const [library, setLibrary] = useState('');
  const [after, setAfter] = useState<string | undefined>();
  const [oversight, setOversight] = useState('');
  const [managed, setManaged] = useState<string | null>(null);
  const current = useRef(team);
  current.current = team;
  const generation = useRef(0);
  const ticket = useRef(0);
  const owner = team?.role === 'owner';
  useEffect(() => {
    if (team)
      return registerBack?.(() => {
        ticket.current++;
        current.current = null;
        setTeam(null);
        setChannels([]);
        setMembers([]);
      });
  }, [team, registerBack]);
  useEffect(() => {
    const gen = ++generation.current;
    let loading = false;
    setBusy(false);
    setTeams([]);
    setTeam(null);
    current.current = null;
    setChannels([]);
    setMembers([]);
    setError('');
    if (!connected) return;
    async function refresh() {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      let selectedId: string | undefined;
      try {
        const list = await request<TeamSummary[]>(
          'GET',
          `${after ? `?after=${encodeURIComponent(after)}` : ''}`,
        );
        if (gen !== generation.current) return;
        setTeams(list);
        const selected = current.current;
        selectedId = selected?.id;
        if (selected) {
          const match = list.find((t) => t.id === selected.id);
          if (!match) {
            setTeam(null);
            setChannels([]);
            setMembers([]);
            return;
          }
          const [chs, ms] = await Promise.all([
            request<TeamChannel[]>('GET', `/${selected.id}/channels`),
            request<TeamMember[]>('GET', `/${selected.id}/members`),
          ]);
          if (gen !== generation.current || current.current?.id !== selected.id) return;
          setTeam(match);
          setChannels(chs);
          setMembers(ms);
        }
        setError('');
      } catch (reason) {
        if (gen === generation.current && (!selectedId || current.current?.id === selectedId)) {
          setTeams([]);
          setTeam(null);
          setChannels([]);
          setMembers([]);
          setError(String(reason));
        }
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      generation.current = gen + 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [request, connected, after]);
  async function select(value: TeamSummary) {
    const n = ++ticket.current;
    current.current = value;
    setTeam(value);
    setChannels([]);
    setMembers([]);
    setName('');
    setPerson('');
    setError('');
    try {
      const [chs, ms] = await Promise.all([
        request<TeamChannel[]>('GET', `/${value.id}/channels`),
        request<TeamMember[]>('GET', `/${value.id}/members`),
      ]);
      if (n === ticket.current && current.current?.id === value.id) {
        setChannels(chs);
        setMembers(ms);
      }
    } catch (reason) {
      if (n === ticket.current) {
        setTeam(null);
        setError(String(reason));
      }
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (busy || !connected) return;
    const gen = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
      if (gen !== generation.current) return;
      const list = await request<TeamSummary[]>('GET', after ? `?after=${after}` : '');
      if (gen !== generation.current) return;
      setTeams(list);
      const selected = current.current;
      if (selected) {
        const updated = list.find((t) => t.id === selected.id);
        if (updated) await select(updated);
        else {
          setTeam(null);
          setChannels([]);
          setMembers([]);
        }
      }
      setName('');
    } catch (reason) {
      if (gen === generation.current) setError(String(reason));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    setPeople([]);
    setPerson('');
    if (!query.trim() || !connected) return;
    const timer = setTimeout(() => {
      void directory(query.trim())
        .then((rows) => {
          if (alive) setPeople(rows);
        })
        .catch((reason) => {
          if (alive) setError(String(reason));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, directory, connected]);
  const path = team ? `/${team.id}` : '';
  const creationFields = (
    <>
      <label>
        {team ? 'Channel name' : 'New team name'}
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Find a person
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search server accounts"
        />
      </label>
      <div className="team-actions" aria-label="People">
        {people.map((p) => (
          <Button
            key={p.userId}
            variant="outline"
            aria-pressed={person === p.userId}
            onClick={() => setPerson(p.userId)}
          >
            {p.displayName}
          </Button>
        ))}
      </div>
    </>
  );
  return (
    <section className="team-workspace" aria-label="Teams and channels">
      <header>
        <h2>{team ? team.name : 'Teams'}</h2>
        {team && (
          <Button
            onClick={() => {
              ticket.current++;
              current.current = null;
              setTeam(null);
              setChannels([]);
              setMembers([]);
            }}
          >
            Back to teams
          </Button>
        )}
      </header>
      {!connected && <p role="status">Reconnect this server to open teams.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="team-scroll">
        {!team && (
          <>
            {!teams.length && connected && (
              <p>
                No teams on this page. A server admin can create a team and assign its first owner.
              </p>
            )}
            {teams.map((t) => (
              <Button key={t.id} variant="outline" onClick={() => void select(t)}>
                {t.name} · {t.role}
                {t.archived ? ' · archived' : ''}
              </Button>
            ))}
            <div className="team-actions">
              {after && <Button onClick={() => setAfter(undefined)}>Latest teams</Button>}
              {teams.length === 100 && (
                <Button onClick={() => setAfter(teams[teams.length - 1]?.id)}>Next teams</Button>
              )}
            </div>
          </>
        )}
        {serverAdmin && !team && (
          <>
            {creationFields}
            <p>
              The selected person becomes the first team owner. Team ownership is independent of
              server administration.
            </p>
            <Button
              disabled={busy || !connected || !name.trim() || !person}
              onClick={() => void run(() => request('POST', '', { name, ownerId: person }))}
            >
              Create team
            </Button>
            <details>
              <summary>Administrative oversight</summary>
              <p>
                Claim team ownership by ID. This records an audit event and grants access to public
                channels. Private channels require a separate invitation.
              </p>
              <Input
                aria-label="Team ID for oversight"
                value={oversight}
                onChange={(e) => setOversight(e.target.value)}
              />
              <Button
                disabled={busy || !connected || !oversight}
                onClick={() => void run(() => request('POST', `/${oversight}/oversight`))}
              >
                Claim ownership with audit
              </Button>
            </details>
          </>
        )}
        {team && (
          <>
            {team.archived && (
              <p role="status">
                This team is archived. Restore it to use its channels and libraries.
              </p>
            )}
            <h3>Channels</h3>
            {channels.map((ch) => (
              <div className="team-channel" key={ch.id}>
                <Button
                  variant="outline"
                  disabled={team.archived || ch.archived || !connected}
                  onClick={() => openChannel(ch)}
                >
                  {ch.private ? 'Private' : 'Public'} · {ch.name}
                  {ch.archived ? ' · archived' : ''}
                  {!!ch.unread && (
                    <span aria-label={`${ch.unread} unread messages`}> · {ch.unread} unread</span>
                  )}
                </Button>
                {ch.libraryVaultId && (
                  <p>
                    Linked library: <code>{ch.libraryVaultId}</code>. Open it in Files with this
                    server account.
                  </p>
                )}
                {owner && !team.archived && (
                  <details open={managed === ch.id}>
                    <summary
                      onClick={(event) => {
                        event.preventDefault();
                        setManaged(managed === ch.id ? null : ch.id);
                      }}
                    >
                      Manage {ch.name}
                    </summary>
                    <Button
                      disabled={busy || !connected}
                      onClick={() =>
                        void run(() =>
                          request('PATCH', `${path}/channels/${ch.id}`, {
                            name: ch.name,
                            archived: !ch.archived,
                          }),
                        )
                      }
                    >
                      {ch.archived ? 'Restore channel' : 'Archive channel'}
                    </Button>
                    <TeamRename
                      value={ch.name}
                      label={`Rename ${ch.name}`}
                      disabled={busy || !connected}
                      save={(value) =>
                        void run(() =>
                          request('PATCH', `${path}/channels/${ch.id}`, {
                            name: value,
                            archived: ch.archived,
                          }),
                        )
                      }
                    />
                    {ch.private && managed === ch.id && !ch.archived && (
                      <PrivateChannelPeople
                        id={ch.id}
                        load={channelMembers}
                        teamMembers={members}
                        disabled={busy || !connected}
                        change={(userId, role) =>
                          run(() =>
                            request('POST', `${path}/channels/${ch.id}/members`, { userId, role }),
                          )
                        }
                      />
                    )}
                    <label>
                      Library vault ID
                      <Input
                        value={library}
                        onChange={(e) => setLibrary(e.target.value)}
                        placeholder="An active vault you own"
                      />
                    </label>
                    <p>
                      Linking adds channel membership as a requirement. Existing file grants remain
                      required. Detaching restores the vault's previous access rules.
                    </p>
                    <Button
                      disabled={busy || !connected || !library}
                      onClick={() =>
                        void run(() =>
                          request('POST', `${path}/channels/${ch.id}/library`, {
                            vaultId: library,
                          }),
                        )
                      }
                    >
                      Link library
                    </Button>
                    {ch.libraryVaultId && (
                      <Button
                        disabled={busy || !connected}
                        onClick={() =>
                          void run(() =>
                            request('POST', `${path}/channels/${ch.id}/library`, { vaultId: null }),
                          )
                        }
                      >
                        Detach library
                      </Button>
                    )}
                  </details>
                )}
              </div>
            ))}
            {owner && !team.archived && (
              <>
                <h3>Create a channel or add a person</h3>
                {creationFields}
                <div className="team-actions">
                  <Button
                    variant="outline"
                    aria-pressed={!privateChannel}
                    onClick={() => setPrivate(false)}
                  >
                    Public channel
                  </Button>
                  <Button
                    variant="outline"
                    aria-pressed={privateChannel}
                    onClick={() => setPrivate(true)}
                  >
                    Private channel
                  </Button>
                </div>
                <p>
                  Public channels include every team member. Private channels initially include you
                  and the selected person, if any.
                </p>
                <Button
                  disabled={busy || !connected || !name.trim()}
                  onClick={() =>
                    void run(() =>
                      request('POST', `${path}/channels`, {
                        name,
                        private: privateChannel,
                        members: person ? [person] : [],
                      }),
                    )
                  }
                >
                  Create channel
                </Button>
                <Button
                  disabled={busy || !connected || !person}
                  onClick={() =>
                    void run(() =>
                      request('POST', `${path}/members`, { userId: person, role: 'member' }),
                    )
                  }
                >
                  Add person to team
                </Button>
              </>
            )}
            <h3>Members</h3>
            <p>
              Owners add people immediately. New and returning channel members see messages from
              their join time.
            </p>
            {members.map((m) => (
              <div className="team-member" key={m.userId}>
                <span>
                  {m.displayName} · {m.role}
                  {!m.active ? ' · disabled' : ''}
                </span>
                {owner && !team.archived && (
                  <Button
                    disabled={busy || !connected || !m.active}
                    onClick={() =>
                      void run(() =>
                        request('POST', `${path}/members`, {
                          userId: m.userId,
                          role: m.role === 'owner' ? 'member' : 'owner',
                        }),
                      )
                    }
                  >
                    {m.role === 'owner' ? 'Make member' : 'Make owner'}
                  </Button>
                )}
                {(owner || m.userId === accountId) && (
                  <Button
                    variant="outline"
                    disabled={busy || !connected}
                    onClick={() => void run(() => request('DELETE', `${path}/members/${m.userId}`))}
                  >
                    {m.userId === accountId ? 'Leave team' : 'Remove member'}
                  </Button>
                )}
              </div>
            ))}
            {owner && (
              <>
                <TeamRename
                  value={team.name}
                  label="Rename team"
                  disabled={busy || !connected}
                  save={(value) =>
                    void run(() => request('PATCH', path, { name: value, archived: team.archived }))
                  }
                />
                <Button
                  disabled={busy || !connected}
                  onClick={() =>
                    void run(() =>
                      request('PATCH', path, { name: team.name, archived: !team.archived }),
                    )
                  }
                >
                  {team.archived ? 'Restore team' : 'Archive team'}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TeamRename({
  value,
  label,
  disabled,
  save,
}: {
  value: string;
  label: string;
  disabled: boolean;
  save: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <form
      className="team-actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim() && draft !== value && !disabled) save(draft);
      }}
    >
      <label>
        {label}
        <Input
          value={draft}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <Button type="submit" disabled={disabled || !draft.trim() || draft === value}>
        Save name
      </Button>
    </form>
  );
}

function PrivateChannelPeople({
  id,
  load,
  teamMembers,
  disabled,
  change,
}: {
  id: string;
  load: (id: string) => Promise<TeamMember[]>;
  teamMembers: TeamMember[];
  disabled: boolean;
  change: (userId: string, role: 'member' | 'remove') => Promise<void>;
}) {
  const [participants, setParticipants] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let loading = false;
    async function refresh() {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const rows = await load(id);
        if (alive) {
          setParticipants(rows);
          setError('');
        }
      } catch (reason) {
        if (alive) {
          setParticipants(null);
          setError(String(reason));
        }
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, load, teamMembers]);
  return (
    <div className="team-actions" aria-label="Private channel membership">
      {error && <p role="alert">{error}</p>}
      {teamMembers
        .filter((m) => m.active)
        .map((m) => {
          const joined = participants?.some((p) => p.userId === m.userId);
          return (
            <span key={m.userId}>
              {m.displayName} ·{' '}
              {!participants
                ? 'checking membership'
                : joined
                  ? 'channel member'
                  : 'outside channel'}
              <Button
                disabled={disabled || !participants}
                onClick={() => void change(m.userId, joined ? 'remove' : 'member')}
              >
                {joined ? 'Remove from channel' : 'Invite to channel'}
              </Button>
            </span>
          );
        })}
    </div>
  );
}
