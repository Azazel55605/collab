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
//! This crate is a pure domain crate: no filesystem, network, database, or
//! Tauri access, and no executable or externally fetched formula content.

pub mod formula;

pub use formula::{
    SheetCellRef, SheetEngineError, SheetFormulaBudget, SheetFormulaEngine, SheetFormulaError,
    SheetFormulaValue,
};
