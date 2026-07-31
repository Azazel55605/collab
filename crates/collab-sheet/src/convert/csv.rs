//! Conservative CSV import and export.
//!
//! CSV has no workbook model, so an import always produces exactly one
//! worksheet and an export always writes exactly one worksheet or range. Type
//! inference is opt-in and deliberately narrow: a value only stops being text
//! when it is unambiguously something else, because guessing wrong silently
//! changes the user's data.

use std::collections::BTreeMap;

use super::model::{ConvertedCell, ConvertedValue, ConvertedWorkbook, ConvertedWorksheet};
use super::report::ConversionReport;
use super::{ConversionError, ConversionLimits, ConversionResult, Converted};

/// Delimiters sniffed, in preference order.
const CANDIDATE_DELIMITERS: [char; 4] = [',', ';', '\t', '|'];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsvQuoting {
    /// Quote only fields that need it.
    Minimal,
    /// Quote every field.
    Always,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CsvImportOptions {
    /// `None` sniffs the delimiter from the first lines.
    pub delimiter: Option<char>,
    /// Convert unambiguous numbers, booleans, and ISO dates to typed values.
    pub infer_types: bool,
    /// Treat the first row as a header row. Purely informational for CSV — the
    /// row is still imported as cells — but it drives the frozen-row hint.
    pub has_header_row: bool,
    pub worksheet_name: String,
}

impl Default for CsvImportOptions {
    fn default() -> Self {
        Self {
            delimiter: None,
            infer_types: true,
            has_header_row: true,
            worksheet_name: "Sheet1".into(),
        }
    }
}

/// Decodes CSV bytes, honoring a UTF-8 or UTF-16 byte-order mark.
///
/// Without a BOM the bytes are read as UTF-8 and, only if that fails, as
/// Latin-1 — the two encodings that actually appear in exported CSV. Anything
/// else is rejected rather than mojibaked into the user's vault.
fn decode(bytes: &[u8]) -> ConversionResult<String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec()).map_err(|_| ConversionError::Undecodable);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let little_endian = bytes[0] == 0xFF;
        let body = &bytes[2..];
        if body.len() % 2 != 0 {
            return Err(ConversionError::Undecodable);
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        return String::from_utf16(&units).map_err(|_| ConversionError::Undecodable);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        // Latin-1 maps every byte to a code point, so this cannot fail — which
        // is exactly why it is the last resort and never the first guess.
        Err(_) => Ok(bytes.iter().map(|byte| *byte as char).collect()),
    }
}

/// Picks the delimiter that yields the most consistent field count.
pub fn detect_csv_dialect(text: &str) -> char {
    let sample: Vec<&str> = text.lines().take(20).filter(|line| !line.is_empty()).collect();
    if sample.is_empty() {
        return ',';
    }

    let mut best = (',', 0usize, usize::MAX);
    for delimiter in CANDIDATE_DELIMITERS {
        let counts: Vec<usize> = sample
            .iter()
            .map(|line| split_record(line, delimiter).len())
            .collect();
        let fields = *counts.iter().max().unwrap_or(&0);
        if fields < 2 {
            continue;
        }
        // Prefer more columns, then the most consistent row shape.
        let spread = counts.iter().map(|count| fields - count).sum::<usize>();
        if fields > best.1 || (fields == best.1 && spread < best.2) {
            best = (delimiter, fields, spread);
        }
    }
    best.0
}

/// Splits one already-unquoted-newline-free record. Used only for sniffing.
fn split_record(line: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    current.push('"');
                    characters.next();
                } else {
                    quoted = false;
                }
            } else {
                current.push(character);
            }
        } else if character == '"' && current.is_empty() {
            quoted = true;
        } else if character == delimiter {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    fields.push(current);
    fields
}

/// Full RFC 4180-style parse, including quoted fields containing newlines.
fn parse_records(text: &str, delimiter: char, limits: &ConversionLimits) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = text.chars().peekable();

    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    field.push('"');
                    characters.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }

        match character {
            '"' if field.is_empty() => quoted = true,
            character if character == delimiter => record.push(std::mem::take(&mut field)),
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            character => field.push(character),
        }

        if records.len() >= limits.rows_per_worksheet {
            return records;
        }
    }

    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    // A trailing newline produces one empty record; it is not a row of data.
    if records
        .last()
        .is_some_and(|record| record.len() == 1 && record[0].is_empty())
    {
        records.pop();
    }
    records
}

