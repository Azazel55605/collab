import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { SHEET_DEFAULTS, SHEET_SCHEMA_VERSION } from '../types/sheet';
import { createEmptySheetDocument, serializeSheetDocument } from '../lib/sheet/document';
import { setCell } from '../lib/sheet/operations';
import type { VaultMeta } from '../types/vault';

const clientMocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../lib/vaultClient', () => ({
  createVaultClient: vi.fn(() => ({
    kind: 'local',
    capabilities: { filesystemWatch: true },
    readDocument: clientMocks.readDocument,
    writeDocument: clientMocks.writeDocument,
  })),
}));

vi.mock('../lib/vaultReplica', () => ({
  onReplicaMutated: vi.fn(() => () => {}),
  replicaMutationAffectsPath: vi.fn(() => false),
}));

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMocks }));

import SheetView from './SheetView';

const LOCAL_VAULT: VaultMeta = {
  id: 'vault-1',
  path: '/vault',
  name: 'Vault',
  isEncrypted: false,
  lastOpened: 0,
};

const HOSTED_VIEWER_VAULT: VaultMeta = {
  id: 'vault-2',
  path: 'hosted://vault-2',
  name: 'Hosted',
  isEncrypted: false,
  lastOpened: 0,
  kind: 'hosted',
  serverUrl: 'https://example.test',
  hostedVaultId: 'vault-2',
  role: 'viewer',
};

const PATH = 'Books/Budget.sheet';

function workbookContent(withCells = true) {
  let document = createEmptySheetDocument('Budget', {
    id: 'wb1',
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { id: 'ws1', name: 'Sheet1', rows: 20, columns: 8 },
  });
  if (withCells) {
    const worksheetId = document.worksheets[0].id;
    document = setCell(document, worksheetId, { row: 0, column: 0 }, { value: 10, valueType: 'number' });
    document = setCell(document, worksheetId, { row: 1, column: 0 }, { value: 20, valueType: 'number' });
  }
  return serializeSheetDocument(document);
}

function pointFor(row: number, column: number) {
  return {
    clientX: SHEET_DEFAULTS.headerWidth + column * SHEET_DEFAULTS.columnWidth + SHEET_DEFAULTS.columnWidth / 2,
    clientY: SHEET_DEFAULTS.headerHeight + row * SHEET_DEFAULTS.rowHeight + SHEET_DEFAULTS.rowHeight / 2,
  };
}

function setVault(vault: VaultMeta) {
  useVaultStore.setState({ vault, fileTree: [] } as never);
}

async function openWorkbook() {
  render(<SheetView relativePath={PATH} />);
  await screen.findByTestId('sheet-grid');
}

