//! Phase 0 technical proof for the Advanced Tables plan.
//!
//! These tests are the executable half of
//! `docs/plans/advanced-tables-phase0-contract.md`. They prove the properties
//! the exit gate depends on: incremental dependency updates, cross-sheet
//! references, terminating cycles, stable unsupported-function behavior,
//! bounded recalculation, and workable performance at the target scale.

use std::time::{Duration, Instant};

use collab_sheet::{
    SheetCellRef, SheetEngineError, SheetFormulaBudget, SheetFormulaEngine, SheetFormulaError,
    SheetFormulaValue,
};

fn engine() -> SheetFormulaEngine {
    let mut engine = SheetFormulaEngine::new(SheetFormulaBudget::default());
    engine.add_worksheet("Sheet1").unwrap();
    engine
}

fn cell(sheet: &str, row: u32, column: u32) -> SheetCellRef {
    SheetCellRef::new(sheet, row, column)
}

fn evaluate_one(engine: &mut SheetFormulaEngine, target: &SheetCellRef) -> SheetFormulaValue {
    engine
        .evaluate(std::slice::from_ref(target))
        .unwrap()
        .remove(0)
}

#[test]
fn recalculates_dependents_after_a_value_edit() {
    let mut engine = engine();
    engine
        .set_value(&cell("Sheet1", 1, 1), SheetFormulaValue::number(100.0))
        .unwrap();
    engine
        .set_value(&cell("Sheet1", 2, 1), SheetFormulaValue::number(5.0))
        .unwrap();
    engine
        .set_formula(&cell("Sheet1", 1, 2), "=SUM(A1:A2)")
        .unwrap();

    let total = cell("Sheet1", 1, 2);
    assert_eq!(
        evaluate_one(&mut engine, &total),
        SheetFormulaValue::number(105.0)
    );

    engine
        .set_value(&cell("Sheet1", 2, 1), SheetFormulaValue::number(7.0))
        .unwrap();
    assert_eq!(
        evaluate_one(&mut engine, &total),
        SheetFormulaValue::number(107.0)
    );
}

#[test]
fn resolves_cross_sheet_references() {
    let mut engine = engine();
    engine.add_worksheet("Data").unwrap();
    engine
        .set_value(&cell("Data", 1, 1), SheetFormulaValue::number(21.0))
        .unwrap();
    engine
        .set_formula(&cell("Sheet1", 1, 1), "=Data!A1*2")
        .unwrap();

    let target = cell("Sheet1", 1, 1);
    assert_eq!(
        evaluate_one(&mut engine, &target),
        SheetFormulaValue::number(42.0)
    );

    engine
        .set_value(&cell("Data", 1, 1), SheetFormulaValue::number(50.0))
        .unwrap();
    assert_eq!(
        evaluate_one(&mut engine, &target),
        SheetFormulaValue::number(100.0)
    );
}

#[test]
fn cycles_terminate_with_a_stable_error() {
    let mut engine = engine();
    engine.set_formula(&cell("Sheet1", 1, 1), "=B1+1").unwrap();
    engine.set_formula(&cell("Sheet1", 1, 2), "=A1+1").unwrap();

    let started = Instant::now();
    let value = evaluate_one(&mut engine, &cell("Sheet1", 1, 1));
    assert_eq!(value.as_error(), Some(SheetFormulaError::Circular));
    assert_eq!(value.as_error().unwrap().code(), "#CIRC!");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "cycle detection must not approach the evaluation budget"
    );
}

