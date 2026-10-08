import { useEffect, useMemo, useRef, useState } from 'react';

import { TeamWorkspace } from '../../../src/components/teams/TeamWorkspace';
import { Textarea } from '../../../src/components/ui/textarea';
import type {
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
} from '../../../src/types/conversation';
import type { TeamMember, TeamRequest } from '../../../src/types/team';

import { api } from './api';
import type { ServerUser } from './types';
import { Button } from './ui';

const request: TeamRequest = (method, path, body) =>
  api(`/api/v1/teams${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const directory = (query: string) =>
  api<{ userId: string; displayName: string }[]>(
    `/api/v1/users/directory?q=${encodeURIComponent(query)}`,
  );
const channelMembers = (id: string) =>
  api<TeamMember[]>(`/api/v1/conversations/${encodeURIComponent(id)}/members`);
export function TeamsPage({ me }: { me: ServerUser }) {
  const [channel, setChannel] = useState<ConversationSummary | null>(null);
  const [error, setError] = useState('');
  // Account identity keys the entire browser surface on session changes.
  const open = useMemo(
    () => async (id: string) => {
      try {
        const rows = await api<ConversationSummary[]>(
          `/api/v1/conversations?limit=1&conversation=${encodeURIComponent(id)}`,
        );
        if (!rows.length) throw new Error('This channel is unavailable.');
        setChannel(rows[0]);
        setError('');
      } catch (reason) {
        setError(String(reason));
      }
    },
    [],
  );
  return (
    <div className="browser-teams">
      {error && <p role="alert">{error}</p>}
      {channel ? (
        <BrowserChannel key={channel.id} channel={channel} close={() => setChannel(null)} />
      ) : (
        <TeamWorkspace
          key={me.id}
          request={request}
          directory={directory}
          channelMembers={channelMembers}
          accountId={me.id}
          serverAdmin={me.role === 'admin'}
          connected
          openChannel={(ch) => void open(ch.id)}
        />
      )}
    </div>
  );
}
function BrowserChannel({ channel, close }: { channel: ConversationSummary; close: () => void }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ id: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const mode = useRef(false);
  const ticket = useRef(0);
  const base = `/api/v1/conversations/${channel.id}`;
  async function load(cursor?: string) {
    const gen = epoch.current;
    const n = ++ticket.current;
    try {
      const page = await api<ConversationPage>(
        `${base}/messages?limit=50${cursor ? `&before=${cursor}` : ''}`,
      );
      if (gen !== epoch.current || n !== ticket.current) return;
      setMessages(page.messages);
      setBefore(page.hasMore ? page.nextBefore : null);
      setOlder(!!cursor);
      mode.current = !!cursor;
      setAuthorized(true);
      setError('');
      const last = page.messages.at(-1);
      if (!cursor && last && document.visibilityState !== 'hidden')
        await api(`${base}/read`, {
          method: 'POST',
          body: JSON.stringify({ sequence: last.sequence }),
        });
    } catch (reason) {
      if (gen === epoch.current && n === ticket.current) {
        setMessages([]);
        setAuthorized(false);
        setError(String(reason));
      }
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const gen = ++epoch.current;
    void loadRef.current();
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      if (!mode.current) void loadRef.current();
      else
        void api(`${base}/messages?limit=1`).catch((reason) => {
          setMessages([]);
          setAuthorized(false);
          setError(String(reason));
        });
    };
    const timer = window.setInterval(poll, 5000);
    window.addEventListener('focus', poll);
    window.addEventListener('online', poll);
    return () => {
      epoch.current = gen + 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
      window.removeEventListener('online', poll);
    };
  }, [base]);
  async function send() {
    const item = pending ?? { id: crypto.randomUUID(), content: text.trim() };
    if (!item.content || busy || !authorized) return;
    setPending(item);
    setBusy(true);
    try {
      await api(`${base}/messages`, { method: 'POST', body: JSON.stringify(item) });
      setPending(null);
      setText('');
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="team-workspace">
      <header>
        <Button onClick={close}>Back to teams</Button>
        <h2>
          {channel.teamName ? `${channel.teamName} / ` : ''}
          {channel.name}
        </h2>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="team-scroll" aria-label="Channel messages">
        {before && <Button onClick={() => void load(before)}>Earlier messages</Button>}
        {older && <Button onClick={() => void load()}>Latest messages</Button>}
        {messages.map((m) => (
          <article key={m.id}>
            <strong>{m.userName}</strong>
            <time dateTime={new Date(m.timestamp).toISOString()}>
              {' '}
              · {new Date(m.timestamp).toLocaleString()}
            </time>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</p>
          </article>
        ))}
      </div>
      <label>
        Message
        <Textarea
          value={pending ? pending.content : text}
          disabled={!!pending || !authorized}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !authorized || (!pending && !text.trim())}
        onClick={() => void send()}
      >
        {pending ? 'Retry send' : 'Send'}
      </Button>
      {pending && (
        <Button disabled={busy} onClick={() => setPending(null)}>
          Discard pending send
        </Button>
      )}
      <p>Unsent browser messages stay in this open tab. Closing the tab clears them.</p>
    </section>
  );
}
