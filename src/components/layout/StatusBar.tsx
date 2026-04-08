import { useEditorStore } from '../../store/editorStore';
import { useVaultStore } from '../../store/vaultStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useUpdateStore } from '../../store/updateStore';
import PresenceBar from '../collaboration/PresenceBar';
import { Progress } from '../ui/progress';
import { BookOpen, Hash, Download, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';

export default function StatusBar() {
  const { activeTabPath, openTabs } = useEditorStore();
  const { vault } = useVaultStore();
  const { notes } = useNoteIndexStore();
  const { openVaultManager, openSettings } = useUiStore();
  const activeTab = openTabs.find((t) => t.relativePath === activeTabPath);
  const activeMeta = notes.find((n) => n.relativePath === activeTabPath);

  const { status, downloadProgress, updaterSupported } = useUpdateStore();
  const isDownloading = status === 'downloading';
  const isInstalling  = status === 'installing';
  const isAvailable   = updaterSupported && status === 'available';

  return (
    <div className="flex items-center justify-between h-[22px] px-3 border-t border-border/40 bg-sidebar/60 backdrop-blur-sm-webkit text-[11px] text-muted-foreground shrink-0 select-none">
      {/* Left: vault + file path */}
      <div className="flex items-center gap-2 min-w-0">
        {vault && (
          <button
            onClick={openVaultManager}
            className="text-primary/80 font-medium shrink-0 flex items-center gap-1 hover:text-primary transition-colors app-motion-fast"
            title="Manage vaults"
          >
            <BookOpen size={10} />
            {vault.name}
          </button>
        )}
        {activeTab && (
          <>
            <span className="text-border/80">›</span>
            <span className="truncate opacity-60">{activeTab.relativePath}</span>
          </>
        )}
      </div>

      {/* Center: download progress (only while active) */}
      {(isDownloading || isInstalling) && (
        <button
          onClick={() => openSettings()}
          title="Open Settings → About"
          className="flex items-center gap-1.5 flex-1 max-w-[200px] mx-3 hover:opacity-80 transition-opacity app-motion-fast"
        >
          {isInstalling ? (
            <>
              <RefreshCw size={9} className="shrink-0 text-primary app-spin-soft" />
              <span className="text-[10px] text-primary/80 shrink-0">Installing…</span>
            </>
          ) : (
            <>
              <Download size={9} className="shrink-0 text-primary/70 app-pulse-soft" />
              <Progress value={downloadProgress ?? 0} className="flex-1 h-1" />
              <span className="tabular-nums text-muted-foreground/70 shrink-0">
                {downloadProgress ?? 0}%
              </span>
            </>
          )}
        </button>
      )}

      {/* Right: update dot + word count + presence */}
      <div className="flex items-center gap-3 shrink-0">
        {isAvailable && (
          <button
            onClick={() => openSettings()}
            title="Update available — open Settings → About"
            className="flex items-center gap-1 text-primary/80 hover:text-primary transition-colors app-motion-fast"
          >
            <div className={cn('w-1.5 h-1.5 rounded-full bg-primary app-pulse-soft')} />
            <span className="text-[10px]">Update</span>
          </button>
        )}
        {activeMeta && (
          <span className="flex items-center gap-1 opacity-60">
            <Hash size={10} />
            {activeMeta.wordCount.toLocaleString()} words
          </span>
        )}
        <PresenceBar />
      </div>
    </div>
  );
}