#[test]
fn unknown_and_malformed_formulas_produce_visible_errors() {
    let mut engine = engine();
    engine
        .set_formula(&cell("Sheet1", 1, 1), "=FROBNICATE(1)")
        .unwrap();
    engine.set_formula(&cell("Sheet1", 2, 1), "=SUM((").unwrap();

    assert_eq!(
        evaluate_one(&mut engine, &cell("Sheet1", 1, 1)).as_error(),
        Some(SheetFormulaError::Name),
        "an unsupported function must not silently return a stale value"
    );
    assert_eq!(
        evaluate_one(&mut engine, &cell("Sheet1", 2, 1)).as_error(),
        Some(SheetFormulaError::Malformed)
    );
    // The engine rewrites malformed source into its own diagnostic text, so it
    // cannot be trusted to hand the user's formula back. The `.sheet` document
    // stays the authoritative source of formula text.
    let engine_text = engine.engine_formula_text(&cell("Sheet1", 2, 1)).unwrap();
    assert_ne!(engine_text, "=SUM((");
    assert!(engine_text.contains("#ERROR!"), "{engine_text}");
}

#[test]
fn network_and_external_data_functions_are_not_available() {
    let mut engine = engine();
    for (row, formula) in [
        "=WEBSERVICE(\"https://example.com\")",
        "=IMPORTRANGE(\"https://example.com\",\"A1\")",
        "=RTD(\"a\",\"b\",\"c\")",
    ]
    .iter()
    .enumerate()
    {
        let target = cell("Sheet1", row as u32 + 1, 1);
        engine.set_formula(&target, formula).unwrap();
        let error = evaluate_one(&mut engine, &target).as_error();
        assert!(
            matches!(
                error,
                Some(SheetFormulaError::Name) | Some(SheetFormulaError::Unsupported)
            ),
            "{formula} must not resolve to a working external-data call (got {error:?})"
        );
    }
}

#[test]
fn baseline_function_set_is_covered() {
    let mut engine = engine();
    engine
        .set_values(
            "Sheet1",
            1,
            1,
            vec![
                vec![SheetFormulaValue::number(4.0)],
                vec![SheetFormulaValue::number(6.0)],
                vec![SheetFormulaValue::number(10.0)],
            ],
        )
        .unwrap();

    let cases: &[(&str, SheetFormulaValue)] = &[
        ("=SUM(A1:A3)", SheetFormulaValue::number(20.0)),
        ("=AVERAGE(A1:A3)", SheetFormulaValue::number(20.0 / 3.0)),
        ("=MIN(A1:A3)", SheetFormulaValue::number(4.0)),
        ("=MAX(A1:A3)", SheetFormulaValue::number(10.0)),
        ("=COUNT(A1:A3)", SheetFormulaValue::number(3.0)),
        ("=COUNTA(A1:A3)", SheetFormulaValue::number(3.0)),
        ("=IF(A1>1,\"yes\",\"no\")", SheetFormulaValue::text("yes")),
        ("=IFS(A1>5,\"big\",TRUE,\"small\")", SheetFormulaValue::text("small")),
        ("=AND(A1>1,A2>1)", SheetFormulaValue::boolean(true)),
        ("=OR(A1>100,A2>1)", SheetFormulaValue::boolean(true)),
        ("=NOT(A1>100)", SheetFormulaValue::boolean(true)),
        ("=IFERROR(1/0,\"safe\")", SheetFormulaValue::text("safe")),
        ("=ROUND(A1/3,2)", SheetFormulaValue::number(1.33)),
        ("=ABS(0-A1)", SheetFormulaValue::number(4.0)),
        ("=MOD(A3,A2)", SheetFormulaValue::number(4.0)),
        ("=SQRT(A2*6)", SheetFormulaValue::number(6.0)),
        ("=POWER(2,10)", SheetFormulaValue::number(1024.0)),
        ("=LEN(\"abcd\")", SheetFormulaValue::number(4.0)),
        ("=LEFT(\"abcd\",2)", SheetFormulaValue::text("ab")),
        ("=RIGHT(\"abcd\",2)", SheetFormulaValue::text("cd")),
        ("=MID(\"abcd\",2,2)", SheetFormulaValue::text("bc")),
        ("=TRIM(\"  x  \")", SheetFormulaValue::text("x")),
        ("=CONCAT(\"a\",\"b\")", SheetFormulaValue::text("ab")),
        ("=YEAR(DATE(2026,7,29))", SheetFormulaValue::number(2026.0)),
        ("=MONTH(DATE(2026,7,29))", SheetFormulaValue::number(7.0)),
        ("=DAY(DATE(2026,7,29))", SheetFormulaValue::number(29.0)),
        ("=SUMIF(A1:A3,\">5\")", SheetFormulaValue::number(16.0)),
        ("=SUMIFS(A1:A3,A1:A3,\">5\")", SheetFormulaValue::number(16.0)),
        ("=COUNTIF(A1:A3,\">5\")", SheetFormulaValue::number(2.0)),
        ("=COUNTIFS(A1:A3,\">5\")", SheetFormulaValue::number(2.0)),
        ("=AVERAGEIF(A1:A3,\">5\")", SheetFormulaValue::number(8.0)),
        ("=AVERAGEIFS(A1:A3,A1:A3,\">5\")", SheetFormulaValue::number(8.0)),
        ("=INDEX(A1:A3,2,1)", SheetFormulaValue::number(6.0)),
        ("=MATCH(6,A1:A3,0)", SheetFormulaValue::number(2.0)),
        ("=VLOOKUP(6,A1:A3,1,FALSE)", SheetFormulaValue::number(6.0)),
        ("=XLOOKUP(6,A1:A3,A1:A3)", SheetFormulaValue::number(6.0)),
        ("=1+2*3", SheetFormulaValue::number(7.0)),
        ("=(1+2)*3", SheetFormulaValue::number(9.0)),
        ("=\"a\"&\"b\"", SheetFormulaValue::text("ab")),
        ("=A1<A2", SheetFormulaValue::boolean(true)),
        ("=$A$1+A$2", SheetFormulaValue::number(10.0)),
    ];

    for (index, (formula, expected)) in cases.iter().enumerate() {
        let target = cell("Sheet1", index as u32 + 1, 5);
        engine.set_formula(&target, formula).unwrap();
        let actual = evaluate_one(&mut engine, &target);
        match (&actual, expected) {
            (
                SheetFormulaValue::Number { value: got },
                SheetFormulaValue::Number { value: want },
            ) => assert!(
                (got - want).abs() < 1e-9,
                "{formula} => {got} (expected {want})"
            ),
            _ => assert_eq!(&actual, expected, "{formula}"),
        }
    }
}

