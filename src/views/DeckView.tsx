import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowDownToLine,
  ArrowUpToLine,
  Circle,
  Group,
  LayoutTemplate,
  Loader2,
  Lock,
  Minus,
  PanelLeft,
  Plus,
  Presentation,
  Redo2,
  Save,
  Settings2,
  Shapes,
  Square,
  StickyNote,
  Type,
  Undo2,
  Ungroup,
} from 'lucide-react';
import { toast } from 'sonner';

import { DeckSlideRail } from '../components/deck/DeckSlideRail';
import type { DeckRailAction } from '../components/deck/DeckSlideRail';
import { DeckStage } from '../components/deck/DeckStage';
import {
  DocumentTopBar,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  DocumentTopBarIconButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { collectDeckAssetPaths } from '../lib/deck/assets';
import {
  copyElements,
  parseClipboard,
  preparePaste,
  textToParagraphs,
} from '../lib/deck/clipboard';
import { createSlide } from '../lib/deck/document';
import { createInsertedElement } from '../lib/deck/insert';
import type { DeckInsertKind } from '../lib/deck/insert';
import {
  addElements,
  deleteSlides,
  duplicateSlides,
  groupElements,
  insertSlide,
  moveSlides,
  removeElements,
  reorderElements,
  setElementsLocked,
  setSlidesHidden,
  ungroupElements,
  updateElements,
} from '../lib/deck/operations';
import type { DeckEdit, DeckReorder } from '../lib/deck/operations';
import { plainText, resolveSlide } from '../lib/deck/resolve';
import type { ResolvedSlide } from '../lib/deck/resolve';
import { fitSlide } from '../lib/deck/svg';
import { createCanvasMeasurer } from '../lib/deck/textLayout';
import {
  alignSelection,
  distributeSelection,
  groupFrameFor,
  moveSelection,
  slideGeometry,
} from '../lib/deck/transform';
import type { DeckAlignment, ElementUpdaters } from '../lib/deck/transform';
import { useDeckSession } from '../lib/deck/useDeckSession';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { InkHistory } from '../lib/ink/history';
import { createVaultClient } from '../lib/vaultClient';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import type { DeckViewState } from '../store/editorStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { DECK_SCHEMA_VERSION, DECK_UNITS_PER_INCH, DECK_UNITS_PER_POINT } from '../types/deck';
import type { DeckAssetRef, DeckDocument } from '../types/deck';
import { isVaultReadOnly } from '../types/vault';

interface DeckViewProps {
  relativePath: string;
}

const DEFAULT_VIEW_STATE: DeckViewState = {
  slideId: null,
  zoom: 'fit',
  slideRailOpen: true,
  notesOpen: false,
  selectedElementIds: [],
  showRulers: false,
  snapToObjects: true,
  showGrid: false,
};

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const STAGE_MARGIN_PX = 48;
const NUDGE = DECK_UNITS_PER_POINT;
const GRID = DECK_UNITS_PER_INCH / 4;
const PASTE_STEP = 12 * DECK_UNITS_PER_POINT;

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

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The `.deck` editor.
 *
 * Phase 2 is the scene editor: slide management, selection, move, resize,
 * rotate, snapping, order, group, lock, align, distribute, clipboard, and
 * undo/redo. Text editing, themes, and layouts are Phase 3; the full object
 * gallery and images are Phase 4.
 *
 * Every change goes through a reversible operation (`operations.ts`) and one
 * local undo stack; the session re-validates each result before it can save.
 */
export default function DeckView({ relativePath }: DeckViewProps) {
  const vault = useVaultStore((state) => state.vault);
  const markDirty = useEditorStore((state) => state.markDirty);
  const setSavedHash = useEditorStore((state) => state.setSavedHash);
  const storedViewState = useEditorStore((state) => state.deckViewStates[relativePath]);
  const setDeckViewState = useEditorStore((state) => state.setDeckViewState);

  const session = useDeckSession({ vault, relativePath, markDirty, markSaved: setSavedHash });
  const { document } = session;
  const supported = session.schemaSupport === 'supported';
  const editable = supported && !session.readOnly;

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

  /* ----------------------------------------------------------------------- */
  /* History                                                                 */
  /* ----------------------------------------------------------------------- */

  const historyRef = useRef(new InkHistory<DeckDocument>());
  const [historyVersion, setHistoryVersion] = useState(0);
  const lastLocalRef = useRef<DeckDocument | null>(null);
  // A document that did not come from our own edit — the first load, a
  // reload, a conflict resolution — makes every stored inverse meaningless.
  useEffect(() => {
    if (document && document !== lastLocalRef.current) {
      historyRef.current.clear();
      lastLocalRef.current = document;
      setHistoryVersion((version) => version + 1);
    }
  }, [document]);
  // `historyVersion` is the change signal for the mutable history object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => historyRef.current.snapshot(), [historyVersion]);

  const commit = useCallback(
    (label: string, operation: (current: DeckDocument) => DeckEdit) => {
      if (!document || !editable) return false;
      try {
        const edit = operation(document);
        if (edit.result === document) return false;
        const saved = session.updateDocument(() => edit.result);
        if (!saved) return false;
        lastLocalRef.current = saved;
        historyRef.current.push(edit, label);
        setHistoryVersion((version) => version + 1);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [document, editable, session],
  );

  const undoOrRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      if (!document || !editable) return;
      const next =
        direction === 'undo'
          ? historyRef.current.undo(document)
          : historyRef.current.redo(document);
      if (!next) return;
      try {
        lastLocalRef.current = session.updateDocument(() => next);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      setHistoryVersion((version) => version + 1);
    },
    [document, editable, session],
  );

  /* ----------------------------------------------------------------------- */
  /* Slides and selection                                                    */
  /* ----------------------------------------------------------------------- */

  const idCounter = useRef(0);
  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current}`;
  }, []);

  const measurer = useMemo(() => createCanvasMeasurer(), []);
  const resolveAsset = useDeckAssets(document, vault);

  const slideOrder = useMemo(
    () => (document && supported ? document.slideOrder : []),
    [document, supported],
  );
  const activeSlideId =
    viewState.slideId && slideOrder.includes(viewState.slideId)
      ? viewState.slideId
      : (slideOrder[0] ?? null);
  const activeIndex = activeSlideId ? slideOrder.indexOf(activeSlideId) : -1;
  const [selectedSlideIds, setSelectedSlideIds] = useState<string[]>([]);
  const railSelection = selectedSlideIds.filter((id) => slideOrder.includes(id));
  const slideSelection =
    railSelection.length > 0 && activeSlideId && railSelection.includes(activeSlideId)
      ? railSelection
      : activeSlideId
        ? [activeSlideId]
        : [];

  const resolved = useMemo(() => {
    const map = new Map<string, ResolvedSlide>();
    if (!document || !supported) return map;
    for (const id of document.slideOrder) {
      try {
        map.set(id, resolveSlide(document, id));
      } catch {
        // Shown as "Cannot display" rather than taking the deck down.
      }
    }
    return map;
  }, [document, supported]);
  const activeSlide = activeSlideId ? resolved.get(activeSlideId) : undefined;
  const geometry = useMemo(
    () =>
      document && activeSlideId && activeSlide ? slideGeometry(document, activeSlideId) : null,
    [activeSlide, activeSlideId, document],
  );

  const selectedIds = useMemo(
    () => viewState.selectedElementIds.filter((id) => geometry?.order.includes(id)),
    [geometry, viewState.selectedElementIds],
  );
  const setSelectedIds = useCallback((ids: string[]) => {
    setViewState((current) => ({ ...current, selectedElementIds: ids }));
  }, []);
  // Crop mode belongs to one image; selecting anything else leaves it.
  const [cropId, setCropId] = useState<string | null>(null);
  const croppedElement =
    selectedIds.length === 1 ? geometry?.slide.elements[selectedIds[0]] : undefined;
  const croppable = croppedElement?.type === 'image' && !croppedElement.locked;
  const cropping = croppable && cropId === selectedIds[0];
  const setCropping = (next: boolean) => setCropId(next ? (selectedIds[0] ?? null) : null);

  const showSlide = useCallback((slideId: string, railIds: string[] = [slideId]) => {
    setSelectedSlideIds(railIds);
    setViewState((current) =>
      current.slideId === slideId ? current : { ...current, slideId, selectedElementIds: [] },
    );
  }, []);

  const goTo = useCallback(
    (index: number) => {
      if (slideOrder.length === 0) return;
      showSlide(slideOrder[Math.max(0, Math.min(slideOrder.length - 1, index))]);
    },
    [showSlide, slideOrder],
  );

  const sectionStarts = useMemo(
    () =>
      new Map(
        (document && supported ? (document.sections ?? []) : []).map((section) => [
          section.firstSlideId,
          section.name,
        ]),
      ),
    [document, supported],
  );
  // A newer-schema document is never interpreted, only held read-only.
  const layouts = useMemo(
    () => (document && supported ? Object.values(document.layouts) : []),
    [document, supported],
  );

  /* ----------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ----------------------------------------------------------------------- */

  const newSlide = (layoutId: string) => {
    if (!document) return;
    const layout = document.layouts[layoutId];
    const placeholders = Object.values(layout?.elements ?? {})
      .map((element) => element.placeholder?.type)
      .filter(
        (type): type is 'title' | 'subtitle' | 'body' =>
          type === 'title' || type === 'subtitle' || type === 'body',
      );
    const slide = createSlide(nextId('slide'), layoutId, [...new Set(placeholders)]);
    if (!layout) delete slide.layoutId;
    if (commit('New slide', (current) => insertSlide(current, slide, activeIndex + 1))) {
      showSlide(slide.id);
    }
  };

  const railAction = (action: DeckRailAction) => {
    if (!document) return;
    if (action.kind === 'new') {
      newSlide(action.layoutId);
    } else if (action.kind === 'duplicate') {
      let created: string[] = [];
      const done = commit('Duplicate slide', (current) => {
        const edit = duplicateSlides(current, slideSelection, nextId);
        created = edit.slideIds;
        return edit;
      });
      if (done && created.length > 0) showSlide(created[0], created);
    } else if (action.kind === 'delete') {
      const survivors = slideOrder.filter((id) => !slideSelection.includes(id));
      const next =
        slideOrder.slice(activeIndex).find((id) => survivors.includes(id)) ??
        survivors[survivors.length - 1];
      const label = slideSelection.length > 1 ? 'Delete slides' : 'Delete slide';
      if (commit(label, (current) => deleteSlides(current, slideSelection)) && next) {
        showSlide(next);
      }
    } else if (action.kind === 'hide') {
      commit(action.hidden ? 'Hide slide' : 'Show slide', (current) =>
        setSlidesHidden(current, slideSelection, action.hidden),
      );
    } else if (action.kind === 'move') {
      const start = Math.min(...slideSelection.map((id) => slideOrder.indexOf(id)));
      commit('Move slide', (current) =>
        moveSlides(current, slideSelection, Math.max(0, start + action.by)),
      );
    }
  };

  const onSlide = (
    label: string,
    operation: (current: DeckDocument, slideId: string) => DeckEdit,
  ) => (activeSlideId ? commit(label, (current) => operation(current, activeSlideId)) : false);

  const applyUpdaters = (updaters: ElementUpdaters, label: string) =>
    Object.keys(updaters).length > 0 &&
    onSlide(label, (current, slideId) => updateElements(current, slideId, updaters));

  const insert = (kind: DeckInsertKind) => {
    if (!document || !activeSlideId) return;
    const id = nextId('el');
    const count = Object.keys(document.slides[activeSlideId].elements).length;
    const element = createInsertedElement(document, id, kind, (count % 6) * PASTE_STEP);
    if (onSlide('Insert', (current, slideId) => addElements(current, slideId, [element]))) {
      setSelectedIds([id]);
    }
  };

  const removeSelection = () => {
    if (selectedIds.length === 0) return;
    if (onSlide('Delete', (current, slideId) => removeElements(current, slideId, selectedIds))) {
      setSelectedIds([]);
    }
  };

  const reorder = (direction: DeckReorder) =>
    onSlide('Arrange', (current, slideId) =>
      reorderElements(current, slideId, selectedIds, direction),
    );

  const group = () => {
    if (!geometry || selectedIds.length < 2) return;
    const id = nextId('group');
    const frame = groupFrameFor(geometry, selectedIds);
    if (
      onSlide('Group', (current, slideId) =>
        groupElements(current, slideId, selectedIds, id, frame),
      )
    ) {
      setSelectedIds([id]);
    }
  };

  const ungroup = () => {
    if (!geometry) return;
    const groups = selectedIds.filter((id) => geometry.slide.elements[id]?.type === 'group');
    if (groups.length === 0) return;
    const children = groups.flatMap((id) => {
      const element = geometry.slide.elements[id];
      return element.type === 'group' ? element.childIds : [];
    });
    if (onSlide('Ungroup', (current, slideId) => ungroupElements(current, slideId, groups))) {
      setSelectedIds([...selectedIds.filter((id) => !groups.includes(id)), ...children]);
    }
  };

  const allLocked =
    selectedIds.length > 0 && selectedIds.every((id) => geometry?.slide.elements[id]?.locked);
  const toggleLock = () =>
    onSlide(allLocked ? 'Unlock' : 'Lock', (current, slideId) =>
      setElementsLocked(current, slideId, selectedIds, !allLocked),
    );

  const align = (alignment: DeckAlignment) =>
    geometry && applyUpdaters(alignSelection(geometry, selectedIds, alignment), 'Align');
  const distribute = (axis: 'horizontal' | 'vertical') =>
    geometry && applyUpdaters(distributeSelection(geometry, selectedIds, axis), 'Distribute');

  const nudge = (dx: number, dy: number) => {
    const movable = selectedIds.filter((id) => !geometry?.slide.elements[id]?.locked);
    if (geometry && movable.length > 0)
      applyUpdaters(moveSelection(geometry, movable, dx, dy), 'Move');
  };

  /* ----------------------------------------------------------------------- */
  /* Clipboard                                                               */
  /* ----------------------------------------------------------------------- */

  const memoryClipboard = useRef<string | null>(null);
  const pasteCount = useRef(0);

  const copyText = () =>
    geometry && selectedIds.length > 0 ? copyElements(geometry, selectedIds) : null;

  const pasteText = (text: string) => {
    if (!document || !activeSlideId || !editable) return;
    const payload = parseClipboard(text);
    pasteCount.current += 1;
    if (payload) {
      const pasted = preparePaste(payload, nextId, pasteCount.current * PASTE_STEP);
      if (
        onSlide('Paste', (current, slideId) =>
          addElements(current, slideId, pasted.elements, { topLevelIds: pasted.topLevel }),
        )
      ) {
        setSelectedIds(pasted.topLevel);
      }
      return;
    }
    if (!text.trim()) return;
    const id = nextId('el');
    const box = createInsertedElement(document, id, 'text', (pasteCount.current % 6) * PASTE_STEP);
    if (box.type !== 'text') return;
    box.text = { ...box.text, content: { paragraphs: textToParagraphs(text, id) } };
    if (onSlide('Paste', (current, slideId) => addElements(current, slideId, [box]))) {
      setSelectedIds([id]);
    }
  };

  const onCopyEvent = (event: React.ClipboardEvent, cut: boolean) => {
    if (isEditableTarget(event.target)) return;
    const text = copyText();
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    memoryClipboard.current = text;
    pasteCount.current = 0;
    if (cut) removeSelection();
  };

  const onPasteEvent = (event: React.ClipboardEvent) => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    pasteText(event.clipboardData.getData('text/plain') || memoryClipboard.current || '');
  };

  /** Menu paste receives no paste event: read the clipboard, or fall back to the last copy. */
  const pasteFromMenu = async () => {
    let text = memoryClipboard.current ?? '';
    try {
      text = (await navigator.clipboard.readText()) || text;
    } catch {
      // Clipboard reads can be refused by the WebView; the in-app copy remains.
    }
    pasteText(text);
  };

  const copyFromMenu = async (cut: boolean) => {
    const text = copyText();
    if (!text) return;
    memoryClipboard.current = text;
    pasteCount.current = 0;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The in-app clipboard still has it.
    }
    if (cut) removeSelection();
  };

  const duplicateSelection = () => {
    const text = copyText();
    if (!text) return;
    pasteCount.current = 0;
    pasteText(text);
  };

  /* ----------------------------------------------------------------------- */
  /* Zoom                                                                    */
  /* ----------------------------------------------------------------------- */

  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const rulerPx = viewState.showRulers ? 20 : 0;
  const fitZoom =
    document && supported
      ? fitSlide(document.size, {
          width: Math.max(1, stageSize.width - rulerPx - STAGE_MARGIN_PX * 2),
          height: Math.max(1, stageSize.height - rulerPx - STAGE_MARGIN_PX * 2),
        }).scale || 1
      : 1;
  const zoom = viewState.zoom === 'fit' ? fitZoom : viewState.zoom;
  const setZoom = (next: number | 'fit') =>
    setViewState((current) => ({
      ...current,
      zoom: next === 'fit' ? 'fit' : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)),
    }));
  const stepZoom = (direction: 1 | -1) =>
    setZoom(
      direction > 0
        ? (ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM)
        : ([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? MIN_ZOOM),
    );

  /* ----------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ----------------------------------------------------------------------- */

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const inRail = (event.target as HTMLElement).closest?.('[aria-label="Slides"]') != null;
    const key = event.key;
    const lower = key.toLowerCase();
    const run = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };

    if (mod && lower === 'z') return run(() => undoOrRedo(event.shiftKey ? 'redo' : 'undo'));
    if (mod && lower === 'y') return run(() => undoOrRedo('redo'));
    if (mod && lower === 's') return run(() => void session.save());
    if (mod && (key === '=' || key === '+')) return run(() => stepZoom(1));
    if (mod && key === '-') return run(() => stepZoom(-1));
    if (mod && key === '0') return run(() => setZoom('fit'));
    if (mod && lower === 'm') {
      const layoutId =
        (activeSlideId && document?.slides[activeSlideId]?.layoutId) || layouts[0]?.id || '';
      return run(() => newSlide(layoutId));
    }

    // Slide navigation: in the rail, or on the stage with nothing selected.
    if (inRail || selectedIds.length === 0) {
      if (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
        return run(() => railAction({ kind: 'move', by: key === 'ArrowDown' ? 1 : -1 }));
      }
      const forward =
        key === 'ArrowDown' || key === 'PageDown' || (!inRail && key === 'ArrowRight');
      const back = key === 'ArrowUp' || key === 'PageUp' || (!inRail && key === 'ArrowLeft');
      if (forward) return run(() => goTo(activeIndex + 1));
      if (back) return run(() => goTo(activeIndex - 1));
      if (key === 'Home') return run(() => goTo(0));
      if (key === 'End') return run(() => goTo(slideOrder.length - 1));
      if (inRail && (key === 'Delete' || key === 'Backspace')) {
        return run(() => railAction({ kind: 'delete' }));
      }
      if (inRail && mod && lower === 'd') return run(() => railAction({ kind: 'duplicate' }));
    }

    if (mod && lower === 'a') return run(() => setSelectedIds(geometry?.order ?? []));
    if (key === 'Escape') return run(() => (cropping ? setCropping(false) : setSelectedIds([])));
    if (key === 'Tab' && geometry && geometry.order.length > 0) {
      return run(() => {
        const current = selectedIds.length === 1 ? geometry.order.indexOf(selectedIds[0]) : -1;
        const count = geometry.order.length;
        setSelectedIds([geometry.order[(current + (event.shiftKey ? -1 : 1) + count) % count]]);
      });
    }
    if (selectedIds.length === 0) return;
    const step = event.shiftKey ? NUDGE * 10 : NUDGE;
    if (key === 'ArrowLeft') return run(() => nudge(-step, 0));
    if (key === 'ArrowRight') return run(() => nudge(step, 0));
    if (key === 'ArrowUp') return run(() => nudge(0, -step));
    if (key === 'ArrowDown') return run(() => nudge(0, step));
    if (key === 'Delete' || key === 'Backspace') return run(removeSelection);
    if (mod && lower === 'd') return run(duplicateSelection);
    if (mod && lower === 'g') return run(event.shiftKey ? ungroup : group);
    if (mod && key === ']') return run(() => reorder(event.shiftKey ? 'front' : 'forward'));
    if (mod && key === '[') return run(() => reorder(event.shiftKey ? 'back' : 'backward'));
  };

  /* ----------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ----------------------------------------------------------------------- */

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
  const hasSelection = selectedIds.length > 0;
  const hasGroup = selectedIds.some((id) => geometry?.slide.elements[id]?.type === 'group');
  const aspect = document && supported ? document.size.width / document.size.height : 16 / 9;

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-background outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCopy={(event) => onCopyEvent(event, false)}
      onCut={(event) => onCopyEvent(event, true)}
      onPaste={onPasteEvent}
    >
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
            <>
              <span>
                Slide {activeIndex + 1} of {slideOrder.length}
              </span>
              {hasSelection && <span>{selectedIds.length} selected</span>}
            </>
          ) : undefined
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton
                onClick={() => undoOrRedo('undo')}
                disabled={!editable || !history.canUndo}
                aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
              >
                <Undo2 size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() => undoOrRedo('redo')}
                disabled={!editable || !history.canRedo}
                aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
              >
                <Redo2 size={14} />
              </DocumentTopBarIconButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton disabled={!editable}>
                    <LayoutTemplate size={14} />
                    New slide
                  </DocumentTopBarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {layouts.map((layout) => (
                    <DropdownMenuItem key={layout.id} onClick={() => newSlide(layout.id)}>
                      {layout.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton disabled={!editable || !activeSlideId}>
                    <Shapes size={14} />
                    Insert
                  </DocumentTopBarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => insert('text')}>
                    <Type size={13} /> Text box
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => insert('rect')}>
                    <Square size={13} /> Rectangle
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => insert('roundRect')}>
                    <Square size={13} /> Rounded rectangle
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => insert('ellipse')}>
                    <Circle size={13} /> Ellipse
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => insert('line')}>
                    <Minus size={13} /> Line
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton disabled={!editable || !hasSelection}>
                    <Group size={14} />
                    Arrange
                  </DocumentTopBarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuItem onClick={() => reorder('front')}>
                    <ArrowUpToLine size={13} /> Bring to front
                    <DropdownMenuShortcut>Ctrl+Shift+]</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => reorder('forward')}>
                    Bring forward <DropdownMenuShortcut>Ctrl+]</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => reorder('backward')}>
                    Send backward <DropdownMenuShortcut>Ctrl+[</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => reorder('back')}>
                    <ArrowDownToLine size={13} /> Send to back
                    <DropdownMenuShortcut>Ctrl+Shift+[</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={selectedIds.length < 2} onClick={group}>
                    <Group size={13} /> Group <DropdownMenuShortcut>Ctrl+G</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!hasGroup} onClick={ungroup}>
                    <Ungroup size={13} /> Ungroup
                    <DropdownMenuShortcut>Ctrl+Shift+G</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleLock}>
                    <Lock size={13} /> {allLocked ? 'Unlock' : 'Lock'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px]">
                    Align {selectedIds.length < 2 ? 'to slide' : 'to selection'}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => align('left')}>
                    <AlignStartVertical size={13} /> Left
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => align('center')}>
                    <AlignCenterVertical size={13} /> Centre
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => align('right')}>
                    <AlignEndVertical size={13} /> Right
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => align('top')}>
                    <AlignStartHorizontal size={13} /> Top
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => align('middle')}>
                    <AlignCenterHorizontal size={13} /> Middle
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => align('bottom')}>
                    <AlignEndHorizontal size={13} /> Bottom
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={selectedIds.length < 3}
                    onClick={() => distribute('horizontal')}
                  >
                    <AlignHorizontalSpaceAround size={13} /> Distribute horizontally
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={selectedIds.length < 3}
                    onClick={() => distribute('vertical')}
                  >
                    <AlignVerticalSpaceAround size={13} /> Distribute vertically
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton onClick={() => stepZoom(-1)} aria-label="Zoom out">
                <Minus size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarButton
                onClick={() => setZoom('fit')}
                aria-label="Fit slide"
                className="min-w-14 justify-center tabular-nums"
              >
                {viewState.zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
              </DocumentTopBarButton>
              <DocumentTopBarIconButton onClick={() => stepZoom(1)} aria-label="Zoom in">
                <Plus size={14} />
              </DocumentTopBarIconButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarIconButton aria-label="View options">
                    <Settings2 size={14} />
                  </DocumentTopBarIconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuCheckboxItem
                    checked={viewState.showRulers ?? false}
                    onCheckedChange={(checked) =>
                      setViewState((current) => ({ ...current, showRulers: checked }))
                    }
                  >
                    Rulers
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.snapToObjects ?? true}
                    onCheckedChange={(checked) =>
                      setViewState((current) => ({ ...current, snapToObjects: checked }))
                    }
                  >
                    Smart guides
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showGrid ?? false}
                    onCheckedChange={(checked) =>
                      setViewState((current) => ({ ...current, showGrid: checked }))
                    }
                  >
                    Grid (snap to ¼ inch)
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
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

      <div className="flex min-h-0 flex-1" role="application" aria-label="Presentation editor">
        {viewState.slideRailOpen && slideOrder.length > 0 && (
          <DeckSlideRail
            slideOrder={slideOrder}
            slides={resolved}
            sections={sectionStarts}
            layouts={layouts}
            activeId={activeSlideId}
            selectedIds={slideSelection}
            readOnly={!editable}
            measurer={measurer}
            resolveAsset={resolveAsset}
            aspect={aspect}
            onSelect={(ids, active) => showSlide(active, ids)}
            onMove={(ids, toIndex) =>
              commit('Move slide', (current) => moveSlides(current, ids, toIndex))
            }
            onAction={railAction}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={stageRef}
                className="relative min-h-0 flex-1 outline-none"
                tabIndex={0}
                aria-label="Slide canvas"
              >
                {document && activeSlideId && activeSlide && geometry && stageSize.width > 0 ? (
                  <DeckStage
                    deck={document}
                    slideId={activeSlideId}
                    resolved={activeSlide}
                    geometry={geometry}
                    zoom={zoom}
                    measurer={measurer}
                    resolveAsset={resolveAsset}
                    selectedIds={selectedIds}
                    readOnly={!editable}
                    cropping={cropping}
                    onCroppingChange={setCropId}
                    options={{
                      snapToObjects: viewState.snapToObjects ?? true,
                      grid: viewState.showGrid ? GRID : 0,
                      showRulers: viewState.showRulers ?? false,
                    }}
                    onSelectionChange={setSelectedIds}
                    onCommit={(updaters, label) => applyUpdaters(updaters, label)}
                    onZoom={(next) => setZoom(next)}
                  />
                ) : null}
              </div>
            </ContextMenuTrigger>
            {editable && (
              <ContextMenuContent className="w-56">
                <ContextMenuItem disabled={!hasSelection} onClick={() => void copyFromMenu(true)}>
                  Cut <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasSelection} onClick={() => void copyFromMenu(false)}>
                  Copy <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void pasteFromMenu()}>
                  Paste <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasSelection} onClick={duplicateSelection}>
                  Duplicate <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
                </ContextMenuItem>
                {editable && croppable && (
                  <ContextMenuItem onClick={() => setCropping(!cropping)}>
                    {cropping ? 'Finish crop' : 'Crop image'}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem disabled={selectedIds.length < 2} onClick={group}>
                  Group <ContextMenuShortcut>Ctrl+G</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasGroup} onClick={ungroup}>
                  Ungroup <ContextMenuShortcut>Ctrl+Shift+G</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasSelection} onClick={() => reorder('front')}>
                  Bring to front
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasSelection} onClick={() => reorder('back')}>
                  Send to back
                </ContextMenuItem>
                <ContextMenuItem disabled={!hasSelection} onClick={toggleLock}>
                  {allLocked ? 'Unlock' : 'Lock'}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={!hasSelection}
                  onClick={removeSelection}
                >
                  Delete <ContextMenuShortcut>Del</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
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
