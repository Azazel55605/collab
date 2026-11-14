import { useEffect } from 'react';

import { Eye, X } from 'lucide-react';

import {
  getVaultDocumentTabType,
  getVaultDocumentTitle,
  getVaultDocumentView,
} from '../../../lib/vaultLinks';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { Button } from '../../ui/button';

const STALE_MS = 30_000;

/**
 * Follow mode: while following someone, open each document they open. Stops on
 * its own when they go offline. Renders the small "Following" bar.
 */
export function FollowController() {
  const followingUserId = useCollabStore((state) => state.followingUserId);
  const setFollowing = useCollabStore((state) => state.setFollowing);
  const peer = useCollabStore((state) =>
    state.followingUserId
      ? (state.peers.find((entry) => entry.userId === state.followingUserId) ?? null)
      : null,
  );
  const activeFile = peer?.activeFile ?? null;
  const online = peer ? Date.now() - peer.lastSeen < STALE_MS : false;

  useEffect(() => {
    if (followingUserId && !online) setFollowing(null);
  }, [followingUserId, online, setFollowing]);

  useEffect(() => {
    if (!followingUserId || !activeFile) return;
    if (useEditorStore.getState().activeTabPath === activeFile) return;
    const type = getVaultDocumentTabType(activeFile);
    useEditorStore.getState().openTab(activeFile, getVaultDocumentTitle(activeFile), type);
    useUiStore.getState().setActiveView(getVaultDocumentView(type));
  }, [followingUserId, activeFile]);

  if (!followingUserId || !peer) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto fixed top-14 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border/70 bg-popover/95 py-1 pr-1 pl-2.5 text-[13px] text-popover-foreground shadow-lg shadow-black/20"
    >
      <span
        className="flex size-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: peer.userColor }}
      >
        {peer.userName.slice(0, 1).toUpperCase()}
      </span>
      <Eye className="size-3.5 text-muted-foreground" />
      Following {peer.userName}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => setFollowing(null)}
      >
        <X /> Stop
      </Button>
    </div>
  );
}
