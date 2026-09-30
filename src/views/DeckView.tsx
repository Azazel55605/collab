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
  Paintbrush,
  PanelLeft,
  PanelRight,
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
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { DeckDesignRail } from '../components/deck/DeckDesignRail';
import type { DeckDesignTarget } from '../components/deck/DeckDesignRail';
import { DeckInspector } from '../components/deck/DeckInspector';
import type { MasterTextClass, MasterTextStylePatch } from '../components/deck/DeckInspector';
import { DeckLinkDialog } from '../components/deck/DeckLinkDialog';
import { DeckSlideRail } from '../components/deck/DeckSlideRail';
import type { DeckRailAction } from '../components/deck/DeckSlideRail';
import { DeckStage } from '../components/deck/DeckStage';
import { DeckTextEditor } from '../components/deck/DeckTextEditor';
import type { TextEditKind } from '../components/deck/DeckTextEditor';
import { DeckTextToolbar } from '../components/deck/DeckTextToolbar';
import type { DeckFontChoice, TextBoxSettings } from '../components/deck/DeckTextToolbar';
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
import {
  createSlideForLayout,
  deleteLayout,
  duplicateLayout,
  hasPlaceholderOverrides,
  insertPlaceholder,
  orderedLayouts,
  placeholderName,
  resetPlaceholders,
  setSlideLayout,
  updateLayout,
  updateMaster,
  updateTheme,
} from '../lib/deck/design';
import { createInsertedElement } from '../lib/deck/insert';
import type { DeckInsertKind } from '../lib/deck/insert';
import {
  addElements,
  applyPatch,
  composeEdits,
  deleteSlides,
  duplicateSlides,
  groupElements,
  insertSlide,
  moveSlides,
  removeElements,
  reorderElements,
  setElementsLocked,
  setSlidesHidden,
  setSpeakerNotes,
  ungroupElements,
  updateElements,
} from '../lib/deck/operations';
import type { DeckEdit, DeckOperation, DeckReorder, DeckTargetRef } from '../lib/deck/operations';
import { plainText, resolveDesign, resolveSlide, resolveTarget } from '../lib/deck/resolve';
import type {
  DeckTarget,
  ResolvedShapeItem,
  ResolvedSlide,
  ResolvedTextBody,
} from '../lib/deck/resolve';
import {
  linkExtent,
  linkInRange,
  normalizeRange,
  paragraphStarts,
  textLength,
} from '../lib/deck/richText';
import { fitSlide } from '../lib/deck/svg';
import { applyTemplate } from '../lib/deck/templates';
import type { DeckTemplateId } from '../lib/deck/templates';
import { runTextCommand, textState, wholeBody } from '../lib/deck/textCommands';
import type { TextCommand, TextState } from '../lib/deck/textCommands';
import { createCanvasMeasurer, layoutText } from '../lib/deck/textLayout';
import type { DeckTextMeasurer } from '../lib/deck/textLayout';
import { editSession, redoSession, startTextSession, undoSession } from '../lib/deck/textSession';
import type { EditorSelection, TextSession, TextSessionEditKind } from '../lib/deck/textSession';
import {
  alignSelection,
  distributeSelection,
  groupFrameFor,
  moveSelection,
  targetGeometry,
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
import {
  DECK_SCHEMA_VERSION,
  DECK_UNITS_PER_INCH,
  DECK_UNITS_PER_POINT,
  DECK_UNITS_PER_PX,
} from '../types/deck';
import type {
  DeckAssetRef,
  DeckColor,
  DeckDocument,
  DeckElement,
  DeckFill,
  DeckLink,
  DeckPlaceholderType,
  DeckRichText,
  DeckTextLevelStyle,
  DeckThemeColorToken,
  DeckThemeFontRole,
} from '../types/deck';
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
  inspectorOpen: false,
};

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const STAGE_MARGIN_PX = 48;
const NUDGE = DECK_UNITS_PER_POINT;
const GRID = DECK_UNITS_PER_INCH / 4;
const PASTE_STEP = 12 * DECK_UNITS_PER_POINT;
/** How long typing may pause before the draft is written to the document. */
const TEXT_FLUSH_MS = 400;

const SERIF_FAMILIES = /georgia|times|palatino|garamond|serif|cambria|book antiqua/i;
const MONO_FAMILIES = /mono|courier|consolas/i;

/** Fallbacks for a theme font chosen by name: same generic class, then the generic. */
function fallbacksFor(family: string): string[] {
  if (MONO_FAMILIES.test(family)) return ['Courier New', 'monospace'];
  if (SERIF_FAMILIES.test(family)) return ['Times New Roman', 'serif'];
  return ['Arial', 'sans-serif'];
}

const PLACEHOLDER_INSERTS: DeckPlaceholderType[] = [
  'title',
  'subtitle',
  'body',
  'date',
  'footer',
  'slideNumber',
];

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

/**
 * The size of an element that may mount after the view does (the stage only
 * exists once the deck has loaded), so it is tracked through a callback ref.
 */
function useElementSize<T extends HTMLElement>() {
  const [element, ref] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
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
  }, [element]);
  return [ref, size] as const;
}

const noEdit: DeckOperation = (document) => ({ result: document, inverse: noEdit });

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const isTextCapable = (element: DeckElement | undefined) =>
  element?.type === 'text' || element?.type === 'shape';

/** An element with a new text body; shapes without text gain one. */
function withContent(element: DeckElement, content: DeckRichText): DeckElement {
  if (element.type !== 'text' && element.type !== 'shape') return element;
  return { ...element, text: { ...(element.text ?? {}), content } } as DeckElement;
}

/** The resolved text body of an element in a scene. */
function itemText(scene: ResolvedSlide | undefined, id: string): ResolvedShapeItem | undefined {
  const item = scene?.items.find((entry) => entry.id === id);
  return item?.kind === 'shape' ? item : undefined;
}

/**
 * Frame updates for "resize box to fit text": each text box whose autofit is
 * `grow` takes exactly the height its text needs, as PowerPoint does.
 */
