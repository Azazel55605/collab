import { describe, expect, it } from 'vitest';

import type { SheetConversionReport } from './sheetConversion';
import {
  groupConversionNotes,
  isLosslessConversion,
  isSheetConvertibleFile,
} from './sheetConversion';

function report(
  ...notes: { severity: SheetConversionReport['notes'][number]['severity']; feature: string }[]
): SheetConversionReport {
  return {
    notes: notes.map((note) => ({ ...note, detail: 'detail', count: 1 })),
    truncated: false,
  };
}

describe('isSheetConvertibleFile', () => {
  it('accepts the spreadsheet formats that are converted, not stored', () => {
    for (const name of ['Budget.xlsx', 'Budget.XLSM', 'data.csv', 'data.tsv']) {
      expect(isSheetConvertibleFile(name), name).toBe(true);
    }
  });

  it('rejects everything else, including .sheet itself', () => {
    // `.sheet` is stored directly; routing it through the converter would
    // rebuild identities that are supposed to stay stable.
    for (const name of ['Budget.sheet', 'notes.md', 'image.png', 'archive', 'x.xls']) {
      expect(isSheetConvertibleFile(name), name).toBe(false);
    }
  });
});

describe('isLosslessConversion', () => {
  it('is true only when every note is an imported one', () => {
    expect(isLosslessConversion(report({ severity: 'imported', feature: 'Worksheets' }))).toBe(
      true,
    );
    expect(
      isLosslessConversion(
        report({ severity: 'imported', feature: 'A' }, { severity: 'skipped', feature: 'B' }),
      ),
    ).toBe(false);
  });

  it('is false when content was dropped for hitting a limit', () => {
    const truncated: SheetConversionReport = {
      ...report({ severity: 'imported', feature: 'Rows' }),
      truncated: true,
    };
    expect(isLosslessConversion(truncated)).toBe(false);
  });
});

describe('groupConversionNotes', () => {
  it('puts the most consequential severities first', () => {
    const grouped = groupConversionNotes(
      report(
        { severity: 'imported', feature: 'Worksheets' },
        { severity: 'skipped', feature: 'Charts' },
        { severity: 'unsupported', feature: 'Formula function' },
        { severity: 'flattened', feature: 'Array formulas' },
      ),
    );
    expect(grouped.map((group) => group.severity)).toEqual([
      'unsupported',
      'skipped',
      'flattened',
      'imported',
    ]);
  });

  it('omits severities with nothing in them', () => {
    const grouped = groupConversionNotes(report({ severity: 'imported', feature: 'Worksheets' }));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].notes).toHaveLength(1);
  });
});
