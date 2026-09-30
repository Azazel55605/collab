import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ResolvedSlide } from '../../lib/deck/resolve';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import type { DeckAssetRef, DeckLayout } from '../../types/deck';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../ui/context-menu';

import { DeckSlide } from './DeckSlide';

export type DeckRailAction =
  | { kind: 'new'; layoutId: string }
  | { kind: 'duplicate' }
  | { kind: 'delete' }
  | { kind: 'hide'; hidden: boolean }
  | { kind: 'move'; by: -1 | 1 }
  | { kind: 'export' };

interface DeckSlideRailProps {
  slideOrder: string[];
  slides: Map<string, ResolvedSlide>;
  sections: Map<string, string>;
  layouts: DeckLayout[];
  activeId: string | null;
  selectedIds: string[];
  readOnly: boolean;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  aspect: number;
  onSelect: (ids: string[], activeId: string) => void;
  /** Moves `ids` so they start at `toIndex` of the slides that are not moving. */
  onMove: (ids: string[], toIndex: number) => void;
  onAction: (action: DeckRailAction) => void;
}

const THUMB_WIDTH = 150;
/** The row button's `p-1` padding, top and bottom: the highlight must enclose the thumbnail. */
const ITEM_PADDING = 4;
const ROW_GAP = 8;
const SECTION_HEIGHT = 22;
const OVERSCAN_PX = 400;
const DRAG_THRESHOLD_PX = 4;

/**
 * The slide rail: numbered thumbnails with sections, multi-select, drag to
 * reorder, and a context menu.
 *
 * Virtualized — only rows in view (plus an overscan band) are drawn, so a
 * large deck costs a screenful of thumbnails, not the whole deck.
 */
