//! Collab-owned formula boundary over the selected spreadsheet engine.
//!
//! Design rules frozen in Phase 0:
//!
//! - Formula source text is authoritative; computed values are derived and are
//!   never persisted as a second source of truth.
//! - Every evaluation runs under an explicit [`SheetFormulaBudget`] so a hostile
//!   or accidental workbook cannot hang the caller.
//! - Cycles, unknown functions, and parse failures resolve to stable cell error
//!   values, never to panics, stale values, or unbounded work.
//! - Formulas cannot reach the filesystem, network, environment, external
//!   workbooks, or executable code. The engine's optional `webservice`,
//!   `import_range`, `io_builtins`, `wasm_plugins`, and
//!   `wasm_runtime_wasmtime` features stay disabled in `Cargo.toml`, and no
//!   custom function or WASM module is ever registered here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use formualizer_common::{ExcelError, ExcelErrorKind, LiteralValue};
use formualizer_workbook::{Workbook, WorkbookConfig};
use serde::{Deserialize, Serialize};

/// Day zero of the spreadsheet serial-date system used by the engine and by
/// every mainstream spreadsheet application (`1899-12-30`, which absorbs the
/// historical 1900 leap-year bug).
const SERIAL_EPOCH: (i32, u32, u32) = (1899, 12, 30);

const SECONDS_PER_DAY: f64 = 86_400.0;

/// A single cell, addressed the way the engine expects: 1-based row and column
/// within a named worksheet.
///
/// `.sheet` documents address cells by stable row/column IDs. Translating those
/// IDs to this positional form is the caller's job, so structural edits stay
/// independent of engine internals.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SheetCellRef {
    pub sheet: String,
    pub row: u32,
    pub column: u32,
}

impl SheetCellRef {
    pub fn new(sheet: impl Into<String>, row: u32, column: u32) -> Self {
        Self {
            sheet: sheet.into(),
            row,
            column,
        }
    }
}

/// Stable spreadsheet cell error values.
///
/// These are values, not failures: a cell holding `#REF!` is a successfully
/// evaluated cell. Display codes are fixed and are safe to render directly;
/// they never carry engine internals, local paths, or source data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SheetFormulaError {
    /// `#NULL!`
    Null,
    /// `#REF!`
    Reference,
    /// `#NAME?` — also the result of an unknown or unsupported function name.
    Name,
    /// `#VALUE!`
    Value,
    /// `#DIV/0!`
    DivideByZero,
    /// `#N/A`
    NotAvailable,
    /// `#NUM!`
    Number,
    /// `#SPILL!`
    Spill,
    /// `#CALC!`
    Calculation,
    /// `#CIRC!` — a dependency cycle. Bounded and always terminating.
    Circular,
    /// `#N/IMPL!` — recognized by the engine but deliberately not implemented.
    Unsupported,
    /// `#ERROR!` — malformed formula source or an engine-level failure.
    Malformed,
    /// `#TIMEOUT!` — evaluation stopped by the Collab recalculation budget.
    /// This is Collab-owned, not an Excel code.
    BudgetExceeded,
}

