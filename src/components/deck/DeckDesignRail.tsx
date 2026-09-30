import type { ResolvedSlide } from '../../lib/deck/resolve';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import { cn } from '../../lib/utils';
import type { DeckAssetRef, DeckDocument } from '../../types/deck';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../ui/context-menu';

import { DeckSlide } from './DeckSlide';

export type DeckDesignTarget = { kind: 'layout' | 'master'; id: string };

interface DeckDesignRailProps {
  deck: DeckDocument;
  scenes: Map<string, ResolvedSlide>;
  active: DeckDesignTarget;
  readOnly: boolean;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  onSelect: (target: DeckDesignTarget) => void;
  onDuplicateLayout: (layoutId: string) => void;
  onDeleteLayout: (layoutId: string) => void;
}

const THUMB_WIDTH = 150;

/**
 * The design editor's rail: each master, followed by its layouts, with how
 * many slides use each layout. There are at most 16 masters and 128 layouts,
 * so it is not virtualized.
 */
export function DeckDesignRail({
  deck,
  scenes,
  active,
  readOnly,
  measurer,
  resolveAsset,
  onSelect,
  onDuplicateLayout,
  onDeleteLayout,
}: DeckDesignRailProps) {
  const usage = new Map<string, number>();
  for (const id of deck.slideOrder) {
    const layoutId = deck.slides[id]?.layoutId;
    if (layoutId) usage.set(layoutId, (usage.get(layoutId) ?? 0) + 1);
  }
  const masters = Object.values(deck.masters);
  const row = (target: DeckDesignTarget, label: string, detail: string | null, width: number) => {
    const scene = scenes.get(`${target.kind}:${target.id}`);
    const selected = active.kind === target.kind && active.id === target.id;
    return (
      <button
        type="button"
        aria-label={`${target.kind === 'master' ? 'Master' : 'Layout'} ${label}`}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col items-start gap-1 rounded-md p-1 text-left',
          selected ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-muted/60',
        )}
        onClick={() => onSelect(target)}
      >
        {scene ? (
          <DeckSlide
            slide={scene}
            width={width}
            measurer={measurer}
            resolveAsset={resolveAsset}
            className="overflow-hidden rounded-sm ring-1 ring-border/60"
            label={`${label} preview`}
          />
        ) : (
          <div
            className="rounded-sm bg-muted text-[10px] text-muted-foreground"
            style={{ width, height: (width * deck.size.height) / deck.size.width }}
          >
            Cannot display
          </div>
        )}
        <span className="w-full truncate px-0.5 text-[11px]">
          {label}
          {detail && <span className="ml-1 text-muted-foreground">{detail}</span>}
        </span>
      </button>
    );
  };

  return (
    <nav
      className="flex w-[178px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border/50 bg-card/30 p-2"
      aria-label="Master and layouts"
    >
      {masters.map((master) => (
        <div key={master.id} className="flex flex-col gap-2">
          {row({ kind: 'master', id: master.id }, master.name, 'master', THUMB_WIDTH)}
          <div className="flex flex-col gap-2 border-l border-border/60 pl-2">
            {Object.values(deck.layouts)
              .filter((layout) => layout.masterId === master.id)
              .map((layout) => {
                const count = usage.get(layout.id) ?? 0;
                return (
                  <ContextMenu key={layout.id}>
                    <ContextMenuTrigger asChild>
                      <div>
                        {row(
                          { kind: 'layout', id: layout.id },
                          layout.name,
                          count > 0 ? `· ${count}` : null,
                          THUMB_WIDTH - 10,
                        )}
                      </div>
                    </ContextMenuTrigger>
                    {!readOnly && (
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem onClick={() => onDuplicateLayout(layout.id)}>
                          Duplicate layout
                        </ContextMenuItem>
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={count > 0}
                          onClick={() => onDeleteLayout(layout.id)}
                        >
                          {count > 0
                            ? `Used by ${count} slide${count === 1 ? '' : 's'}`
                            : 'Delete layout'}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                );
              })}
          </div>
        </div>
      ))}
    </nav>
  );
}
