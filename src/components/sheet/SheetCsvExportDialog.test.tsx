import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptySheetDocument, addWorksheet } from '../../lib/sheet/document';
import SheetCsvExportDialog from './SheetCsvExportDialog';

function documentWith(worksheets: number) {
  let document = createEmptySheetDocument('Budget', {
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { name: 'Q1', rows: 10, columns: 5 },
  });
  for (let index = 1; index < worksheets; index += 1) {
    document = addWorksheet(document, `Q${index + 1}`);
  }
  return document;
}

function renderDialog(overrides: Partial<Parameters<typeof SheetCsvExportDialog>[0]> = {}) {
  const onExport = vi.fn();
  const document = overrides.document ?? documentWith(1);
  render(
    <SheetCsvExportDialog
      open
      onOpenChange={() => {}}
      document={document}
      activeWorksheetId={document?.worksheets[0].id}
      selectionRange={null}
      selectionLabel="A1:B2"
      onExport={onExport}
      {...overrides}
    />,
  );
  return { onExport, document };
}

afterEach(cleanup);

describe('CSV export options', () => {
  it('exports the active worksheet with safe defaults', () => {
    const { onExport, document } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(onExport).toHaveBeenCalledWith({
      worksheetId: document.worksheets[0].id,
      range: undefined,
      delimiter: ',',
      includeFormulas: false,
      // Injection protection is on unless the user deliberately turns it off.
      sanitizeFormulas: true,
    });
  });

  it('says how many worksheets will not be written', () => {
    // CSV has no workbook model, so the user is told before the export, not
    // only afterwards in the report.
    renderDialog({ document: documentWith(3) });
    expect(screen.getByTestId('csv-worksheets-left-out').textContent)
      .toBe('2 other worksheets will not be written.');
  });

  it('does not mention other worksheets for a single-worksheet workbook', () => {
    renderDialog();
    expect(screen.queryByTestId('csv-worksheets-left-out')).toBeNull();
  });

  it('offers the selected range only when more than one cell is selected', () => {
    renderDialog();
    expect(screen.queryByText('Cells')).toBeNull();

    cleanup();
    renderDialog({ selectionRange: { top: 0, left: 0, bottom: 1, right: 1 } });
    expect(screen.getByText('Cells')).not.toBeNull();
  });

  it('exports the selected range when it is chosen', () => {
    const range = { top: 1, left: 2, bottom: 4, right: 3 };
    const { onExport } = renderDialog({ selectionRange: range });

    fireEvent.click(screen.getByText('Whole worksheet'));
    fireEvent.click(screen.getByText('Selected range (A1:B2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ range }));
  });

  it('warns before allowing fields a spreadsheet would execute', () => {
    const { onExport } = renderDialog();

    expect(screen.queryByTestId('csv-injection-warning')).toBeNull();
    fireEvent.click(screen.getByLabelText('Allow fields a spreadsheet will execute'));
    expect(screen.getByTestId('csv-injection-warning')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ sanitizeFormulas: false }));
  });

  it('keeps writing formula source an explicit choice', () => {
    const { onExport } = renderDialog();
    fireEvent.click(screen.getByLabelText('Write formula source instead of values'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ includeFormulas: true }));
  });
});