impl SheetFormulaError {
    /// Stable display code. Kept in one place so desktop, mobile, and future
    /// export paths cannot drift.
    pub fn code(self) -> &'static str {
        match self {
            Self::Null => "#NULL!",
            Self::Reference => "#REF!",
            Self::Name => "#NAME?",
            Self::Value => "#VALUE!",
            Self::DivideByZero => "#DIV/0!",
            Self::NotAvailable => "#N/A",
            Self::Number => "#NUM!",
            Self::Spill => "#SPILL!",
            Self::Calculation => "#CALC!",
            Self::Circular => "#CIRC!",
            Self::Unsupported => "#N/IMPL!",
            Self::Malformed => "#ERROR!",
            Self::BudgetExceeded => "#TIMEOUT!",
        }
    }

    fn from_engine(kind: ExcelErrorKind) -> Self {
        match kind {
            ExcelErrorKind::Null => Self::Null,
            ExcelErrorKind::Ref => Self::Reference,
            ExcelErrorKind::Name => Self::Name,
            ExcelErrorKind::Value => Self::Value,
            ExcelErrorKind::Div => Self::DivideByZero,
            ExcelErrorKind::Na => Self::NotAvailable,
            ExcelErrorKind::Num => Self::Number,
            ExcelErrorKind::Spill => Self::Spill,
            ExcelErrorKind::Calc => Self::Calculation,
            ExcelErrorKind::Circ => Self::Circular,
            ExcelErrorKind::NImpl => Self::Unsupported,
            ExcelErrorKind::Cancelled => Self::BudgetExceeded,
            ExcelErrorKind::Error => Self::Malformed,
        }
    }

    fn into_engine(self) -> ExcelErrorKind {
        match self {
            Self::Null => ExcelErrorKind::Null,
            Self::Reference => ExcelErrorKind::Ref,
            Self::Name => ExcelErrorKind::Name,
            Self::Value => ExcelErrorKind::Value,
            Self::DivideByZero => ExcelErrorKind::Div,
            Self::NotAvailable => ExcelErrorKind::Na,
            Self::Number => ExcelErrorKind::Num,
            Self::Spill => ExcelErrorKind::Spill,
            Self::Calculation => ExcelErrorKind::Calc,
            Self::Circular => ExcelErrorKind::Circ,
            Self::Unsupported => ExcelErrorKind::NImpl,
            Self::Malformed => ExcelErrorKind::Error,
            Self::BudgetExceeded => ExcelErrorKind::Cancelled,
        }
    }
}

/// A cell value crossing the Collab formula boundary.
///
/// Dates, times, and durations are normalized to spreadsheet serial numbers
/// here. `.sheet` stores them as ISO-8601 strings with an explicit value type;
/// converting between the two is an adapter concern, not a storage concern.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SheetFormulaValue {
    Blank,
    Number { value: f64 },
    Text { value: String },
    Boolean { value: bool },
    Error { value: SheetFormulaError },
}

impl SheetFormulaValue {
    pub fn number(value: f64) -> Self {
        Self::Number { value }
    }

    pub fn text(value: impl Into<String>) -> Self {
        Self::Text {
            value: value.into(),
        }
    }

    pub fn boolean(value: bool) -> Self {
        Self::Boolean { value }
    }

    pub fn error(value: SheetFormulaError) -> Self {
        Self::Error { value }
    }

    pub fn date(value: NaiveDate) -> Self {
        Self::number(date_to_serial(value))
    }

    pub fn time(value: NaiveTime) -> Self {
        Self::number(time_to_serial(value))
    }

    pub fn datetime(value: NaiveDateTime) -> Self {
        Self::number(datetime_to_serial(value))
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number { value } => Some(*value),
            _ => None,
        }
    }

    pub fn as_error(&self) -> Option<SheetFormulaError> {
        match self {
            Self::Error { value } => Some(*value),
            _ => None,
        }
    }

    fn into_engine(self) -> LiteralValue {
        match self {
            Self::Blank => LiteralValue::Empty,
            Self::Number { value } => LiteralValue::Number(value),
            Self::Text { value } => LiteralValue::Text(value),
            Self::Boolean { value } => LiteralValue::Boolean(value),
            Self::Error { value } => LiteralValue::Error(ExcelError::from(value.into_engine())),
        }
    }

    fn from_engine(value: LiteralValue) -> Self {
        match value {
            LiteralValue::Empty | LiteralValue::Pending => Self::Blank,
            LiteralValue::Int(value) => Self::number(value as f64),
            LiteralValue::Number(value) => Self::number(value),
            LiteralValue::Text(value) => Self::text(value),
            LiteralValue::Boolean(value) => Self::boolean(value),
            LiteralValue::Date(date) => Self::number(date_to_serial(date)),
            LiteralValue::DateTime(stamp) => Self::number(datetime_to_serial(stamp)),
            LiteralValue::Time(time) => Self::number(time_to_serial(time)),
            LiteralValue::Duration(duration) => Self::number(duration_to_serial(duration)),
            // Spilled array results are a later phase. Until the `.sheet`
            // schema models spill ranges, surfacing a stable error beats
            // silently collapsing an array to its top-left cell.
            LiteralValue::Array(_) => Self::error(SheetFormulaError::Spill),
            LiteralValue::Error(error) => Self::error(SheetFormulaError::from_engine(error.kind)),
        }
    }
}

