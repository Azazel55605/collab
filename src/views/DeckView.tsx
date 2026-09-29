import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PanelLeft,
  Presentation,
  Save,
  StickyNote,
} from 'lucide-react';
import { toast } from 'sonner';

import { DeckSlide } from '../components/deck/DeckSlide';
import {
  DocumentTopBar,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  DocumentTopBarIconButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import { collectDeckAssetPaths } from '../lib/deck/assets';
import { plainText, resolveSlide } from '../lib/deck/resolve';
import type { ResolvedSlide } from '../lib/deck/resolve';
import { fitSlide } from '../lib/deck/svg';
import { createCanvasMeasurer } from '../lib/deck/textLayout';
import { useDeckSession } from '../lib/deck/useDeckSession';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { createVaultClient } from '../lib/vaultClient';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import type { DeckViewState } from '../store/editorStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { DECK_SCHEMA_VERSION } from '../types/deck';
import type { DeckAssetRef, DeckDocument } from '../types/deck';
import { isVaultReadOnly } from '../types/vault';

interface DeckViewProps {
  relativePath: string;
}

const RAIL_THUMBNAIL_WIDTH = 168;
const DEFAULT_VIEW_STATE: DeckViewState = {
  slideId: null,
  zoom: 'fit',
  slideRailOpen: true,
  notesOpen: false,
  selectedElementIds: [],
};

/**
 * Loads every image a deck draws as an inline data URL. Renders never wait on
 * it: a slide draws a stable placeholder until its image arrives.
 */
function useDeckAssets(
  document: DeckDocument | null,
  vault: ReturnType<typeof useVaultStore.getState>['vault'],
) {
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const paths = useMemo(() => (document ? collectDeckAssetPaths(document) : []), [document]);
  const key = paths.join('\n');

  useEffect(() => {
    if (!client || paths.length === 0) return;
    let cancelled = false;
    for (const path of paths) {
      if (assets[path]) continue;
      client
        .readAssetDataUrl(path)
        .then((url) => {
          if (!cancelled) setAssets((current) => ({ ...current, [path]: url }));
        })
        .catch(() => {
          // A missing asset keeps its placeholder; the deck stays repairable.
        });
    }
    return () => {
      cancelled = true;
    };
    // `key` stands for `paths`; re-reading on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return useCallback((asset: DeckAssetRef) => assets[asset.path] ?? null, [assets]);
}

/** Tracks an element's content size for fitting the slide stage. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((current) =>
        current.width === Math.floor(width) && current.height === Math.floor(height)
          ? current
          : { width: Math.floor(width), height: Math.floor(height) },
      );
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The `.deck` view: slide rail, fitted stage, and speaker notes.
 *
 * Presentation Phase 1 makes a deck an ordinary vault document — open, browse,
 * save, sync, conflicts, history — without authoring. The editing stage,
 * selection, and transforms are Phase 2; text editing is Phase 3.
 */
export default function DeckView({ relativePath }: DeckViewProps) {
  const vault = useVaultStore((state) => state.vault);
  const markDirty = useEditorStore((state) => state.markDirty);
  const setSavedHash = useEditorStore((state) => state.setSavedHash);
  const storedViewState = useEditorStore((state) => state.deckViewStates[relativePath]);
  const setDeckViewState = useEditorStore((state) => state.setDeckViewState);

  const session = useDeckSession({ vault, relativePath, markDirty, markSaved: setSavedHash });
  const { document } = session;

  const documentStatus = useMemo(
    () => ({
      status: session.status,
      controller: session.controller as DocumentSessionController<unknown>,
      snapshot: session.snapshot as DocumentSessionSnapshot<unknown>,
      onSaveAsNew: session.saveMineAsNew,
      readOnly: session.readOnly,
    }),
    [session.controller, session.readOnly, session.saveMineAsNew, session.snapshot, session.status],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  const [viewState, setViewState] = useState<DeckViewState>(() => ({
    ...DEFAULT_VIEW_STATE,
    ...storedViewState,
  }));
  useEffect(() => {
    setDeckViewState(relativePath, viewState);
  }, [relativePath, setDeckViewState, viewState]);

  useEffect(() => {
    if (session.warnings.length === 0) return;
    toast.warning(
      session.warnings.length === 1
        ? session.warnings[0]
        : `This presentation was repaired while opening (${session.warnings.length} issues).`,
      {
        description:
          session.warnings.length > 1 ? session.warnings.slice(0, 4).join('\n') : undefined,
      },
    );
  }, [session.warnings]);

  const measurer = useMemo(() => createCanvasMeasurer(), []);
  const resolveAsset = useDeckAssets(document, vault);
  const supported = session.schemaSupport === 'supported';

  const slideOrder = useMemo(
    () => (document && supported ? document.slideOrder : []),
    [document, supported],
  );
  const activeSlideId =
    viewState.slideId && slideOrder.includes(viewState.slideId)
      ? viewState.slideId
      : (slideOrder[0] ?? null);
  const activeIndex = activeSlideId ? slideOrder.indexOf(activeSlideId) : -1;

  const resolved = useMemo(() => {
    if (!document || !supported) return new Map<string, ResolvedSlide>();
    const map = new Map<string, ResolvedSlide>();
    for (const id of document.slideOrder) {
      try {
        map.set(id, resolveSlide(document, id));
      } catch {
        // A slide that cannot resolve is shown as a gap in the rail rather
        // than taking the whole deck down.
      }
    }
    return map;
  }, [document, supported]);
  const activeSlide = activeSlideId ? resolved.get(activeSlideId) : undefined;

  const sectionStarts = useMemo(
    () =>
      new Map((document?.sections ?? []).map((section) => [section.firstSlideId, section.name])),
    [document],
  );

  const goTo = useCallback(
    (index: number) => {
      if (slideOrder.length === 0) return;
      const next = slideOrder[Math.max(0, Math.min(slideOrder.length - 1, index))];
      setViewState((current) =>
        current.slideId === next ? current : { ...current, slideId: next },
      );
    },
    [slideOrder],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const moves: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      PageDown: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
      PageUp: -1,
    };
    if (event.key in moves) goTo(activeIndex + moves[event.key]);
    else if (event.key === 'Home') goTo(0);
    else if (event.key === 'End') goTo(slideOrder.length - 1);
    else return;
    event.preventDefault();
  };

  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeSlideId) return;
    // Matched by dataset rather than a selector, so no slide id needs escaping.
    const items = railRef.current?.querySelectorAll<HTMLElement>('[data-slide-id]') ?? [];
    for (const item of items) {
      if (item.dataset.slideId === activeSlideId) item.scrollIntoView({ block: 'nearest' });
    }
  }, [activeSlideId]);

  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const fitted = activeSlide
    ? fitSlide(activeSlide, {
        width: Math.max(0, stageSize.width - 48),
        height: Math.max(0, stageSize.height - 48),
      })
    : null;

  if (session.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={15} className="animate-spin" />
        Opening presentation…
      </div>
    );
  }

  if (session.error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-lg text-center text-sm text-destructive">{session.error}</p>
      </div>
    );
  }

  const notes = activeSlide?.notes ? plainText(activeSlide.notes) : '';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {isVaultReadOnly(vault) && <ReadOnlyBanner />}
      {session.schemaSupport === 'newer' && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          This presentation was written by a newer version of Collab (schema {session.schemaVersion}{' '}
          against {DECK_SCHEMA_VERSION}). It is open read-only so nothing that version stored is
          lost, and this version cannot display it.
        </div>
      )}

      <DocumentTopBar
        icon={<Presentation size={15} className="text-orange-400/80" />}
        title={getDocumentBaseName(relativePath, 'Presentation')}
        subtitle={getDocumentFolderPath(relativePath)}
        meta={
          slideOrder.length > 0 ? (
            <span>
              Slide {activeIndex + 1} of {slideOrder.length}
            </span>
          ) : undefined
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton
                onClick={() => goTo(activeIndex - 1)}
                disabled={activeIndex <= 0}
                aria-label="Previous slide"
              >
                <ChevronLeft size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() => goTo(activeIndex + 1)}
                disabled={activeIndex < 0 || activeIndex >= slideOrder.length - 1}
                aria-label="Next slide"
              >
                <ChevronRight size={14} />
              </DocumentTopBarIconButton>
            </div>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton
                onClick={() =>
                  setViewState((current) => ({ ...current, slideRailOpen: !current.slideRailOpen }))
                }
                aria-label={viewState.slideRailOpen ? 'Hide slide list' : 'Show slide list'}
                aria-pressed={viewState.slideRailOpen}
              >
                <PanelLeft size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() =>
                  setViewState((current) => ({ ...current, notesOpen: !current.notesOpen }))
                }
                aria-label={viewState.notesOpen ? 'Hide speaker notes' : 'Show speaker notes'}
                aria-pressed={viewState.notesOpen}
              >
                <StickyNote size={14} />
              </DocumentTopBarIconButton>
            </div>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={() => void session.save()}
                disabled={session.readOnly || !session.dirty || session.saving}
              >
                <Save size={14} />
                Save
              </DocumentTopBarButton>
            </div>
          </>
        }
      />

      <div
        className="flex min-h-0 flex-1 outline-none"
        tabIndex={0}
        role="application"
        aria-label="Presentation slides"
        onKeyDown={onKeyDown}
      >
        {viewState.slideRailOpen && slideOrder.length > 0 && (
          <div
            ref={railRef}
            className="w-[208px] shrink-0 overflow-y-auto border-r border-border/50 bg-card/30 p-3"
            role="listbox"
            aria-label="Slides"
          >
            {slideOrder.map((id, index) => {
              const slide = resolved.get(id);
              const section = sectionStarts.get(id);
              return (
                <div key={id}>
                  {section !== undefined && (
                    <div className="mb-1.5 mt-2 truncate px-1 text-[11px] font-medium text-muted-foreground first:mt-0">
                      {section}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={id === activeSlideId}
                    data-slide-id={id}
                    onClick={() => goTo(index)}
                    className={
                      'mb-2 flex w-full items-start gap-2 rounded-lg p-1 text-left transition-colors ' +
                      (id === activeSlideId
                        ? 'bg-primary/15 ring-1 ring-primary/50'
                        : 'hover:bg-accent/50')
                    }
                  >
                    <span className="w-4 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    {slide ? (
                      <DeckSlide
                        slide={slide}
                        width={RAIL_THUMBNAIL_WIDTH - 24}
                        measurer={measurer}
                        resolveAsset={resolveAsset}
                        className={
                          'overflow-hidden rounded border border-border/60 shadow-sm' +
                          (slide.hidden ? ' opacity-40' : '')
                        }
                        label={`Slide ${index + 1}${slide.hidden ? ', hidden' : ''}`}
                      />
                    ) : (
                      <div className="flex aspect-video flex-1 items-center justify-center rounded border border-dashed border-destructive/40 text-[10px] text-destructive">
                        Cannot display
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
            {activeSlide && fitted && fitted.width > 0 ? (
              <div className="absolute" style={{ left: fitted.x + 24, top: fitted.y + 24 }}>
                <DeckSlide
                  slide={activeSlide}
                  width={fitted.width}
                  measurer={measurer}
                  resolveAsset={resolveAsset}
                  className="overflow-hidden rounded-sm shadow-lg shadow-black/20"
                  label={`Slide ${activeIndex + 1} of ${slideOrder.length}`}
                />
              </div>
            ) : null}
          </div>
          {viewState.notesOpen && (
            <div className="h-32 shrink-0 overflow-y-auto border-t border-border/50 bg-card/40 px-4 py-3 text-sm">
              {notes ? (
                <p className="whitespace-pre-wrap text-foreground/90">{notes}</p>
              ) : (
                <p className="text-muted-foreground">No speaker notes for this slide.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
