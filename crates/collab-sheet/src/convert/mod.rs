//! Bounded `.xlsx` and `.csv` conversion for `.sheet` workbooks.
//!
//! Phase 10 of the Advanced Tables plan. `.sheet` stays the only editable and
//! authoritative workbook format: these functions convert *into* a new `.sheet`
//! document, or produce a separate exported copy. Nothing here ever makes an
//! external format the backing model of an open document.
//!
//! The conversion is first-party on purpose. Reading `.xlsx` means unpacking an
//! untrusted ZIP of untrusted XML, so the traversal, entry-count, per-entry, and
//! total-expansion bounds live in this crate rather than inside a third-party
//! reader we do not control. The only dependencies are the `zip` and `quick-xml`
//! codecs already used elsewhere in the workspace.
//!
//! Every conversion returns a [`ConversionReport`]. A feature that could not be
//! carried across is reported as flattened, skipped, or unsupported — never
//! silently dropped, and never described as compatible when it is not.

mod csv;
mod model;
mod report;
mod sheet_json;
mod xlsx_read;
mod xlsx_write;

pub use csv::{
    detect_csv_dialect, export_csv, import_csv, CsvExportOptions, CsvImportOptions, CsvQuoting,
};
pub use model::{
    ConvertedBorders, ConvertedCell, ConvertedNumberFormat, ConvertedRange, ConvertedStyle,
    ConvertedValue, ConvertedWorkbook, ConvertedWorksheet,
};
pub use report::{ConversionNote, ConversionReport, ConversionSeverity};
pub use sheet_json::{
    sheet_document_to_workbook, workbook_to_sheet_document, SHEET_DOCUMENT_KIND,
    SHEET_SCHEMA_VERSION,
};
pub use xlsx_read::import_xlsx;
pub use xlsx_write::export_xlsx;

/// Bounds every conversion runs under.
///
/// The workbook limits mirror `SHEET_LIMITS` in `src/types/sheet.ts` and
/// `DEFAULT_SHEET_LIMITS` in `collab-documents`; keep all three in sync. The
/// archive limits exist only here, because only this crate unpacks a `.xlsx`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConversionLimits {
    pub worksheets: usize,
    pub rows_per_worksheet: usize,
    pub columns_per_worksheet: usize,
    pub cells_per_worksheet: usize,
    pub cells_per_workbook: usize,
    pub formula_cells: usize,
    pub formula_source_length: usize,
    pub cell_text_length: usize,
    pub worksheet_name_length: usize,
    pub styles: usize,
    pub merged_ranges_per_worksheet: usize,
    /// Compressed archive bytes accepted for a `.xlsx` import.
    pub source_bytes: usize,
    /// Total uncompressed bytes read out of a `.xlsx`, across all entries.
    pub expanded_bytes: usize,
    /// Uncompressed bytes accepted from any single archive entry.
    pub entry_bytes: usize,
    /// Entries an archive may contain before it is rejected outright.
    pub archive_entries: usize,
}

pub const DEFAULT_CONVERSION_LIMITS: ConversionLimits = ConversionLimits {
    worksheets: 200,
    rows_per_worksheet: 1_000_000,
    columns_per_worksheet: 16_384,
    cells_per_worksheet: 500_000,
    cells_per_workbook: 1_000_000,
    formula_cells: 200_000,
    formula_source_length: 8_192,
    cell_text_length: 32_768,
    worksheet_name_length: 64,
    styles: 10_000,
    merged_ranges_per_worksheet: 10_000,
    source_bytes: 64 * 1024 * 1024,
    expanded_bytes: 512 * 1024 * 1024,
    entry_bytes: 128 * 1024 * 1024,
    archive_entries: 4_096,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConversionError {
    #[error("the file is not a readable .xlsx workbook: {0}")]
    NotAWorkbook(String),
    #[error("the workbook is malformed: {0}")]
    Malformed(String),
    #[error("the file is too large to convert ({limit} byte limit)")]
    TooLarge { limit: usize },
    #[error("the workbook exceeds a Collab limit: {0}")]
    LimitExceeded(String),
    #[error("the text could not be decoded; only UTF-8, UTF-16, and Latin-1 are supported")]
    Undecodable,
    #[error("the workbook is not a valid Collab workbook: {0}")]
    InvalidSheetDocument(String),
    #[error("this workbook cannot be converted: {0}")]
    Refused(String),
}

pub type ConversionResult<T> = Result<T, ConversionError>;

/// A conversion outcome: the converted payload plus what happened to it.
#[derive(Debug, Clone, PartialEq)]
pub struct Converted<T> {
    pub value: T,
    pub report: ConversionReport,
}

/// The largest column index expressible in A1 notation within our limits.
pub(crate) fn column_label(index: usize) -> String {
    let mut label = String::new();
    let mut current = index + 1;
    while current > 0 {
        let remainder = (current - 1) % 26;
        label.insert(0, (b'A' + remainder as u8) as char);
        current = (current - 1) / 26;
    }
    label
}

/// Parses an A1 cell reference into zero-based `(row, column)`.
pub(crate) fn parse_a1(reference: &str) -> Option<(usize, usize)> {
    let mut column = 0usize;
    let mut row = 0usize;
    let mut seen_digit = false;
    for character in reference.chars() {
        if character == '$' {
            continue;
        }
        if character.is_ascii_alphabetic() {
            if seen_digit {
                return None;
            }
            column = column
                .checked_mul(26)?
                .checked_add((character.to_ascii_uppercase() as u8 - b'A' + 1) as usize)?;
        } else if character.is_ascii_digit() {
            seen_digit = true;
            row = row
                .checked_mul(10)?
                .checked_add(character as usize - '0' as usize)?;
        } else {
            return None;
        }
    }
    if column == 0 || row == 0 {
        return None;
    }
    Some((row - 1, column - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_labels_round_trip() {
        for index in [0usize, 1, 25, 26, 27, 51, 52, 701, 702, 16_383] {
            let label = column_label(index);
            assert_eq!(parse_a1(&format!("{label}1")), Some((0, index)), "{label}");
        }
    }

    #[test]
    fn rejects_malformed_references() {
        assert_eq!(parse_a1("A"), None);
        assert_eq!(parse_a1("1"), None);
        assert_eq!(parse_a1("1A"), None);
        assert_eq!(parse_a1("A1B"), None);
        assert_eq!(parse_a1(""), None);
    }

    #[test]
    fn accepts_absolute_references() {
        assert_eq!(parse_a1("$B$3"), Some((2, 1)));
    }
}
