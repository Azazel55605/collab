import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowRightToLine,
  Columns3,
  Combine,
  Download,
  Loader2,
  Redo2,
  Rows3,
  Save,
  Search,
  Printer,
  Snowflake,
  Split,
  Table2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  DocumentTopBar,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import SheetFormulaBar from '../components/sheet/SheetFormulaBar';
import SheetFindDialog from '../components/sheet/SheetFindDialog';
import SheetFormattingToolbar from '../components/sheet/SheetFormattingToolbar';
import SheetGrid, { type SheetGridEditing } from '../components/sheet/SheetGrid';
import SheetWorksheetBar from '../components/sheet/SheetWorksheetBar';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { useUiStore } from '../store/uiStore';
import { isVaultReadOnly } from '../types/vault';
import { SHEET_SCHEMA_VERSION } from '../types/sheet';
import type { SheetDocument } from '../types/sheet';
import type { SheetPosition } from '../lib/sheet/address';
import { formatA1, parseA1Range } from '../lib/sheet/address';
import { SheetDocumentError, addWorksheet, removeWorksheet, renameWorksheet } from '../lib/sheet/document';
import { formatCellEditText, formatNumber, parseCellInput } from '../lib/sheet/cellValue';
import {
  activeWorksheet as activeWorksheetOf,
  autoSizeColumn,
  clearCells,
  deleteTracks,
  duplicateWorksheet,
  getCell,
  insertTracks,
  mergeSelection,
  reorderWorksheet,
  resizeTrack,
  setActiveWorksheet,
  setCell,
  setCellNote,
  setFrozen,
  setWorksheetHidden,
  summarizeSelection,
  unmergeSelection,
  worksheetById,
} from '../lib/sheet/operations';
import {
  clampPosition,
  createSelection,
  normalizeRange,
  type SheetSelection,
  type SheetSelectionRange,
} from '../lib/sheet/selection';
import { useSheetSession } from '../lib/sheet/useSheetSession';
import { useSheetFormulaEngine } from '../lib/sheet/useSheetFormulaEngine';
import { formulaDependsOn, formulaPrecedents } from '../lib/sheet/formulaReferences';
import { insertFormulaReference } from '../lib/sheet/formulaFunctions';
import { fillSheetSelection } from '../lib/sheet/fill';
import {
  findSheetMatches,
  nextSheetMatch,
  replaceAllSheetMatches,
  replaceSheetMatch,
  type SheetSearchOptions,
} from '../lib/sheet/search';
import {
  createSheetClipboardPayload,
  parseSheetClipboardPayload,
  pasteSheetClipboardPayload,
  SHEET_CLIPBOARD_MIME,
  sheetClipboardToHtml,
  sheetClipboardToTsv,
  tsvToSheetClipboard,
  type SheetClipboardPayload,
  type SheetPasteMode,
} from '../lib/sheet/clipboard';
import {
  applyStyleToSelection,
  clearStylesFromSelection,
  resolveCellStyle,
} from '../lib/sheet/styles';
import {
  buildSheetRangePrintHtml,
  buildSheetRangeSvg,
  printSheetRange,
  sheetRangeLabel,
  sheetSvgToPngBase64,
} from '../lib/sheet/export';
import { utf8ToBase64 } from '../lib/circuitSweepExport';
import { tauriCommands } from '../lib/tauri';

interface Props {
  relativePath: string;
}

const SHEET_HISTORY_LIMIT = 100;

/**
 * `.sheet` workbook editor.
 *
 * Layout follows the shared `DocumentTopBar` pattern: identity and controls on
 * top, then the name box/formula bar, the virtualized grid, the worksheet strip,
 * and a selection summary. The document itself is owned by `useSheetSession`;
 * every edit here goes through a pure operation in `src/lib/sheet/operations.ts`.
 */
