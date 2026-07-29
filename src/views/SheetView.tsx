import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRightToLine,
  Columns3,
  Combine,
  Loader2,
  Rows3,
  Save,
  Snowflake,
  Split,
  Table2,
  Trash2,
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
import SheetFormulaBar from '../components/sheet/SheetFormulaBar';
import SheetGrid, { type SheetGridEditing } from '../components/sheet/SheetGrid';
import SheetWorksheetBar from '../components/sheet/SheetWorksheetBar';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { isVaultReadOnly } from '../types/vault';
import { SHEET_SCHEMA_VERSION } from '../types/sheet';
import type { SheetDocument } from '../types/sheet';
import type { SheetPosition } from '../lib/sheet/address';
import { formatA1 } from '../lib/sheet/address';
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
} from '../lib/sheet/selection';
import { useSheetSession } from '../lib/sheet/useSheetSession';

interface Props {
  relativePath: string;
}

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
  const { markDirty, setSavedHash, sheetViewStates, setSheetViewState } = useEditorStore();

  const session = useSheetSession({
    vault,
    relativePath,
    markDirty,
    markSaved: (path, hash) => setSavedHash(path, hash),
  });

  const { document } = session;
  const [selection, setSelection] = useState<SheetSelection>(() => createSelection({ row: 0, column: 0 }));
  const [editing, setEditing] = useState<SheetGridEditing | null>(null);
  const restoredRef = useRef(false);

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

  const mutate = useCallback((updater: (document: SheetDocument, worksheetId: string) => SheetDocument) => {
    if (!document || !worksheet) return;
    guard(() => session.updateDocument((current) => {
      const target = activeWorksheetOf(current);
      return updater(current, target.id);
    }));
  }, [document, guard, session, worksheet]);

  // ── Editing ────────────────────────────────────────────────────────────────
  const activeCellText = useMemo(() => {
    if (editing) return editing.text;
    if (!worksheet) return '';
    return formatCellEditText(getCell(worksheet, selection.active));
  }, [editing, selection.active, worksheet]);

  const commitCell = useCallback((position: SheetPosition, text: string) => {
    mutate((current, worksheetId) => setCell(current, worksheetId, position, parseCellInput(text)));
  }, [mutate]);

  const handleFormulaBarChange = useCallback((text: string) => {
    if (session.readOnly) return;
    setEditing({ position: selection.active, text });
  }, [selection.active, session.readOnly]);

  const commitFormulaBar = useCallback(() => {
    if (!editing) return;
    commitCell(editing.position, editing.text);
    setEditing(null);
  }, [commitCell, editing]);

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
    () => (worksheet ? summarizeSelection(worksheet, selection) : null),
    [selection, worksheet],
  );

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
          <SheetFormulaBar
            selection={selection}
            value={activeCellText}
            editing={editing !== null}
            onChange={handleFormulaBarChange}
            onCommit={commitFormulaBar}
            onCancel={() => setEditing(null)}
            onNavigate={(position) => setSelection(createSelection(clampPosition(position, bounds)))}
            readOnly={session.readOnly}
          />

          <SheetGrid
            worksheet={worksheet}
            selection={selection}
            onSelectionChange={setSelection}
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
            scrollPosition={initialViewStateRef.current
              ? { top: initialViewStateRef.current.scrollTop, left: initialViewStateRef.current.scrollLeft }
              : undefined}
            onScrollPositionChange={(scroll) => persistViewState(scroll)}
            readOnly={session.readOnly}
          />

          <SheetWorksheetBar
            document={document}
            readOnly={session.readOnly}
            onSelect={(worksheetId) => {
              session.updateDocument((current) => setActiveWorksheet(current, worksheetId));
              setSelection(createSelection({ row: 0, column: 0 }));
            }}
            onAdd={() => guard(() => session.updateDocument((current) => addWorksheet(current)))}
            onRename={(worksheetId, name) => guard(
              () => session.updateDocument((current) => renameWorksheet(current, worksheetId, name)),
            )}
            onDuplicate={(worksheetId) => guard(
              () => session.updateDocument((current) => duplicateWorksheet(current, worksheetId)),
            )}
            onDelete={(worksheetId) => guard(
              () => session.updateDocument((current) => removeWorksheet(current, worksheetId)),
            )}
            onReorder={(worksheetId, toIndex) => guard(
              () => session.updateDocument((current) => reorderWorksheet(current, worksheetId, toIndex)),
            )}
            onToggleHidden={(worksheetId, hidden) => guard(
              () => session.updateDocument((current) => setWorksheetHidden(current, worksheetId, hidden)),
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
          </div>
        </>
      )}
    </div>
  );
}