fn serial_epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(SERIAL_EPOCH.0, SERIAL_EPOCH.1, SERIAL_EPOCH.2)
        .expect("serial epoch is a valid date")
}

fn date_to_serial(date: NaiveDate) -> f64 {
    (date - serial_epoch()).num_days() as f64
}

fn time_to_serial(time: NaiveTime) -> f64 {
    let seconds = time.num_seconds_from_midnight() as f64;
    let fraction = time.nanosecond() as f64 / 1_000_000_000.0;
    (seconds + fraction) / SECONDS_PER_DAY
}

fn datetime_to_serial(stamp: NaiveDateTime) -> f64 {
    date_to_serial(stamp.date()) + time_to_serial(stamp.time())
}

fn duration_to_serial(duration: ChronoDuration) -> f64 {
    duration.num_milliseconds() as f64 / (SECONDS_PER_DAY * 1000.0)
}

/// Hard bounds applied to every workbook handled by this adapter.
///
/// The defaults are the Phase 0 desktop budgets. Mobile and background callers
/// are expected to pass smaller values rather than trusting the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SheetFormulaBudget {
    /// Maximum number of formula cells the engine will hold.
    pub max_formula_cells: usize,
    /// Wall-clock ceiling for a single evaluation request.
    pub max_evaluation: Duration,
}

impl SheetFormulaBudget {
    pub const DEFAULT_MAX_FORMULA_CELLS: usize = 200_000;
    pub const DEFAULT_MAX_EVALUATION: Duration = Duration::from_secs(5);

    pub fn new(max_formula_cells: usize, max_evaluation: Duration) -> Self {
        Self {
            max_formula_cells,
            max_evaluation,
        }
    }
}

impl Default for SheetFormulaBudget {
    fn default() -> Self {
        Self {
            max_formula_cells: Self::DEFAULT_MAX_FORMULA_CELLS,
            max_evaluation: Self::DEFAULT_MAX_EVALUATION,
        }
    }
}

/// Failures of the adapter itself, as opposed to cell error values.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SheetEngineError {
    #[error("worksheet '{0}' does not exist")]
    UnknownWorksheet(String),
    #[error("worksheet '{0}' already exists")]
    DuplicateWorksheet(String),
    #[error("formula budget exceeded: {limit} formula cells")]
    FormulaBudgetExceeded { limit: usize },
    #[error("evaluation exceeded its {0:?} budget")]
    EvaluationTimeout(Duration),
    #[error("formula engine error: {0}")]
    Engine(String),
}

/// The Collab formula engine.
///
/// This is deliberately a thin, replaceable surface: worksheets, values,
/// formulas, and bounded evaluation. Recalculation is incremental — the engine
/// tracks the dependency graph and recomputes only what an edit dirtied.
pub struct SheetFormulaEngine {
    workbook: Workbook,
    budget: SheetFormulaBudget,
    formula_cells: usize,
    /// Worksheets this adapter owns, in insertion order. The engine ships a
    /// default worksheet of its own; the registry keeps that implementation
    /// detail from being mistaken for document content.
    worksheets: Vec<String>,
}

impl SheetFormulaEngine {
    pub fn new(budget: SheetFormulaBudget) -> Self {
        // `with_span_evaluation` is required, not optional: without it, wide
        // row-oriented range aggregations (`=SUM(A1:CV1)`) fall off a cliff in
        // the engine's column-oriented storage. Measured in Phase 0 at ~4.6s
        // versus ~0.15s for 1000 such formulas. See the Phase 0 contract.
        let config = WorkbookConfig::interactive().with_span_evaluation(true);
        Self {
            workbook: Workbook::new_with_config(config),
            budget,
            formula_cells: 0,
            worksheets: Vec::new(),
        }
    }