function growToFit(
  deck: DeckDocument,
  target: DeckTarget,
  ids: string[],
  measurer: DeckTextMeasurer,
): ElementUpdaters {
  const scene = resolveTarget(deck, target);
  const updaters: ElementUpdaters = {};
  for (const id of ids) {
    const item = itemText(scene, id);
    if (!item?.text || item.text.autoFit !== 'grow') continue;
    const layout = layoutText(item.text, item.frame.width, item.frame.height, measurer);
    const height = Math.max(DECK_UNITS_PER_POINT, Math.ceil(layout.contentHeight));
    if (Math.abs(height - item.frame.height) < 1) continue;
    updaters[id] = (element) =>
      element.type === 'line'
        ? element
        : ({
            ...element,
            frame: { ...item.frame, ...(element.frame ?? {}), height },
          } as DeckElement);
  }
  return updaters;
}

/**
 * The `.deck` editor.
 *
 * Phase 2 built the scene editor: slide management, selection, move, resize,
 * rotate, snapping, order, group, lock, align, distribute, clipboard, and
 * undo/redo. Phase 3 adds in-place rich-text editing, the text toolbar,
 * speaker-notes editing, placeholders with prompts and overrides, theme
 * editing, built-in designs, and the master and layout editor. The full object
 * gallery and images are Phase 4.
 *
 * Every change goes through a reversible operation and one local undo stack;
 * the session re-validates each result before it can save.
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
  /** The last commit that may absorb the next one with the same key. */
  const coalesceRef = useRef<{ key: string; depth: number } | null>(null);
  // A document that did not come from our own edit — the first load, a
  // reload, a conflict resolution — makes every stored inverse meaningless.
  useEffect(() => {
    if (document && document !== lastLocalRef.current) {
      historyRef.current.clear();
      coalesceRef.current = null;
      lastLocalRef.current = document;
      setHistoryVersion((version) => version + 1);
    }
  }, [document]);
  // `historyVersion` is the change signal for the mutable history object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => historyRef.current.snapshot(), [historyVersion]);

  /**
   * Applies an operation to the current document as one undo step. With a
   * `coalesce` key, an operation following one with the same key — and
   * nothing in between — joins its step instead: the step's inverse already
   * restores everything those operations touch.
   */
  const commit = useCallback(
    (label: string, operation: DeckOperation, coalesce?: string) => {
      if (!editable) return false;
      try {
        let edit: DeckEdit | null = null;
        let input: DeckDocument | null = null;
        const saved = session.updateDocument((current) => {
          input = current;
          edit = operation(current);
          return edit.result;
        });
        if (!saved || !edit || (edit as DeckEdit).result === input) return false;
        lastLocalRef.current = saved;
        const depth = historyRef.current.snapshot().depth;
        const joins =
          coalesce !== undefined &&
          coalesceRef.current?.key === coalesce &&
          coalesceRef.current.depth === depth &&
          !historyRef.current.snapshot().canRedo;
        if (!joins) {
          historyRef.current.push(edit!, label);
          coalesceRef.current =
            coalesce !== undefined
              ? { key: coalesce, depth: historyRef.current.snapshot().depth }
              : null;
        }
        setHistoryVersion((version) => version + 1);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [editable, session],
  );

  const undoOrRedo = useCallback(
    (direction: 'undo' | 'redo') => {
      if (!document || !editable) return;
      coalesceRef.current = null;
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
  /* Slides, design targets, and selection                                   */
  /* ----------------------------------------------------------------------- */

  const idCounter = useRef(0);
  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current}`;
  }, []);
  const nextParagraphId = useCallback(() => nextId('p'), [nextId]);

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

  // The master and layout editor. A target removed underneath (undo, reload)
  // falls back to the first master.
  const [designTargetState, setDesignTarget] = useState<DeckDesignTarget | null>(null);
  const designTarget: DeckDesignTarget | null =
    designTargetState && document && supported
      ? designTargetState.kind === 'layout' && document.layouts[designTargetState.id]
        ? designTargetState
        : designTargetState.kind === 'master' && document.masters[designTargetState.id]
          ? designTargetState
          : Object.keys(document.masters).length > 0
            ? { kind: 'master', id: Object.keys(document.masters).sort()[0] }
            : null
      : null;
  const stageTarget: DeckTarget | null =
    designTarget ?? (activeSlideId ? { kind: 'slide', id: activeSlideId } : null);
  const stageKey = stageTarget ? `${stageTarget.kind}:${stageTarget.id}` : '';

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

  const designScenes = useMemo(() => {
    const map = new Map<string, ResolvedSlide>();
    if (!document || !supported || !designTarget) return map;
    for (const master of Object.keys(document.masters)) {
      try {
        map.set(`master:${master}`, resolveDesign(document, { kind: 'master', id: master }));
      } catch {
        // Drawn as "Cannot display".
      }
    }
    for (const layout of Object.keys(document.layouts)) {
      try {
        map.set(`layout:${layout}`, resolveDesign(document, { kind: 'layout', id: layout }));
      } catch {
        // Drawn as "Cannot display".
      }
    }
    return map;
    // `designTarget` only switches the scenes on; its identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, supported, designTarget !== null]);

  const geometry = useMemo(() => {
    if (!document || !supported || !stageTarget) return null;
    try {
      return targetGeometry(document, stageTarget);
    } catch {
      return null;
    }
    // `stageKey` stands for `stageTarget`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, supported, stageKey]);

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

  /* ----------------------------------------------------------------------- */
  /* Text editing sessions                                                   */
  /* ----------------------------------------------------------------------- */

  const [textSession, setTextSessionState] = useState<TextSession | null>(null);
  const textSessionRef = useRef<TextSession | null>(null);
  const setTextSession = useCallback((next: TextSession | null) => {
    textSessionRef.current = next;
    setTextSessionState(next);
  }, []);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measurerRef = useRef(measurer);
  measurerRef.current = measurer;

  /** Writes a session's draft to the document, as one undo step per session. */
  const flushText = useCallback(
    (active: TextSession | null = textSessionRef.current) => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (!active) return;
      const coalesce = `text:${active.id}`;
      if (active.kind === 'notes') {
        const slideId = active.target.id;
        commit(
          'Edit notes',
          (current) =>
            current.slides[slideId]?.speakerNotes === active.body
              ? noEdit(current)
              : setSpeakerNotes(current, slideId, active.body),
          coalesce,
        );
        return;
      }
      const elementId = active.elementId!;
      commit(
        'Edit text',
        (current) => {
          let container;
          try {
            container = targetGeometry(current, active.target).slide;
          } catch {
            return noEdit(current);
          }
          const element = container.elements[elementId];
          if (!element || !isTextCapable(element)) return noEdit(current);
          const stored =
            element.type === 'text' || element.type === 'shape' ? element.text?.content : undefined;
          if (stored === active.body) return noEdit(current);
          return composeEdits(current, [
            (deck) =>
              updateElements(deck, active.target, {
                [elementId]: (entry) => withContent(entry, active.body),
              }),
            (deck) =>
              updateElements(
                deck,
                active.target,
                growToFit(deck, active.target, [elementId], measurerRef.current),
              ),
          ]);
        },
        coalesce,
      );
    },
    [commit],
  );

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushText();
    }, TEXT_FLUSH_MS);
  }, [flushText]);

  /** Ends editing, writing whatever is still in the draft. */
  const endTextSession = useCallback(() => {
    const active = textSessionRef.current;
    if (!active) return;
    flushText(active);
    coalesceRef.current = null;
    setTextSession(null);
  }, [flushText, setTextSession]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  // Leaving the slide, layout, or master being edited ends the session.
  useEffect(() => {
    const active = textSessionRef.current;
    if (!active) return;
    if (`${active.target.kind}:${active.target.id}` !== stageKey) endTextSession();
  }, [endTextSession, stageKey]);

  // A document replaced underneath (reload, conflict) abandons the draft.
  useEffect(() => {
    if (document && document !== lastLocalRef.current && textSessionRef.current) {
      setTextSession(null);
    }
  }, [document, setTextSession]);

  const beginTextEdit = (elementId: string, point: { clientX: number; clientY: number } | null) => {
    if (!document || !stageTarget || !geometry || !editable) return;
    const element = geometry.slide.elements[elementId];
    if (!isTextCapable(element) || element?.locked) return;
    endTextSession();
    const body =
      element?.type === 'text' || element?.type === 'shape'
        ? (element.text?.content ?? { paragraphs: [] })
        : { paragraphs: [] };
    const end = textLength(body);
    setCropId(null);
    setTextSession(
      startTextSession({
        kind: 'element',
        target: stageTarget,
        elementId,
        body,
        selection: { anchor: end, focus: end },
        initialPoint: point,
      }),
    );
  };

  const beginNotesEdit = (point: { clientX: number; clientY: number } | null) => {
    if (!document || !activeSlideId || !editable || designTarget) return;
    endTextSession();
    const body = document.slides[activeSlideId]?.speakerNotes ?? { paragraphs: [] };
    const end = textLength(body);
    setTextSession(
      startTextSession({
        kind: 'notes',
        target: { kind: 'slide', id: activeSlideId },
        elementId: null,
        body,
        selection: { anchor: end, focus: end },
        initialPoint: point,
      }),
    );
  };

  const onTextChange = useCallback(
    (body: DeckRichText, selection: EditorSelection, kind: TextEditKind | TextSessionEditKind) => {
      const active = textSessionRef.current;
      if (!active) return;
      setTextSession(editSession(active, body, selection, kind, Date.now()));
      scheduleFlush();
    },
    [scheduleFlush, setTextSession],
  );

  const onTextSelection = useCallback(
    (selection: EditorSelection) => {
      const active = textSessionRef.current;
      if (!active) return;
      setTextSession({ ...active, selection, pending: null });
    },
    [setTextSession],
  );

  const onTextUndo = useCallback(() => {
    const active = textSessionRef.current;
    if (!active) return;
    const previous = undoSession(active);
    if (previous) {
      setTextSession(previous);
      scheduleFlush();
      return;
    }
    // Nothing left in this session: leave it and undo on the deck.
    endTextSession();
    undoOrRedo('undo');
  }, [endTextSession, scheduleFlush, setTextSession, undoOrRedo]);

  const onTextRedo = useCallback(() => {
    const active = textSessionRef.current;
    if (!active) return;
    const next = redoSession(active);
    if (next) {
      setTextSession(next);
      scheduleFlush();
    }
  }, [scheduleFlush, setTextSession]);

  /** The document with the session's draft applied: what the editor shows. */
  const draftDeck = useMemo(() => {
    if (!document || !textSession) return document;
    try {
      if (textSession.kind === 'notes') {
        const slide = document.slides[textSession.target.id];
        if (!slide) return document;
        return applyPatch(document, {
          slides: { [slide.id]: { ...slide, speakerNotes: textSession.body } },
        }).result;
      }
      return updateElements(document, textSession.target, {
        [textSession.elementId!]: (element) => withContent(element, textSession.body),
      }).result;
    } catch {
      return document;
    }
  }, [document, textSession]);

  const draftScene = useMemo(() => {
    if (!draftDeck || !textSession) return null;
    try {
      return resolveTarget(draftDeck, textSession.target);
    } catch {
      return null;
    }
  }, [draftDeck, textSession]);

  /** The resolved body of the text being edited. */
  const draftResolved: ResolvedTextBody | null = useMemo(() => {
    if (!textSession || !draftScene) return null;
    if (textSession.kind === 'notes') {
      return (
        draftScene.notes ?? {
          paragraphs: [],
          insets: [0, 0, 0, 0],
          verticalAlign: 'top',
          autoFit: 'none',
          wrap: true,
        }
      );
    }
    return itemText(draftScene, textSession.elementId!)?.text ?? null;
  }, [draftScene, textSession]);

  /* ----------------------------------------------------------------------- */
  /* Scenes shown on the stage                                               */
  /* ----------------------------------------------------------------------- */

  const stageScene = useMemo(() => {
    const source = draftDeck ?? document;
    if (!source || !supported || !stageTarget) return undefined;
    try {
      const scene = resolveTarget(source, stageTarget, { prompts: true });
      if (textSession?.kind !== 'element') return scene;
      // The element being edited draws through the editor instead.
      return {
        ...scene,
        items: scene.items.map((item) =>
          item.id === textSession.elementId && item.kind === 'shape'
            ? { ...item, text: null }
            : item,
        ),
      };
    } catch {
      return undefined;
    }
    // `stageKey` stands for `stageTarget`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, draftDeck, stageKey, supported, textSession?.kind, textSession?.elementId]);

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
    () => (document && supported ? orderedLayouts(document) : []),
    [document, supported],
  );

  /* ----------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ----------------------------------------------------------------------- */

  const newSlide = (layoutId: string) => {
    if (!document) return;
    endTextSession();
    const slide = createSlideForLayout(nextId('slide'), document.layouts[layoutId]);
    if (commit('New slide', (current) => insertSlide(current, slide, activeIndex + 1))) {
      showSlide(slide.id);
    }
  };

  const railAction = (action: DeckRailAction) => {
    if (!document) return;
    endTextSession();
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

  /** Runs an operation on whatever the stage shows: a slide, a layout, or a master. */
  const onSlide = (
    label: string,
    operation: (current: DeckDocument, target: DeckTargetRef) => DeckEdit,
  ) => {
    if (!stageTarget) return false;
    endTextSession();
    const target: DeckTargetRef = stageTarget.kind === 'slide' ? stageTarget.id : stageTarget;
    return commit(label, (current) => operation(current, target));
  };

  const applyUpdaters = (updaters: ElementUpdaters, label: string) =>
    Object.keys(updaters).length > 0 &&
    onSlide(label, (current, target) => updateElements(current, target, updaters));

  const insert = (kind: DeckInsertKind) => {
    if (!document || !geometry) return;
    const id = nextId('el');
    const count = Object.keys(geometry.slide.elements).length;
    const element = createInsertedElement(document, id, kind, (count % 6) * PASTE_STEP);
    if (onSlide('Insert', (current, target) => addElements(current, target, [element]))) {
      setSelectedIds([id]);
      // A new text box opens for typing, as in PowerPoint.
      if (kind === 'text' && element.type === 'text' && stageTarget) {
        setTextSession(
          startTextSession({
            kind: 'element',
            target: stageTarget,
            elementId: id,
            body: element.text.content,
            selection: { anchor: 0, focus: textLength(element.text.content) },
          }),
        );
      }
    }
  };

  const insertDesignPlaceholder = (type: DeckPlaceholderType) => {
    if (!designTarget) return;
    const id = nextId('ph');
    endTextSession();
    if (
      commit(`Insert ${placeholderName(type).toLowerCase()} placeholder`, (current) =>
        insertPlaceholder(current, designTarget, type, id),
      )
    ) {
      setSelectedIds([id]);
    }
  };

  const removeSelection = () => {
    if (selectedIds.length === 0) return;
    if (onSlide('Delete', (current, target) => removeElements(current, target, selectedIds))) {
      setSelectedIds([]);
    }
  };

  const reorder = (direction: DeckReorder) =>
    onSlide('Arrange', (current, target) =>
      reorderElements(current, target, selectedIds, direction),
    );

  const group = () => {
    if (!geometry || selectedIds.length < 2) return;
    const id = nextId('group');
    const frame = groupFrameFor(geometry, selectedIds);
    if (
      onSlide('Group', (current, target) => groupElements(current, target, selectedIds, id, frame))
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
    if (onSlide('Ungroup', (current, target) => ungroupElements(current, target, groups))) {
      setSelectedIds([...selectedIds.filter((id) => !groups.includes(id)), ...children]);
    }
  };

  const allLocked =
    selectedIds.length > 0 && selectedIds.every((id) => geometry?.slide.elements[id]?.locked);
  const toggleLock = () =>
    onSlide(allLocked ? 'Unlock' : 'Lock', (current, target) =>
      setElementsLocked(current, target, selectedIds, !allLocked),
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
  /* Text formatting                                                         */
  /* ----------------------------------------------------------------------- */

  const textTargets = selectedIds.filter((id) => isTextCapable(geometry?.slide.elements[id]));
  const editingElement =
    textSession?.kind === 'element' ? geometry?.slide.elements[textSession.elementId!] : undefined;

  /** Applies a text command to the edited selection, or to every selected box's text. */
  const runCommand = (command: TextCommand) => {
    const active = textSessionRef.current;
    if (active && draftResolved) {
      const range = normalizeRange(
        { start: active.selection.anchor, end: active.selection.focus },
        active.body,
      );
      const result = runTextCommand(active.body, draftResolved, range, command, active.pending);
      const edited = editSession(active, result.body, active.selection, 'format', Date.now());
      setTextSession({
        ...edited,
        pending: result.pending !== undefined ? result.pending : active.pending,
        focusRequest: active.focusRequest + 1,
      });
      if (result.body !== active.body) scheduleFlush();
      return;
    }
    if (!stageTarget || !stageScene || textTargets.length === 0) return;
    const scene = stageScene;
    const target = stageTarget;
    onSlide('Format text', (current, ref) =>
      composeEdits(current, [
        (deck) => {
          const updaters: ElementUpdaters = {};
          for (const id of textTargets) {
            const resolvedText = itemText(scene, id)?.text;
            updaters[id] = (element) => {
              if (element.type !== 'text' && element.type !== 'shape') return element;
              const body = element.text?.content;
              if (
                !body ||
                !resolvedText ||
                resolvedText.paragraphs.length !== body.paragraphs.length
              ) {
                return element;
              }
              const result = runTextCommand(body, resolvedText, wholeBody(body), command);
              return result.body === body ? element : withContent(element, result.body);
            };
          }
          return updateElements(deck, ref, updaters);
        },
        (deck) => updateElements(deck, ref, growToFit(deck, target, textTargets, measurer)),
      ]),
    );
  };

  const setFont = (font: DeckFontChoice) => runCommand({ kind: 'style', patch: { font } });
  const setColor = (color: DeckColor | null) => runCommand({ kind: 'style', patch: { color } });

  const boxIds = textSession?.kind === 'element' ? [textSession.elementId!] : textTargets;
  const boxItem = boxIds.length > 0 ? itemText(stageScene, boxIds[0]) : undefined;
  const box: TextBoxSettings | null = (() => {
    const source =
      textSession?.kind === 'element'
        ? itemText(draftScene ?? undefined, textSession.elementId!)?.text
        : boxItem?.text;
    return source
      ? { autoFit: source.autoFit, verticalAlign: source.verticalAlign, wrap: source.wrap }
      : null;
  })();

  const setBox = (patch: Partial<TextBoxSettings>) => {
    const ids = boxIds;
    if (ids.length === 0 || !stageTarget) return;
    flushText();
    const target = stageTarget;
    onSlide('Text box options', (current, ref) =>
      composeEdits(current, [
        (deck) =>
          updateElements(
            deck,
            ref,
            Object.fromEntries(
              ids.map((id) => [
                id,
                (element: DeckElement) =>
                  element.type === 'text' || element.type === 'shape'
                    ? ({
                        ...element,
                        text: {
                          ...(element.text ?? { content: { paragraphs: [] } }),
                          ...patch,
                        },
                      } as DeckElement)
                    : element,
              ]),
            ),
          ),
        (deck) => updateElements(deck, ref, growToFit(deck, target, ids, measurer)),
      ]),
    );
    const active = textSessionRef.current;
    if (active) setTextSession({ ...active, focusRequest: active.focusRequest + 1 });
  };

  const toolbarState: TextState = (() => {
    if (textSession && draftResolved) {
      return textState(
        draftResolved,
        normalizeRange(
          { start: textSession.selection.anchor, end: textSession.selection.focus },
          textSession.body,
        ),
        textSession.pending,
      );
    }
    const first = textTargets[0];
    const body = first ? itemText(stageScene, first)?.text : undefined;
    if (!body) return {};
    const element = geometry?.slide.elements[first];
    const content =
      element?.type === 'text' || element?.type === 'shape' ? element.text?.content : undefined;
    if (!content) return {};
    return textState(body, wholeBody(content));
  })();

  const placeholderToReset =
    !designTarget && activeSlideId
      ? (textSession?.kind === 'element' ? [textSession.elementId!] : textTargets).filter((id) => {
          const element = document?.slides[activeSlideId]?.elements[id];
          return element ? hasPlaceholderOverrides(element) : false;
        })
      : [];

  const resetSelectedPlaceholders = () => {
    if (!activeSlideId || placeholderToReset.length === 0) return;
    endTextSession();
    commit('Reset to layout', (current) =>
      resetPlaceholders(current, activeSlideId, placeholderToReset),
    );
  };

  /* Links ------------------------------------------------------------------ */

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const currentLink = (() => {
    if (!linkDialogOpen) return null;
    const active = textSessionRef.current;
    if (active) {
      return linkInRange(active.body, {
        start: active.selection.anchor,
        end: active.selection.focus,
      });
    }
    const element = textTargets[0] ? geometry?.slide.elements[textTargets[0]] : undefined;
    const body =
      element?.type === 'text' || element?.type === 'shape' ? element.text?.content : undefined;
    return body ? linkInRange(body, wholeBody(body)) : null;
  })();
  const openLinkDialog = () => {
    const active = textSessionRef.current;
    if (active && active.selection.anchor === active.selection.focus) {
      // A caret inside a link edits that whole link; elsewhere, text must be selected.
      const extent = linkExtent(active.body, active.selection.anchor);
      if (!extent) {
        toast.info('Select the text to link first.');
        return;
      }
      setTextSession({ ...active, selection: { anchor: extent.start, focus: extent.end } });
    }
    setLinkDialogOpen(true);
  };
  const applyLink = (link: DeckLink | null) => {
    setLinkDialogOpen(false);
    runCommand({ kind: 'link', link });
  };
  const linkSlides = useMemo(
    () =>
      slideOrder.map((id, index) => {
        const title = resolved
          .get(id)
          ?.items.find((item) => item.kind === 'shape' && item.placeholder === 'title');
        const text = title?.kind === 'shape' ? plainText(title.text).trim() : '';
        return { id, label: `${index + 1}. ${text || 'Untitled slide'}` };
      }),
    [resolved, slideOrder],
  );

  /** Keyboard shortcuts inside the text editor. */
  const onEditorShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const lower = event.key.toLowerCase();
    const run = (command: TextCommand) => {
      runCommand(command);
      return true;
    };
    if (mod && !event.shiftKey && lower === 'b') return run({ kind: 'toggle', key: 'bold' });
    if (mod && !event.shiftKey && lower === 'i') return run({ kind: 'toggle', key: 'italic' });
    if (mod && !event.shiftKey && lower === 'u') return run({ kind: 'toggle', key: 'underline' });
    if (mod && lower === 'k') {
      openLinkDialog();
      return true;
    }
    if (mod && !event.shiftKey && lower === 'l') return run({ kind: 'align', value: 'left' });
    if (mod && !event.shiftKey && lower === 'e') return run({ kind: 'align', value: 'center' });
    if (mod && !event.shiftKey && lower === 'r') return run({ kind: 'align', value: 'right' });
    if (mod && !event.shiftKey && lower === 'j') return run({ kind: 'align', value: 'justify' });
    if (mod && event.shiftKey && (event.key === '>' || event.key === '.')) {
      return run({ kind: 'sizeStep', direction: 1 });
    }
    if (mod && event.shiftKey && (event.key === '<' || event.key === ',')) {
      return run({ kind: 'sizeStep', direction: -1 });
    }
    if (mod && event.key === '.') return run({ kind: 'baseline', value: 'superscript' });
    if (mod && event.key === ',') return run({ kind: 'baseline', value: 'subscript' });
    if (mod && event.key === ' ') return run({ kind: 'clear' });
    if (mod && lower === 's') {
      flushText();
      void session.save();
      return true;
    }
    if (event.key === 'Tab' && !mod && !event.altKey) {
      const active = textSessionRef.current;
      if (!active || !draftResolved) return false;
      const range = normalizeRange(
        { start: active.selection.anchor, end: active.selection.focus },
        active.body,
      );
      const starts = paragraphStarts(active.body);
      const atStart = range.start === range.end && starts.includes(range.start);
      const state = textState(draftResolved, range);
      // Tab changes the list level in lists, at a paragraph start, or over a
      // selection; elsewhere it types a tab.
      if (range.start !== range.end || atStart || (state.list && state.list !== 'none')) {
        return run({ kind: 'level', delta: event.shiftKey ? -1 : 1 });
      }
    }
    return false;
  };

  /* Design ----------------------------------------------------------------- */

  const onApplyTemplate = (templateId: DeckTemplateId) => {
    endTextSession();
    if (commit('Apply design', (current) => applyTemplate(current, templateId, nextId))) {
      toast.success('Design applied. Undo restores the previous one.');
    }
  };

  const onThemeColor = (token: DeckThemeColorToken, hex: string) => {
    if (!document) return;
    endTextSession();
    commit(
      'Theme colour',
      (current) =>
        updateTheme(current, current.themeId, (theme) =>
          theme.colors[token] === hex
            ? theme
            : { ...theme, colors: { ...theme.colors, [token]: hex } },
        ),
      `theme-colour:${token}`,
    );
  };

  const onThemeFont = (role: DeckThemeFontRole, family: string) => {
    endTextSession();
    commit('Theme font', (current) =>
      updateTheme(current, current.themeId, (theme) =>
        theme.fonts[role].family === family
          ? theme
          : {
              ...theme,
              fonts: { ...theme.fonts, [role]: { family, fallbacks: fallbacksFor(family) } },
            },
      ),
    );
  };

  const onSlideLayout = (layoutId: string) => {
    endTextSession();
    commit('Change layout', (current) => setSlideLayout(current, slideSelection, layoutId, nextId));
  };

  const canResetSlide = Boolean(
    document &&
    slideSelection.some((id) =>
      Object.values(document.slides[id]?.elements ?? {}).some(hasPlaceholderOverrides),
    ),
  );
  const onResetSlide = () => {
    endTextSession();
    commit('Reset slide', (current) =>
      composeEdits(
        current,
        slideSelection.map((id) => (deck: DeckDocument) => resetPlaceholders(deck, id)),
      ),
    );
  };

  const onSlideBackground = (fill: DeckFill | null) => {
    commit(
      'Slide background',
      (current) => {
        const slides: Record<string, DeckDocument['slides'][string]> = {};
        for (const id of slideSelection) {
          const slide = current.slides[id];
          if (!slide) continue;
          const next = { ...slide };
          if (fill) next.background = fill;
          else delete next.background;
          slides[id] = next;
        }
        return applyPatch(current, { slides });
      },
      `slide-background:${slideSelection.join(',')}`,
    );
  };

  const onLayoutChange = (patch: { name?: string; showMasterElements?: boolean }) => {
    if (designTarget?.kind !== 'layout') return;
    const id = designTarget.id;
    commit(patch.name !== undefined ? 'Rename layout' : 'Layout options', (current) =>
      updateLayout(current, id, (layout) => {
        const next = { ...layout, ...patch };
        if (patch.showMasterElements === true) delete next.showMasterElements;
        return next;
      }),
    );
  };

  const onDesignBackground = (fill: DeckFill | null) => {
    if (!designTarget) return;
    const id = designTarget.id;
    const apply = <T extends { background?: DeckFill }>(entry: T): T => {
      const next = { ...entry };
      if (fill) next.background = fill;
      else delete next.background;
      return next;
    };
    commit(
      'Background',
      (current) =>
        designTarget.kind === 'layout'
          ? updateLayout(current, id, apply)
          : updateMaster(current, id, apply),
      `design-background:${designTarget.kind}:${id}`,
    );
  };

  const onMasterTextStyle = (
    textClass: MasterTextClass,
    level: number,
    patch: MasterTextStylePatch,
  ) => {
    if (designTarget?.kind !== 'master') return;
    const id = designTarget.id;
    commit('Master text style', (current) =>
      updateMaster(current, id, (master) => {
        const levels = [...master.textStyles[textClass]];
        while (levels.length <= level)
          levels.push(structuredClone(levels[levels.length - 1] ?? {}));
        const entry: DeckTextLevelStyle = structuredClone(levels[level]);
        const run = { ...(entry.run ?? {}) };
        const paragraph = { ...(entry.paragraph ?? {}) };
        if (patch.size !== undefined) run.size = patch.size;
        if (patch.bold !== undefined) run.bold = patch.bold;
        if (patch.italic !== undefined) run.italic = patch.italic;
        if (patch.color !== undefined) run.color = patch.color;
        if (patch.font !== undefined) run.font = patch.font;
        if (patch.indent !== undefined) paragraph.indent = patch.indent;
        if (patch.bullet !== undefined) {
          paragraph.list = patch.bullet ? { kind: 'bullet', char: patch.bullet } : null;
        }
        levels[level] = { run, paragraph };
        return { ...master, textStyles: { ...master.textStyles, [textClass]: levels } };
      }),
    );
  };

  const enterDesign = () => {
    if (!document) return;
    endTextSession();
    const layoutId = activeSlideId ? document.slides[activeSlideId]?.layoutId : undefined;
    setSelectedIds([]);
    setDesignTarget(
      layoutId && document.layouts[layoutId]
        ? { kind: 'layout', id: layoutId }
        : { kind: 'master', id: Object.keys(document.masters).sort()[0] },
    );
    setViewState((current) => ({ ...current, inspectorOpen: true }));
  };
  const leaveDesign = () => {
    endTextSession();
    setSelectedIds([]);
    setDesignTarget(null);
  };

  /* ----------------------------------------------------------------------- */
  /* Clipboard                                                               */
  /* ----------------------------------------------------------------------- */

  const memoryClipboard = useRef<string | null>(null);
  const pasteCount = useRef(0);

  const copyText = () =>
    geometry && selectedIds.length > 0 ? copyElements(geometry, selectedIds) : null;

  const pasteText = (text: string) => {
    if (!document || !stageTarget || !editable) return;
    const payload = parseClipboard(text);
    pasteCount.current += 1;
    if (payload) {
      const pasted = preparePaste(payload, nextId, pasteCount.current * PASTE_STEP);
      if (
        onSlide('Paste', (current, target) =>
          addElements(current, target, pasted.elements, { topLevelIds: pasted.topLevel }),
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
    if (onSlide('Paste', (current, target) => addElements(current, target, [box]))) {
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
    if (mod && lower === 'm' && !designTarget) {
      const layoutId =
        (activeSlideId && document?.slides[activeSlideId]?.layoutId) || layouts[0]?.id || '';
      return run(() => newSlide(layoutId));
    }

    // Slide navigation: in the rail, or on the stage with nothing selected.
    if (!designTarget && (inRail || selectedIds.length === 0)) {
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
    if (key === 'Escape') {
      return run(() =>
        cropping
          ? setCropping(false)
          : selectedIds.length > 0
            ? setSelectedIds([])
            : designTarget
              ? leaveDesign()
              : undefined,
      );
    }
    if (key === 'Tab' && geometry && geometry.order.length > 0) {
      return run(() => {
        const current = selectedIds.length === 1 ? geometry.order.indexOf(selectedIds[0]) : -1;
        const count = geometry.order.length;
        setSelectedIds([geometry.order[(current + (event.shiftKey ? -1 : 1) + count) % count]]);
      });
    }
    if (selectedIds.length === 0) return;
    // Enter or F2 edits the selected box's text.
    if ((key === 'Enter' || key === 'F2') && selectedIds.length === 1 && editable) {
      if (isTextCapable(geometry?.slide.elements[selectedIds[0]])) {
        return run(() => beginTextEdit(selectedIds[0], null));
      }
    }
    if (mod && !event.shiftKey && lower === 'b' && textTargets.length > 0) {
      return run(() => runCommand({ kind: 'toggle', key: 'bold' }));
    }
    if (mod && !event.shiftKey && lower === 'i' && textTargets.length > 0) {
      return run(() => runCommand({ kind: 'toggle', key: 'italic' }));
    }
    if (mod && !event.shiftKey && lower === 'u' && textTargets.length > 0) {
      return run(() => runCommand({ kind: 'toggle', key: 'underline' }));
    }
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

  const activeSlide = activeSlideId ? resolved.get(activeSlideId) : undefined;
  const notes = activeSlide?.notes ? plainText(activeSlide.notes) : '';
  const hasSelection = selectedIds.length > 0;
  const hasGroup = selectedIds.some((id) => geometry?.slide.elements[id]?.type === 'group');
  const aspect = document && supported ? document.size.width / document.size.height : 16 / 9;
  const showTextToolbar =
    editable && (textSession !== null || textTargets.length > 0) && Boolean(document);
  const theme = document && supported ? document.themes[document.themeId] : undefined;

  const textEditorFor = (active: TextSession, plain: boolean) =>
    draftResolved ? (
      <DeckTextEditor
        key={active.id}
        body={active.body}
        resolved={draftResolved}
        selection={active.selection}
        pendingFormat={active.pending}
        pxPerUnit={
          plain
            ? 1
            : (zoom / DECK_UNITS_PER_PX) *
              (editingElement && draftScene
                ? (() => {
                    const item = itemText(draftScene, active.elementId!);
                    return item?.text
                      ? layoutText(item.text, item.frame.width, item.frame.height, measurer).scale
                      : 1;
                  })()
                : 1)
        }
        plain={plain}
        label={plain ? 'Speaker notes' : (editingElement?.name ?? 'Text')}
        className={plain ? 'min-h-full text-sm text-foreground/90' : 'w-full'}
        focusRequest={active.focusRequest}
        initialPoint={active.initialPoint}
        nextId={nextParagraphId}
        onChange={onTextChange}
        onSelectionChange={onTextSelection}
        onShortcut={onEditorShortcut}
        onUndo={onTextUndo}
        onRedo={onTextRedo}
        onExit={() => {
          endTextSession();
          if (
            active.kind === 'element' &&
            active.elementId &&
            geometry?.order.includes(active.elementId)
          ) {
            setSelectedIds([active.elementId]);
          }
        }}
        onLimit={(message) => toast.error(message)}
      />
    ) : null;

  const editingOverlay =
    textSession?.kind === 'element' && draftResolved
      ? (() => {
          const [left, top, right, bottom] = draftResolved.insets;
          const unit = zoom / DECK_UNITS_PER_PX;
          return {
            id: textSession.elementId!,
            content: (
              <div
                className="flex h-full w-full flex-col overflow-visible"
                style={{
                  padding: `${top * unit}px ${right * unit}px ${bottom * unit}px ${left * unit}px`,
                  justifyContent:
                    draftResolved.verticalAlign === 'middle'
                      ? 'center'
                      : draftResolved.verticalAlign === 'bottom'
                        ? 'flex-end'
                        : 'flex-start',
                  whiteSpace: draftResolved.wrap ? undefined : 'pre',
                }}
              >
                {textEditorFor(textSession, false)}
              </div>
            ),
          };
        })()
      : null;

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
          designTarget && document ? (
            <span>
              Editing{' '}
              {designTarget.kind === 'master'
                ? `master “${document.masters[designTarget.id]?.name ?? ''}”`
                : `layout “${document.layouts[designTarget.id]?.name ?? ''}”`}
            </span>
          ) : slideOrder.length > 0 ? (
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
                onClick={() => {
                  endTextSession();
                  undoOrRedo('undo');
                }}
                disabled={!editable || !history.canUndo}
                aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
              >
                <Undo2 size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() => {
                  endTextSession();
                  undoOrRedo('redo');
                }}
                disabled={!editable || !history.canRedo}
                aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
              >
                <Redo2 size={14} />
              </DocumentTopBarIconButton>
            </div>

            <div className={documentTopBarGroupClass}>
              {designTarget ? (
                <DocumentTopBarButton onClick={leaveDesign} aria-label="Close master view">
                  <X size={14} />
                  Close master view
                </DocumentTopBarButton>
              ) : (
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
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton disabled={!editable || !stageTarget}>
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
                  {designTarget && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px]">Placeholder</DropdownMenuLabel>
                      {PLACEHOLDER_INSERTS.map((type) => (
                        <DropdownMenuItem key={type} onClick={() => insertDesignPlaceholder(type)}>
                          {placeholderName(type)} placeholder
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!supported || Boolean(designTarget)}
                    onClick={enterDesign}
                  >
                    <Paintbrush size={13} /> Edit master and layouts
                  </DropdownMenuItem>
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
                onClick={() => {
                  if (textSession?.kind === 'notes') endTextSession();
                  setViewState((current) => ({ ...current, notesOpen: !current.notesOpen }));
                }}
                aria-label={viewState.notesOpen ? 'Hide speaker notes' : 'Show speaker notes'}
                aria-pressed={viewState.notesOpen}
              >
                <StickyNote size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() =>
                  setViewState((current) => ({ ...current, inspectorOpen: !current.inspectorOpen }))
                }
                aria-label={viewState.inspectorOpen ? 'Hide design panel' : 'Show design panel'}
                aria-pressed={viewState.inspectorOpen ?? false}
                disabled={!supported}
              >
                <PanelRight size={14} />
              </DocumentTopBarIconButton>
            </div>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={() => {
                  flushText();
                  void session.save();
                }}
                disabled={session.readOnly || !session.dirty || session.saving}
              >
                <Save size={14} />
                Save
              </DocumentTopBarButton>
            </div>
          </>
        }
      />

      {showTextToolbar && theme && (
        <DeckTextToolbar
          state={toolbarState}
          theme={theme}
          box={textSession?.kind === 'notes' ? null : box}
          disabled={!editable}
          canResetPlaceholder={placeholderToReset.length > 0}
          onCommand={runCommand}
          onFont={setFont}
          onColor={(color) => setColor(color)}
          onBox={setBox}
          onLink={openLinkDialog}
          onResetPlaceholder={resetSelectedPlaceholders}
        />
      )}

      <div className="flex min-h-0 flex-1" role="application" aria-label="Presentation editor">
        {viewState.slideRailOpen && designTarget && document && (
          <DeckDesignRail
            deck={document}
            scenes={designScenes}
            active={designTarget}
            readOnly={!editable}
            measurer={measurer}
            resolveAsset={resolveAsset}
            onSelect={(next) => {
              endTextSession();
              setSelectedIds([]);
              setDesignTarget(next);
            }}
            onDuplicateLayout={(layoutId) => {
              let created: string | null = null;
              if (
                commit('Duplicate layout', (current) => {
                  const edit = duplicateLayout(current, layoutId, nextId('layout'));
                  created = edit.layoutId;
                  return edit;
                }) &&
                created
              ) {
                setDesignTarget({ kind: 'layout', id: created });
              }
            }}
            onDeleteLayout={(layoutId) => {
              if (commit('Delete layout', (current) => deleteLayout(current, layoutId))) {
                setDesignTarget({ kind: 'master', id: document.layouts[layoutId]?.masterId ?? '' });
              }
            }}
          />
        )}
        {viewState.slideRailOpen && !designTarget && slideOrder.length > 0 && (
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
            onSelect={(ids, active) => {
              endTextSession();
              showSlide(active, ids);
            }}
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
                {document && stageTarget && stageScene && geometry && stageSize.width > 0 ? (
                  <DeckStage
                    deck={document}
                    target={stageTarget}
                    resolved={stageScene}
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
                    onEditText={(id, point) => beginTextEdit(id, point)}
                    editing={editingOverlay}
                    onExitText={endTextSession}
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
                {selectedIds.length === 1 && textTargets.length === 1 && (
                  <ContextMenuItem onClick={() => beginTextEdit(selectedIds[0], null)}>
                    Edit text <ContextMenuShortcut>Enter</ContextMenuShortcut>
                  </ContextMenuItem>
                )}
                {editable && croppable && (
                  <ContextMenuItem onClick={() => setCropping(!cropping)}>
                    {cropping ? 'Finish crop' : 'Crop image'}
                  </ContextMenuItem>
                )}
                {placeholderToReset.length > 0 && (
                  <ContextMenuItem onClick={resetSelectedPlaceholders}>
                    Reset to layout
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
          {viewState.notesOpen && !designTarget && (
            <div
              className="h-32 shrink-0 overflow-y-auto border-t border-border/50 bg-card/40 px-4 py-3 text-sm"
              aria-label="Speaker notes"
            >
              {textSession?.kind === 'notes' ? (
                textEditorFor(textSession, true)
              ) : (
                <div
                  role={editable ? 'button' : undefined}
                  tabIndex={editable ? 0 : undefined}
                  aria-label={editable ? 'Edit speaker notes' : undefined}
                  className={editable ? 'min-h-full cursor-text' : undefined}
                  onClick={(event) =>
                    editable && beginNotesEdit({ clientX: event.clientX, clientY: event.clientY })
                  }
                  onKeyDown={(event) => {
                    if (editable && (event.key === 'Enter' || event.key === 'F2')) {
                      event.preventDefault();
                      event.stopPropagation();
                      beginNotesEdit(null);
                    }
                  }}
                >
                  {notes ? (
                    <p className="whitespace-pre-wrap text-foreground/90">{notes}</p>
                  ) : (
                    <p className="text-muted-foreground">
                      {editable
                        ? 'Click to add speaker notes.'
                        : 'No speaker notes for this slide.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {(viewState.inspectorOpen ?? false) && document && supported && (
          <DeckInspector
            deck={document}
            slideIds={designTarget ? [] : slideSelection}
            design={designTarget}
            readOnly={!editable}
            canResetSlide={canResetSlide}
            onSlideLayout={onSlideLayout}
            onResetSlide={onResetSlide}
            onSlideBackground={onSlideBackground}
            onApplyTemplate={onApplyTemplate}
            onThemeColor={onThemeColor}
            onThemeFont={onThemeFont}
            onEditDesign={enterDesign}
            onLayoutChange={onLayoutChange}
            onDesignBackground={onDesignBackground}
            onMasterTextStyle={onMasterTextStyle}
          />
        )}
      </div>

      <DeckLinkDialog
        open={linkDialogOpen}
        current={currentLink}
        slides={linkSlides}
        onOpenChange={(open) => {
          setLinkDialogOpen(open);
          const active = textSessionRef.current;
          if (!open && active) setTextSession({ ...active, focusRequest: active.focusRequest + 1 });
        }}
        onApply={applyLink}
      />
    </div>
  );
}