export function DeckSlideRail({
  slideOrder,
  slides,
  sections,
  layouts,
  activeId,
  selectedIds,
  readOnly,
  measurer,
  resolveAsset,
  aspect,
  onSelect,
  onMove,
  onAction,
}: DeckSlideRailProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [drag, setDrag] = useState<{
    ids: string[];
    startY: number;
    y: number;
    active: boolean;
  } | null>(null);
  const anchorRef = useRef<string | null>(null);

  const thumbHeight = Math.round(THUMB_WIDTH / aspect);
  const itemHeight = thumbHeight + ITEM_PADDING * 2;
  const rowHeight = itemHeight + ROW_GAP;
  const layout = useMemo(() => {
    const offsets: number[] = [];
    let y = 8;
    for (const id of slideOrder) {
      if (sections.has(id)) y += SECTION_HEIGHT;
      offsets.push(y);
      y += rowHeight;
    }
    return { offsets, total: y + 8 };
  }, [rowHeight, sections, slideOrder]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () =>
      setViewport({ top: element.scrollTop, height: element.clientHeight || 800 });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the active slide in view when it changes from elsewhere.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const index = activeId ? slideOrder.indexOf(activeId) : -1;
    if (!element || index < 0) return;
    const top = layout.offsets[index];
    if (top < element.scrollTop) element.scrollTop = top - 8;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight + 8;
    }
  }, [activeId, layout.offsets, rowHeight, slideOrder]);

  const first = Math.max(
    0,
    layout.offsets.findIndex((offset) => offset + rowHeight >= viewport.top - OVERSCAN_PX),
  );
  let last = first;
  while (
    last < slideOrder.length &&
    layout.offsets[last] <= viewport.top + viewport.height + OVERSCAN_PX
  )
    last += 1;

  const select = (id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (event.shiftKey && anchorRef.current) {
      const from = slideOrder.indexOf(anchorRef.current);
      const to = slideOrder.indexOf(id);
      const range = slideOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
      onSelect(range, id);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((entry) => entry !== id)
        : [...selectedIds, id];
      anchorRef.current = id;
      onSelect(next.length > 0 ? next : [id], id);
      return;
    }
    anchorRef.current = id;
    onSelect([id], id);
  };

  /** Where a drop at content-y lands, as an index into the full slide order. */
  const dropIndexAt = (y: number) => {
    for (let index = 0; index < slideOrder.length; index += 1) {
      if (y < layout.offsets[index] + rowHeight / 2) return index;
    }
    return slideOrder.length;
  };

  const contentY = (clientY: number) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    return clientY - rect.top + scrollRef.current!.scrollTop;
  };

  const finishDrag = () => {
    if (drag?.active) {
      const target = dropIndexAt(drag.y);
      const stationaryBefore = slideOrder
        .slice(0, target)
        .filter((id) => !drag.ids.includes(id)).length;
      onMove(drag.ids, stationaryBefore);
    }
    setDrag(null);
  };

  const dropIndicator = drag?.active
    ? (() => {
        const index = dropIndexAt(drag.y);
        return index < slideOrder.length ? layout.offsets[index] - ROW_GAP / 2 : layout.total - 8;
      })()
    : null;

  const selection = new Set(selectedIds);
  const allHidden = selectedIds.every((id) => slides.get(id)?.hidden);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollRef}
          className="relative h-full w-[196px] shrink-0 overflow-y-auto border-r border-border/50 bg-card/30"
          role="listbox"
          aria-label="Slides"
          aria-multiselectable
          onScroll={(event) =>
            setViewport((current) => ({ ...current, top: event.currentTarget.scrollTop }))
          }
          onPointerMove={(event) => {
            if (!drag) return;
            const y = contentY(event.clientY);
            const active = drag.active || Math.abs(y - drag.startY) > DRAG_THRESHOLD_PX;
            setDrag({ ...drag, y, active });
          }}
          onPointerUp={finishDrag}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="relative" style={{ height: layout.total }}>
            {slideOrder.slice(first, last).map((id, offset) => {
              const index = first + offset;
              const slide = slides.get(id);
              const top = layout.offsets[index];
              const section = sections.get(id);
              return (
                <div key={id}>
                  {section !== undefined && (
                    <div
                      className="absolute left-3 right-3 truncate text-[11px] font-medium text-muted-foreground"
                      style={{ top: top - SECTION_HEIGHT + 4 }}
                    >
                      {section}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selection.has(id)}
                    aria-current={id === activeId ? 'true' : undefined}
                    data-slide-id={id}
                    className={
                      'absolute left-2 right-2 flex items-start gap-2 rounded-lg p-1 text-left transition-colors ' +
                      (id === activeId
                        ? 'bg-primary/15 ring-1 ring-primary/60'
                        : selection.has(id)
                          ? 'bg-primary/8 ring-1 ring-primary/30'
                          : 'hover:bg-accent/50') +
                      (drag?.active && drag.ids.includes(id) ? ' opacity-40' : '')
                    }
                    style={{ top, height: itemHeight }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      select(id, event);
                      if (!readOnly && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                        const ids = selection.has(id)
                          ? slideOrder.filter((entry) => selection.has(entry))
                          : [id];
                        const y = contentY(event.clientY);
                        setDrag({ ids, startY: y, y, active: false });
                      }
                    }}
                    onContextMenu={() => {
                      if (!selection.has(id))
                        select(id, { shiftKey: false, ctrlKey: false, metaKey: false });
                    }}
                  >
                    <span className="w-4 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    {slide ? (
                      <DeckSlide
                        slide={slide}
                        width={THUMB_WIDTH}
                        measurer={measurer}
                        resolveAsset={resolveAsset}
                        className={
                          'pointer-events-none overflow-hidden rounded border border-border/60 shadow-sm' +
                          (slide.hidden ? ' opacity-40' : '')
                        }
                        label={`Slide ${index + 1}${slide.hidden ? ', hidden' : ''}`}
                      />
                    ) : (
                      <div
                        className="flex items-center justify-center rounded border border-dashed border-destructive/40 text-[10px] text-destructive"
                        style={{ width: THUMB_WIDTH, height: thumbHeight }}
                      >
                        Cannot display
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
            {dropIndicator !== null && (
              <div
                className="pointer-events-none absolute left-3 right-3 h-0.5 rounded bg-primary"
                style={{ top: dropIndicator }}
                data-testid="deck-rail-drop"
              />
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      {!readOnly && (
        <ContextMenuContent className="w-52">
          <ContextMenuSub>
            <ContextMenuSubTrigger>New slide</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {layouts.map((entry) => (
                <ContextMenuItem
                  key={entry.id}
                  onClick={() => onAction({ kind: 'new', layoutId: entry.id })}
                >
                  {entry.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => onAction({ kind: 'duplicate' })}>
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAction({ kind: 'hide', hidden: !allHidden })}>
            {allHidden ? 'Show slide' : 'Hide slide'}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAction({ kind: 'export' })}>
            Export as image for notes
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction({ kind: 'move', by: -1 })}>
            Move up
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAction({ kind: 'move', by: 1 })}>
            Move down
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            disabled={selectedIds.length >= slideOrder.length}
            onClick={() => onAction({ kind: 'delete' })}
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