/// Converts one field to a typed value. Only unambiguous forms are converted.
fn infer(text: &str) -> ConvertedValue {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return ConvertedValue::Blank;
    }
    // A leading zero or a leading `+` usually means an identifier — a postal
    // code, a phone number, an account number — not a number to do maths on.
    let numeric_candidate = !(trimmed.len() > 1 && trimmed.starts_with('0') && !trimmed.starts_with("0."))
        && !trimmed.starts_with('+');
    if numeric_candidate {
        if let Ok(number) = trimmed.parse::<f64>() {
            if number.is_finite() {
                return ConvertedValue::Number(number);
            }
        }
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => return ConvertedValue::Boolean(true),
        "false" => return ConvertedValue::Boolean(false),
        _ => {}
    }
    if is_iso_date(trimmed) {
        return ConvertedValue::Date(trimmed.to_string());
    }
    if is_iso_datetime(trimmed) {
        return ConvertedValue::DateTime(trimmed.to_string());
    }
    ConvertedValue::Text(text.to_string())
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn is_iso_datetime(value: &str) -> bool {
    value.len() >= 16
        && value.as_bytes()[10] == b'T'
        && is_iso_date(&value[..10])
        && value[11..].chars().all(|c| c.is_ascii_digit() || matches!(c, ':' | '.' | 'Z' | '+' | '-'))
}