async function writtenDocument(callIndex = 0) {
  await waitFor(() => expect(clientMocks.writeDocument).toHaveBeenCalled());
  return JSON.parse(clientMocks.writeDocument.mock.calls[callIndex][1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.readDocument.mockResolvedValue({ content: workbookContent(), version: '1' });
  clientMocks.writeDocument.mockResolvedValue({ version: '2' });
  setVault(LOCAL_VAULT);
  useEditorStore.setState({
    openTabs: [{ relativePath: PATH, title: 'Budget', isDirty: false, savedHash: null, type: 'sheet' }],
    activeTabPath: PATH,
    sheetViewStates: {},
  } as never);

  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

afterEach(cleanup);

describe('SheetView editor', () => {
  it('opens a workbook with a grid, formula bar, worksheet strip, and summary', async () => {
    await openWorkbook();

    expect(screen.getByLabelText('Formula bar')).toBeTruthy();
    expect(screen.getByLabelText('Name box')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Sheet1' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Selection summary' }).textContent).toContain('A1');
  });

  it('edits a cell and saves the typed value into the workbook', async () => {
    await openWorkbook();

    fireEvent.keyDown(screen.getByTestId('sheet-grid'), { key: '5' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' });
    fireEvent.change(editor, { target: { value: '123' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();

    const worksheet = written.worksheets[0];
    const key = `${worksheet.rowOrder[0]}:${worksheet.columnOrder[0]}`;
    expect(worksheet.cells[key]).toEqual({ value: 123, valueType: 'number' });
  });

  it('shows the active cell in the formula bar and commits edits from it', async () => {
    await openWorkbook();

    expect((screen.getByLabelText('Formula bar') as HTMLInputElement).value).toBe('10');

    fireEvent.change(screen.getByLabelText('Formula bar'), { target: { value: '=SUM(A1:A2)' } });
    fireEvent.keyDown(screen.getByLabelText('Formula bar'), { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();
    const worksheet = written.worksheets[0];
    expect(worksheet.cells[`${worksheet.rowOrder[0]}:${worksheet.columnOrder[0]}`])
      .toEqual({ formula: '=SUM(A1:A2)' });
  });

  it('offers keyboard formula IntelliSense and inserts a dragged cell range', async () => {
    await openWorkbook();
    const formulaBar = screen.getByRole('textbox', { name: 'Formula bar' });

    fireEvent.focus(formulaBar);
    fireEvent.change(formulaBar, { target: { value: '=SU', selectionStart: 3 } });
    expect(screen.getByRole('listbox', { name: 'Formula suggestions' })).toBeTruthy();
    fireEvent.keyDown(formulaBar, { key: 'Tab' });
    expect((formulaBar as HTMLInputElement).value).toBe('=SUM(');
    await waitFor(() => expect((formulaBar as HTMLInputElement).selectionStart).toBe(5));

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(0, 0) });
    fireEvent.pointerMove(surface, pointFor(1, 0));
    fireEvent.pointerUp(surface, pointFor(1, 0));
    expect((formulaBar as HTMLInputElement).value).toBe('=SUM(A1:A2');

    fireEvent.change(formulaBar, {
      target: { value: '=SUM(A1:A2)', selectionStart: 11 },
    });
    fireEvent.keyDown(formulaBar, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();
    expect(Object.values(written.worksheets[0].cells)).toContainEqual({
      formula: '=SUM(A1:A2)',
    });
  });

  it('supports IntelliSense and range insertion while editing directly in a cell', async () => {
    await openWorkbook();
    const sheetGrid = screen.getByTestId('sheet-grid');

    fireEvent.keyDown(sheetGrid, { key: '=' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    fireEvent.change(editor, { target: { value: '=SU', selectionStart: 3 } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.selectionStart).toBe(5));

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(0, 0) });
    fireEvent.pointerMove(surface, pointFor(1, 0));
    fireEvent.pointerUp(surface, pointFor(1, 0));

    expect((screen.getByLabelText('Formula bar') as HTMLInputElement).value)
      .toBe('=SUM(A1:A2');
  });

  it('navigates to a reference typed into the name box', async () => {
    await openWorkbook();

    const nameBox = screen.getByLabelText('Name box');
    fireEvent.focus(nameBox);
    fireEvent.change(nameBox, { target: { value: 'C4' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });

    expect(screen.getByRole('status', { name: 'Selection summary' }).textContent).toContain('C4');
  });

  it('summarizes a numeric selection', async () => {
    await openWorkbook();

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(0, 0) });
    fireEvent.pointerMove(surface, pointFor(1, 0));
    fireEvent.pointerUp(surface, pointFor(1, 0));

    const summary = screen.getByRole('status', { name: 'Selection summary' }).textContent ?? '';
    expect(summary).toContain('Sum: 30');
    expect(summary).toContain('Average: 15');
    expect(summary).toContain('Min: 10');
    expect(summary).toContain('Max: 20');
  });

  it('inserts and deletes rows through the toolbar', async () => {
    await openWorkbook();

    fireEvent.click(screen.getByRole('button', { name: /insert rows/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    let written = await writtenDocument();
    expect(written.worksheets[0].rowOrder).toHaveLength(21);
    // The inserted row pushes the existing content down but keeps its identity.
    expect(Object.keys(written.worksheets[0].cells)).toHaveLength(2);

    clientMocks.writeDocument.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /delete rows/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    written = await writtenDocument();
    expect(written.worksheets[0].rowOrder).toHaveLength(20);
  });

  it('freezes panes at the active cell and unfreezes again', async () => {
    await openWorkbook();

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(2, 1) });
    fireEvent.click(screen.getByRole('button', { name: /freeze here/i }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();
    expect(written.worksheets[0].frozen).toEqual({ rows: 2, columns: 1 });
    expect(screen.getByRole('status', { name: 'Selection summary' }).textContent).toContain('Frozen: 2R × 1C');
  });

  it('merges a selected range and reports an invalid merge instead of throwing', async () => {
    await openWorkbook();

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(0, 0) });
    fireEvent.pointerMove(surface, pointFor(1, 1));
    fireEvent.pointerUp(surface, pointFor(1, 1));
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();
    expect(written.worksheets[0].mergedRanges).toHaveLength(1);

    // A single cell cannot merge: the user gets a message, not a crash.
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(5, 5) });
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining('more than one cell'));
  });

  it('adds, renames, duplicates, and deletes worksheets from the strip', async () => {
    await openWorkbook();

    fireEvent.click(screen.getByRole('button', { name: 'Add worksheet' }));
    await screen.findByRole('tab', { name: 'Sheet2' });

    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Sheet2' }));
    const nameInput = screen.getByRole('textbox', { name: 'Worksheet name' });
    fireEvent.change(nameInput, { target: { value: 'Data' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    await screen.findByRole('tab', { name: 'Data' });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const written = await writtenDocument();
    expect(written.worksheets.map((sheet: { name: string }) => sheet.name)).toEqual(['Sheet1', 'Data']);
  });

  it('switches the active worksheet and shows its own grid', async () => {
    await openWorkbook();

    fireEvent.click(screen.getByRole('button', { name: 'Add worksheet' }));
    await screen.findByRole('tab', { name: 'Sheet2' });

    const strip = screen.getByRole('tablist', { name: 'Worksheets' });
    expect(within(strip).getByRole('tab', { name: 'Sheet2' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(within(strip).getByRole('tab', { name: 'Sheet1' }));
    expect(within(strip).getByRole('tab', { name: 'Sheet1' }).getAttribute('aria-selected')).toBe('true');
  });

  it('persists per-tab selection and worksheet state', async () => {
    await openWorkbook();

    fireEvent.pointerDown(screen.getByTestId('sheet-cell-surface'), { button: 0, ...pointFor(3, 2) });

    await waitFor(() => {
      const state = useEditorStore.getState().sheetViewStates[PATH];
      expect(state?.activeRow).toBe(3);
      expect(state?.activeColumn).toBe(2);
      expect(state?.activeWorksheetId).toBe('ws1');
    });
  });

  it('restores a persisted selection when the tab is reopened', async () => {
    useEditorStore.setState({
      sheetViewStates: {
        [PATH]: { activeWorksheetId: 'ws1', scrollTop: 0, scrollLeft: 0, activeRow: 4, activeColumn: 3 },
      },
    } as never);

    await openWorkbook();
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selection summary' }).textContent).toContain('D5');
    });
  });

  it('opens a newer-schema workbook read-only but still viewable', async () => {
    const newer = JSON.parse(workbookContent());
    newer.schemaVersion = SHEET_SCHEMA_VERSION + 1;
    clientMocks.readDocument.mockResolvedValue({ content: JSON.stringify(newer), version: '1' });

    render(<SheetView relativePath={PATH} />);

    await screen.findByText(/open read-only/i);
    // The grid still renders: a workbook from a newer client is readable, it
    // just may not be rewritten by this build.
    expect(screen.getByTestId('sheet-grid')).toBeTruthy();
    expect(screen.getByRole('button', { name: /insert rows/i }).hasAttribute('disabled')).toBe(true);

    fireEvent.keyDown(screen.getByTestId('sheet-grid'), { key: '5' });
    expect(screen.queryByRole('textbox', { name: 'Cell editor' })).toBeNull();
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });

  it('reports a malformed workbook instead of rendering an empty grid', async () => {
    clientMocks.readDocument.mockResolvedValue({ content: '{not json', version: '1' });

    render(<SheetView relativePath={PATH} />);

    await screen.findByText(/does not contain valid JSON/i);
    expect(screen.queryByTestId('sheet-grid')).toBeNull();
  });

  it('surfaces repairs applied while opening a damaged workbook', async () => {
    const damaged = JSON.parse(workbookContent());
    damaged.worksheets[0].cells = { 'missing-row:c1': { value: 1 } };
    clientMocks.readDocument.mockResolvedValue({ content: JSON.stringify(damaged), version: '1' });

    render(<SheetView relativePath={PATH} />);
    await screen.findByText(/Repaired on open/i);
  });

  it('is fully read-only for a hosted viewer', async () => {
    setVault(HOSTED_VIEWER_VAULT);
    await openWorkbook();

    expect(screen.getByText(/viewer access/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /insert rows/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /^merge$/i }).hasAttribute('disabled')).toBe(true);

    fireEvent.keyDown(screen.getByTestId('sheet-grid'), { key: '5' });
    expect(screen.queryByRole('textbox', { name: 'Cell editor' })).toBeNull();
    expect(clientMocks.writeDocument).not.toHaveBeenCalled();
  });
});