    pub fn budget(&self) -> SheetFormulaBudget {
        self.budget
    }

    /// Number of formula cells currently held, for budget reporting.
    pub fn formula_cell_count(&self) -> usize {
        self.formula_cells
    }

    pub fn worksheet_names(&self) -> Vec<String> {
        self.worksheets.clone()
    }

    pub fn add_worksheet(&mut self, name: &str) -> Result<(), SheetEngineError> {
        if self.worksheets.iter().any(|existing| existing == name) {
            return Err(SheetEngineError::DuplicateWorksheet(name.to_string()));
        }
        // Adopt the engine's pre-existing default worksheet rather than
        // failing on a name the document legitimately uses.
        if !self.workbook.has_sheet(name) {
            self.workbook
                .add_sheet(name)
                .map_err(|error| SheetEngineError::Engine(error.to_string()))?;
        }
        self.worksheets.push(name.to_string());
        Ok(())
    }

    pub fn set_value(
        &mut self,
        cell: &SheetCellRef,
        value: SheetFormulaValue,
    ) -> Result<(), SheetEngineError> {
        self.require_worksheet(&cell.sheet)?;
        let replacing_formula = self
            .workbook
            .get_formula(&cell.sheet, cell.row, cell.column)
            .is_some();
        self.workbook
            .set_value(&cell.sheet, cell.row, cell.column, value.into_engine())
            .map_err(|error| SheetEngineError::Engine(error.to_string()))?;
        if replacing_formula {
            self.formula_cells = self.formula_cells.saturating_sub(1);
        }
        Ok(())
    }

    /// Sets a rectangular block of values in one dependency-propagation pass.
    /// Loading a workbook cell-by-cell is measurably slower; use this on open.
    pub fn set_values(
        &mut self,
        sheet: &str,
        start_row: u32,
        start_column: u32,
        rows: Vec<Vec<SheetFormulaValue>>,
    ) -> Result<(), SheetEngineError> {
        self.require_worksheet(sheet)?;
        let rows: Vec<Vec<LiteralValue>> = rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(SheetFormulaValue::into_engine)
                    .collect()
            })
            .collect();
        self.workbook
            .set_values(sheet, start_row, start_column, &rows)
            .map_err(|error| SheetEngineError::Engine(error.to_string()))
    }

    /// Stores formula source. Malformed source is accepted and resolves to a
    /// stable error value at evaluation time, matching spreadsheet behavior and
    /// keeping the user's text recoverable.
    pub fn set_formula(
        &mut self,
        cell: &SheetCellRef,
        formula: &str,
    ) -> Result<(), SheetEngineError> {
        self.require_worksheet(&cell.sheet)?;
        let replacing = self
            .workbook
            .get_formula(&cell.sheet, cell.row, cell.column)
            .is_some();
        if !replacing && self.formula_cells >= self.budget.max_formula_cells {
            return Err(SheetEngineError::FormulaBudgetExceeded {
                limit: self.budget.max_formula_cells,
            });
        }
        self.workbook
            .set_formula(&cell.sheet, cell.row, cell.column, formula)
            .map_err(|error| SheetEngineError::Engine(error.to_string()))?;
        if !replacing {
            self.formula_cells += 1;
        }
        Ok(())
    }

    /// Diagnostic only. The engine normalizes stored formula text and, for
    /// malformed input, replaces it with its own error description. The
    /// `.sheet` document — never this — is the authoritative formula source.
    pub fn engine_formula_text(&self, cell: &SheetCellRef) -> Option<String> {
        self.workbook
            .get_formula(&cell.sheet, cell.row, cell.column)
    }

    /// Last computed value without forcing recalculation.
    pub fn cached_value(&self, cell: &SheetCellRef) -> SheetFormulaValue {
        self.workbook
            .get_value(&cell.sheet, cell.row, cell.column)
            .map(SheetFormulaValue::from_engine)
            .unwrap_or(SheetFormulaValue::Blank)
    }

    /// Evaluates the requested cells, recomputing only dirty dependencies.
    pub fn evaluate(
        &mut self,
        cells: &[SheetCellRef],
    ) -> Result<Vec<SheetFormulaValue>, SheetEngineError> {
        for cell in cells {
            self.require_worksheet(&cell.sheet)?;
        }
        let targets: Vec<(&str, u32, u32)> = cells
            .iter()
            .map(|cell| (cell.sheet.as_str(), cell.row, cell.column))
            .collect();
        let budget = self.budget.max_evaluation;
        let workbook = &mut self.workbook;
        let values = run_bounded(budget, |cancel| {
            workbook.evaluate_cells_cancellable(&targets, cancel)
        })?
        .map_err(|error| SheetEngineError::Engine(error.to_string()))?;
        Ok(values
            .into_iter()
            .map(SheetFormulaValue::from_engine)
            .collect())
    }

    /// Recomputes every dirty formula in the workbook and reports how many
    /// cells were actually recalculated.
    pub fn evaluate_all(&mut self) -> Result<usize, SheetEngineError> {
        let budget = self.budget.max_evaluation;
        let workbook = &mut self.workbook;
        let result = run_bounded(budget, |cancel| workbook.evaluate_all_cancellable(cancel))?
            .map_err(|error| SheetEngineError::Engine(error.to_string()))?;
        Ok(result.computed_vertices)
    }

    fn require_worksheet(&self, sheet: &str) -> Result<(), SheetEngineError> {
        if self.worksheets.iter().any(|existing| existing == sheet) {
            Ok(())
        } else {
            Err(SheetEngineError::UnknownWorksheet(sheet.to_string()))
        }
    }
}