pub fn import_csv(
    bytes: &[u8],
    options: &CsvImportOptions,
    limits: &ConversionLimits,
) -> ConversionResult<Converted<ConvertedWorkbook>> {
    if bytes.len() > limits.source_bytes {
        return Err(ConversionError::TooLarge {
            limit: limits.source_bytes,
        });
    }

    let mut report = ConversionReport::default();
    let text = decode(bytes)?;
    let delimiter = options.delimiter.unwrap_or_else(|| detect_csv_dialect(&text));
    let records = parse_records(&text, delimiter, limits);

    if records.is_empty() {
        return Err(ConversionError::Malformed("the file contains no rows".into()));
    }
    if records.len() >= limits.rows_per_worksheet {
        report.truncated = true;
        report.skipped(
            "Rows",
            format!(
                "Stopped at the {} row limit; later rows were not imported.",
                limits.rows_per_worksheet
            ),
            None,
        );
    }

    let column_count = records.iter().map(Vec::len).max().unwrap_or(1);
    if column_count > limits.columns_per_worksheet {
        return Err(ConversionError::LimitExceeded(format!(
            "a worksheet may not have more than {} columns",
            limits.columns_per_worksheet
        )));
    }

    let mut cells = Vec::new();
    let mut truncated_text = 0usize;
    for (row, record) in records.iter().enumerate() {
        for (column, field) in record.iter().enumerate() {
            if field.is_empty() {
                continue;
            }
            let mut field = field.clone();
            if field.len() > limits.cell_text_length {
                field.truncate(limits.cell_text_length);
                truncated_text += 1;
            }
            let value = if options.infer_types {
                infer(&field)
            } else {
                ConvertedValue::Text(field)
            };
            if value.is_blank() {
                continue;
            }
            if cells.len() >= limits.cells_per_worksheet {
                report.truncated = true;
                break;
            }
            cells.push(ConvertedCell {
                row,
                column,
                value,
                formula: None,
                style: None,
            });
        }
    }

    if truncated_text > 0 {
        report.truncated = true;
        report.flattened(
            "Cell text",
            format!("Truncated {truncated_text} field(s) to the {} character cell limit.", limits.cell_text_length),
            None,
        );
    }

    report.imported(
        "Rows and columns",
        format!(
            "Imported {} row(s) and {} column(s) with '{}' as the delimiter.",
            records.len(),
            column_count,
            if delimiter == '\t' { "tab".to_string() } else { delimiter.to_string() },
        ),
    );
    if options.infer_types {
        report.imported(
            "Type inference",
            "Unambiguous numbers, booleans, and ISO dates were converted; everything else stayed text.",
        );
    }
    report.skipped(
        "Workbook structure",
        "CSV has no workbook model, so the file became a single worksheet with no formulas, styles, or formatting.",
        None,
    );

    Ok(Converted {
        value: ConvertedWorkbook {
            name: options.worksheet_name.clone(),
            worksheets: vec![ConvertedWorksheet {
                name: options.worksheet_name.clone(),
                hidden: false,
                row_count: records.len().max(1),
                column_count: column_count.max(1),
                cells,
                column_widths: BTreeMap::new(),
                row_heights: BTreeMap::new(),
                merges: Vec::new(),
                frozen_rows: usize::from(options.has_header_row && records.len() > 1),
                frozen_columns: 0,
            }],
        },
        report,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct CsvExportOptions {
    pub delimiter: char,
    pub quoting: CsvQuoting,
    /// Write formula source instead of the evaluated value.
    ///
    /// Off by default. A CSV consumer that opens the file will *execute* a
    /// leading `=`, so exporting formulas is an explicit choice, and even then
    /// the sanitizing prefix below still applies unless the caller also opts
    /// out of it.
    pub include_formulas: bool,
    /// Prefix a field that a consuming spreadsheet would treat as a formula.
    ///
    /// This is the CSV-injection defense. Turning it off is only correct when
    /// the user deliberately wants live formulas in the exported file.
    pub sanitize_formulas: bool,
    /// Restrict the export to this zero-based, inclusive rectangle.
    pub range: Option<super::model::ConvertedRange>,
}

impl Default for CsvExportOptions {
    fn default() -> Self {
        Self {
            delimiter: ',',
            quoting: CsvQuoting::Minimal,
            include_formulas: false,
            sanitize_formulas: true,
            range: None,
        }
    }
}

/// Characters a spreadsheet treats as the start of an executable formula.
const INJECTION_PREFIXES: [char; 5] = ['=', '+', '-', '@', '\t'];

fn render_value(value: &ConvertedValue) -> String {
    match value {
        ConvertedValue::Blank => String::new(),
        ConvertedValue::Number(number) => {
            if number.fract() == 0.0 && number.abs() < 1e15 {
                format!("{}", *number as i64)
            } else {
                format!("{number}")
            }
        }
        ConvertedValue::Boolean(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        ConvertedValue::Text(text) => text.clone(),
        ConvertedValue::Error(code) => code.clone(),
        ConvertedValue::Date(iso) | ConvertedValue::Time(iso) | ConvertedValue::DateTime(iso) => {
            iso.clone()
        }
    }
}

fn escape_field(field: &str, options: &CsvExportOptions) -> String {
    let needs_quotes = options.quoting == CsvQuoting::Always
        || field.contains(options.delimiter)
        || field.contains('"')
        || field.contains('\n')
        || field.contains('\r');
    if needs_quotes {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// Writes one worksheet as CSV.
pub fn export_csv(
    worksheet: &ConvertedWorksheet,
    options: &CsvExportOptions,
) -> Converted<String> {
    let mut report = ConversionReport::default();

    let range = options.range.unwrap_or(super::model::ConvertedRange {
        top: 0,
        left: 0,
        bottom: worksheet.row_count.saturating_sub(1),
        right: worksheet.column_count.saturating_sub(1),
    });

    let mut index: BTreeMap<(usize, usize), &ConvertedCell> = BTreeMap::new();
    for cell in &worksheet.cells {
        index.insert((cell.row, cell.column), cell);
    }

    let mut sanitized = 0usize;
    let mut formulas = 0usize;
    let mut lines = Vec::new();
    for row in range.top..=range.bottom {
        let mut fields = Vec::new();
        for column in range.left..=range.right {
            let cell = index.get(&(row, column));
            let mut field = match cell {
                Some(cell) if cell.formula.is_some() && options.include_formulas => {
                    formulas += 1;
                    cell.formula.clone().unwrap_or_default()
                }
                Some(cell) => {
                    if cell.formula.is_some() {
                        formulas += 1;
                    }
                    render_value(&cell.value)
                }
                None => String::new(),
            };
            if options.sanitize_formulas
                && field.starts_with(INJECTION_PREFIXES)
            {
                // A leading apostrophe is the conventional inert marker: the
                // consuming application shows the text and does not evaluate it.
                field.insert(0, '\'');
                sanitized += 1;
            }
            fields.push(escape_field(&field, options));
        }
        lines.push(fields.join(&options.delimiter.to_string()));
    }

    report.imported(
        "Cells",
        format!(
            "Exported {} row(s) and {} column(s).",
            range.bottom.saturating_sub(range.top) + 1,
            range.right.saturating_sub(range.left) + 1,
        ),
    );
    if formulas > 0 && !options.include_formulas {
        report.flattened(
            "Formulas",
            format!("Wrote the current value of {formulas} formula cell(s); CSV cannot carry the formula and its result together."),
            None,
        );
    } else if formulas > 0 {
        report.flattened(
            "Formulas",
            format!("Wrote the source of {formulas} formula cell(s) instead of their values, at your request."),
            None,
        );
    }
    if sanitized > 0 {
        report.flattened(
            "Formula injection",
            format!("Prefixed {sanitized} field(s) with an apostrophe so a spreadsheet opening this file cannot execute them."),
            None,
        );
    }
    report.skipped(
        "Styles, merges, and structure",
        "CSV carries values only; formatting, merged ranges, frozen panes, charts, and other worksheets were not written.",
        None,
    );

    Converted {
        value: format!("{}\n", lines.join("\n")),
        report,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::DEFAULT_CONVERSION_LIMITS;

    fn import(text: &str) -> ConvertedWorkbook {
        import_csv(
            text.as_bytes(),
            &CsvImportOptions::default(),
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap()
        .value
    }

    #[test]
    fn imports_a_simple_comma_file() {
        let workbook = import("name,amount\nRent,1240\n");
        let worksheet = &workbook.worksheets[0];
        assert_eq!((worksheet.row_count, worksheet.column_count), (2, 2));
        assert_eq!(
            worksheet.cell_at(0, 0).unwrap().value,
            ConvertedValue::Text("name".into())
        );
        assert_eq!(
            worksheet.cell_at(1, 1).unwrap().value,
            ConvertedValue::Number(1240.0)
        );
        assert_eq!(worksheet.frozen_rows, 1);
    }

    #[test]
    fn sniffs_semicolon_and_tab_files() {
        assert_eq!(detect_csv_dialect("a;b;c\n1;2;3\n"), ';');
        assert_eq!(detect_csv_dialect("a\tb\tc\n1\t2\t3\n"), '\t');
        assert_eq!(detect_csv_dialect("a|b\n1|2\n"), '|');
        assert_eq!(detect_csv_dialect("single\ncolumn\n"), ',');
    }

    #[test]
    fn handles_quoted_fields_containing_delimiters_and_newlines() {
        let workbook = import("a,\"b,c\",\"line1\nline2\"\n");
        let worksheet = &workbook.worksheets[0];
        assert_eq!(
            worksheet.cell_at(0, 1).unwrap().value,
            ConvertedValue::Text("b,c".into())
        );
        assert_eq!(
            worksheet.cell_at(0, 2).unwrap().value,
            ConvertedValue::Text("line1\nline2".into())
        );
        assert_eq!(worksheet.row_count, 1);
    }

    #[test]
    fn handles_escaped_quotes_and_crlf() {
        let workbook = import("a,\"say \"\"hi\"\"\"\r\nb,c\r\n");
        assert_eq!(
            workbook.worksheets[0].cell_at(0, 1).unwrap().value,
            ConvertedValue::Text("say \"hi\"".into())
        );
        assert_eq!(workbook.worksheets[0].row_count, 2);
    }

    #[test]
    fn leaves_identifier_shaped_fields_as_text() {
        // Losing the leading zero of a postal code is data corruption, not
        // type inference.
        let workbook = import("zip,phone,plain\n01234,+31201234567,42\n");
        let worksheet = &workbook.worksheets[0];
        assert_eq!(
            worksheet.cell_at(1, 0).unwrap().value,
            ConvertedValue::Text("01234".into())
        );
        assert_eq!(
            worksheet.cell_at(1, 1).unwrap().value,
            ConvertedValue::Text("+31201234567".into())
        );
        assert_eq!(
            worksheet.cell_at(1, 2).unwrap().value,
            ConvertedValue::Number(42.0)
        );
    }

    #[test]
    fn infers_booleans_and_iso_dates() {
        let workbook = import("a,b,c\ntrue,2026-03-04,2026-03-04T10:30:00Z\n");
        let worksheet = &workbook.worksheets[0];
        assert_eq!(
            worksheet.cell_at(1, 0).unwrap().value,
            ConvertedValue::Boolean(true)
        );
        assert_eq!(
            worksheet.cell_at(1, 1).unwrap().value,
            ConvertedValue::Date("2026-03-04".into())
        );
        assert_eq!(
            worksheet.cell_at(1, 2).unwrap().value,
            ConvertedValue::DateTime("2026-03-04T10:30:00Z".into())
        );
    }

    #[test]
    fn inference_can_be_turned_off() {
        let workbook = import_csv(
            b"1,2\n",
            &CsvImportOptions {
                infer_types: false,
                ..Default::default()
            },
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap()
        .value;
        assert_eq!(
            workbook.worksheets[0].cell_at(0, 0).unwrap().value,
            ConvertedValue::Text("1".into())
        );
    }

    #[test]
    fn honors_byte_order_marks() {
        let mut utf8 = vec![0xEF, 0xBB, 0xBF];
        utf8.extend_from_slice("a,b\n".as_bytes());
        assert_eq!(
            import_csv(&utf8, &CsvImportOptions::default(), &DEFAULT_CONVERSION_LIMITS)
                .unwrap()
                .value
                .worksheets[0]
                .cell_at(0, 0)
                .unwrap()
                .value,
            ConvertedValue::Text("a".into())
        );

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "a,b\n".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(
            import_csv(&utf16, &CsvImportOptions::default(), &DEFAULT_CONVERSION_LIMITS)
                .unwrap()
                .value
                .worksheets[0]
                .cell_at(0, 1)
                .unwrap()
                .value,
            ConvertedValue::Text("b".into())
        );
    }

    #[test]
    fn always_reports_that_csv_carries_no_workbook_structure() {
        let converted = import_csv(
            b"a,b\n",
            &CsvImportOptions::default(),
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        assert!(converted
            .report
            .notes
            .iter()
            .any(|note| note.feature == "Workbook structure"));
        assert!(!converted.report.is_lossless());
    }

    #[test]
    fn rejects_an_empty_file() {
        assert!(matches!(
            import_csv(b"", &CsvImportOptions::default(), &DEFAULT_CONVERSION_LIMITS),
            Err(ConversionError::Malformed(_))
        ));
    }

    fn export_worksheet() -> ConvertedWorksheet {
        ConvertedWorksheet {
            name: "Data".into(),
            row_count: 2,
            column_count: 2,
            cells: vec![
                ConvertedCell {
                    row: 0,
                    column: 0,
                    value: ConvertedValue::Text("a,b".into()),
                    formula: None,
                    style: None,
                },
                ConvertedCell {
                    row: 0,
                    column: 1,
                    value: ConvertedValue::Number(12.0),
                    formula: None,
                    style: None,
                },
                ConvertedCell {
                    row: 1,
                    column: 0,
                    value: ConvertedValue::Number(24.0),
                    formula: Some("=B1*2".into()),
                    style: None,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn exports_values_and_quotes_only_what_needs_it() {
        let converted = export_csv(&export_worksheet(), &CsvExportOptions::default());
        assert_eq!(converted.value, "\"a,b\",12\n24,\n");
    }

    #[test]
    fn writes_formula_values_by_default_and_source_on_request() {
        let source = export_csv(
            &export_worksheet(),
            &CsvExportOptions {
                include_formulas: true,
                ..Default::default()
            },
        );
        // Still sanitized: opting into formulas is not opting into execution.
        assert!(source.value.contains("'=B1*2"));
    }

    #[test]
    fn prefixes_fields_a_spreadsheet_would_execute() {
        let worksheet = ConvertedWorksheet {
            row_count: 1,
            column_count: 4,
            cells: vec![
                ("=cmd|' /c calc'!A1", 0),
                ("+1+1", 1),
                ("-1+1", 2),
                ("@SUM(1)", 3),
            ]
            .into_iter()
            .map(|(text, column)| ConvertedCell {
                row: 0,
                column,
                value: ConvertedValue::Text(text.into()),
                formula: None,
                style: None,
            })
            .collect(),
            ..Default::default()
        };
        let converted = export_csv(&worksheet, &CsvExportOptions::default());
        // Every one of the four dangerous fields gains an inert prefix.
        for field in converted.value.trim_end().split(',') {
            assert!(field.starts_with('\''), "{field} was left executable");
        }
        assert!(converted
            .report
            .notes
            .iter()
            .any(|note| note.feature == "Formula injection"));
    }

    #[test]
    fn injection_protection_can_be_deliberately_disabled() {
        let worksheet = ConvertedWorksheet {
            row_count: 1,
            column_count: 1,
            cells: vec![ConvertedCell {
                row: 0,
                column: 0,
                value: ConvertedValue::Text("=1+1".into()),
                formula: None,
                style: None,
            }],
            ..Default::default()
        };
        let converted = export_csv(
            &worksheet,
            &CsvExportOptions {
                sanitize_formulas: false,
                ..Default::default()
            },
        );
        assert_eq!(converted.value, "=1+1\n");
    }

    #[test]
    fn exports_only_the_requested_range() {
        let converted = export_csv(
            &export_worksheet(),
            &CsvExportOptions {
                range: Some(super::super::model::ConvertedRange {
                    top: 0,
                    left: 1,
                    bottom: 0,
                    right: 1,
                }),
                ..Default::default()
            },
        );
        assert_eq!(converted.value, "12\n");
    }
}
