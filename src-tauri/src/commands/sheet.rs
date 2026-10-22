use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use chrono_tz::Tz;
use collab_sheet::formula::{
    SheetCellRef, SheetEngineError, SheetFormulaBudget, SheetFormulaEngine, SheetFormulaError,
    SheetFormulaValue,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::state::AppState;

const MAX_ACTIVE_SHEET_RUNTIMES: usize = 16;
const MAX_EVALUATION_MILLIS: u64 = 5_000;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFormulaCellInput {
    pub worksheet_id: String,
    pub row_id: String,
    pub column_id: String,
    pub row: u32,
    pub column: u32,
    pub formula: Option<String>,
    pub value_type: Option<String>,
    pub value: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFormulaWorksheetInput {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFormulaEvaluationRequest {
    pub runtime_id: String,
    pub structure_signature: String,
    pub worksheets: Vec<SheetFormulaWorksheetInput>,
    pub cells: Vec<SheetFormulaCellInput>,
    pub evaluation_time: String,
    pub time_zone: String,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default)]
    pub full_seed: Option<bool>,
    #[serde(default)]
    pub removed_cells: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SheetFormulaComputedValue {
    Blank,
    Number { value: f64 },
    Text { value: String },
    Boolean { value: bool },
    Error { value: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFormulaComputedCell {
    pub worksheet_id: String,
    pub row_id: String,
    pub column_id: String,
    pub value: SheetFormulaComputedValue,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFormulaEvaluationResponse {
    pub cells: Vec<SheetFormulaComputedCell>,
    pub recalculated: usize,
    pub incremental: bool,
    pub revision: Option<u64>,
    pub full_result: bool,
    pub reset_required: bool,
    pub removed_cells: Vec<String>,
}

struct SheetRuntime {
    structure_signature: String,
    worksheets: HashMap<String, String>,
    cells: HashMap<String, SheetFormulaCellInput>,
    engine: SheetFormulaEngine,
    last_used: u128,
    revision: u64,
    outputs: HashMap<String, SheetFormulaComputedCell>,
}

struct RuntimeOwner {
    runtime: Mutex<Option<SheetRuntime>>,
    retired: AtomicBool,
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
}
impl RuntimeOwner {
    fn retire(&self) {
        self.retired.store(true, Ordering::Relaxed);
        if let Some(flag) = self.active_cancel.lock().as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
#[derive(Default)]
pub struct SheetFormulaRegistry {
    runtimes: Mutex<HashMap<String, Arc<RuntimeOwner>>>,
}
impl SheetFormulaRegistry {
    fn owner(&self, id: &str) -> Result<Arc<RuntimeOwner>, String> {
        if id.is_empty() || id.len() > 128 {
            return Err("invalid sheet formula runtime identifier".into());
        }
        let mut runtimes = self.runtimes.lock();
        if let Some(owner) = runtimes.get(id) {
            return Ok(Arc::clone(owner));
        }
        let mut retired = None;
        if runtimes.len() >= MAX_ACTIVE_SHEET_RUNTIMES {
            let idle = runtimes
                .iter()
                .filter(|(_, owner)| Arc::strong_count(owner) == 1)
                .min_by_key(|(_, owner)| {
                    owner
                        .runtime
                        .try_lock()
                        .and_then(|runtime| runtime.as_ref().map(|r| r.last_used))
                        .unwrap_or(u128::MAX)
                })
                .map(|(id, _)| id.clone());
            if let Some(id) = idle {
                retired = runtimes.remove(&id);
            } else {
                return Err("Sheet formula runtime limit reached; close an unused workbook".into());
            }
        }
        let owner = Arc::new(RuntimeOwner {
            runtime: Mutex::new(None),
            retired: AtomicBool::new(false),
            active_cancel: Mutex::new(None),
        });
        runtimes.insert(id.into(), Arc::clone(&owner));
        drop(runtimes);
        if let Some(previous) = retired {
            previous.retire();
        }
        Ok(owner)
    }
    #[cfg(test)]
    fn evaluate(
        &self,
        request: SheetFormulaEvaluationRequest,
    ) -> Result<SheetFormulaEvaluationResponse, String> {
        let owner = self.owner(&request.runtime_id)?;
        self.evaluate_owned(&owner, request, Arc::new(AtomicBool::new(false)))
    }
    fn evaluate_owned(
        &self,
        owner: &RuntimeOwner,
        request: SheetFormulaEvaluationRequest,
        cancel: Arc<AtomicBool>,
    ) -> Result<SheetFormulaEvaluationResponse, String> {
        let _trace = crate::performance::span("sheet.evaluate");
        validate_request(&request)?;
        let mut slot = owner
            .runtime
            .try_lock()
            .ok_or("This workbook is already calculating")?;
        if owner.retired.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
            return Err("Sheet evaluation cancelled".into());
        }
        *owner.active_cancel.lock() = Some(Arc::clone(&cancel));
        let result = (|| {
            let volatile = volatile_values(&request.evaluation_time, &request.time_zone)?;
            let delta = request.full_seed == Some(false);
            let can_increment = slot
                .as_ref()
                .is_some_and(|r| r.structure_signature == request.structure_signature);
            if delta
                && (!can_increment || slot.as_ref().map(|r| r.revision) != request.base_revision)
            {
                return Ok(SheetFormulaEvaluationResponse {
                    reset_required: true,
                    ..Default::default()
                });
            }
            if !can_increment || request.full_seed == Some(true) {
                *slot = Some(build_runtime(&request, volatile, &cancel)?);
            } else {
                apply_incremental_changes(slot.as_mut().unwrap(), &request, volatile, &cancel)?;
            }
            let runtime = slot.as_mut().unwrap();
            if runtime.cells.len() > 1_000_000 {
                return Err("formula input exceeds the workbook cell budget".into());
            }
            if cancel.load(Ordering::Relaxed) {
                return Err("Sheet evaluation cancelled".into());
            }
            runtime.last_used = now_millis();
            let recalculated = match runtime.engine.evaluate_all_cancellable(Arc::clone(&cancel)) {
                Ok(count) => count,
                Err(SheetEngineError::EvaluationTimeout(_)) if !cancel.load(Ordering::Relaxed) => {
                    return Ok(timeout_response(
                        &runtime
                            .cells
                            .values()
                            .filter(|cell| cell.formula.is_some())
                            .cloned()
                            .collect::<Vec<_>>(),
                        can_increment,
                    ))
                }
                Err(error) => return Err(error.to_string()),
            };
            if cancel.load(Ordering::Relaxed) || owner.retired.load(Ordering::Relaxed) {
                return Err("Sheet evaluation cancelled".into());
            }
            let inputs = runtime
                .cells
                .values()
                .filter(|c| c.formula.is_some())
                .cloned()
                .collect::<Vec<_>>();
            let outputs = computed_cells(runtime, &inputs)
                .into_iter()
                .map(|c| {
                    (
                        format!("{}:{}:{}", c.worksheet_id, c.row_id, c.column_id),
                        c,
                    )
                })
                .collect::<HashMap<_, _>>();
            let full = !delta;
            let removed_cells = runtime
                .outputs
                .keys()
                .filter(|key| !outputs.contains_key(*key))
                .cloned()
                .collect();
            let cells = outputs
                .iter()
                .filter(|(key, value)| full || runtime.outputs.get(*key) != Some(*value))
                .map(|(_, value)| value.clone())
                .collect();
            runtime.outputs = outputs;
            runtime.revision = request.revision.unwrap_or(runtime.revision + 1);
            Ok(SheetFormulaEvaluationResponse {
                cells,
                recalculated,
                incremental: can_increment,
                revision: Some(runtime.revision),
                full_result: full,
                reset_required: false,
                removed_cells,
            })
        })();
        *owner.active_cancel.lock() = None;
        if result.as_ref().map_or(true, |response| {
            response.revision.is_none() && !response.reset_required
        }) {
            *slot = None;
        } // Never reuse a partially cancelled update.
        result
    }
    pub fn release(&self, id: &str) {
        let removed = self.runtimes.lock().remove(id);
        if let Some(owner) = removed {
            owner.retire();
        }
    }
}

fn validate_request(request: &SheetFormulaEvaluationRequest) -> Result<(), String> {
    if request.runtime_id.is_empty() || request.runtime_id.len() > 128 {
        return Err("invalid sheet formula runtime identifier".to_string());
    }
    if request.worksheets.is_empty() || request.worksheets.len() > 200 {
        return Err("a formula workbook must contain between 1 and 200 worksheets".to_string());
    }
    if request.cells.len() > 1_000_000 {
        return Err("formula input exceeds the workbook cell budget".to_string());
    }
    for cell in &request.cells {
        if cell.row == 0 || cell.column == 0 || cell.column > 16_384 || cell.row > 1_000_000 {
            return Err("formula input contains an out-of-bounds cell".to_string());
        }
        if cell
            .formula
            .as_ref()
            .is_some_and(|formula| formula.len() > 8_192)
        {
            return Err("formula source exceeds the 8192 byte limit".to_string());
        }
    }
    Ok(())
}

fn build_runtime(
    request: &SheetFormulaEvaluationRequest,
    volatile: VolatileValues,
    cancel: &AtomicBool,
) -> Result<SheetRuntime, String> {
    let mut engine = SheetFormulaEngine::new(SheetFormulaBudget::new(
        200_000,
        Duration::from_millis(MAX_EVALUATION_MILLIS),
    ));
    let worksheets = request
        .worksheets
        .iter()
        .map(|worksheet| {
            engine
                .add_worksheet(&worksheet.name)
                .map_err(|error| error.to_string())?;
            Ok((worksheet.id.clone(), worksheet.name.clone()))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;
    let mut runtime = SheetRuntime {
        structure_signature: request.structure_signature.clone(),
        worksheets,
        cells: HashMap::new(),
        engine,
        last_used: now_millis(),
        revision: request.revision.unwrap_or(0),
        outputs: HashMap::new(),
    };
    for cell in &request.cells {
        if cancel.load(Ordering::Relaxed) {
            return Err("Sheet evaluation cancelled".into());
        }
        apply_cell(&mut runtime, cell, volatile)?;
        runtime.cells.insert(cell_key(cell), cell.clone());
    }
    Ok(runtime)
}

fn apply_incremental_changes(
    runtime: &mut SheetRuntime,
    request: &SheetFormulaEvaluationRequest,
    volatile: VolatileValues,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let next = request
        .cells
        .iter()
        .map(|cell| (cell_key(cell), cell))
        .collect::<HashMap<_, _>>();
    let explicitly_removed = request
        .removed_cells
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let removed = runtime
        .cells
        .keys()
        .filter(|key| {
            if request.full_seed == Some(false) {
                explicitly_removed.contains(key)
            } else {
                !next.contains_key(*key)
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    for key in removed {
        if let Some(previous) = runtime.cells.remove(&key) {
            let target = engine_ref(runtime, &previous)?;
            runtime
                .engine
                .set_value(&target, SheetFormulaValue::Blank)
                .map_err(|error| error.to_string())?;
        }
    }
    let volatile_cells = if request.full_seed == Some(false) {
        runtime
            .cells
            .values()
            .filter(|cell| !next.contains_key(&cell_key(cell)))
            .filter(|cell| {
                cell.formula
                    .as_ref()
                    .is_some_and(|f| is_volatile_formula(f))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    for cell in request.cells.iter().chain(volatile_cells.iter()) {
        if cancel.load(Ordering::Relaxed) {
            return Err("Sheet evaluation cancelled".into());
        }
        let key = cell_key(cell);
        let volatile_formula = cell
            .formula
            .as_ref()
            .is_some_and(|formula| is_volatile_formula(formula));
        if runtime.cells.get(&key) == Some(cell) && !volatile_formula {
            continue;
        }
        apply_cell(runtime, cell, volatile)?;
        runtime.cells.insert(key, cell.clone());
    }
    Ok(())
}

fn is_volatile_formula(formula: &str) -> bool {
    let upper = formula
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    ["TODAY(", "NOW(", "RAND(", "RANDBETWEEN("]
        .iter()
        .any(|name| upper.contains(name))
}

fn apply_cell(
    runtime: &mut SheetRuntime,
    cell: &SheetFormulaCellInput,
    volatile: VolatileValues,
) -> Result<(), String> {
    let target = engine_ref(runtime, cell)?;
    if let Some(formula) = &cell.formula {
        if contains_range_text_aggregation(formula) {
            return runtime
                .engine
                .set_value(
                    &target,
                    SheetFormulaValue::error(SheetFormulaError::Unsupported),
                )
                .map_err(|error| error.to_string());
        }
        let evaluated_formula = bind_volatile_functions(formula, volatile);
        runtime
            .engine
            .set_formula(&target, &evaluated_formula)
            .map_err(|error| error.to_string())
    } else {
        runtime
            .engine
            .set_value(&target, literal_value(cell)?)
            .map_err(|error| error.to_string())
    }
}

fn engine_ref(
    runtime: &SheetRuntime,
    cell: &SheetFormulaCellInput,
) -> Result<SheetCellRef, String> {
    let sheet = runtime
        .worksheets
        .get(&cell.worksheet_id)
        .ok_or_else(|| "cell references an unknown worksheet".to_string())?;
    Ok(SheetCellRef::new(sheet, cell.row, cell.column))
}

fn literal_value(cell: &SheetFormulaCellInput) -> Result<SheetFormulaValue, String> {
    let Some(value) = &cell.value else {
        return Ok(SheetFormulaValue::Blank);
    };
    if value.is_null() {
        return Ok(SheetFormulaValue::Blank);
    }
    match cell.value_type.as_deref() {
        Some("number") => value
            .as_f64()
            .map(SheetFormulaValue::number)
            .ok_or_else(|| "invalid numeric sheet value".to_string()),
        Some("boolean") => value
            .as_bool()
            .map(SheetFormulaValue::boolean)
            .ok_or_else(|| "invalid boolean sheet value".to_string()),
        Some("date") => NaiveDate::parse_from_str(
            value
                .as_str()
                .ok_or_else(|| "invalid date sheet value".to_string())?,
            "%Y-%m-%d",
        )
        .map(SheetFormulaValue::date)
        .map_err(|_| "invalid date sheet value".to_string()),
        Some("time") => NaiveTime::parse_from_str(
            value
                .as_str()
                .ok_or_else(|| "invalid time sheet value".to_string())?,
            "%H:%M:%S",
        )
        .map(SheetFormulaValue::time)
        .map_err(|_| "invalid time sheet value".to_string()),
        Some("datetime") => NaiveDateTime::parse_from_str(
            value
                .as_str()
                .ok_or_else(|| "invalid datetime sheet value".to_string())?,
            "%Y-%m-%dT%H:%M:%S",
        )
        .map(SheetFormulaValue::datetime)
        .map_err(|_| "invalid datetime sheet value".to_string()),
        _ if value.is_number() => value
            .as_f64()
            .map(SheetFormulaValue::number)
            .ok_or_else(|| "invalid numeric sheet value".to_string()),
        _ if value.is_boolean() => value
            .as_bool()
            .map(SheetFormulaValue::boolean)
            .ok_or_else(|| "invalid boolean sheet value".to_string()),
        _ => Ok(SheetFormulaValue::text(
            value
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| value.to_string()),
        )),
    }
}

fn computed_cells(
    runtime: &SheetRuntime,
    cells: &[SheetFormulaCellInput],
) -> Vec<SheetFormulaComputedCell> {
    cells
        .iter()
        .filter(|cell| cell.formula.is_some())
        .filter_map(|cell| {
            let target = engine_ref(runtime, cell).ok()?;
            Some(SheetFormulaComputedCell {
                worksheet_id: cell.worksheet_id.clone(),
                row_id: cell.row_id.clone(),
                column_id: cell.column_id.clone(),
                value: computed_value(runtime.engine.cached_value(&target)),
            })
        })
        .collect()
}

fn computed_value(value: SheetFormulaValue) -> SheetFormulaComputedValue {
    match value {
        SheetFormulaValue::Blank => SheetFormulaComputedValue::Blank,
        SheetFormulaValue::Number { value } => SheetFormulaComputedValue::Number { value },
        SheetFormulaValue::Text { value } => SheetFormulaComputedValue::Text { value },
        SheetFormulaValue::Boolean { value } => SheetFormulaComputedValue::Boolean { value },
        SheetFormulaValue::Error { value } => SheetFormulaComputedValue::Error {
            value: value.code().to_string(),
        },
    }
}

fn timeout_response(
    cells: &[SheetFormulaCellInput],
    incremental: bool,
) -> SheetFormulaEvaluationResponse {
    SheetFormulaEvaluationResponse {
        cells: cells
            .iter()
            .filter(|cell| cell.formula.is_some())
            .map(|cell| SheetFormulaComputedCell {
                worksheet_id: cell.worksheet_id.clone(),
                row_id: cell.row_id.clone(),
                column_id: cell.column_id.clone(),
                value: SheetFormulaComputedValue::Error {
                    value: SheetFormulaError::BudgetExceeded.code().to_string(),
                },
            })
            .collect(),
        recalculated: 0,
        incremental,
        full_result: true,
        reset_required: false,
        ..Default::default()
    }
}

fn cell_key(cell: &SheetFormulaCellInput) -> String {
    format!("{}:{}:{}", cell.worksheet_id, cell.row_id, cell.column_id)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Clone, Copy)]
struct VolatileValues {
    today: f64,
    now: f64,
}

fn volatile_values(stamp: &str, time_zone: &str) -> Result<VolatileValues, String> {
    let instant = DateTime::parse_from_rfc3339(stamp)
        .map_err(|_| "invalid formula evaluation timestamp".to_string())?
        .with_timezone(&Utc);
    let zone = time_zone
        .parse::<Tz>()
        .map_err(|_| "invalid formula evaluation timezone".to_string())?;
    let local = instant.with_timezone(&zone);
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30).expect("valid serial epoch");
    let today = (local.date_naive() - epoch).num_days() as f64;
    let seconds = local.time().num_seconds_from_midnight() as f64
        + local.time().nanosecond() as f64 / 1_000_000_000.0;
    Ok(VolatileValues {
        today,
        now: today + seconds / 86_400.0,
    })
}

fn bind_volatile_functions(formula: &str, values: VolatileValues) -> String {
    let source = replace_zero_arg_function(formula, "TODAY", &values.today.to_string());
    replace_zero_arg_function(&source, "NOW", &values.now.to_string())
}

fn contains_range_text_aggregation(formula: &str) -> bool {
    let upper = formula.to_ascii_uppercase();
    ["CONCAT", "TEXTJOIN"].iter().any(|name| {
        let mut offset = 0;
        while let Some(relative) = upper[offset..].find(name) {
            let start = offset + relative;
            let before = start
                .checked_sub(1)
                .and_then(|index| upper.as_bytes().get(index));
            let mut open = start + name.len();
            while upper
                .as_bytes()
                .get(open)
                .is_some_and(u8::is_ascii_whitespace)
            {
                open += 1;
            }
            if before.is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                || upper.as_bytes().get(open) != Some(&b'(')
            {
                offset = start + name.len();
                continue;
            }
            let mut index = open + 1;
            let mut depth = 1;
            let mut quoted = false;
            while index < formula.len() && depth > 0 {
                match formula.as_bytes()[index] {
                    b'"' => {
                        if quoted && formula.as_bytes().get(index + 1) == Some(&b'"') {
                            index += 2;
                            continue;
                        }
                        quoted = !quoted;
                    }
                    b'(' if !quoted => depth += 1,
                    b')' if !quoted => depth -= 1,
                    b':' if !quoted => return true,
                    _ => {}
                }
                index += 1;
            }
            offset = start + name.len();
        }
        false
    })
}

fn replace_zero_arg_function(source: &str, name: &str, replacement: &str) -> String {
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut index = 0;
    let mut quoted = false;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            quoted = !quoted;
            output.push('"');
            index += 1;
            continue;
        }
        if !quoted
            && index + name.len() <= bytes.len()
            && source[index..index + name.len()].eq_ignore_ascii_case(name)
        {
            let mut end = index + name.len();
            while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                end += 1;
            }
            if bytes.get(end) == Some(&b'(') {
                end += 1;
                while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                    end += 1;
                }
                if bytes.get(end) == Some(&b')') {
                    output.push_str(replacement);
                    index = end + 1;
                    continue;
                }
            }
        }
        let character = source[index..].chars().next().expect("valid UTF-8");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

static FORMULA_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(2));
#[tauri::command]
pub async fn sheet_formula_evaluate(
    state: State<'_, AppState>,
    request: SheetFormulaEvaluationRequest,
    request_id: Option<String>,
) -> Result<SheetFormulaEvaluationResponse, String> {
    let registry = Arc::clone(&state.sheet_formulas);
    let job = super::media_jobs::MediaJob::start(
        request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    )?;
    // Register ownership before waiting: release must retire already-admitted queued work.
    let owner = registry.owner(&request.runtime_id)?;
    let permit = job
        .wait(FORMULA_SLOTS.acquire())
        .await?
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        job.check()?;
        registry.evaluate_owned(&owner, request, job.cancellation_flag())
    })
    .await
    .map_err(|e| format!("sheet formula worker failed: {e}"))?
}

#[tauri::command]
pub fn sheet_formula_release(state: State<'_, AppState>, runtime_id: String) {
    state.sheet_formulas.release(&runtime_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volatile_functions_are_bound_outside_strings_only() {
        assert!(is_volatile_formula("=NOW () + TODAY ( )"));
        assert!(is_volatile_formula("=RAND () + RANDBETWEEN (1,2)"));
        let values = VolatileValues {
            today: 46_000.0,
            now: 46_000.5,
        };
        assert_eq!(
            bind_volatile_functions("=TODAY()+NOW()+\"TODAY()\"", values),
            "=46000+46000.5+\"TODAY()\""
        );
    }

    #[test]
    fn range_text_aggregation_is_rejected_without_false_positives() {
        assert!(contains_range_text_aggregation("=CONCAT(A1:A2)"));
        assert!(contains_range_text_aggregation(
            "=TEXTJOIN(\",\",TRUE,A1:A2)"
        ));
        assert!(!contains_range_text_aggregation("=CONCAT(\"a:b\",\"c\")"));
        assert!(!contains_range_text_aggregation("=CONCAT(\"x\")+A1:A2"));
    }

    fn request(value: f64) -> SheetFormulaEvaluationRequest {
        SheetFormulaEvaluationRequest {
            runtime_id: "test-runtime".to_string(),
            structure_signature: "v1".to_string(),
            worksheets: vec![SheetFormulaWorksheetInput {
                id: "ws1".to_string(),
                name: "Sheet1".to_string(),
            }],
            cells: vec![
                SheetFormulaCellInput {
                    worksheet_id: "ws1".to_string(),
                    row_id: "r1".to_string(),
                    column_id: "c1".to_string(),
                    row: 1,
                    column: 1,
                    formula: None,
                    value_type: Some("number".to_string()),
                    value: Some(Value::from(value)),
                },
                SheetFormulaCellInput {
                    worksheet_id: "ws1".to_string(),
                    row_id: "r1".to_string(),
                    column_id: "c2".to_string(),
                    row: 1,
                    column: 2,
                    formula: Some("=A1*2".to_string()),
                    value_type: None,
                    value: None,
                },
            ],
            evaluation_time: "2026-07-29T12:00:00Z".to_string(),
            time_zone: "Europe/Berlin".to_string(),
            revision: None,
            base_revision: None,
            full_seed: None,
            removed_cells: Vec::new(),
        }
    }

    #[test]
    fn runtime_recalculates_only_dirty_dependents() {
        let registry = SheetFormulaRegistry::default();
        let first = registry.evaluate(request(3.0)).unwrap();
        assert!(!first.incremental);
        assert_eq!(
            first.cells[0].value,
            SheetFormulaComputedValue::Number { value: 6.0 }
        );

        let second = registry.evaluate(request(5.0)).unwrap();
        assert!(second.incremental);
        assert_eq!(
            second.cells[0].value,
            SheetFormulaComputedValue::Number { value: 10.0 }
        );
        assert!(second.recalculated <= 1);
    }

    #[test]
    fn range_text_aggregation_returns_unsupported() {
        let registry = SheetFormulaRegistry::default();
        let mut input = request(3.0);
        input.runtime_id = "range-text-runtime".to_string();
        input.cells.push(SheetFormulaCellInput {
            worksheet_id: "ws1".to_string(),
            row_id: "r2".to_string(),
            column_id: "c1".to_string(),
            row: 2,
            column: 1,
            formula: None,
            value_type: Some("text".to_string()),
            value: Some(Value::from("b")),
        });
        input.cells[1].formula = Some("=CONCAT(A1:A2)".to_string());
        let response = registry.evaluate(input).unwrap();
        assert_eq!(
            response.cells[0].value,
            SheetFormulaComputedValue::Error {
                value: "#N/IMPL!".to_string()
            }
        );
    }
    #[test]
    fn revisioned_deltas_recover_missing_baselines_and_remove_outputs() {
        let registry = SheetFormulaRegistry::default();
        let mut first = request(3.0);
        first.full_seed = Some(true);
        first.revision = Some(1);
        let response = registry.evaluate(first.clone()).unwrap();
        assert_eq!(response.cells.len(), 1);
        let mut delta = request(4.0);
        delta.cells.truncate(1);
        delta.full_seed = Some(false);
        delta.base_revision = Some(1);
        delta.revision = Some(2);
        let response = registry.evaluate(delta.clone()).unwrap();
        assert_eq!(
            response.cells[0].value,
            SheetFormulaComputedValue::Number { value: 8.0 }
        );
        assert!(!response.full_result);
        delta.cells.clear();
        delta.base_revision = Some(2);
        delta.revision = Some(3);
        assert!(registry.evaluate(delta.clone()).unwrap().cells.is_empty());
        delta.removed_cells = vec!["ws1:r1:c2".into()];
        delta.base_revision = Some(3);
        delta.revision = Some(4);
        assert_eq!(
            registry.evaluate(delta.clone()).unwrap().removed_cells,
            vec!["ws1:r1:c2"]
        );
        registry.release(&delta.runtime_id);
        delta.base_revision = Some(4);
        delta.revision = Some(5);
        assert!(registry.evaluate(delta).unwrap().reset_required);
        first.revision = Some(6);
        assert_eq!(registry.evaluate(first).unwrap().cells.len(), 1);
    }
    #[test]
    fn independent_runtime_locking_and_retirement_do_not_wait_for_another_workbook() {
        let registry = SheetFormulaRegistry::default();
        let first = request(3.0);
        let owner = registry.owner(&first.runtime_id).unwrap();
        let guard = owner.runtime.lock();
        let cancel = Arc::new(AtomicBool::new(false));
        *owner.active_cancel.lock() = Some(Arc::clone(&cancel));
        let mut second = request(4.0);
        second.runtime_id = "independent".into();
        assert_eq!(
            registry.evaluate(second).unwrap().cells[0].value,
            SheetFormulaComputedValue::Number { value: 8.0 }
        );
        registry.release(&first.runtime_id);
        assert!(cancel.load(Ordering::Relaxed));
        drop(guard);
        assert!(registry
            .evaluate_owned(&owner, first, Arc::new(AtomicBool::new(false)))
            .unwrap_err()
            .contains("cancelled"));
    }
}