/// Runs one engine call under a wall-clock ceiling.
///
/// The engine polls the cancellation flag inside its evaluation loops, so a
/// runaway workbook stops instead of pinning a thread indefinitely. The outer
/// `Result` reports the budget; the inner one is the engine's own result.
fn run_bounded<T, E>(
    budget: Duration,
    call: impl FnOnce(Arc<AtomicBool>) -> Result<T, E>,
) -> Result<Result<T, E>, SheetEngineError> {
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let cancel = Arc::clone(&cancel);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            let started = Instant::now();
            while !finished.load(Ordering::Relaxed) {
                if started.elapsed() >= budget {
                    cancel.store(true, Ordering::Relaxed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };

    let result = call(Arc::clone(&cancel));
    finished.store(true, Ordering::Relaxed);
    let _ = watchdog.join();

    if cancel.load(Ordering::Relaxed) {
        return Err(SheetEngineError::EvaluationTimeout(budget));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(SheetFormulaError::Reference.code(), "#REF!");
        assert_eq!(SheetFormulaError::Circular.code(), "#CIRC!");
        assert_eq!(SheetFormulaError::Name.code(), "#NAME?");
        assert_eq!(SheetFormulaError::BudgetExceeded.code(), "#TIMEOUT!");
    }

    #[test]
    fn serial_conversion_matches_the_spreadsheet_epoch() {
        let date = NaiveDate::from_ymd_opt(1900, 1, 1).unwrap();
        assert_eq!(date_to_serial(date), 2.0);
        let noon = NaiveTime::from_hms_opt(12, 0, 0).unwrap();
        assert_eq!(time_to_serial(noon), 0.5);
    }

    #[test]
    fn replacing_a_formula_with_a_literal_releases_the_budget_slot() {
        let mut engine =
            SheetFormulaEngine::new(SheetFormulaBudget::new(1, Duration::from_secs(1)));
        engine.add_worksheet("Sheet1").unwrap();
        let first = SheetCellRef::new("Sheet1", 1, 1);
        let second = SheetCellRef::new("Sheet1", 2, 1);
        engine.set_formula(&first, "=1").unwrap();
        engine
            .set_value(&first, SheetFormulaValue::number(2.0))
            .unwrap();
        engine.set_formula(&second, "=3").unwrap();
        assert_eq!(engine.formula_cell_count(), 1);
    }
}
