import { useState } from 'react';

import { ChevronDown, ChevronRight, ExternalLink, Eye } from 'lucide-react';

import {
  getVaultDocumentTabType,
  getVaultDocumentTitle,
  getVaultDocumentView,
} from '../../../lib/vaultLinks';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import type { PresenceEntry } from '../../../types/collab';
import { Button } from '../../ui/button';

const STALE_MS = 30_000;

function fileName(path: string) {
  return path.split('/').pop() ?? path;
}

function Avatar({ entry, online }: { entry: PresenceEntry; online: boolean }) {
  return (
    <span className="relative shrink-0">
      <span
        className="flex size-7 items-center justify-center rounded-full text-xs font-semibold text-white"
        style={{ backgroundColor: entry.userColor }}
      >
        {entry.userName.slice(0, 1).toUpperCase()}
      </span>
      <span
        className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar ${online ? 'bg-green-500' : 'bg-muted-foreground'}`}
      />
    </span>
  );
}

function PeerRow({
  entry,
  online,
  detail,
  action,
  label,
}: {
  entry: PresenceEntry;
  online: boolean;
  detail: string;
  action?: React.ReactNode;
  label?: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors hover:bg-sidebar-accent/50">
      <Avatar entry={entry} online={online} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px] font-medium">{label ?? entry.userName}</div>
        <div className="truncate text-[11.5px] text-muted-foreground">{detail}</div>
      </div>
      {action}
    </div>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase first:pt-1">
      {children}
    </h3>
  );
}

/**
 * People grouped by where they are: in the document you have open, elsewhere in
 * the vault (with a button that opens their document), offline, then you.
 */
export function PeerList() {
  const myUserId = useCollabStore((state) => state.myUserId);
  const myUserName = useCollabStore((state) => state.myUserName);
  const myUserColor = useCollabStore((state) => state.myUserColor);
  const peers = useCollabStore((state) => state.peers);
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const openTab = useEditorStore((state) => state.openTab);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const [showOffline, setShowOffline] = useState(false);
  const followingUserId = useCollabStore((state) => state.followingUserId);
  const setFollowing = useCollabStore((state) => state.setFollowing);
  const followButton = (peer: PresenceEntry) => {
    const following = followingUserId === peer.userId;
    return (
      <Button
        type="button"
        variant={following ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={following}
        aria-label={following ? `Stop following ${peer.userName}` : `Follow ${peer.userName}`}
        title={following ? 'Stop following' : 'Open each document they open'}
        className="h-7 px-2 text-xs"
        onClick={() => setFollowing(following ? null : peer.userId)}
      >
        <Eye />
        {following ? 'Following' : 'Follow'}
      </Button>
    );
  };

  const now = Date.now();
  const isOnline = (entry: PresenceEntry) => now - entry.lastSeen < STALE_MS;
  const others = peers.filter((peer) => peer.userId !== myUserId);
  const here = others.filter(
    (peer) => isOnline(peer) && activeTabPath && peer.activeFile === activeTabPath,
  );
  const elsewhere = others.filter((peer) => isOnline(peer) && !here.includes(peer));
  const offline = others.filter((peer) => !isOnline(peer));

  const self: PresenceEntry = {
    userId: myUserId,
    userName: myUserName,
    userColor: myUserColor,
    activeFile: activeTabPath,
    cursorLine: null,
    chatTypingUntil: null,
    lastSeen: now,
    appVersion: '',
  };

  const openDocument = (path: string) => {
    const type = getVaultDocumentTabType(path);
    openTab(path, getVaultDocumentTitle(path), type);
    setActiveView(getVaultDocumentView(type));
  };

  const where = (entry: PresenceEntry) =>
    entry.activeFile
      ? `${fileName(entry.activeFile)}${entry.cursorLine != null ? ` · line ${entry.cursorLine}` : ''}`
      : 'No document open';

  return (
    <div className="flex flex-col p-1.5">
      {others.length === 0 && (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          Nobody else is here right now
        </p>
      )}
      {here.length > 0 && (
        <section aria-label="In this document">
          <GroupHeading>In this document · {here.length}</GroupHeading>
          {here.map((peer) => (
            <PeerRow
              key={peer.userId}
              entry={peer}
              online
              detail={peer.cursorLine != null ? `Line ${peer.cursorLine}` : 'Viewing this document'}
              action={followButton(peer)}
            />
          ))}
        </section>
      )}
      {elsewhere.length > 0 && (
        <section aria-label="Elsewhere in this vault">
          <GroupHeading>Elsewhere · {elsewhere.length}</GroupHeading>
          {elsewhere.map((peer) => (
            <PeerRow
              key={peer.userId}
              entry={peer}
              online
              detail={where(peer)}
              action={
                peer.activeFile ? (
                  <span className="flex items-center gap-0.5">
                    {followButton(peer)}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Open ${fileName(peer.activeFile)}`}
                      title="Open their document"
                      className="text-muted-foreground"
                      onClick={() => openDocument(peer.activeFile!)}
                    >
                      <ExternalLink />
                    </Button>
                  </span>
                ) : undefined
              }
            />
          ))}
        </section>
      )}
      {offline.length > 0 && (
        <section aria-label="Offline">
          <button
            type="button"
            aria-expanded={showOffline}
            onClick={() => setShowOffline((value) => !value)}
            className="flex w-full items-center gap-1 rounded-md px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {showOffline ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Offline · {offline.length}
          </button>
          {showOffline &&
            offline.map((peer) => (
              <PeerRow key={peer.userId} entry={peer} online={false} detail="Offline" />
            ))}
        </section>
      )}
      <section aria-label="You">
        <GroupHeading>You</GroupHeading>
        <PeerRow entry={self} online label={`${myUserName} (you)`} detail={where(self)} />
      </section>
    </div>
  );
}
