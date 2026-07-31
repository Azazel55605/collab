//! Collab spreadsheet domain crate.
//!
//! Phase 0 of the Advanced Tables plan owns exactly one thing here: the
//! Collab-owned formula boundary. The selected third-party engine
//! ([`formualizer`](https://crates.io/crates/formualizer), MIT OR Apache-2.0)
//! sits behind [`formula::SheetFormulaEngine`] so that no engine type, error
//! type, or value type reaches the `.sheet` schema, the IPC layer, or the UI.
//!
//! Replacing the engine must stay a change to this crate alone. Nothing outside
//! `formula.rs` may depend on `formualizer_*` types.
//!
//! Phase 10 adds a second Collab-owned boundary in [`convert`]: bounded
//! `.xlsx` and `.csv` conversion. `.sheet` stays the only editable and
//! authoritative format — conversion produces a new `.sheet` document or a
//! separate exported copy, never a live external backing model. Reading an
//! untrusted archive of untrusted XML is why the bounds live here rather than
//! inside a third-party reader.
//!
//! This crate is a pure domain crate: no filesystem, network, database, or
//! Tauri access, and no executable or externally fetched formula content.

pub mod convert;
pub mod formula;

pub use convert::{
    export_csv, export_xlsx, import_csv, import_xlsx, sheet_document_to_workbook,
    workbook_to_sheet_document, ConversionError, ConversionLimits, ConversionNote,
    ConversionReport, ConversionSeverity, Converted, ConvertedValue, ConvertedWorkbook,
    CsvExportOptions, CsvImportOptions, DEFAULT_CONVERSION_LIMITS,
};
pub use formula::{
    SheetCellRef, SheetEngineError, SheetFormulaBudget, SheetFormulaEngine, SheetFormulaError,
    SheetFormulaValue,
};