/// `TEXTJOIN`/`CONCAT` over a *range* collapse to the first cell in
/// formualizer 0.7.1. Recorded here so the defect is tracked rather than
/// discovered later; Phase 3 must re-check it and either report upstream or
/// implement the range form in the adapter.
#[test]
fn known_upstream_gap_range_text_aggregation() {
    let mut engine = engine();
    engine
        .set_values(
            "Sheet1",
            1,
            1,
            vec![
                vec![SheetFormulaValue::text("a")],
                vec![SheetFormulaValue::text("b")],
            ],
        )
        .unwrap();
    engine
        .set_formula(&cell("Sheet1", 1, 3), "=TEXTJOIN(\",\",TRUE,A1:A2)")
        .unwrap();

    let actual = evaluate_one(&mut engine, &cell("Sheet1", 1, 3));
    assert_eq!(
        actual,
        SheetFormulaValue::text("a"),
        "if this now returns \"a,b\", the upstream gap is fixed — update the \
         Phase 0 contract and delete this test"
    );
}

#[test]
fn evaluation_is_bounded_by_the_time_budget() {
    let mut engine = SheetFormulaEngine::new(SheetFormulaBudget::new(
        SheetFormulaBudget::DEFAULT_MAX_FORMULA_CELLS,
        Duration::from_millis(1),
    ));
    engine.add_worksheet("Sheet1").unwrap();
    engine
        .set_value(&cell("Sheet1", 1, 1), SheetFormulaValue::number(1.0))
        .unwrap();
    for row in 2..=20_000u32 {
        engine
            .set_formula(&cell("Sheet1", row, 1), &format!("=A{}+1", row - 1))
            .unwrap();
    }

    let started = Instant::now();
    let outcome = engine.evaluate(&[cell("Sheet1", 20_000, 1)]);
    assert!(
        matches!(outcome, Err(SheetEngineError::EvaluationTimeout(_))),
        "expected a budget timeout, got {outcome:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a cancelled evaluation must return promptly"
    );
}

