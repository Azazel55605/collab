import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import type { PresenceEntry } from '../../../types/collab';

function PeerRow({ entry, isSelf }: { entry: PresenceEntry; isSelf?: boolean }) {
  const staleThreshold = 30_000;
  const isOnline = Date.now() - entry.lastSeen < staleThreshold;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-muted/40 transition-colors">
      <div className="relative flex-shrink-0">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold text-white"
          style={{ backgroundColor: entry.userColor }}
        >
          {entry.userName.slice(0, 1).toUpperCase()}
        </div>
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-background ${isOnline ? 'bg-green-500' : 'bg-muted-foreground'}`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{entry.userName}</span>
          {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
        </div>
        {entry.activeFile ? (
          <p className="text-xs text-muted-foreground truncate">
            {entry.activeFile.split('/').pop()}
            {entry.cursorLine != null && <span className="opacity-60"> :{entry.cursorLine}</span>}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No file open</p>
        )}
      </div>
    </div>
  );
}

export function PeerList() {
  const { myUserId, myUserName, myUserColor, peers } = useCollabStore();
  const { activeTabPath } = useEditorStore();

  const selfEntry: PresenceEntry = {
    userId: myUserId,
    userName: myUserName,
    userColor: myUserColor,
    activeFile: activeTabPath,
    cursorLine: null,
    lastSeen: Date.now(),
    appVersion: '',
  };

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <PeerRow entry={selfEntry} isSelf />
      {peers.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground text-center">No other users online</p>
      ) : (
        peers.map((p) => <PeerRow key={p.userId} entry={p} />)
      )}
    </div>
  );
}
