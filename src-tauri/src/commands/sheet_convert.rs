//! `.xlsx` / `.csv` conversion commands.
//!
//! The conversion itself lives in `collab_sheet::convert`; this module is the
//! adapter that reads and writes files and crosses the IPC boundary. Two rules
//! shape it:
//!
//! - The frontend never sees external-format bytes. It sends or receives a
//!   `.sheet` document as text, and the raw `.xlsx` never enters the webview.
//! - An imported workbook is validated against the shared trust boundary in
//!   `collab_documents::sheet` before it is handed back, so a hostile file
//!   cannot produce a document the rest of the app would refuse to persist.

use std::path::Path;

use collab_documents::sheet::{validate_document, DEFAULT_SHEET_LIMITS};
use collab_sheet::convert::{
    export_csv, export_xlsx, import_csv, import_xlsx, sheet_document_to_workbook,
    workbook_to_sheet_document, ConversionError, ConversionReport, ConvertedRange, ConvertedValue,
    CsvExportOptions, CsvImportOptions, CsvQuoting, DEFAULT_CONVERSION_LIMITS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Source formats an import accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SheetImportFormat {
    Xlsx,
    Csv,
}

impl SheetImportFormat {
    /// Derives the format from an extension, so the caller cannot ask for an
    /// `.xlsx` parse of something that is not one.
    pub fn from_path(path: &str) -> Option<Self> {
        match Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())?
            .to_ascii_lowercase()
            .as_str()
        {
            "xlsx" | "xlsm" => Some(Self::Xlsx),
            "csv" | "tsv" | "txt" => Some(Self::Csv),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetImportOptions {
    /// CSV only. `None` sniffs the delimiter.
    pub delimiter: Option<String>,
    /// CSV only. Defaults to on.
    pub infer_types: Option<bool>,
    /// CSV only. Defaults to on.
    pub has_header_row: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetImportResult {
    /// The new `.sheet` document, serialized. The caller writes it into the
    /// vault as a normal document; the source file is never touched.
    pub document: String,
    /// Suggested file name without an extension.
    pub suggested_name: String,
    pub report: ConversionReport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SheetExportFormat {
    Xlsx,
    Csv,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetExportOptions {
    /// CSV only. Which worksheet to write; defaults to the active one.
    pub worksheet_id: Option<String>,
    /// CSV only. Zero-based inclusive rectangle.
    pub range: Option<SheetExportRange>,
    /// CSV only. Defaults to `,`.
    pub delimiter: Option<String>,
    /// CSV only. Quote every field.
    pub quote_all: Option<bool>,
    /// CSV only. Write formula source instead of values. Off by default.
    pub include_formulas: Option<bool>,
    /// CSV only. Defaults to on. Turning it off produces a file whose fields a
    /// spreadsheet application will execute, so the UI must ask first.
    pub sanitize_formulas: Option<bool>,
    /// Evaluated formula results keyed `worksheetId:rowId:columnId`, so an
    /// exported file shows the same numbers the editor shows.
    pub computed_values: Option<Vec<SheetComputedValue>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetExportRange {
    pub top: usize,
    pub left: usize,
    pub bottom: usize,
    pub right: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetComputedValue {
    pub key: String,
    /// `number`, `text`, `boolean`, or `error`.
    pub kind: String,
    pub number: Option<f64>,
    pub text: Option<String>,
    pub boolean: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetExportResult {
    pub path: String,
    pub bytes_written: usize,
    pub report: ConversionReport,
}

fn message(error: ConversionError) -> String {
    error.to_string()
}

fn single_char(value: Option<&String>) -> Option<char> {
    let text = value?;
    match text.as_str() {
        "\\t" | "tab" => Some('\t'),
        _ => text.chars().next(),
    }
}

fn computed_map(values: Option<Vec<SheetComputedValue>>) -> BTreeMap<String, ConvertedValue> {
    values
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let value = match entry.kind.as_str() {
                "number" => ConvertedValue::Number(entry.number?),
                "text" => ConvertedValue::Text(entry.text?),
                "boolean" => ConvertedValue::Boolean(entry.boolean?),
                "error" => ConvertedValue::Error(entry.text?),
                _ => return None,
            };
            Some((entry.key, value))
        })
        .collect()
}

/// Converts an external file into a new `.sheet` document.
///
/// The source file is opened read-only and left untouched: the result is a
/// separate Collab document the caller creates in the vault.
#[tauri::command]
pub fn sheet_convert_import(
    source_path: String,
    workbook_id: String,
    timestamp: String,
    options: Option<SheetImportOptions>,
) -> Result<SheetImportResult, String> {
    let format = SheetImportFormat::from_path(&source_path)
        .ok_or_else(|| "Only .xlsx and .csv files can be converted into a workbook.".to_string())?;

    let metadata = std::fs::metadata(&source_path)
        .map_err(|error| format!("Failed to open '{source_path}': {error}"))?;
    if metadata.len() as usize > DEFAULT_CONVERSION_LIMITS.source_bytes {
        return Err(format!(
            "That file is larger than the {} MiB conversion limit.",
            DEFAULT_CONVERSION_LIMITS.source_bytes / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&source_path)
        .map_err(|error| format!("Failed to read '{source_path}': {error}"))?;

    let stem = Path::new(&source_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("Workbook")
        .to_string();

    let options = options.unwrap_or_default();
    let converted = match format {
        SheetImportFormat::Xlsx => {
            import_xlsx(&bytes, &stem, &DEFAULT_CONVERSION_LIMITS).map_err(message)?
        }
        SheetImportFormat::Csv => import_csv(
            &bytes,
            &CsvImportOptions {
                delimiter: single_char(options.delimiter.as_ref()),
                infer_types: options.infer_types.unwrap_or(true),
                has_header_row: options.has_header_row.unwrap_or(true),
                worksheet_name: stem.clone(),
            },
            &DEFAULT_CONVERSION_LIMITS,
        )
        .map_err(message)?,
    };

    let document = workbook_to_sheet_document(
        &converted.value,
        &workbook_id,
        &timestamp,
        &DEFAULT_CONVERSION_LIMITS,
    )
    .map_err(message)?;

    // The shared trust boundary, not a second opinion: if the converted result
    // would be rejected on write, it must be rejected here instead of landing
    // in the vault as an unopenable file.
    validate_document(&document, DEFAULT_SHEET_LIMITS)
        .map_err(|error| format!("The converted workbook is not valid: {error}"))?;

    Ok(SheetImportResult {
        document: serde_json::to_string_pretty(&document)
            .map_err(|error| format!("Failed to serialize the converted workbook: {error}"))?,
        suggested_name: stem,
        report: converted.report,
    })
}

/// Writes a `.sheet` document out as a new `.xlsx` or `.csv` copy.
///
/// The open document is untouched and keeps its own format; this only produces
/// a separate file at `target_path`.
#[tauri::command]
pub fn sheet_convert_export(
    document_text: String,
    target_path: String,
    format: SheetExportFormat,
    options: Option<SheetExportOptions>,
) -> Result<SheetExportResult, String> {
    let document: Value = serde_json::from_str(&document_text)
        .map_err(|error| format!("The workbook could not be read: {error}"))?;
    let options = options.unwrap_or_default();
    let workbook = sheet_document_to_workbook(&document, &computed_map(options.computed_values))
        .map_err(message)?;

    let bytes = match format {
        SheetExportFormat::Xlsx => {
            let converted = export_xlsx(&workbook).map_err(message)?;
            (converted.value, converted.report)
        }
        SheetExportFormat::Csv => {
            // CSV cannot hold a workbook, so exactly one worksheet is written
            // and the caller is responsible for having asked which one.
            let index = match options.worksheet_id.as_deref() {
                Some(id) => document
                    .get("worksheets")
                    .and_then(Value::as_array)
                    .and_then(|worksheets| {
                        worksheets
                            .iter()
                            .position(|worksheet| worksheet.get("id").and_then(Value::as_str) == Some(id))
                    })
                    .ok_or_else(|| "That worksheet is no longer in the workbook.".to_string())?,
                None => 0,
            };
            let worksheet = workbook
                .worksheets
                .get(index)
                .ok_or_else(|| "That worksheet is no longer in the workbook.".to_string())?;
            let converted = export_csv(
                worksheet,
                &CsvExportOptions {
                    delimiter: single_char(options.delimiter.as_ref()).unwrap_or(','),
                    quoting: if options.quote_all.unwrap_or(false) {
                        CsvQuoting::Always
                    } else {
                        CsvQuoting::Minimal
                    },
                    include_formulas: options.include_formulas.unwrap_or(false),
                    sanitize_formulas: options.sanitize_formulas.unwrap_or(true),
                    range: options.range.map(|range| ConvertedRange {
                        top: range.top,
                        left: range.left,
                        bottom: range.bottom,
                        right: range.right,
                    }),
                },
            );
            (converted.value.into_bytes(), converted.report)
        }
    };

    let (payload, mut report) = bytes;
    if workbook.worksheets.len() > 1 && format == SheetExportFormat::Csv {
        report.flattened(
            "Worksheets",
            format!(
                "Only one of the {} worksheets was written; CSV has no workbook model.",
                workbook.worksheets.len()
            ),
            None,
        );
    }

    if let Some(parent) = Path::new(&target_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare the destination folder: {error}"))?;
    }
    std::fs::write(&target_path, &payload)
        .map_err(|error| format!("Failed to write '{target_path}': {error}"))?;

    Ok(SheetExportResult {
        path: target_path,
        bytes_written: payload.len(),
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_format_from_the_extension_only() {
        assert_eq!(
            SheetImportFormat::from_path("/tmp/Budget.xlsx"),
            Some(SheetImportFormat::Xlsx)
        );
        assert_eq!(
            SheetImportFormat::from_path("/tmp/Budget.XLSX"),
            Some(SheetImportFormat::Xlsx)
        );
        assert_eq!(
            SheetImportFormat::from_path("/tmp/data.csv"),
            Some(SheetImportFormat::Csv)
        );
        assert_eq!(SheetImportFormat::from_path("/tmp/notes.md"), None);
        assert_eq!(SheetImportFormat::from_path("/tmp/archive"), None);
    }

    #[test]
    fn reads_a_tab_delimiter_from_its_escape() {
        assert_eq!(single_char(Some(&"\\t".to_string())), Some('\t'));
        assert_eq!(single_char(Some(&";".to_string())), Some(';'));
        assert_eq!(single_char(None), None);
    }

    #[test]
    fn maps_computed_values_and_drops_unknown_kinds() {
        let map = computed_map(Some(vec![
            SheetComputedValue {
                key: "ws1:r1:c1".into(),
                kind: "number".into(),
                number: Some(12.0),
                text: None,
                boolean: None,
            },
            SheetComputedValue {
                key: "ws1:r2:c1".into(),
                kind: "mystery".into(),
                number: None,
                text: None,
                boolean: None,
            },
        ]));
        assert_eq!(map.len(), 1);
        assert_eq!(map["ws1:r1:c1"], ConvertedValue::Number(12.0));
    }

    #[test]
    fn imports_a_csv_file_into_a_valid_sheet_document() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("Budget.csv");
        std::fs::write(&source, "name,amount\nRent,1240\n").unwrap();

        let result = sheet_convert_import(
            source.to_string_lossy().to_string(),
            "wb-1".into(),
            "2026-01-01T00:00:00.000Z".into(),
            None,
        )
        .unwrap();

        assert_eq!(result.suggested_name, "Budget");
        let document: Value = serde_json::from_str(&result.document).unwrap();
        assert_eq!(document["kind"], "collab-sheet");
        assert_eq!(document["worksheets"][0]["cells"]["r2:c2"]["value"], 1240.0);
        // The source file is a separate document and must be left as it was.
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "name,amount\nRent,1240\n"
        );
        assert!(!result.report.notes.is_empty());
    }

    #[test]
    fn refuses_a_file_type_it_cannot_convert() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("notes.md");
        std::fs::write(&source, "# hello").unwrap();
        assert!(sheet_convert_import(
            source.to_string_lossy().to_string(),
            "wb-1".into(),
            "2026-01-01T00:00:00.000Z".into(),
            None,
        )
        .is_err());
    }

    fn workbook_document() -> String {
        serde_json::json!({
            "kind": "collab-sheet",
            "schemaVersion": 1,
            "id": "wb-1",
            "name": "Budget",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "activeWorksheetId": "ws1",
            "worksheets": [{
                "id": "ws1",
                "name": "Q1",
                "rowOrder": ["r1", "r2"],
                "columnOrder": ["c1", "c2"],
                "cells": {
                    "r1:c1": { "value": "Rent", "valueType": "text" },
                    "r1:c2": { "value": 1240, "valueType": "number" },
                    "r2:c2": { "formula": "=B1*2" }
                }
            }],
            "styles": {}
        })
        .to_string()
    }

    #[test]
    fn exports_an_xlsx_copy_without_touching_the_document() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("Budget.xlsx");
        let source = workbook_document();

        let result = sheet_convert_export(
            source.clone(),
            target.to_string_lossy().to_string(),
            SheetExportFormat::Xlsx,
            None,
        )
        .unwrap();

        assert!(result.bytes_written > 0);
        let bytes = std::fs::read(&target).unwrap();
        assert_eq!(&bytes[..2], b"PK", "an .xlsx is a ZIP archive");
        // The exported copy is separate; the source text is unchanged.
        assert_eq!(source, workbook_document());
    }

    #[test]
    fn exports_csv_with_evaluated_values_and_injection_protection() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("Budget.csv");

        let result = sheet_convert_export(
            workbook_document(),
            target.to_string_lossy().to_string(),
            SheetExportFormat::Csv,
            Some(SheetExportOptions {
                computed_values: Some(vec![SheetComputedValue {
                    key: "ws1:r2:c2".into(),
                    kind: "number".into(),
                    number: Some(2480.0),
                    text: None,
                    boolean: None,
                }]),
                ..Default::default()
            }),
        )
        .unwrap();

        let text = std::fs::read_to_string(&target).unwrap();
        assert_eq!(text, "Rent,1240\n,2480\n");
        assert!(result.report.notes.iter().any(|note| note.feature == "Formulas"));
    }

    #[test]
    fn csv_export_reports_the_worksheets_it_could_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("Budget.csv");
        let mut document: Value = serde_json::from_str(&workbook_document()).unwrap();
        let mut second = document["worksheets"][0].clone();
        second["id"] = Value::String("ws2".into());
        second["name"] = Value::String("Q2".into());
        document["worksheets"].as_array_mut().unwrap().push(second);

        let report = sheet_convert_export(
            document.to_string(),
            target.to_string_lossy().to_string(),
            SheetExportFormat::Csv,
            None,
        )
        .unwrap()
        .report;
        assert!(report.notes.iter().any(|note| note.feature == "Worksheets"));
    }

    #[test]
    fn rejects_a_document_that_is_not_a_workbook() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("out.csv");
        assert!(sheet_convert_export(
            "{\"kind\":\"collab-kanban\"}".into(),
            target.to_string_lossy().to_string(),
            SheetExportFormat::Csv,
            None,
        )
        .is_err());
    }
}
