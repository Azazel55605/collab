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
  BarChart3,
  Circle,
  Download,
  FileText,
  Group,
  ImageIcon,
  LayoutTemplate,
  Loader2,
  Lock,
  Minus,
  MonitorPlay,
  MoveRight,
  Paintbrush,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Presentation,
  Redo2,
  Save,
  Settings2,
  Shapes,
  Square,
  StickyNote,
  Table2,
  Type,
  Undo2,
  Ungroup,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import LivePeers from '../components/collaboration/LivePeers';
import { DeckChartDialog } from '../components/deck/DeckChartDialog';
import type { ChartEdit } from '../components/deck/DeckChartDialog';
import { DeckDesignRail } from '../components/deck/DeckDesignRail';
import type { DeckDesignTarget } from '../components/deck/DeckDesignRail';
import { DeckExportDialog } from '../components/deck/DeckExportDialog';
import { DeckExportReportDialog } from '../components/deck/DeckExportReportDialog';
import { DeckInspector } from '../components/deck/DeckInspector';
import type { MasterTextClass, MasterTextStylePatch } from '../components/deck/DeckInspector';
import { DeckLinkDialog } from '../components/deck/DeckLinkDialog';
import { DeckObjectToolbar } from '../components/deck/DeckObjectToolbar';
import type { TableAction } from '../components/deck/DeckObjectToolbar';
import { DeckPresenter } from '../components/deck/DeckPresenter';
import type {
  DeckPresenterRemote,
  DeckPresentMode,
  DeckPresentSummary,
  DeckShowPosition,
} from '../components/deck/DeckPresenter';
import { DeckPrintHost } from '../components/deck/DeckPrintHost';
import { DeckSlideRail } from '../components/deck/DeckSlideRail';
import type { DeckRailAction } from '../components/deck/DeckSlideRail';
import { DeckStage } from '../components/deck/DeckStage';
import type { DeckStagePeer } from '../components/deck/DeckStage';
import { DeckTableDialog } from '../components/deck/DeckTableDialog';
import type { TableInsert } from '../components/deck/DeckTableDialog';
import { DeckTextEditor } from '../components/deck/DeckTextEditor';
import type { TextEditKind } from '../components/deck/DeckTextEditor';
import { DeckTextToolbar } from '../components/deck/DeckTextToolbar';
import type { DeckFontChoice, TextBoxSettings } from '../components/deck/DeckTextToolbar';
import { DeckVaultPicker } from '../components/deck/DeckVaultPicker';
import { useDeckExport } from '../components/deck/useDeckExport';
import {
  DocumentTopBar,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  DocumentTopBarIconButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
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
import { useCollabIdentity } from '../lib/collabIdentity';
import { assetKey, collectDeckAssets } from '../lib/deck/assets';
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
import {
  deckAssetFolder,
  embedPreviewName,
  inkAnnotationName,
  NOTE_PREVIEW_SIZE,
  notePreviewSvg,
  slideExportMarkdown,
  slideExportName,
  svgDataUrl,
} from '../lib/deck/embeds';
import { describeImage, fileDataUrl, isDeckImagePath } from '../lib/deck/images';
import {
  createChartElement,
  createEmbedElement,
  createImageElement,
  createInsertedElement,
  createTableElement,
  SHAPE_NAMES,
} from '../lib/deck/insert';
import type { DeckInsertKind } from '../lib/deck/insert';
import { mergeRichText } from '../lib/deck/liveDeckDocument';
import {
  addElements,
  applyPatch,
  composeEdits,
  deleteSlides,
  duplicateSlides,
  expandGroups,
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
import { inkAnnotationSvg } from '../lib/deck/playback';
import type { PlaybackAction, PlaybackInk } from '../lib/deck/playback';
import { newShowId, remoteCommandAction, takeRemoteCommands } from '../lib/deck/remote';
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
import { applyChartData, gridToChartData, parseSheetRange } from '../lib/deck/sheetSnapshot';
import { fitSlide, renderSlideSvg } from '../lib/deck/svg';
import {
  deleteTableColumns,
  deleteTableRows,
  fitTableRows,
  insertTableColumns,
  insertTableRows,
  scaleTable,
  setCellContent,
  setCellFill,
  setHeaderRow,
  tableFromGrid,
} from '../lib/deck/tables';
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
  rotateSelection,
  targetGeometry,
} from '../lib/deck/transform';
import type { DeckAlignment, ElementUpdaters } from '../lib/deck/transform';
import { normalizeRotation, unitsToPx } from '../lib/deck/units';
import { useDeckSession } from '../lib/deck/useDeckSession';
import { flattenVaultPaths, takeSheetSnapshot, writeVaultImage } from '../lib/deck/vaultAssets';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { InkHistory } from '../lib/ink/history';
import { useLivePeers } from '../lib/liveAwareness';
import type { DeckInteraction } from '../lib/liveAwareness';
import { createVaultClient } from '../lib/vaultClient';
import {
  getVaultDocumentTabType,
  getVaultDocumentTitle,
  getVaultDocumentView,
} from '../lib/vaultLinks';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import type { DeckViewState } from '../store/editorStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import {
  DECK_SCHEMA_VERSION,
  DECK_SHAPE_GEOMETRIES,
  DECK_UNITS_PER_INCH,
  DECK_UNITS_PER_POINT,
  DECK_UNITS_PER_PX,
} from '../types/deck';
import type {
  DeckAnimation,
  DeckArrowhead,
  DeckAssetRef,
  DeckChartElement,
  DeckChartKind,
  DeckColor,
  DeckDash,
  DeckDocument,
  DeckElement,
  DeckFill,
  DeckLine,
  DeckLink,
  DeckPlaceholderType,
  DeckRichText,
  DeckShapeGeometry,
  DeckTableElement,
  DeckTextLevelStyle,
  DeckThemeColorToken,
  DeckThemeFontRole,
  DeckTransition,
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

/** The stored text a session edits, or undefined when it no longer exists. */
function storedTextBody(deck: DeckDocument, active: TextSession): DeckRichText | undefined {
  if (active.kind === 'notes') {
    const slide = deck.slides[active.target.id];
    return slide ? (slide.speakerNotes ?? { paragraphs: [] }) : undefined;
  }
  let container;
  try {
    container = targetGeometry(deck, active.target).slide;
  } catch {
    return undefined;
  }
  const element = active.elementId ? container.elements[active.elementId] : undefined;
  if (!element) return undefined;
  if (active.cellKey) {
    return element.type === 'table'
      ? (element.cells[active.cellKey]?.text.content ?? { paragraphs: [] })
      : undefined;
  }
  return element.type === 'text' || element.type === 'shape'
    ? (element.text?.content ?? { paragraphs: [] })
    : undefined;
}

function useDeckAssets(
  document: DeckDocument | null,
  vault: ReturnType<typeof useVaultStore.getState>['vault'],
) {
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const entries = useMemo(() => (document ? collectDeckAssets(document) : []), [document]);
  const key = entries.map((entry) => entry.key).join('\n');

  useEffect(() => {
    if (!client || entries.length === 0) return;
    let cancelled = false;
    for (const entry of entries) {
      if (assets[entry.key]) continue;
      client
        .readAssetDataUrl(entry.path)
        .then((url) => {
          if (!cancelled) setAssets((current) => ({ ...current, [entry.key]: url }));
        })
        .catch(() => {
          // A missing asset keeps its placeholder; the deck stays repairable.
        });
    }
    return () => {
      cancelled = true;
    };
    // `key` stands for `entries`; re-reading on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return useCallback((asset: DeckAssetRef) => assets[assetKey(asset)] ?? null, [assets]);
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
  return [ref, size, element] as const;
}

/** Documents a slide can link to: anything in the vault but images and the deck itself. */
const isLinkableDocument = (path: string) => !isDeckImagePath(path) && !/\.deck$/i.test(path);

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
 * What an element text session edits, in its scene: the text body and the
 * box it lays out in — a text or shape frame, or one table cell.
 */
function editingBox(
  scene: ResolvedSlide | null | undefined,
  session: TextSession,
): { text: ResolvedTextBody; x: number; y: number; width: number; height: number } | null {
  const item = scene?.items.find((entry) => entry.id === session.elementId);
  if (!item) return null;
  if (item.kind === 'table' && session.cellKey) {
    const cell = item.cells.find((entry) => `${entry.rowId}:${entry.columnId}` === session.cellKey);
    return cell
      ? { text: cell.text, x: cell.x, y: cell.y, width: cell.width, height: cell.height }
      : null;
  }
  if (item.kind !== 'shape' || !item.text) return null;
  return { text: item.text, ...item.frame };
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
  /** Joined to the hosted deck's live room (edits merge instead of saving). */
  const live = session.liveSession !== null;
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
  // A collaborator's live edit does not: inverses touch only the objects this
  // person changed, so undo keeps working while others edit.
  useEffect(() => {
    if (document && document !== lastLocalRef.current && !live) {
      historyRef.current.clear();
      coalesceRef.current = null;
      lastLocalRef.current = document;
      setHistoryVersion((version) => version + 1);
    }
  }, [document, live]);
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
  /** The stored body a draft was last in step with, to rebase it on a collaborator's edit. */
  const textBaseRef = useRef<DeckRichText | null>(null);
  const setTextSession = useCallback((next: TextSession | null) => {
    if (next && next.id !== textSessionRef.current?.id) textBaseRef.current = next.body;
    if (!next) textBaseRef.current = null;
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
      textBaseRef.current = active.body;
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
          if (!element) return noEdit(current);
          if (active.cellKey) {
            if (element.type !== 'table') return noEdit(current);
            const cellKey = active.cellKey;
            return composeEdits(current, [
              (deck) =>
                updateElements(deck, active.target, {
                  [elementId]: (entry) =>
                    entry.type === 'table' ? setCellContent(entry, cellKey, active.body) : entry,
                }),
              // Rows grow to fit what was typed, as in PowerPoint.
              (deck) => {
                const item = resolveTarget(deck, active.target).items.find(
                  (entry) => entry.id === elementId,
                );
                return updateElements(deck, active.target, {
                  [elementId]: (entry) =>
                    entry.type === 'table' && item?.kind === 'table'
                      ? fitTableRows(entry, item, measurerRef.current)
                      : entry,
                });
              },
            ]);
          }
          if (!isTextCapable(element)) return noEdit(current);
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

  // A document replaced underneath: a collaborator's live edit rebases the
  // draft onto theirs (both people's typing stays); a reload or a resolved
  // conflict abandons it, as does the text being deleted.
  useEffect(() => {
    const active = textSessionRef.current;
    if (!document || document === lastLocalRef.current || !active) return;
    const stored = live ? storedTextBody(document, active) : undefined;
    if (!stored) {
      setTextSession(null);
      return;
    }
    const base = textBaseRef.current;
    if (!base || JSON.stringify(base) === JSON.stringify(stored)) return;
    const merged = mergeRichText(base, active.body, stored, active.selection);
    textBaseRef.current = stored;
    setTextSession({ ...active, body: merged.body, selection: merged.selection });
  }, [document, live, setTextSession]);

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
      const cellKey = textSession.cellKey;
      const elementId = textSession.elementId!;
      const drafted = updateElements(document, textSession.target, {
        [elementId]: (element) =>
          cellKey
            ? element.type === 'table'
              ? setCellContent(element, cellKey, textSession.body)
              : element
            : withContent(element, textSession.body),
      }).result;
      if (!cellKey) return drafted;
      // Rows grow as you type, not only when the draft is written.
      const item = resolveTarget(drafted, textSession.target).items.find(
        (entry) => entry.id === elementId,
      );
      return item?.kind === 'table'
        ? updateElements(drafted, textSession.target, {
            [elementId]: (element) =>
              element.type === 'table' ? fitTableRows(element, item, measurer) : element,
          }).result
        : drafted;
    } catch {
      return document;
    }
  }, [document, measurer, textSession]);

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
    return editingBox(draftScene, textSession)?.text ?? null;
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
      const cellKey = textSession.cellKey;
      return {
        ...scene,
        items: scene.items.map((item) =>
          item.id !== textSession.elementId
            ? item
            : item.kind === 'shape'
              ? { ...item, text: null }
              : item.kind === 'table' && cellKey
                ? {
                    ...item,
                    cells: item.cells.map((cell) =>
                      `${cell.rowId}:${cell.columnId}` === cellKey
                        ? { ...cell, text: { ...cell.text, paragraphs: [] } }
                        : cell,
                    ),
                  }
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
    } else if (action.kind === 'export' && activeSlideId) {
      void exportSlide(activeSlideId);
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

  /* Objects: images, tables, charts, linked documents ----------------------- */

  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const fileTree = useVaultStore((state) => state.fileTree);
  const refreshFileTree = useVaultStore((state) => state.refreshFileTree);
  const timeZone = useUiStore((state) => state.calendarDefaultTimeZone);
  const openTab = useEditorStore((state) => state.openTab);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const workbooks = useMemo(
    () =>
      flattenVaultPaths(fileTree)
        .filter((path) => /\.sheet$/i.test(path))
        .sort((a, b) => a.localeCompare(b)),
    [fileTree],
  );
  const [activeCell, setActiveCell] = useState<{
    tableId: string;
    rowId: string;
    columnId: string;
  } | null>(null);
  const [picker, setPicker] = useState<
    { kind: 'image'; replace?: string } | { kind: 'embed' } | null
  >(null);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [chartDialogId, setChartDialogId] = useState<string | null>(null);

  const reportError = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error));

  /** Selected elements, with groups opened up to the objects they hold. */
  const formatIds = useMemo(() => {
    if (!geometry) return [];
    return [...expandGroups(geometry.slide, selectedIds)].filter(
      (id) => geometry.slide.elements[id]?.type !== 'group' && !geometry.slide.elements[id]?.locked,
    );
  }, [geometry, selectedIds]);
  const formatElements = formatIds
    .map((id) => geometry?.slide.elements[id])
    .filter((element): element is DeckElement => element !== undefined);

  const updateEach = (
    label: string,
    update: (element: DeckElement) => DeckElement,
    ids = formatIds,
  ) => applyUpdaters(Object.fromEntries(ids.map((id) => [id, update])), label);

  const onFill = (color: DeckColor | null) =>
    updateEach('Fill', (element) =>
      element.type === 'text' || element.type === 'shape'
        ? ({ ...element, fill: color ? { kind: 'solid', color } : { kind: 'none' } } as DeckElement)
        : element,
    );

  const onOutline = (patch: { color?: DeckColor; width?: number; dash?: DeckDash } | null) => {
    const fallback: DeckLine = {
      color: { kind: 'theme', token: 'dark1' },
      width: DECK_UNITS_PER_POINT,
    };
    updateEach('Outline', (element) => {
      if (element.type === 'line') {
        return {
          ...element,
          line: patch ? { ...element.line, ...patch } : { ...element.line, color: fallback.color },
        };
      }
      if (element.type === 'table') {
        const next = { ...element };
        if (patch) next.border = { ...(element.border ?? fallback), ...patch };
        else delete next.border;
        return next;
      }
      if (element.type === 'text' || element.type === 'shape' || element.type === 'image') {
        const next = { ...element };
        if (patch) next.line = { ...(element.line ?? fallback), ...patch };
        else delete next.line;
        return next;
      }
      return element;
    });
  };

  const onArrow = (end: 'start' | 'end', kind: DeckArrowhead) =>
    updateEach('Arrowhead', (element) => {
      if (element.type !== 'line') return element;
      const key = end === 'start' ? 'startArrow' : 'endArrow';
      const next = { ...element };
      if (kind === 'none') delete next[key];
      else next[key] = kind;
      return next;
    });

  const onGeometry = (next: DeckShapeGeometry) =>
    updateEach('Change shape', (element) =>
      element.type === 'shape' ? { ...element, geometry: next, name: SHAPE_NAMES[next] } : element,
    );

  const onOpacity = (percent: number) =>
    updateEach(
      'Opacity',
      (element) => {
        const next = { ...element };
        if (percent >= 100) delete next.opacity;
        else next.opacity = Math.max(0, Math.min(100, Math.round(percent)));
        return next;
      },
      selectedIds.filter((id) => !geometry?.slide.elements[id]?.locked),
    );

  const onFlip = (axis: 'horizontal' | 'vertical') => {
    if (!geometry) return;
    const updaters: ElementUpdaters = {};
    for (const id of formatIds) {
      const element = geometry.slide.elements[id];
      if (element.type === 'line') {
        const cx = (element.from.x + element.to.x) / 2;
        const cy = (element.from.y + element.to.y) / 2;
        const mirror = (point: { x: number; y: number }) =>
          axis === 'horizontal'
            ? { x: Math.round(2 * cx - point.x), y: point.y }
            : { x: point.x, y: Math.round(2 * cy - point.y) };
        updaters[id] = (current) =>
          current.type === 'line'
            ? { ...current, from: mirror(current.from), to: mirror(current.to) }
            : current;
        continue;
      }
      const frame = geometry.frames.get(id);
      if (!frame) continue;
      updaters[id] = (current) => {
        const base = { ...frame, ...(current.frame ?? {}) };
        const key = axis === 'horizontal' ? 'flipH' : 'flipV';
        const next = { ...base, [key]: !base[key] };
        if (!next[key]) delete (next as Partial<typeof next>)[key];
        return { ...current, frame: next } as DeckElement;
      };
    }
    applyUpdaters(updaters, 'Flip');
  };

  const onRotateQuarter = () => {
    if (!geometry) return;
    const movable = selectedIds.filter((id) => !geometry.slide.elements[id]?.locked);
    applyUpdaters(rotateSelection(geometry, movable, 9_000), 'Rotate');
  };

  /** Places an image from the vault: a new object, or the picture of an existing one. */
  const placeImage = async (
    path: string,
    options: { dataUrl?: string; replace?: string; at?: { x: number; y: number } } = {},
  ) => {
    if (!client || !document) return;
    try {
      const dataUrl = options.dataUrl ?? (await client.readAssetDataUrl(path));
      const asset = await describeImage(path, dataUrl);
      if (options.replace) {
        const id = options.replace;
        applyUpdaters(
          {
            [id]: (element) => {
              if (element.type !== 'image') return element;
              const next = { ...element, asset };
              delete next.crop;
              // Keep the width; take the new picture's shape.
              if (next.frame) {
                next.frame = {
                  ...next.frame,
                  height: Math.max(
                    DECK_UNITS_PER_POINT,
                    Math.round((next.frame.width * asset.pixelHeight) / asset.pixelWidth),
                  ),
                };
              }
              return next;
            },
          },
          'Replace image',
        );
        return;
      }
      const id = nextId('img');
      const count = Object.keys(geometry?.slide.elements ?? {}).length;
      const element = createImageElement(document, id, asset, (count % 6) * PASTE_STEP);
      if (options.at && element.frame) {
        element.frame = {
          ...element.frame,
          x: Math.round(options.at.x - element.frame.width / 2),
          y: Math.round(options.at.y - element.frame.height / 2),
        };
      }
      if (onSlide('Insert image', (current, target) => addElements(current, target, [element]))) {
        setSelectedIds([id]);
      }
    } catch (error) {
      reportError(error);
    }
  };

  /** Imports a file from outside the vault beside the deck, then places it. */
  const uploadImage = async (
    file: File,
    options: { replace?: string; at?: { x: number; y: number } } = {},
  ) => {
    if (!client || !vault) return;
    try {
      const dataUrl = await fileDataUrl(file);
      const name =
        file.name && isDeckImagePath(file.name)
          ? file.name
          : `image.${(file.type.split('/')[1] ?? 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`;
      if (!isDeckImagePath(name))
        throw new Error('Presentations can hold PNG, JPEG, GIF, WebP, and SVG images.');
      const path = await writeVaultImage(
        client,
        vault,
        deckAssetFolder(relativePath),
        name,
        dataUrl,
        false,
      );
      void refreshFileTree();
      await placeImage(path, { dataUrl, ...options });
    } catch (error) {
      reportError(error);
    }
  };

  const onDropFiles = (files: File[], point: { x: number; y: number }) => {
    const images = files.filter(
      (file) => file.type.startsWith('image/') || isDeckImagePath(file.name),
    );
    if (images.length === 0) {
      toast.info('Only images can be dropped onto a slide.');
      return;
    }
    void (async () => {
      for (const file of images) await uploadImage(file, { at: point });
    })();
  };

  /* Tables */

  const selectedTable =
    selectedIds.length === 1 && geometry?.slide.elements[selectedIds[0]]?.type === 'table'
      ? (geometry.slide.elements[selectedIds[0]] as DeckTableElement)
      : null;
  const tableCellHere =
    selectedTable &&
    activeCell?.tableId === selectedTable.id &&
    selectedTable.rowOrder.includes(activeCell.rowId) &&
    selectedTable.columnOrder.includes(activeCell.columnId)
      ? activeCell
      : null;

  const loadRangeGrid = async (path: string, range: string) => {
    if (!client) throw new Error('No vault is open.');
    const reference = parseSheetRange(range);
    if (!reference) throw new Error('Write the range like A1:D5 or Sheet1!A1:D5.');
    return takeSheetSnapshot(client, path, reference, timeZone);
  };

  const onInsertTable = (request: TableInsert) => {
    if (!document) return;
    try {
      const id = nextId('table');
      const count = Object.keys(geometry?.slide.elements ?? {}).length;
      const table =
        request.kind === 'blank'
          ? createTableElement(
              document,
              id,
              request.rows,
              request.columns,
              nextId,
              (count % 6) * PASTE_STEP,
            )
          : tableFromGrid(document, id, request.grid, nextId);
      if (onSlide('Insert table', (current, target) => addElements(current, target, [table]))) {
        setSelectedIds([id]);
        setTableDialogOpen(false);
      }
    } catch (error) {
      reportError(error);
    }
  };

  const onTableAction = (action: TableAction) => {
    const table = selectedTable;
    if (!table) return;
    const row = tableCellHere
      ? table.rowOrder.indexOf(tableCellHere.rowId)
      : table.rowOrder.length - 1;
    const column = tableCellHere
      ? table.columnOrder.indexOf(tableCellHere.columnId)
      : table.columnOrder.length - 1;
    const change = (current: DeckTableElement): DeckTableElement => {
      switch (action) {
        case 'rowAbove':
          return insertTableRows(current, row, 1, nextId);
        case 'rowBelow':
          return insertTableRows(current, row + 1, 1, nextId);
        case 'columnLeft':
          return insertTableColumns(current, column, 1, nextId);
        case 'columnRight':
          return insertTableColumns(current, column + 1, 1, nextId);
        case 'deleteRow':
          return tableCellHere ? deleteTableRows(current, [tableCellHere.rowId]) : current;
        case 'deleteColumn':
          return tableCellHere ? deleteTableColumns(current, [tableCellHere.columnId]) : current;
        case 'header':
          return setHeaderRow(current, !current.headerRow);
      }
    };
    applyUpdaters(
      { [table.id]: (element) => (element.type === 'table' ? change(element) : element) },
      action === 'header'
        ? 'Header row'
        : action.startsWith('delete')
          ? 'Delete from table'
          : 'Insert into table',
    );
  };

  const onCellFill = (color: DeckColor | null) => {
    if (!selectedTable || !tableCellHere) return;
    const key = `${tableCellHere.rowId}:${tableCellHere.columnId}`;
    applyUpdaters(
      {
        [selectedTable.id]: (element) =>
          element.type === 'table'
            ? setCellFill(element, [key], color ? { kind: 'solid', color } : null)
            : element,
      },
      'Cell fill',
    );
  };

  const beginCellEdit = (
    tableId: string,
    cell: { rowId: string; columnId: string },
    point: { clientX: number; clientY: number } | null,
  ) => {
    if (!geometry || !stageTarget || !editable) return;
    const table = geometry.slide.elements[tableId];
    if (!table || table.type !== 'table' || table.locked) return;
    endTextSession();
    const key = `${cell.rowId}:${cell.columnId}`;
    const body = table.cells[key]?.text.content ?? { paragraphs: [] };
    const end = textLength(body);
    setActiveCell({ tableId, ...cell });
    setTextSession(
      startTextSession({
        kind: 'element',
        target: stageTarget,
        elementId: tableId,
        cellKey: key,
        body,
        selection: { anchor: end, focus: end },
        initialPoint: point,
      }),
    );
  };

  /* Charts */

  const chartForDialog =
    chartDialogId && geometry?.slide.elements[chartDialogId]?.type === 'chart'
      ? (geometry.slide.elements[chartDialogId] as DeckChartElement)
      : null;

  const insertChart = (kind: DeckChartKind) => {
    if (!document) return;
    const id = nextId('chart');
    const count = Object.keys(geometry?.slide.elements ?? {}).length;
    const chart = createChartElement(document, id, kind, nextId, (count % 6) * PASTE_STEP);
    if (onSlide('Insert chart', (current, target) => addElements(current, target, [chart]))) {
      setSelectedIds([id]);
    }
  };

  const onApplyChart = (edit: ChartEdit) => {
    const id = chartDialogId;
    setChartDialogId(null);
    if (!id) return;
    const now = new Date().toISOString();
    applyUpdaters(
      {
        [id]: (element) => {
          if (element.type !== 'chart') return element;
          const next: DeckChartElement = {
            ...applyChartData(element, edit, nextId),
            kind: edit.kind,
            showLegend: edit.showLegend,
          };
          if (edit.title) next.title = edit.title.slice(0, 256);
          else delete next.title;
          if (edit.source === null) delete next.source;
          else if (edit.source) {
            const same =
              element.source?.path === edit.source.path &&
              element.source.range === edit.source.range;
            next.source = {
              ...edit.source,
              refreshedAt: same ? (element.source?.refreshedAt ?? now) : now,
            };
          }
          return next;
        },
      },
      'Edit chart',
    );
  };

  const refreshChart = async (id: string) => {
    const chart = geometry?.slide.elements[id];
    if (!chart || chart.type !== 'chart' || !chart.source) return;
    const source = chart.source;
    try {
      const data = gridToChartData(await loadRangeGrid(source.path, source.range));
      applyUpdaters(
        {
          [id]: (element) =>
            element.type === 'chart'
              ? {
                  ...applyChartData(element, data, nextId),
                  source: { ...source, refreshedAt: new Date().toISOString() },
                }
              : element,
        },
        'Refresh chart',
      );
      toast.success(`Chart refreshed from ${source.path.split('/').pop()}`);
    } catch (error) {
      reportError(error);
    }
  };

  /* Linked documents and slide exports */

  /** Writes a note's preview image; other documents are shown as a card. */
  const makePreview = async (
    path: string,
    elementId: string,
  ): Promise<DeckAssetRef | undefined> => {
    if (!client || !vault || !/\.md$/i.test(path)) return undefined;
    const { content } = await client.readDocument(path);
    const dataUrl = svgDataUrl(notePreviewSvg(getVaultDocumentTitle(path), content));
    const written = await writeVaultImage(
      client,
      vault,
      deckAssetFolder(relativePath),
      embedPreviewName(elementId),
      dataUrl,
      true,
    );
    return describeImage(written, dataUrl, async () => NOTE_PREVIEW_SIZE);
  };

  const insertEmbed = async (path: string) => {
    if (!document) return;
    const id = nextId('embed');
    try {
      const preview = await makePreview(path, id);
      const count = Object.keys(geometry?.slide.elements ?? {}).length;
      const element = createEmbedElement(document, id, path, preview, (count % 6) * PASTE_STEP);
      if (onSlide('Link document', (current, target) => addElements(current, target, [element]))) {
        setSelectedIds([id]);
      }
      if (preview) void refreshFileTree();
    } catch (error) {
      reportError(error);
    }
  };

  const refreshEmbed = async (id: string) => {
    const element = geometry?.slide.elements[id];
    if (!element || element.type !== 'embed') return;
    try {
      const preview = await makePreview(element.source.path, id);
      if (!preview) {
        toast.info('Only notes have a text preview; other documents are shown as a card.');
        return;
      }
      applyUpdaters(
        { [id]: (current) => (current.type === 'embed' ? { ...current, preview } : current) },
        'Refresh preview',
      );
    } catch (error) {
      reportError(error);
    }
  };

  const openEmbed = (id: string) => {
    const element = geometry?.slide.elements[id];
    if (!element || element.type !== 'embed') return;
    const path = element.source.path;
    const type = getVaultDocumentTabType(path);
    openTab(path, getVaultDocumentTitle(path), type);
    setActiveView(getVaultDocumentView(type));
  };

  /** Writes a slide as an SVG at a stable path and copies Markdown for a note. */
  const exportSlide = async (slideId: string) => {
    if (!client || !vault || !document) return;
    try {
      const scene = resolveSlide(document, slideId);
      const svg = renderSlideSvg(scene, { measurer, resolveAsset, pixelWidth: 1_920 });
      const path = await writeVaultImage(
        client,
        vault,
        deckAssetFolder(relativePath),
        slideExportName(slideId),
        svgDataUrl(svg),
        true,
      );
      void refreshFileTree();
      const markdown = slideExportMarkdown(path, relativePath, scene.number);
      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        // Clipboard writes can be refused; the path is in the message.
      }
      toast.success(`Slide ${scene.number} exported to ${path}`, {
        description:
          'Markdown to show it in a note was copied. Export again to update it in place.',
      });
    } catch (error) {
      reportError(error);
    }
  };

  /* Presenting and export ---------------------------------------------------- */

  const deckTitle = getDocumentBaseName(relativePath, 'Presentation').replace(/\.deck$/i, '');
  const deckExport = useDeckExport({ document, title: deckTitle, measurer, resolveAsset });
  const [exportOpen, setExportOpen] = useState(false);
  const slideNumberById = useMemo(
    () => new Map(slideOrder.map((id, index) => [id, index + 1])),
    [slideOrder],
  );
  const [presenting, setPresenting] = useState<{
    mode: DeckPresentMode;
    startSlideId: string | null;
  } | null>(null);
  const [inkToKeep, setInkToKeep] = useState<PlaybackInk | null>(null);
  const [transitionPreview, setTransitionPreview] = useState<{
    key: number;
    transition: DeckTransition;
  } | null>(null);
  // Phone remote control (`lib/deck/remote.ts`): off until the presenter
  // turns it on, then kept on for this view.
  const { userId } = useCollabIdentity();
  const [showId, setShowId] = useState<string | null>(null);
  const [showPosition, setShowPosition] = useState<DeckShowPosition | null>(null);
  const [remoteAllowed, setRemoteAllowed] = useState(false);
  const remoteListeners = useRef(new Set<(action: PlaybackAction) => void>());
  const remoteApplied = useRef(new Map<number, number>());
  const presenterRemote = useMemo<DeckPresenterRemote>(
    () => ({
      allowed: remoteAllowed,
      onAllowedChange: setRemoteAllowed,
      subscribe: (listener) => {
        remoteListeners.current.add(listener);
        return () => remoteListeners.current.delete(listener);
      },
    }),
    [remoteAllowed],
  );

  const present = (mode: DeckPresentMode, from: 'start' | 'current') => {
    if (!document || !supported || slideOrder.length === 0) return;
    flushText();
    endTextSession();
    if (designTarget) setDesignTarget(null);
    const first = slideOrder.find((id) => !document.slides[id]?.hidden) ?? slideOrder[0];
    remoteApplied.current = new Map();
    setShowPosition(null);
    setShowId(newShowId());
    setPresenting({ mode, startSlideId: from === 'current' ? activeSlideId : first });
  };

  const endPresentation = (summary: DeckPresentSummary) => {
    setPresenting(null);
    const slideId = summary.slideId;
    if (slideId && slideOrder.includes(slideId)) {
      setViewState((current) => ({ ...current, slideId }));
    }
    const drawn = Object.values(summary.ink).some((strokes) => strokes.length > 0);
    if (drawn && editable) setInkToKeep(summary.ink);
    window.setTimeout(() => focusCanvas(), 0);
  };

  /** Writes each slide's ink as a transparent SVG and places it over the slide, as one undo step. */
  const keepInk = async (ink: PlaybackInk) => {
    setInkToKeep(null);
    if (!client || !vault || !document) return;
    try {
      const { width, height } = document.size;
      const additions: Array<{ slideId: string; element: DeckElement }> = [];
      for (const [slideId, strokes] of Object.entries(ink)) {
        if (strokes.length === 0 || !document.slides[slideId]) continue;
        const dataUrl = svgDataUrl(
          inkAnnotationSvg(strokes, width, height, unitsToPx(width), unitsToPx(height)),
        );
        const path = await writeVaultImage(
          client,
          vault,
          deckAssetFolder(relativePath),
          inkAnnotationName(slideId, Date.now()),
          dataUrl,
          false,
        );
        const asset = await describeImage(path, dataUrl);
        additions.push({
          slideId,
          element: {
            id: nextId('ink'),
            type: 'image',
            name: 'Ink annotations',
            frame: { x: 0, y: 0, width, height },
            asset,
          },
        });
      }
      void refreshFileTree();
      if (additions.length === 0) return;
      const kept = commit('Keep ink annotations', (current) =>
        composeEdits(
          current,
          additions
            .filter((entry) => current.slides[entry.slideId])
            .map(
              (entry) => (deck: DeckDocument) => addElements(deck, entry.slideId, [entry.element]),
            ),
        ),
      );
      if (kept) {
        toast.success(
          additions.length === 1
            ? 'Ink kept on 1 slide.'
            : `Ink kept on ${additions.length} slides.`,
          { description: 'Each slide’s ink is an image you can move, hide, or delete.' },
        );
      }
    } catch (error) {
      reportError(error);
    }
  };

  const openPresentationLink = (href: string) => {
    if (!/^(https?:|mailto:)/i.test(href)) return;
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(href))
      .catch(() => window.open(href, '_blank', 'noopener'));
  };

  const openVaultLink = (path: string) => {
    const type = getVaultDocumentTabType(path);
    openTab(path, getVaultDocumentTitle(path), type);
    setActiveView(getVaultDocumentView(type));
  };

  /* Collaborators ------------------------------------------------------------ */

  const allPeers = useLivePeers(session.liveSession);
  const livePeers = useMemo(
    () =>
      allPeers.filter(
        (peer) => peer.document?.kind === 'deck' && peer.document.relativePath === relativePath,
      ),
    [allPeers, relativePath],
  );
  const stageTargetId = stageTarget?.id ?? null;
  const editingInfo = textSession
    ? `${textSession.kind}:${textSession.elementId ?? ''}:${textSession.cellKey ?? ''}`
    : '';
  useEffect(() => {
    const awareness = session.liveSession?.awareness;
    if (!awareness) return;
    const active = textSessionRef.current;
    const deck: DeckInteraction = {
      targetId: stageTargetId,
      selectedIds,
      editing: active
        ? {
            elementId: active.elementId,
            cellKey: active.cellKey,
            notes: active.kind === 'notes',
          }
        : null,
      presenting: presenting !== null,
      show:
        presenting && showId
          ? {
              id: showId,
              slideId: showPosition?.slideId ?? presenting.startSlideId,
              position: showPosition?.position ?? 1,
              total: showPosition?.total ?? slideOrder.length,
              blank: showPosition?.blank ?? null,
              remote: remoteAllowed,
            }
          : null,
    };
    awareness.setLocalStateField('deck', deck);
  }, [
    editingInfo,
    presenting,
    remoteAllowed,
    selectedIds,
    session.liveSession,
    showId,
    showPosition,
    slideOrder.length,
    stageTargetId,
  ]);

  useEffect(() => {
    if (!presenting || !showId) return;
    const taken = takeRemoteCommands(
      livePeers,
      { id: showId, userId, allowed: remoteAllowed },
      remoteApplied.current,
    );
    remoteApplied.current = taken.applied;
    for (const command of taken.commands) {
      const action = remoteCommandAction(command);
      if (!action) continue;
      for (const listener of remoteListeners.current) listener(action);
    }
  }, [livePeers, presenting, remoteAllowed, showId, userId]);

  const peersBySlide = useMemo(() => {
    const map = new Map<
      string,
      Array<{ key: string; name: string; color: string; presenting?: boolean }>
    >();
    for (const peer of livePeers) {
      const id = peer.deck?.targetId;
      if (!id || !peer.user) continue;
      const list = map.get(id) ?? [];
      list.push({
        key: String(peer.clientId),
        name: peer.user.name,
        color: peer.user.color,
        presenting: peer.deck?.presenting,
      });
      map.set(id, list);
    }
    return map;
  }, [livePeers]);

  const stagePeers = useMemo<DeckStagePeer[]>(
    () =>
      livePeers
        .filter((peer) => peer.user && stageTargetId && peer.deck?.targetId === stageTargetId)
        .map((peer) => {
          const typingId = peer.deck?.editing?.notes
            ? null
            : (peer.deck?.editing?.elementId ?? null);
          const ids = [...(peer.deck?.selectedIds ?? [])];
          if (typingId && !ids.includes(typingId)) ids.push(typingId);
          return {
            key: String(peer.clientId),
            name: peer.user!.name,
            color: peer.user!.color,
            ids,
            typingId,
          };
        })
        .filter((peer) => peer.ids.length > 0),
    [livePeers, stageTargetId],
  );
  const presentingPeer = livePeers.find((peer) => peer.deck?.presenting && peer.user);

  /* Position and size */

  const singleObject =
    selectedIds.length === 1 && geometry
      ? (() => {
          const element = geometry.slide.elements[selectedIds[0]];
          const frame = geometry.frames.get(selectedIds[0]);
          return element && frame ? { element, frame } : null;
        })()
      : null;

  const onObjectFrame = (
    patch: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>,
  ) => {
    if (!singleObject || !geometry) return;
    const { element, frame } = singleObject;
    if (element.type === 'line') {
      const dx = (patch.x ?? frame.x) - frame.x;
      const dy = (patch.y ?? frame.y) - frame.y;
      applyUpdaters(moveSelection(geometry, [element.id], dx, dy), 'Position');
      return;
    }
    if (element.type === 'group') {
      applyUpdaters(
        moveSelection(
          geometry,
          [element.id],
          (patch.x ?? frame.x) - frame.x,
          (patch.y ?? frame.y) - frame.y,
        ),
        'Position',
      );
      return;
    }
    applyUpdaters(
      {
        [element.id]: (current) => {
          const next = {
            ...frame,
            ...(current.frame ?? {}),
            ...patch,
            ...(patch.rotation !== undefined
              ? { rotation: normalizeRotation(patch.rotation) }
              : {}),
          };
          const placed = { ...current, frame: next } as DeckElement;
          return placed.type === 'table' ? scaleTable(placed, next.width, next.height) : placed;
        },
      },
      patch.width !== undefined || patch.height !== undefined ? 'Size' : 'Position',
    );
  };

  const onObjectText = (patch: { altText?: string; name?: string }) => {
    if (!singleObject) return;
    applyUpdaters(
      {
        [singleObject.element.id]: (current) => {
          const next = { ...current };
          if (patch.name) next.name = patch.name.slice(0, 256);
          else if (patch.name !== undefined) delete next.name;
          if (patch.altText) next.altText = patch.altText.slice(0, 4_096);
          else if (patch.altText !== undefined) delete next.altText;
          return next;
        },
      },
      patch.name !== undefined ? 'Object name' : 'Alt text',
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
    if (event.key === 'Tab' && !mod && !event.altKey && textSessionRef.current?.cellKey) {
      // In a table, Tab moves between cells, as in PowerPoint.
      const active = textSessionRef.current;
      const table = active.elementId ? geometry?.slide.elements[active.elementId] : undefined;
      if (table?.type === 'table') {
        const keys = table.rowOrder.flatMap((rowId) =>
          table.columnOrder.map((columnId) => ({ rowId, columnId })),
        );
        const at = keys.findIndex((entry) => `${entry.rowId}:${entry.columnId}` === active.cellKey);
        const next = keys[(at + (event.shiftKey ? -1 : 1) + keys.length) % keys.length];
        if (next) beginCellEdit(table.id, next, null);
        return true;
      }
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

  const onTransitionChange = (transition: DeckTransition | null) => {
    commit('Slide transition', (current) => {
      const slides: Record<string, DeckDocument['slides'][string]> = {};
      for (const id of slideSelection) {
        const slide = current.slides[id];
        if (!slide) continue;
        const next = { ...slide };
        if (transition) next.transition = transition;
        else delete next.transition;
        slides[id] = next;
      }
      return applyPatch(current, { slides });
    });
  };

  const onAnimationsChange = (animations: DeckAnimation[]) => {
    if (!activeSlideId) return;
    commit('Animation timeline', (current) => {
      const slide = current.slides[activeSlideId];
      if (!slide) return noEdit(current);
      const next = { ...slide };
      if (animations.length > 0) next.animations = animations;
      else delete next.animations;
      return applyPatch(current, { slides: { [activeSlideId]: next } });
    });
  };

  const onReadingOrderChange = (readingOrder: string[]) => {
    if (!activeSlideId) return;
    commit('Reading order', (current) => {
      const slide = current.slides[activeSlideId];
      if (!slide) return noEdit(current);
      return applyPatch(current, {
        slides: { [activeSlideId]: { ...slide, readingOrder: [...readingOrder] } },
      });
    });
  };

  const onAnimationAdd = (elementId: string) => {
    if (!document || !activeSlideId) return;
    onAnimationsChange([
      ...(document.slides[activeSlideId]?.animations ?? []),
      {
        id: nextId('anim'),
        elementId,
        effect: 'fade',
        phase: 'entrance',
        trigger: 'click',
        durationMs: 500,
      },
    ]);
  };

  const previewTransition = () => {
    const transition = activeSlideId ? document?.slides[activeSlideId]?.transition : undefined;
    if (transition && transition.kind !== 'none') {
      setTransitionPreview({ key: Date.now(), transition });
    }
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
    const images = Array.from(event.clipboardData.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (images.length > 0 && editable) {
      void (async () => {
        for (const file of images) await uploadImage(file);
      })();
      return;
    }
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

  const [stageRef, stageSize, stageElement] = useElementSize<HTMLDivElement>();
  const focusCanvas = () => stageElement?.focus({ preventScroll: true });
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

    if (key === 'F5' && !mod) {
      return run(() =>
        present(event.altKey ? 'presenter' : 'slideshow', event.shiftKey ? 'current' : 'start'),
      );
    }
    if (mod && lower === 'p') return run(() => setExportOpen(true));
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
      const table = selectedTable;
      if (table) {
        const cell = tableCellHere ?? { rowId: table.rowOrder[0], columnId: table.columnOrder[0] };
        return run(() => beginCellEdit(table.id, cell, null));
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
  const hasTextFormattingTarget = textSession !== null || textTargets.length > 0;
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
              (() => {
                const box = editingBox(draftScene, active);
                return box ? layoutText(box.text, box.width, box.height, measurer).scale : 1;
              })()
        }
        plain={plain}
        label={
          plain ? 'Speaker notes' : active.cellKey ? 'Table cell' : (editingElement?.name ?? 'Text')
        }
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
          const box = textSession.cellKey ? editingBox(draftScene, textSession) : null;
          return {
            id: textSession.elementId!,
            ...(box ? { rect: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
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
              {presentingPeer && <span>{presentingPeer.user!.name} is presenting</span>}
              <LivePeers peers={livePeers} />
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
                <DropdownMenuContent
                  align="start"
                  className="max-h-[70vh] overflow-y-auto"
                  // Keys after an insert act on the new object, not on this menu's button.
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    focusCanvas();
                  }}
                >
                  <DropdownMenuItem onClick={() => insert('text')}>
                    <Type size={13} /> Text box
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPicker({ kind: 'image' })}>
                    <ImageIcon size={13} /> Image…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTableDialogOpen(true)}>
                    <Table2 size={13} /> Table…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPicker({ kind: 'embed' })}>
                    <FileText size={13} /> Linked document…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px]">Chart</DropdownMenuLabel>
                  {(
                    [
                      ['column', 'Column chart'],
                      ['bar', 'Bar chart'],
                      ['line', 'Line chart'],
                      ['area', 'Area chart'],
                      ['pie', 'Pie chart'],
                    ] as const
                  ).map(([kind, label]) => (
                    <DropdownMenuItem key={kind} onClick={() => insertChart(kind)}>
                      <BarChart3 size={13} /> {label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px]">Lines</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => insert('line')}>
                    <Minus size={13} /> Line
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => insert('arrow')}>
                    <MoveRight size={13} /> Arrow
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px]">Shapes</DropdownMenuLabel>
                  {DECK_SHAPE_GEOMETRIES.map((geometry) => (
                    <DropdownMenuItem key={geometry} onClick={() => insert(geometry)}>
                      {geometry === 'ellipse' ? <Circle size={13} /> : <Square size={13} />}{' '}
                      {SHAPE_NAMES[geometry]}
                    </DropdownMenuItem>
                  ))}
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton disabled={!supported || slideOrder.length === 0}>
                    <Play size={14} />
                    Present
                  </DocumentTopBarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => present('slideshow', 'start')}>
                    From the beginning
                    <DropdownMenuShortcut>F5</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => present('slideshow', 'current')}>
                    From this slide
                    <DropdownMenuShortcut>Shift+F5</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => present('presenter', 'start')}>
                    <MonitorPlay size={13} /> Presenter view
                    <DropdownMenuShortcut>Alt+F5</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DocumentTopBarIconButton
                onClick={() => setExportOpen(true)}
                disabled={!supported || slideOrder.length === 0}
                aria-label="Export or print"
              >
                <Download size={14} />
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

      {theme && (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/15 px-2 py-1 scrollbar-none"
          data-testid="deck-formatting-row"
        >
          <DeckTextToolbar
            state={toolbarState}
            theme={theme}
            box={textSession?.kind === 'notes' ? null : box}
            disabled={!editable || !hasTextFormattingTarget}
            embedded
            canResetPlaceholder={placeholderToReset.length > 0}
            onCommand={runCommand}
            onFont={setFont}
            onColor={(color) => setColor(color)}
            onBox={setBox}
            onLink={openLinkDialog}
            onResetPlaceholder={resetSelectedPlaceholders}
          />

          {editable && !textSession && formatElements.length > 0 && (
            <DeckObjectToolbar
              elements={formatElements}
              theme={theme}
              embedded
              hasActiveCell={Boolean(tableCellHere)}
              cropping={cropping}
              onFill={onFill}
              onOutline={onOutline}
              onArrow={onArrow}
              onGeometry={onGeometry}
              onOpacity={onOpacity}
              onFlip={onFlip}
              onRotate={onRotateQuarter}
              onCrop={() => setCropping(!cropping)}
              onResetCrop={() =>
                updateEach('Reset crop', (element) => {
                  if (element.type !== 'image') return element;
                  const next = { ...element };
                  delete next.crop;
                  return next;
                })
              }
              onReplaceImage={() =>
                selectedIds[0] && setPicker({ kind: 'image', replace: selectedIds[0] })
              }
              onTable={onTableAction}
              onCellFill={onCellFill}
              onEditChart={() => selectedIds[0] && setChartDialogId(selectedIds[0])}
              onRefreshChart={() => selectedIds[0] && void refreshChart(selectedIds[0])}
              onOpenEmbed={() => selectedIds[0] && openEmbed(selectedIds[0])}
              onRefreshEmbed={() => selectedIds[0] && void refreshEmbed(selectedIds[0])}
            />
          )}
        </div>
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
            peersBySlide={peersBySlide}
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
                onPointerDownCapture={focusCanvas}
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
                    onEditCell={(id, cell, point) => beginCellEdit(id, cell, point)}
                    onActiveCell={(id, cell) =>
                      setActiveCell(cell ? { tableId: id, ...cell } : null)
                    }
                    onOpenEmbed={openEmbed}
                    onDropFiles={onDropFiles}
                    editing={editingOverlay}
                    onExitText={endTextSession}
                    peers={stagePeers}
                    transitionPreview={designTarget ? null : transitionPreview}
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
            onTransitionChange={onTransitionChange}
            onTransitionPreview={previewTransition}
            onAnimationAdd={onAnimationAdd}
            onAnimationsChange={onAnimationsChange}
            onReadingOrderChange={onReadingOrderChange}
            onApplyTemplate={onApplyTemplate}
            onThemeColor={onThemeColor}
            onThemeFont={onThemeFont}
            onEditDesign={enterDesign}
            onLayoutChange={onLayoutChange}
            onDesignBackground={onDesignBackground}
            onMasterTextStyle={onMasterTextStyle}
            object={singleObject}
            onObjectFrame={onObjectFrame}
            onObjectText={onObjectText}
          />
        )}
      </div>

      <DeckVaultPicker
        onReturnFocus={focusCanvas}
        open={picker !== null}
        title={
          picker?.kind === 'embed'
            ? 'Link a document'
            : picker?.replace
              ? 'Replace image'
              : 'Insert image'
        }
        description={
          picker?.kind === 'embed'
            ? 'The slide shows a preview; double-click it to open the document. Notes get a text preview you can refresh.'
            : 'Pick an image in the vault, or bring one in from this computer. Imported images are stored beside the presentation.'
        }
        fileTree={fileTree}
        accept={picker?.kind === 'embed' ? isLinkableDocument : isDeckImagePath}
        uploadAccept={
          picker?.kind === 'image'
            ? 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'
            : undefined
        }
        onOpenChange={(open) => !open && setPicker(null)}
        onPick={(path) => {
          const current = picker;
          setPicker(null);
          if (current?.kind === 'embed') void insertEmbed(path);
          else void placeImage(path, { replace: current?.replace });
        }}
        onUpload={(file) => {
          const current = picker;
          setPicker(null);
          void uploadImage(file, {
            replace: current?.kind === 'image' ? current.replace : undefined,
          });
        }}
      />
      <DeckTableDialog
        onReturnFocus={focusCanvas}
        open={tableDialogOpen}
        workbooks={workbooks}
        onOpenChange={setTableDialogOpen}
        onInsert={onInsertTable}
        onLoadRange={loadRangeGrid}
      />
      <DeckChartDialog
        onReturnFocus={focusCanvas}
        open={chartForDialog !== null}
        chart={chartForDialog}
        workbooks={workbooks}
        onOpenChange={(open) => !open && setChartDialogId(null)}
        onApply={onApplyChart}
        onLoadRange={async (path, range) => gridToChartData(await loadRangeGrid(path, range))}
      />
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
      <DeckExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        onReturnFocus={focusCanvas}
        slideCount={slideOrder.length}
        currentNumber={Math.max(1, activeIndex + 1)}
        selectedNumbers={slideSelection.map((id) => slideOrder.indexOf(id) + 1)}
        progress={deckExport.progress}
        onCancel={deckExport.cancel}
        onExport={(request) => {
          void deckExport.exportDeck(request).then((done) => done && setExportOpen(false));
        }}
        onPrint={(request) => {
          if (deckExport.printDeck(request)) setExportOpen(false);
        }}
      />
      <DeckExportReportDialog
        outcome={deckExport.pptxOutcome}
        slideNumbers={slideNumberById}
        onClose={deckExport.clearPptxOutcome}
        onReturnFocus={focusCanvas}
      />
      {deckExport.printPages && (
        <DeckPrintHost pages={deckExport.printPages} onDone={deckExport.finishPrint} />
      )}
      <Dialog open={inkToKeep !== null} onOpenChange={(open) => !open && setInkToKeep(null)}>
        <DialogContent
          className="sm:max-w-sm"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusCanvas();
          }}
        >
          <DialogHeader>
            <DialogTitle>Keep ink annotations?</DialogTitle>
            <DialogDescription>
              Ink drawn during the show is not part of the presentation. Keep it as an image on each
              slide you drew on, or discard it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setInkToKeep(null)}>
              Discard
            </Button>
            <Button type="button" onClick={() => inkToKeep && void keepInk(inkToKeep)}>
              Keep
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {presenting && document && (
        <DeckPresenter
          deck={document}
          startSlideId={presenting.startSlideId}
          mode={presenting.mode}
          measurer={measurer}
          resolveAsset={resolveAsset}
          onExit={endPresentation}
          onOpenUrl={openPresentationLink}
          onOpenVaultLink={openVaultLink}
          onNotice={(message) => toast.info(message)}
          onShowChange={setShowPosition}
          remote={session.liveSession ? presenterRemote : undefined}
        />
      )}
    </div>
  );
}
