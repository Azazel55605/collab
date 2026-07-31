//! The Collab-owned intermediate model both conversion directions share.
//!
//! Neither `.xlsx` structures nor `.sheet` JSON appear on the other side of a
//! conversion: a reader produces this model and a writer consumes it. That is
//! what keeps an external format from leaking into the schema, and what lets
//! import and export be tested against each other semantically.

use std::collections::BTreeMap;

/// A rectangle in zero-based, inclusive grid coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConvertedRange {
    pub top: usize,
    pub left: usize,
    pub bottom: usize,
    pub right: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConvertedValue {
    Blank,
    Number(f64),
    Text(String),
    Boolean(bool),
    /// A spreadsheet error code such as `#REF!`, carried through as an error.
    Error(String),
    /// ISO-8601 date, time, or datetime. `.sheet` never stores serial numbers.
    Date(String),
    Time(String),
    DateTime(String),
}

impl ConvertedValue {
    pub fn is_blank(&self) -> bool {
        matches!(self, ConvertedValue::Blank)
    }
}

/// Mirrors `SheetNumberFormat` in `src/types/sheet.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConvertedNumberFormat {
    /// One of `general`, `number`, `percent`, `currency`, `date`, `time`,
    /// `datetime`, `text`, `custom`.
    pub kind: String,
    pub decimals: Option<u32>,
    pub use_thousands_separator: bool,
    pub currency_code: Option<String>,
    /// Declarative pattern for `kind: "custom"`. Never evaluated.
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConvertedBorders {
    pub top: bool,
    pub right: bool,
    pub bottom: bool,
    pub left: bool,
}

impl ConvertedBorders {
    pub fn any(&self) -> bool {
        self.top || self.right || self.bottom || self.left
    }
}

/// Mirrors the subset of `SheetStyle` that survives a conversion in both
/// directions. Anything outside this is reported rather than guessed at.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConvertedStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub font_size: Option<f64>,
    pub font_family: Option<String>,
    /// `#rrggbb`.
    pub color: Option<String>,
    pub background_color: Option<String>,
    /// `left`, `center`, or `right`.
    pub horizontal_align: Option<String>,
    /// `top`, `middle`, or `bottom`.
    pub vertical_align: Option<String>,
    pub wrap: bool,
    pub indent: Option<u32>,
    pub borders: ConvertedBorders,
    pub number_format: Option<ConvertedNumberFormat>,
}

impl ConvertedStyle {
    pub fn is_empty(&self) -> bool {
        *self == ConvertedStyle::default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedCell {
    pub row: usize,
    pub column: usize,
    pub value: ConvertedValue,
    /// Formula source including the leading `=`, when the cell has one.
    pub formula: Option<String>,
    pub style: Option<ConvertedStyle>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConvertedWorksheet {
    pub name: String,
    pub hidden: bool,
    /// Logical grid size. At least large enough to contain every cell.
    pub row_count: usize,
    pub column_count: usize,
    /// Sparse, sorted row-major.
    pub cells: Vec<ConvertedCell>,
    /// Explicit sizes only, keyed by zero-based index.
    pub column_widths: BTreeMap<usize, f64>,
    pub row_heights: BTreeMap<usize, f64>,
    pub merges: Vec<ConvertedRange>,
    pub frozen_rows: usize,
    pub frozen_columns: usize,
}

impl ConvertedWorksheet {
    pub fn cell_at(&self, row: usize, column: usize) -> Option<&ConvertedCell> {
        self.cells
            .iter()
            .find(|cell| cell.row == row && cell.column == column)
    }

    /// Grows the logical grid so it contains `(row, column)`.
    pub fn ensure_extent(&mut self, row: usize, column: usize) {
        self.row_count = self.row_count.max(row + 1);
        self.column_count = self.column_count.max(column + 1);
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConvertedWorkbook {
    pub name: String,
    pub worksheets: Vec<ConvertedWorksheet>,
}

impl ConvertedWorkbook {
    pub fn populated_cells(&self) -> usize {
        self.worksheets.iter().map(|sheet| sheet.cells.len()).sum()
    }

    pub fn formula_cells(&self) -> usize {
        self.worksheets
            .iter()
            .flat_map(|sheet| sheet.cells.iter())
            .filter(|cell| cell.formula.is_some())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extent_grows_to_contain_a_cell() {
        let mut worksheet = ConvertedWorksheet::default();
        worksheet.ensure_extent(4, 2);
        assert_eq!((worksheet.row_count, worksheet.column_count), (5, 3));
        worksheet.ensure_extent(1, 1);
        assert_eq!((worksheet.row_count, worksheet.column_count), (5, 3));
    }

    #[test]
    fn an_empty_style_is_not_written_out() {
        assert!(ConvertedStyle::default().is_empty());
        assert!(!ConvertedStyle {
            bold: true,
            ..Default::default()
        }
        .is_empty());
    }
}
