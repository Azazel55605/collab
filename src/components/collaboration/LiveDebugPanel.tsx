import { useSyncExternalStore, useState } from 'react';
import { Copy, Trash2, X, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';

import {
  clearLiveDebugEvents,
  getLiveDebugEvents,
  subscribeLiveDebug,
  type LiveDebugEvent,
} from '../../lib/liveDebugLog';
import { useUiStore } from '../../store/uiStore';

/**
 * Floating live-collaboration debug console. Rendered by `App.tsx` while the
 * Settings → "Live collaboration debug" toggle is on. It surfaces the same
 * events the tracing sink writes to the browser console, so live co-editing can
 * be diagnosed (and the log copied) without opening devtools.
 */
function formatEvent(event: LiveDebugEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 23);
  return `${time} [${event.file}] ${event.message}`;
}

export function LiveDebugPanel() {
  const events = useSyncExternalStore(subscribeLiveDebug, getLiveDebugEvents);
  const setLiveCollabDebug = useUiStore((s) => s.setLiveCollabDebug);
  const [collapsed, setCollapsed] = useState(false);

  const copyAll = async () => {
    const text = events.map(formatEvent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${events.length} live-debug lines`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <div className="fixed bottom-3 left-3 z-[100] w-[min(560px,calc(100vw-1.5rem))] rounded-lg border border-border bg-card/95 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-xs font-semibold">Live debug</span>
        <span className="text-[11px] text-muted-foreground">{events.length} events</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="Copy all"
            onClick={copyAll}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            title="Clear"
            onClick={clearLiveDebugEvents}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((c) => !c)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            type="button"
            title="Turn off (Settings → Live collaboration debug)"
            onClick={() => setLiveCollabDebug(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="max-h-64 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {events.length === 0 ? (
            <p className="px-1 py-2 text-muted-foreground">
              No events yet. Open a hosted document to start a live session.
            </p>
          ) : (
            events.map((event) => (
              <div key={event.id} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">
                  {new Date(event.at).toISOString().slice(11, 23)}{' '}
                </span>
                <span className="text-primary">[{event.file}]</span> {event.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