export default function SheetView({ relativePath }: Props) {
  const { vault } = useVaultStore();
  const { dateFormat, timeFormat } = useUiStore();
  const { markDirty, setSavedHash, sheetViewStates, setSheetViewState } = useEditorStore();

  const session = useSheetSession({
    vault,
    relativePath,
    markDirty,
    markSaved: (path, hash) => setSavedHash(path, hash),
  });

  const { document } = session;
  const formulaState = useSheetFormulaEngine(document);
  const [selection, setSelection] = useState<SheetSelection>(() => createSelection({ row: 0, column: 0 }));
  const [editing, setEditing] = useState<SheetGridEditing | null>(null);
  const [formulaCursor, setFormulaCursor] = useState(0);
  const formulaCursorRef = useRef(0);
  const restoredRef = useRef(false);
  const historyRef = useRef<{ past: SheetDocument[]; future: SheetDocument[] }>({
    past: [],
    future: [],
  });
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 });
  const [findOpen, setFindOpen] = useState(false);
  const [findResultLabel, setFindResultLabel] = useState('');

  const worksheet = useMemo(
    () => (document ? activeWorksheetOf(document) : null),
    [document],
  );

  const bounds = useMemo(() => ({
    rowCount: worksheet?.rowOrder.length ?? 0,
    columnCount: worksheet?.columnOrder.length ?? 0,
  }), [worksheet]);

  // The persisted state is read once per tab: later writes must not feed back
  // into this component, or persisting would re-trigger itself every render.
  const initialViewStateRef = useRef(sheetViewStates[relativePath]);
  const scrollRef = useRef({
    top: initialViewStateRef.current?.scrollTop ?? 0,
    left: initialViewStateRef.current?.scrollLeft ?? 0,
  });

  // Restore the per-tab view state once the workbook is available.
  useEffect(() => {
    if (!document || restoredRef.current) return;
    restoredRef.current = true;
    const restored = initialViewStateRef.current;
    if (!restored) return;
    if (restored.activeWorksheetId && worksheetById(document, restored.activeWorksheetId)) {
      session.updateDocument((current) => setActiveWorksheet(current, restored.activeWorksheetId!));
    }
    setSelection(createSelection(clampPosition(
      { row: restored.activeRow, column: restored.activeColumn },
      {
        rowCount: Math.max(1, bounds.rowCount),
        columnCount: Math.max(1, bounds.columnCount),
      },
    )));
  }, [bounds.columnCount, bounds.rowCount, document, session]);

  const persistViewState = useCallback((scroll?: { top: number; left: number }) => {
    if (scroll) scrollRef.current = scroll;
    const next = {
      activeWorksheetId: document?.activeWorksheetId ?? null,
      scrollTop: scrollRef.current.top,
      scrollLeft: scrollRef.current.left,
      activeRow: selection.active.row,
      activeColumn: selection.active.column,
    };
    const current = useEditorStore.getState().sheetViewStates[relativePath];
    if (current
      && current.activeWorksheetId === next.activeWorksheetId
      && current.scrollTop === next.scrollTop
      && current.scrollLeft === next.scrollLeft
      && current.activeRow === next.activeRow
      && current.activeColumn === next.activeColumn) {
      return;
    }
    setSheetViewState(relativePath, next);
  }, [document?.activeWorksheetId, relativePath, selection.active, setSheetViewState]);

  useEffect(() => {
    if (!document) return;
    persistViewState();
  }, [document, persistViewState]);

  // Keep the selection inside the grid after a structural edit shrinks it.
  useEffect(() => {
    if (bounds.rowCount === 0 || bounds.columnCount === 0) return;
    const clamped = clampPosition(selection.active, bounds);
    if (clamped.row !== selection.active.row || clamped.column !== selection.active.column) {
      setSelection(createSelection(clamped));
    }
  }, [bounds, selection.active]);

  const guard = useCallback((action: () => void) => {
    try {
      action();
    } catch (error) {
      toast.error(error instanceof SheetDocumentError ? error.message : String(error));
    }
  }, []);

  const syncHistoryCounts = useCallback(() => {
    setHistoryCounts({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  }, []);

  useEffect(() => {
    historyRef.current = { past: [], future: [] };
    syncHistoryCounts();
  }, [relativePath, syncHistoryCounts]);

  const mutate = useCallback((updater: (document: SheetDocument, worksheetId: string) => SheetDocument) => {
    if (!document || !worksheet) return;
    guard(() => session.updateDocument((current) => {
      const target = activeWorksheetOf(current);
      const next = updater(current, target.id);
      if (next === current) return current;
      historyRef.current.past.push(current);
      if (historyRef.current.past.length > SHEET_HISTORY_LIMIT) {
        historyRef.current.past.splice(0, historyRef.current.past.length - SHEET_HISTORY_LIMIT);
      }
      historyRef.current.future = [];
      syncHistoryCounts();
      return next;
    }));
  }, [document, guard, session, syncHistoryCounts, worksheet]);

  const undo = useCallback(() => {
    if (session.readOnly || historyRef.current.past.length === 0) return;
    session.updateDocument((current) => {
      const previous = historyRef.current.past.pop();
      if (!previous) return current;
      historyRef.current.future.push(current);
      syncHistoryCounts();
      return previous;
    });
  }, [session, syncHistoryCounts]);

  const redo = useCallback(() => {
    if (session.readOnly || historyRef.current.future.length === 0) return;
    session.updateDocument((current) => {
      const next = historyRef.current.future.pop();
      if (!next) return current;
      historyRef.current.past.push(current);
      syncHistoryCounts();
      return next;
    });
  }, [session, syncHistoryCounts]);

  // ── Editing ────────────────────────────────────────────────────────────────
  const activeCellText = useMemo(() => {
    if (editing) return editing.text;
    if (!worksheet) return '';
    return formatCellEditText(getCell(worksheet, selection.active));
  }, [editing, selection.active, worksheet]);

  useEffect(() => {
    if (editing?.source !== 'grid') return;
    formulaCursorRef.current = editing.text.length;
    setFormulaCursor(editing.text.length);
  }, [editing?.source, editing?.text]);

  const setFormulaCaret = useCallback((cursor: number) => {
    formulaCursorRef.current = cursor;
    setFormulaCursor(cursor);
  }, []);

  const commitCell = useCallback((position: SheetPosition, text: string) => {
    mutate((current, worksheetId) => setCell(current, worksheetId, position, parseCellInput(text)));
  }, [mutate]);

  const handleFormulaBarChange = useCallback((text: string) => {
    if (session.readOnly) return;
    setEditing({ position: selection.active, text, source: 'formula-bar' });
  }, [selection.active, session.readOnly]);

  const commitFormulaBar = useCallback(() => {
    if (!editing) return;
    commitCell(editing.position, editing.text);
    setEditing(null);
  }, [commitCell, editing]);

  const handleGridSelectionChange = useCallback((next: SheetSelection) => {
    setSelection(next);
  }, []);

  const handleFormulaReferenceCommit = useCallback((range: SheetSelectionRange) => {
    if (!editing?.text.startsWith('=')) return;
    const rectangle = normalizeRange(range);
    const start = formatA1({ row: rectangle.top, column: rectangle.left });
    const end = formatA1({ row: rectangle.bottom, column: rectangle.right });
    const reference = start === end ? start : `${start}:${end}`;
    const inserted = insertFormulaReference(editing.text, reference, formulaCursorRef.current);
    setEditing({ ...editing, text: inserted.value, source: 'formula-bar' });
    setFormulaCaret(inserted.cursor);
  }, [editing, setFormulaCaret]);

  // ── Structural commands ────────────────────────────────────────────────────
  const selectionRectangle = useMemo(
    () => (selection.ranges.length > 0 ? normalizeRange(selection.ranges[0]) : null),
    [selection],
  );

  const insertRows = () => mutate((current, id) => insertTracks(
    current, id, 'row', selectionRectangle?.top ?? 0,
    selectionRectangle ? selectionRectangle.bottom - selectionRectangle.top + 1 : 1,
  ));
  const insertColumns = () => mutate((current, id) => insertTracks(
    current, id, 'column', selectionRectangle?.left ?? 0,
    selectionRectangle ? selectionRectangle.right - selectionRectangle.left + 1 : 1,
  ));
  const deleteRows = () => mutate((current, id) => deleteTracks(
    current, id, 'row', selectionRectangle?.top ?? 0,
    selectionRectangle ? selectionRectangle.bottom - selectionRectangle.top + 1 : 1,
  ));
  const deleteColumns = () => mutate((current, id) => deleteTracks(
    current, id, 'column', selectionRectangle?.left ?? 0,
    selectionRectangle ? selectionRectangle.right - selectionRectangle.left + 1 : 1,
  ));

  const toggleFreeze = () => mutate((current, id) => {
    const target = worksheetById(current, id)!;
    const frozen = target.frozen ?? { rows: 0, columns: 0 };
    const isFrozen = frozen.rows > 0 || frozen.columns > 0;
    return setFrozen(current, id, isFrozen
      ? { rows: 0, columns: 0 }
      : { rows: selection.active.row, columns: selection.active.column });
  });

  const summary = useMemo(
    () => (worksheet ? summarizeSelection(worksheet, selection, formulaState.values) : null),
    [formulaState.values, selection, worksheet],
  );
  const activeStyle = useMemo(
    () => (document && worksheet
      ? resolveCellStyle(document.styles, worksheet, selection.active)
      : {}),
    [document, selection.active, worksheet],
  );

  const currentClipboardPayload = useCallback(() => {
    if (!document || !worksheet) return null;
    return createSheetClipboardPayload(document, worksheet, selection, formulaState.values);
  }, [document, formulaState.values, selection, worksheet]);

  const writeClipboardEvent = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const payload = currentClipboardPayload();
    if (!payload) return false;
    event.preventDefault();
    event.clipboardData.setData(SHEET_CLIPBOARD_MIME, JSON.stringify(payload));
    event.clipboardData.setData('text/plain', sheetClipboardToTsv(payload));
    event.clipboardData.setData('text/html', sheetClipboardToHtml(payload));
    return true;
  }, [currentClipboardPayload]);

  const writeSystemClipboard = useCallback(async () => {
    const payload = currentClipboardPayload();
    if (!payload) return false;
    const text = sheetClipboardToTsv(payload);
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({
          [SHEET_CLIPBOARD_MIME]: new Blob([JSON.stringify(payload)], { type: SHEET_CLIPBOARD_MIME }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([sheetClipboardToHtml(payload)], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      return true;
    } catch (structuredError) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (textError) {
        toast.error(`Could not copy cells: ${textError || structuredError}`);
        return false;
      }
    }
  }, [currentClipboardPayload]);

  const applyClipboardPayload = useCallback((payload: SheetClipboardPayload, mode: SheetPasteMode) => {
    mutate((current, id) => pasteSheetClipboardPayload(current, id, selection.active, payload, mode));
  }, [mutate, selection.active]);

  const pasteFromSystemClipboard = useCallback(async (mode: SheetPasteMode) => {
    try {
      let payload: SheetClipboardPayload | null = null;
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes(SHEET_CLIPBOARD_MIME)) {
            payload = parseSheetClipboardPayload(await (await item.getType(SHEET_CLIPBOARD_MIME)).text());
            if (payload) break;
          }
        }
      }
      if (!payload) payload = tsvToSheetClipboard(await navigator.clipboard.readText());
      applyClipboardPayload(payload, mode);
    } catch (error) {
      toast.error(`Could not paste cells: ${error}`);
    }
  }, [applyClipboardPayload]);

  const handlePasteEvent = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    if (session.readOnly) return;
    const structured = parseSheetClipboardPayload(event.clipboardData.getData(SHEET_CLIPBOARD_MIME));
    const text = event.clipboardData.getData('text/plain');
    if (!structured && !text) return;
    event.preventDefault();
    applyClipboardPayload(structured ?? tsvToSheetClipboard(text), 'all');
  }, [applyClipboardPayload, session.readOnly]);

  const handleFillSelection = useCallback((target: SheetPosition) => {
    let filledSelection: SheetSelection | null = null;
    mutate((current, id) => {
      const result = fillSheetSelection(current, id, selection, target);
      filledSelection = result.selection;
      return result.document;
    });
    if (filledSelection) setSelection(filledSelection);
  }, [mutate, selection]);

  const findMatch = useCallback((
    query: string,
    options: SheetSearchOptions,
    direction: 'next' | 'previous',
  ) => {
    if (!worksheet || !query) {
      setFindResultLabel(query ? 'No matches' : '');
      return;
    }
    const matches = findSheetMatches(worksheet, query, options);
    const match = nextSheetMatch(matches, selection.active, direction);
    setFindResultLabel(matches.length === 0 ? 'No matches' : `${matches.length} match${matches.length === 1 ? '' : 'es'}`);
    if (match) setSelection(createSelection(match));
  }, [selection.active, worksheet]);

  const replaceMatch = useCallback((
    query: string,
    replacement: string,
    options: SheetSearchOptions,
  ) => {
    mutate((current, id) => replaceSheetMatch(
      current,
      id,
      selection.active,
      query,
      replacement,
      options,
    ));
  }, [mutate, selection.active]);

  const replaceAllMatches = useCallback((
    query: string,
    replacement: string,
    options: SheetSearchOptions,
  ) => {
    let count = 0;
    mutate((current, id) => {
      const result = replaceAllSheetMatches(current, id, query, replacement, options);
      count = result.count;
      return result.document;
    });
    setFindResultLabel(`${count} replaced`);
  }, [mutate]);

  const goToRange = useCallback((reference: string) => {
    const range = parseA1Range(reference);
    if (!range || range.end.row >= bounds.rowCount || range.end.column >= bounds.columnCount) {
      toast.error('Enter a cell or range inside this worksheet, such as A1 or A1:C8.');
      return;
    }
    setSelection({
      ranges: [{ anchor: range.start, focus: range.end }],
      active: range.start,
      kind: 'cells',
    });
  }, [bounds.columnCount, bounds.rowCount]);

  const exportSelection = useCallback(async (format: 'svg' | 'png') => {
    if (!document || !worksheet) return;
    const baseName = getDocumentBaseName(relativePath, 'Workbook').replace(/\.sheet$/i, '');
    const rangeName = sheetRangeLabel(selection);
    const svg = buildSheetRangeSvg(document, worksheet, selection, {
      computedValues: formulaState.values,
      displayFormat: { dateFormat, timeFormat },
      title: `${baseName} · ${rangeName}`,
    });
    const destination = await tauriCommands.showDownloadDialog(`${baseName}-${rangeName}.${format}`);
    if (!destination) return;
    const content = format === 'svg' ? utf8ToBase64(svg) : await sheetSvgToPngBase64(svg);
    await tauriCommands.writeDownloadedFile(destination, content);
    toast.success(`Exported ${rangeName} as ${format.toUpperCase()}.`);
  }, [
    dateFormat,
    document,
    formulaState.values,
    relativePath,
    selection,
    timeFormat,
    worksheet,
  ]);

  const printSelection = useCallback(() => {
    if (!document || !worksheet) return;
    const baseName = getDocumentBaseName(relativePath, 'Workbook').replace(/\.sheet$/i, '');
    printSheetRange(buildSheetRangePrintHtml(document, worksheet, selection, {
      computedValues: formulaState.values,
      displayFormat: { dateFormat, timeFormat },
      title: `${baseName} · ${sheetRangeLabel(selection)}`,
    }));
  }, [
    dateFormat,
    document,
    formulaState.values,
    relativePath,
    selection,
    timeFormat,
    worksheet,
  ]);

  const formulaHighlights = useMemo(() => {
    if (!document || !worksheet) return new Map<string, 'precedent' | 'dependent'>();
    const highlights = new Map<string, 'precedent' | 'dependent'>();
    const active = getCell(worksheet, selection.active);
    if (active?.formula) {
      for (const dependency of formulaPrecedents(document, worksheet.id, active.formula)) {
        if (dependency.worksheetId === worksheet.id) {
          highlights.set(`${dependency.rowId}:${dependency.columnId}`, 'precedent');
        }
      }
    }
    const activeRowId = worksheet.rowOrder[selection.active.row];
    const activeColumnId = worksheet.columnOrder[selection.active.column];
    if (activeRowId && activeColumnId) {
      let inspected = 0;
      for (const candidate of document.worksheets) {
        for (const [key, cell] of Object.entries(candidate.cells)) {
          if (!cell.formula) continue;
          inspected += 1;
          if (inspected > 5_000) break;
          const dependsOnActive = formulaDependsOn(document, candidate.id, cell.formula, {
            worksheetId: worksheet.id,
            rowId: activeRowId,
            columnId: activeColumnId,
          });
          if (dependsOnActive && candidate.id === worksheet.id) highlights.set(key, 'dependent');
        }
        if (inspected > 5_000) break;
      }
    }
    return highlights;
  }, [document, selection.active, worksheet]);

  const meta = document
    ? `${document.worksheets.length} worksheet${document.worksheets.length === 1 ? '' : 's'}`
    : undefined;

  const frozen = worksheet?.frozen ?? { rows: 0, columns: 0 };
  const isFrozen = frozen.rows > 0 || frozen.columns > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {isVaultReadOnly(vault) && <ReadOnlyBanner />}

      <DocumentTopBar
        icon={<Table2 size={15} className="text-violet-400/80" />}
        title={getDocumentBaseName(relativePath, 'Workbook')}
        subtitle={getDocumentFolderPath(relativePath)}
        meta={meta}
        secondary={(
          <>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton onClick={insertRows} disabled={session.readOnly || !document}>
                <Rows3 size={13} />
                Insert rows
              </DocumentTopBarButton>
              <DocumentTopBarButton onClick={insertColumns} disabled={session.readOnly || !document}>
                <Columns3 size={13} />
                Insert columns
              </DocumentTopBarButton>
              <DocumentTopBarButton onClick={deleteRows} disabled={session.readOnly || !document}>
                <Trash2 size={13} />
                Delete rows
              </DocumentTopBarButton>
              <DocumentTopBarButton onClick={deleteColumns} disabled={session.readOnly || !document}>
                <Trash2 size={13} />
                Delete columns
              </DocumentTopBarButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={undo}
                disabled={session.readOnly || historyCounts.past === 0}
                aria-label="Undo"
                title="Undo"
              >
                <Undo2 size={13} />
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={redo}
                disabled={session.readOnly || historyCounts.future === 0}
                aria-label="Redo"
                title="Redo"
              >
                <Redo2 size={13} />
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => setFindOpen(true)}
                aria-label="Find and replace"
                title="Find and replace"
              >
                <Search size={13} />
              </DocumentTopBarButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarButton aria-label="Export selection" title="Export selection">
                    <Download size={13} />
                    Export
                  </DocumentTopBarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => { void exportSelection('svg'); }}>
                    Export selection as SVG
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => { void exportSelection('png'); }}>
                    Export selection as PNG
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={printSelection}>
                    <Printer />
                    Print selection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DocumentTopBarButton
                onClick={() => mutate((current, id) => mergeSelection(current, id, selection))}
                disabled={session.readOnly || !document}
              >
                <Combine size={13} />
                Merge
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => mutate((current, id) => unmergeSelection(current, id, selection))}
                disabled={session.readOnly || !document}
              >
                <Split size={13} />
                Unmerge
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={toggleFreeze}
                disabled={session.readOnly || !document}
                aria-pressed={isFrozen}
              >
                <Snowflake size={13} />
                {isFrozen ? 'Unfreeze' : 'Freeze here'}
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => mutate((current, id) => insertTracks(current, id, 'row', bounds.rowCount, 100))}
                disabled={session.readOnly || !document}
              >
                <ArrowDownToLine size={13} />
                +100 rows
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => mutate((current, id) => insertTracks(current, id, 'column', bounds.columnCount, 10))}
                disabled={session.readOnly || !document}
              >
                <ArrowRightToLine size={13} />
                +10 columns
              </DocumentTopBarButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={() => session.save().catch((error) => toast.error(`Failed to save workbook: ${error}`))}
                disabled={session.readOnly || !session.dirty || session.saving}
              >
                {session.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {session.saving ? 'Saving…' : session.dirty ? 'Save' : 'Saved'}
              </DocumentTopBarButton>
            </div>
          </>
        )}
      />

      {session.schemaSupport === 'newer' && (
        <div
          role="status"
          className="border-b border-border/50 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200/90"
        >
          This workbook uses schema version {session.schemaVersion} and this version of Collab
          supports version {SHEET_SCHEMA_VERSION}. It is open read-only so a newer client's data is
          not overwritten.
        </div>
      )}

      {session.warnings.length > 0 && (
        <div
          role="status"
          className="border-b border-border/50 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          Repaired on open: {session.warnings.join(' ')}
        </div>
      )}

      {session.loading && (
        <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Opening workbook…
        </div>
      )}

      {!session.loading && session.error && (
        <div className="m-4 max-w-lg rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[12.5px] text-destructive-foreground">
          {session.error}
        </div>
      )}

      {!session.loading && !session.error && document && worksheet && (
        <>
          <SheetFormattingToolbar
            style={activeStyle}
            note={getCell(worksheet, selection.active)?.note}
            disabled={session.readOnly}
            onPatch={(patch) => mutate(
              (current, id) => applyStyleToSelection(current, id, selection, patch),
            )}
            onClear={() => mutate(
              (current, id) => clearStylesFromSelection(current, id, selection),
            )}
            onCopy={() => { void writeSystemClipboard(); }}
            onCut={() => {
              void writeSystemClipboard().then((copied) => {
                if (copied) mutate((current, id) => clearCells(current, id, selection));
              });
            }}
            onPaste={(mode) => { void pasteFromSystemClipboard(mode); }}
            onNoteChange={(note) => mutate(
              (current, id) => setCellNote(current, id, selection.active, note),
            )}
          />
          <SheetFormulaBar
            selection={selection}
            value={activeCellText}
            editing={editing !== null}
            onChange={handleFormulaBarChange}
            onCommit={commitFormulaBar}
            onCancel={() => setEditing(null)}
            cursor={formulaCursor}
            onCursorChange={setFormulaCaret}
            onNavigate={(position) => setSelection(createSelection(clampPosition(position, bounds)))}
            readOnly={session.readOnly}
          />

          <SheetGrid
            worksheet={worksheet}
            selection={selection}
            onSelectionChange={handleGridSelectionChange}
            onCommit={commitCell}
            editing={editing}
            onEditingChange={setEditing}
            onClearSelection={() => mutate((current, id) => clearCells(current, id, selection))}
            onResizeTrack={(axis, index, size) => mutate(
              (current, id) => resizeTrack(current, id, axis, index, size),
            )}
            onAutoSizeColumn={(index) => mutate((current, id) => autoSizeColumn(
              current,
              id,
              index,
              // Approximate measurement: the canvas metrics are not available in
              // every environment, and column width only needs to be close.
              (text) => text.length * 7.2,
            ))}
            onUndo={undo}
            onRedo={redo}
            onFind={() => setFindOpen(true)}
            onCopySelection={writeClipboardEvent}
            onCutSelection={(event) => {
              if (session.readOnly || !writeClipboardEvent(event)) return;
              mutate((current, id) => clearCells(current, id, selection));
            }}
            onPasteSelection={handlePasteEvent}
            onFillSelection={handleFillSelection}
            scrollPosition={initialViewStateRef.current
              ? { top: initialViewStateRef.current.scrollTop, left: initialViewStateRef.current.scrollLeft }
              : undefined}
            onScrollPositionChange={(scroll) => persistViewState(scroll)}
            readOnly={session.readOnly}
            computedValues={formulaState.values}
            formulaHighlights={formulaHighlights}
            styles={document.styles}
            displayFormat={{ dateFormat, timeFormat }}
            formulaReferenceMode={Boolean(editing?.text.startsWith('='))}
            onFormulaReferenceCommit={handleFormulaReferenceCommit}
          />

          <SheetWorksheetBar
            document={document}
            readOnly={session.readOnly}
            onSelect={(worksheetId) => {
              session.updateDocument((current) => setActiveWorksheet(current, worksheetId));
              setSelection(createSelection({ row: 0, column: 0 }));
            }}
            onAdd={() => mutate((current) => addWorksheet(current))}
            onRename={(worksheetId, name) => mutate(
              (current) => renameWorksheet(current, worksheetId, name),
            )}
            onDuplicate={(worksheetId) => mutate(
              (current) => duplicateWorksheet(current, worksheetId),
            )}
            onDelete={(worksheetId) => mutate(
              (current) => removeWorksheet(current, worksheetId),
            )}
            onReorder={(worksheetId, toIndex) => mutate(
              (current) => reorderWorksheet(current, worksheetId, toIndex),
            )}
            onToggleHidden={(worksheetId, hidden) => mutate(
              (current) => setWorksheetHidden(current, worksheetId, hidden),
            )}
          />

          <div
            className="flex shrink-0 items-center gap-4 border-t border-border/50 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground"
            role="status"
            aria-label="Selection summary"
          >
            <span>{formatA1(selection.active)}</span>
            {summary && summary.filled > 0 && <span>Filled: {summary.filled.toLocaleString()}</span>}
            {summary && summary.numeric > 0 && (
              <>
                <span>Sum: {formatNumber(summary.sum)}</span>
                <span>Average: {formatNumber(summary.average ?? 0)}</span>
                <span>Min: {formatNumber(summary.min ?? 0)}</span>
                <span>Max: {formatNumber(summary.max ?? 0)}</span>
              </>
            )}
            {isFrozen && <span>Frozen: {frozen.rows}R × {frozen.columns}C</span>}
            {formulaState.calculating && <span>Calculating…</span>}
            {!formulaState.calculating && formulaState.recalculated > 0 && (
              <span>Recalculated: {formulaState.recalculated.toLocaleString()}</span>
            )}
            {formulaState.error && (
              <span className="text-destructive">Formula engine: {formulaState.error}</span>
            )}
          </div>
        </>
      )}

      <SheetFindDialog
        open={findOpen}
        readOnly={session.readOnly}
        resultLabel={findResultLabel}
        onOpenChange={setFindOpen}
        onFind={findMatch}
        onReplace={replaceMatch}
        onReplaceAll={replaceAllMatches}
        onGoTo={goToRange}
      />
    </div>
  );
}