#[test]
fn formula_cell_budget_is_enforced() {
    let mut engine =
        SheetFormulaEngine::new(SheetFormulaBudget::new(2, Duration::from_secs(1)));
    engine.add_worksheet("Sheet1").unwrap();
    engine.set_formula(&cell("Sheet1", 1, 1), "=1").unwrap();
    engine.set_formula(&cell("Sheet1", 2, 1), "=2").unwrap();
    assert_eq!(
        engine.set_formula(&cell("Sheet1", 3, 1), "=3"),
        Err(SheetEngineError::FormulaBudgetExceeded { limit: 2 })
    );
    // Rewriting an existing formula stays allowed at the limit.
    engine.set_formula(&cell("Sheet1", 1, 1), "=9").unwrap();
    assert_eq!(engine.formula_cell_count(), 2);
}

#[test]
fn unknown_worksheets_are_rejected_rather_than_created() {
    let mut engine = engine();
    assert_eq!(
        engine.set_value(&cell("Missing", 1, 1), SheetFormulaValue::number(1.0)),
        Err(SheetEngineError::UnknownWorksheet("Missing".into()))
    );
    assert_eq!(
        engine.add_worksheet("Sheet1"),
        Err(SheetEngineError::DuplicateWorksheet("Sheet1".into()))
    );
    assert_eq!(engine.worksheet_names(), vec!["Sheet1".to_string()]);
}

/// Scale proof: 100,000 populated cells in a far larger logical grid, plus a
/// dependent formula column. Bounds are deliberately loose — this guards
/// against an order-of-magnitude regression, not against machine variance. The
/// measured Phase 0 numbers live in the contract document.
#[test]
fn sustains_a_hundred_thousand_populated_cells() {
    let mut engine = engine();
    let rows: Vec<Vec<SheetFormulaValue>> = (1..=1_000u32)
        .map(|row| {
            (1..=100u32)
                .map(|column| SheetFormulaValue::number((row * column) as f64))
                .collect()
        })
        .collect();

    let started = Instant::now();
    engine.set_values("Sheet1", 1, 1, rows).unwrap();
    let load = started.elapsed();
    assert!(load < Duration::from_secs(10), "bulk load took {load:?}");

    for row in 1..=1_000u32 {
        engine
            .set_formula(&cell("Sheet1", row, 200), &format!("=SUM(A{row}:CV{row})"))
            .unwrap();
    }

    let started = Instant::now();
    let computed = engine.evaluate_all().unwrap();
    let cold = started.elapsed();
    assert_eq!(computed, 1_000);
    assert!(cold < Duration::from_secs(5), "cold recalc took {cold:?}");

    // Row 1 sums 1*1..1*100 = 5050.
    assert_eq!(
        engine.cached_value(&cell("Sheet1", 1, 200)),
        SheetFormulaValue::number(5050.0)
    );

    // One edit must dirty one dependent, not the whole grid.
    engine
        .set_value(&cell("Sheet1", 1, 1), SheetFormulaValue::number(0.0))
        .unwrap();
    let started = Instant::now();
    let computed = engine.evaluate_all().unwrap();
    let incremental = started.elapsed();
    assert_eq!(computed, 1, "recalculation must be dependency-scoped");
    assert!(
        incremental < Duration::from_millis(500),
        "incremental recalc took {incremental:?}"
    );
    assert_eq!(
        engine.cached_value(&cell("Sheet1", 1, 200)),
        SheetFormulaValue::number(5049.0)
    );
}
