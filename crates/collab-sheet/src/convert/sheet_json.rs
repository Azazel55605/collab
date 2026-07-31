//! Bridges the conversion model and `.sheet` JSON.
//!
//! Identities are generated positionally (`ws1`, `r1`, `c1`, `style-1`) because
//! a converted workbook has no prior stable identity to preserve — the source
//! format has none. From the first save onwards the normal stable-ID rules
//! apply, so a later insert or delete never renumbers anything.
//!
//! Keep the emitted shape aligned with `src/types/sheet.ts` and the validator in
//! `collab-documents`.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::model::{
    ConvertedBorders, ConvertedCell, ConvertedNumberFormat, ConvertedRange, ConvertedStyle,
    ConvertedValue, ConvertedWorkbook, ConvertedWorksheet,
};
use super::{ConversionError, ConversionLimits, ConversionResult};

pub const SHEET_DOCUMENT_KIND: &str = "collab-sheet";
pub const SHEET_SCHEMA_VERSION: u64 = 1;
/// Matches `SHEET_DEFAULTS` in `src/types/sheet.ts`.
const DEFAULT_ROW_HEIGHT: f64 = 24.0;
const DEFAULT_COLUMN_WIDTH: f64 = 100.0;

fn row_id(index: usize) -> String {
    format!("r{}", index + 1)
}

fn column_id(index: usize) -> String {
    format!("c{}", index + 1)
}

fn worksheet_id(index: usize) -> String {
    format!("ws{}", index + 1)
}

fn number_format_json(format: &ConvertedNumberFormat) -> Value {
    let mut object = Map::new();
    object.insert("kind".into(), Value::String(format.kind.clone()));
    if let Some(decimals) = format.decimals {
        object.insert("decimals".into(), json!(decimals));
    }
    if format.use_thousands_separator {
        object.insert("useThousandsSeparator".into(), Value::Bool(true));
    }
    if let Some(code) = &format.currency_code {
        object.insert("currencyCode".into(), Value::String(code.clone()));
    }
    if let Some(pattern) = &format.pattern {
        object.insert("pattern".into(), Value::String(pattern.clone()));
    }
    Value::Object(object)
}

fn borders_json(borders: &ConvertedBorders) -> Value {
    let mut object = Map::new();
    // `.sheet` stores a per-edge object; a plain thin border is all a
    // conversion can claim, because source border styles do not map one to one.
    for (key, present) in [
        ("top", borders.top),
        ("right", borders.right),
        ("bottom", borders.bottom),
        ("left", borders.left),
    ] {
        if present {
            object.insert(key.into(), json!({ "style": "thin" }));
        }
    }
    Value::Object(object)
}

fn style_json(style: &ConvertedStyle) -> Value {
    let mut object = Map::new();
    if style.bold {
        object.insert("bold".into(), Value::Bool(true));
    }
    if style.italic {
        object.insert("italic".into(), Value::Bool(true));
    }
    if style.underline {
        object.insert("underline".into(), Value::Bool(true));
    }
    if style.strikethrough {
        object.insert("strikethrough".into(), Value::Bool(true));
    }
    if let Some(size) = style.font_size {
        object.insert("fontSize".into(), json!(size));
    }
    if let Some(family) = &style.font_family {
        object.insert("fontFamily".into(), Value::String(family.clone()));
    }
    if let Some(color) = &style.color {
        object.insert("color".into(), Value::String(color.clone()));
    }
    if let Some(color) = &style.background_color {
        object.insert("backgroundColor".into(), Value::String(color.clone()));
    }
    if let Some(align) = &style.horizontal_align {
        object.insert("horizontalAlign".into(), Value::String(align.clone()));
    }
    if let Some(align) = &style.vertical_align {
        object.insert("verticalAlign".into(), Value::String(align.clone()));
    }
    if style.wrap {
        object.insert("wrap".into(), Value::Bool(true));
    }
    if let Some(indent) = style.indent {
        object.insert("indent".into(), json!(indent));
    }
    if style.borders.any() {
        object.insert("borders".into(), borders_json(&style.borders));
    }
    if let Some(format) = &style.number_format {
        object.insert("numberFormat".into(), number_format_json(format));
    }
    Value::Object(object)
}

fn cell_json(cell: &ConvertedCell) -> Value {
    let mut object = Map::new();
    if let Some(formula) = &cell.formula {
        // Formula source is authoritative; the imported value is not written,
        // so the workbook recalculates on open instead of showing stale numbers.
        object.insert("formula".into(), Value::String(formula.clone()));
    } else {
        match &cell.value {
            ConvertedValue::Blank => {}
            ConvertedValue::Number(number) => {
                object.insert("value".into(), json!(number));
                object.insert("valueType".into(), Value::String("number".into()));
            }
            ConvertedValue::Text(text) => {
                object.insert("value".into(), Value::String(text.clone()));
                object.insert("valueType".into(), Value::String("text".into()));
            }
            ConvertedValue::Boolean(value) => {
                object.insert("value".into(), Value::Bool(*value));
                object.insert("valueType".into(), Value::String("boolean".into()));
            }
            ConvertedValue::Error(code) => {
                // A stored error is text: `.sheet` only produces error values
                // from its own evaluation, never from imported content.
                object.insert("value".into(), Value::String(code.clone()));
                object.insert("valueType".into(), Value::String("text".into()));
            }
            ConvertedValue::Date(iso) => {
                object.insert("value".into(), Value::String(iso.clone()));
                object.insert("valueType".into(), Value::String("date".into()));
            }
            ConvertedValue::Time(iso) => {
                object.insert("value".into(), Value::String(iso.clone()));
                object.insert("valueType".into(), Value::String("time".into()));
            }
            ConvertedValue::DateTime(iso) => {
                object.insert("value".into(), Value::String(iso.clone()));
                object.insert("valueType".into(), Value::String("datetime".into()));
            }
        }
    }
    Value::Object(object)
}

fn range_json(range: &ConvertedRange) -> Value {
    json!({
        "startRowId": row_id(range.top),
        "startColumnId": column_id(range.left),
        "endRowId": row_id(range.bottom),
        "endColumnId": column_id(range.right),
    })
}

/// Builds a complete `.sheet` document from a converted workbook.
///
/// `id` and `timestamp` come from the caller so this stays a pure function that
/// tests can compare byte for byte.
pub fn workbook_to_sheet_document(
    workbook: &ConvertedWorkbook,
    id: &str,
    timestamp: &str,
    limits: &ConversionLimits,
) -> ConversionResult<Value> {
    if workbook.worksheets.is_empty() {
        return Err(ConversionError::Malformed(
            "the workbook contains no worksheets".into(),
        ));
    }
    if workbook.worksheets.len() > limits.worksheets {
        return Err(ConversionError::LimitExceeded(format!(
            "a workbook may not have more than {} worksheets",
            limits.worksheets
        )));
    }
    if workbook.populated_cells() > limits.cells_per_workbook {
        return Err(ConversionError::LimitExceeded(format!(
            "a workbook may not have more than {} populated cells",
            limits.cells_per_workbook
        )));
    }
    if workbook.formula_cells() > limits.formula_cells {
        return Err(ConversionError::LimitExceeded(format!(
            "a workbook may not have more than {} formula cells",
            limits.formula_cells
        )));
    }

    // Deduplicated style table: the schema requires shared styles, never a full
    // style object per cell.
    let mut styles = Map::new();
    let mut style_ids: BTreeMap<String, String> = BTreeMap::new();

    let mut worksheets = Vec::with_capacity(workbook.worksheets.len());
    let mut taken_names: Vec<String> = Vec::new();

    for (index, source) in workbook.worksheets.iter().enumerate() {
        if source.cells.len() > limits.cells_per_worksheet {
            return Err(ConversionError::LimitExceeded(format!(
                "a worksheet may not have more than {} populated cells",
                limits.cells_per_worksheet
            )));
        }
        if source.merges.len() > limits.merged_ranges_per_worksheet {
            return Err(ConversionError::LimitExceeded(format!(
                "a worksheet may not have more than {} merged ranges",
                limits.merged_ranges_per_worksheet
            )));
        }

        let row_count = source.row_count.max(1).min(limits.rows_per_worksheet);
        let column_count = source.column_count.max(1).min(limits.columns_per_worksheet);

        let mut cells = Map::new();
        for cell in &source.cells {
            if cell.row >= row_count || cell.column >= column_count {
                continue;
            }
            let mut json_cell = cell_json(cell);
            if let Some(style) = &cell.style {
                if !style.is_empty() {
                    let rendered = style_json(style);
                    let key = rendered.to_string();
                    let style_id = match style_ids.get(&key) {
                        Some(existing) => existing.clone(),
                        None => {
                            if styles.len() >= limits.styles {
                                return Err(ConversionError::LimitExceeded(format!(
                                    "a workbook may not have more than {} styles",
                                    limits.styles
                                )));
                            }
                            let style_id = format!("style-{}", styles.len() + 1);
                            styles.insert(style_id.clone(), rendered);
                            style_ids.insert(key, style_id.clone());
                            style_id
                        }
                    };
                    if let Value::Object(object) = &mut json_cell {
                        object.insert("styleId".into(), Value::String(style_id));
                    }
                }
            }
            if let Value::Object(object) = &json_cell {
                if object.is_empty() {
                    continue;
                }
            }
            cells.insert(
                format!("{}:{}", row_id(cell.row), column_id(cell.column)),
                json_cell,
            );
        }

        let mut worksheet = Map::new();
        worksheet.insert("id".into(), Value::String(worksheet_id(index)));
        worksheet.insert(
            "name".into(),
            Value::String(unique_worksheet_name(
                &source.name,
                index,
                limits.worksheet_name_length,
                &mut taken_names,
            )),
        );
        worksheet.insert(
            "rowOrder".into(),
            Value::Array((0..row_count).map(|i| Value::String(row_id(i))).collect()),
        );
        worksheet.insert(
            "columnOrder".into(),
            Value::Array(
                (0..column_count)
                    .map(|i| Value::String(column_id(i)))
                    .collect(),
            ),
        );
        worksheet.insert("cells".into(), Value::Object(cells));

        let rows: Map<String, Value> = source
            .row_heights
            .iter()
            .filter(|(index, _)| **index < row_count)
            .map(|(index, height)| {
                (
                    row_id(*index),
                    json!({ "id": row_id(*index), "height": height }),
                )
            })
            .collect();
        if !rows.is_empty() {
            worksheet.insert("rows".into(), Value::Object(rows));
        }

        let columns: Map<String, Value> = source
            .column_widths
            .iter()
            .filter(|(index, _)| **index < column_count)
            .map(|(index, width)| {
                (
                    column_id(*index),
                    json!({ "id": column_id(*index), "width": width }),
                )
            })
            .collect();
        if !columns.is_empty() {
            worksheet.insert("columns".into(), Value::Object(columns));
        }

        if source.hidden {
            worksheet.insert("hidden".into(), Value::Bool(true));
        }

        let merges: Vec<Value> = source
            .merges
            .iter()
            .filter(|range| range.bottom < row_count && range.right < column_count)
            .map(range_json)
            .collect();
        if !merges.is_empty() {
            worksheet.insert("mergedRanges".into(), Value::Array(merges));
        }

        if source.frozen_rows > 0 || source.frozen_columns > 0 {
            worksheet.insert(
                "frozen".into(),
                json!({
                    "rows": source.frozen_rows.min(row_count),
                    "columns": source.frozen_columns.min(column_count),
                }),
            );
        }

        worksheets.push(Value::Object(worksheet));
    }

    Ok(json!({
        "kind": SHEET_DOCUMENT_KIND,
        "schemaVersion": SHEET_SCHEMA_VERSION,
        "id": id,
        "name": workbook.name,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "activeWorksheetId": worksheet_id(0),
        "worksheets": Value::Array(worksheets),
        "styles": Value::Object(styles),
    }))
}

fn unique_worksheet_name(
    requested: &str,
    index: usize,
    max_length: usize,
    taken: &mut Vec<String>,
) -> String {
    let trimmed = requested.trim();
    let base = if trimmed.is_empty() {
        format!("Sheet{}", index + 1)
    } else {
        trimmed.chars().take(max_length).collect()
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while taken.iter().any(|name| name.eq_ignore_ascii_case(&candidate)) {
        candidate = format!("{base} ({suffix})");
        suffix += 1;
    }
    taken.push(candidate.clone());
    candidate
}

/* -------------------------------------------------------------------------- */
/* .sheet -> conversion model                                                 */
/* -------------------------------------------------------------------------- */

fn parse_borders(value: Option<&Value>) -> ConvertedBorders {
    let Some(Value::Object(object)) = value else {
        return ConvertedBorders::default();
    };
    ConvertedBorders {
        top: object.contains_key("top"),
        right: object.contains_key("right"),
        bottom: object.contains_key("bottom"),
        left: object.contains_key("left"),
    }
}

fn parse_number_format(value: Option<&Value>) -> Option<ConvertedNumberFormat> {
    let Some(Value::Object(object)) = value else {
        return None;
    };
    Some(ConvertedNumberFormat {
        kind: object.get("kind")?.as_str()?.to_string(),
        decimals: object.get("decimals").and_then(Value::as_u64).map(|v| v as u32),
        use_thousands_separator: object
            .get("useThousandsSeparator")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        currency_code: object
            .get("currencyCode")
            .and_then(Value::as_str)
            .map(str::to_string),
        pattern: object
            .get("pattern")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_style(value: Option<&Value>) -> Option<ConvertedStyle> {
    let Value::Object(object) = value? else {
        return None;
    };
    let style = ConvertedStyle {
        bold: object.get("bold").and_then(Value::as_bool).unwrap_or(false),
        italic: object.get("italic").and_then(Value::as_bool).unwrap_or(false),
        underline: object
            .get("underline")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        strikethrough: object
            .get("strikethrough")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        font_size: object.get("fontSize").and_then(Value::as_f64),
        font_family: object
            .get("fontFamily")
            .and_then(Value::as_str)
            .map(str::to_string),
        color: object.get("color").and_then(Value::as_str).map(str::to_string),
        background_color: object
            .get("backgroundColor")
            .and_then(Value::as_str)
            .map(str::to_string),
        horizontal_align: object
            .get("horizontalAlign")
            .and_then(Value::as_str)
            .map(str::to_string),
        vertical_align: object
            .get("verticalAlign")
            .and_then(Value::as_str)
            .map(str::to_string),
        wrap: object.get("wrap").and_then(Value::as_bool).unwrap_or(false),
        indent: object.get("indent").and_then(Value::as_u64).map(|v| v as u32),
        borders: parse_borders(object.get("borders")),
        number_format: parse_number_format(object.get("numberFormat")),
    };
    (!style.is_empty()).then_some(style)
}

/// Reads a stored `.sheet` document into the conversion model.
///
/// `computed` supplies evaluated formula results, keyed
/// `worksheetId:rowId:columnId`. Export uses them to write a value alongside
/// each formula; without them a formula exports with no cached result, which is
/// valid but shows blank until the consuming application recalculates.
pub fn sheet_document_to_workbook(
    document: &Value,
    computed: &BTreeMap<String, ConvertedValue>,
) -> ConversionResult<ConvertedWorkbook> {
    let object = document.as_object().ok_or_else(|| {
        ConversionError::InvalidSheetDocument("the document must be a JSON object".into())
    })?;
    if object.get("kind").and_then(Value::as_str) != Some(SHEET_DOCUMENT_KIND) {
        return Err(ConversionError::InvalidSheetDocument(
            "the document is not a Collab workbook".into(),
        ));
    }

    let styles = object
        .get("styles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let worksheets_value = object
        .get("worksheets")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ConversionError::InvalidSheetDocument("the document has no worksheets".into())
        })?;

    let mut worksheets = Vec::with_capacity(worksheets_value.len());
    for worksheet_value in worksheets_value {
        let worksheet_object = worksheet_value.as_object().ok_or_else(|| {
            ConversionError::InvalidSheetDocument("each worksheet must be an object".into())
        })?;
        let worksheet_id = worksheet_object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();

        let row_order: Vec<&str> = worksheet_object
            .get("rowOrder")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let column_order: Vec<&str> = worksheet_object
            .get("columnOrder")
            .and_then(Value::as_array)
            .map(|columns| columns.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        let row_index: BTreeMap<&str, usize> = row_order
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect();
        let column_index: BTreeMap<&str, usize> = column_order
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect();

        let mut cells = Vec::new();
        if let Some(cell_map) = worksheet_object.get("cells").and_then(Value::as_object) {
            for (key, cell_value) in cell_map {
                let Some((row_key, column_key)) = key.split_once(':') else {
                    continue;
                };
                let (Some(&row), Some(&column)) =
                    (row_index.get(row_key), column_index.get(column_key))
                else {
                    continue;
                };
                let Some(cell_object) = cell_value.as_object() else {
                    continue;
                };

                let formula = cell_object
                    .get("formula")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let value = if formula.is_some() {
                    computed
                        .get(&format!("{worksheet_id}:{row_key}:{column_key}"))
                        .cloned()
                        .unwrap_or(ConvertedValue::Blank)
                } else {
                    read_cell_value(cell_object)
                };

                let style = cell_object
                    .get("styleId")
                    .and_then(Value::as_str)
                    .and_then(|id| styles.get(id))
                    .and_then(|style| parse_style(Some(style)));

                if formula.is_none() && value.is_blank() && style.is_none() {
                    continue;
                }
                cells.push(ConvertedCell {
                    row,
                    column,
                    value,
                    formula,
                    style,
                });
            }
        }
        cells.sort_by_key(|cell| (cell.row, cell.column));

        let mut column_widths = BTreeMap::new();
        if let Some(columns) = worksheet_object.get("columns").and_then(Value::as_object) {
            for (id, column) in columns {
                if let (Some(&index), Some(width)) = (
                    column_index.get(id.as_str()),
                    column.get("width").and_then(Value::as_f64),
                ) {
                    if (width - DEFAULT_COLUMN_WIDTH).abs() > f64::EPSILON {
                        column_widths.insert(index, width);
                    }
                }
            }
        }

        let mut row_heights = BTreeMap::new();
        if let Some(rows) = worksheet_object.get("rows").and_then(Value::as_object) {
            for (id, row) in rows {
                if let (Some(&index), Some(height)) = (
                    row_index.get(id.as_str()),
                    row.get("height").and_then(Value::as_f64),
                ) {
                    if (height - DEFAULT_ROW_HEIGHT).abs() > f64::EPSILON {
                        row_heights.insert(index, height);
                    }
                }
            }
        }

        let merges = worksheet_object
            .get("mergedRanges")
            .and_then(Value::as_array)
            .map(|ranges| {
                ranges
                    .iter()
                    .filter_map(|range| {
                        let object = range.as_object()?;
                        let top = *row_index.get(object.get("startRowId")?.as_str()?)?;
                        let bottom = *row_index.get(object.get("endRowId")?.as_str()?)?;
                        let left = *column_index.get(object.get("startColumnId")?.as_str()?)?;
                        let right = *column_index.get(object.get("endColumnId")?.as_str()?)?;
                        Some(ConvertedRange {
                            top: top.min(bottom),
                            left: left.min(right),
                            bottom: top.max(bottom),
                            right: left.max(right),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let frozen = worksheet_object.get("frozen").and_then(Value::as_object);
        worksheets.push(ConvertedWorksheet {
            name: worksheet_object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Sheet")
                .to_string(),
            hidden: worksheet_object
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            row_count: row_order.len(),
            column_count: column_order.len(),
            cells,
            column_widths,
            row_heights,
            merges,
            frozen_rows: frozen
                .and_then(|f| f.get("rows"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            frozen_columns: frozen
                .and_then(|f| f.get("columns"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        });
    }

    Ok(ConvertedWorkbook {
        name: object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Workbook")
            .to_string(),
        worksheets,
    })
}

fn read_cell_value(cell: &Map<String, Value>) -> ConvertedValue {
    let value_type = cell.get("valueType").and_then(Value::as_str);
    match cell.get("value") {
        None | Some(Value::Null) => ConvertedValue::Blank,
        Some(Value::Bool(value)) => ConvertedValue::Boolean(*value),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(ConvertedValue::Number)
            .unwrap_or(ConvertedValue::Blank),
        Some(Value::String(text)) => match value_type {
            Some("date") => ConvertedValue::Date(text.clone()),
            Some("time") => ConvertedValue::Time(text.clone()),
            Some("datetime") => ConvertedValue::DateTime(text.clone()),
            _ => ConvertedValue::Text(text.clone()),
        },
        Some(_) => ConvertedValue::Blank,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::DEFAULT_CONVERSION_LIMITS;

    fn workbook() -> ConvertedWorkbook {
        ConvertedWorkbook {
            name: "Budget".into(),
            worksheets: vec![ConvertedWorksheet {
                name: "Q1".into(),
                row_count: 3,
                column_count: 2,
                cells: vec![
                    ConvertedCell {
                        row: 0,
                        column: 0,
                        value: ConvertedValue::Text("Rent".into()),
                        formula: None,
                        style: Some(ConvertedStyle {
                            bold: true,
                            ..Default::default()
                        }),
                    },
                    ConvertedCell {
                        row: 0,
                        column: 1,
                        value: ConvertedValue::Number(1240.0),
                        formula: None,
                        style: None,
                    },
                    ConvertedCell {
                        row: 1,
                        column: 1,
                        value: ConvertedValue::Number(2480.0),
                        formula: Some("=B1*2".into()),
                        style: None,
                    },
                ],
                merges: vec![ConvertedRange {
                    top: 2,
                    left: 0,
                    bottom: 2,
                    right: 1,
                }],
                frozen_rows: 1,
                ..Default::default()
            }],
        }
    }

    #[test]
    fn builds_a_schema_shaped_document() {
        let document = workbook_to_sheet_document(
            &workbook(),
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();

        assert_eq!(document["kind"], "collab-sheet");
        assert_eq!(document["schemaVersion"], 1);
        assert_eq!(document["activeWorksheetId"], "ws1");
        let worksheet = &document["worksheets"][0];
        assert_eq!(worksheet["rowOrder"].as_array().unwrap().len(), 3);
        assert_eq!(worksheet["cells"]["r1:c1"]["value"], "Rent");
        assert_eq!(worksheet["cells"]["r1:c1"]["styleId"], "style-1");
        assert_eq!(worksheet["frozen"]["rows"], 1);
        assert_eq!(worksheet["mergedRanges"][0]["startRowId"], "r3");
        assert_eq!(document["styles"]["style-1"]["bold"], true);
    }

    #[test]
    fn never_writes_a_computed_result_next_to_a_formula() {
        // Formula source is authoritative; storing the imported value would
        // create a second source of truth that survives as a stale number.
        let document = workbook_to_sheet_document(
            &workbook(),
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        let cell = &document["worksheets"][0]["cells"]["r2:c2"];
        assert_eq!(cell["formula"], "=B1*2");
        assert!(cell.get("value").is_none());
    }

    #[test]
    fn deduplicates_identical_styles() {
        let mut source = workbook();
        let bold = Some(ConvertedStyle {
            bold: true,
            ..Default::default()
        });
        source.worksheets[0].cells[1].style = bold.clone();
        source.worksheets[0].cells[2].style = bold;

        let document = workbook_to_sheet_document(
            &source,
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        assert_eq!(document["styles"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn renames_duplicate_worksheets_instead_of_colliding() {
        let source = ConvertedWorkbook {
            name: "Book".into(),
            worksheets: vec![
                ConvertedWorksheet {
                    name: "Data".into(),
                    row_count: 1,
                    column_count: 1,
                    ..Default::default()
                },
                ConvertedWorksheet {
                    name: "data".into(),
                    row_count: 1,
                    column_count: 1,
                    ..Default::default()
                },
            ],
        };
        let document = workbook_to_sheet_document(
            &source,
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        assert_eq!(document["worksheets"][0]["name"], "Data");
        assert_eq!(document["worksheets"][1]["name"], "data (2)");
    }

    #[test]
    fn round_trips_through_the_sheet_document() {
        let document = workbook_to_sheet_document(
            &workbook(),
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        let back = sheet_document_to_workbook(&document, &BTreeMap::new()).unwrap();

        assert_eq!(back.name, "Budget");
        assert_eq!(back.worksheets.len(), 1);
        let worksheet = &back.worksheets[0];
        assert_eq!(worksheet.name, "Q1");
        assert_eq!(worksheet.frozen_rows, 1);
        assert_eq!(worksheet.merges.len(), 1);
        assert_eq!(
            worksheet.cell_at(0, 0).unwrap().value,
            ConvertedValue::Text("Rent".into())
        );
        assert_eq!(
            worksheet.cell_at(1, 1).unwrap().formula.as_deref(),
            Some("=B1*2")
        );
        // Without computed values a formula exports with no cached result.
        assert!(worksheet.cell_at(1, 1).unwrap().value.is_blank());
    }

    #[test]
    fn export_uses_supplied_computed_values() {
        let document = workbook_to_sheet_document(
            &workbook(),
            "wb-1",
            "2026-01-01T00:00:00.000Z",
            &DEFAULT_CONVERSION_LIMITS,
        )
        .unwrap();
        let mut computed = BTreeMap::new();
        computed.insert("ws1:r2:c2".to_string(), ConvertedValue::Number(2480.0));

        let back = sheet_document_to_workbook(&document, &computed).unwrap();
        assert_eq!(
            back.worksheets[0].cell_at(1, 1).unwrap().value,
            ConvertedValue::Number(2480.0)
        );
    }

    #[test]
    fn rejects_a_document_that_is_not_a_workbook() {
        let document = json!({ "kind": "collab-kanban" });
        assert!(matches!(
            sheet_document_to_workbook(&document, &BTreeMap::new()),
            Err(ConversionError::InvalidSheetDocument(_))
        ));
    }

    #[test]
    fn rejects_a_workbook_over_the_worksheet_limit() {
        let source = ConvertedWorkbook {
            name: "Big".into(),
            worksheets: (0..201)
                .map(|index| ConvertedWorksheet {
                    name: format!("S{index}"),
                    row_count: 1,
                    column_count: 1,
                    ..Default::default()
                })
                .collect(),
        };
        assert!(matches!(
            workbook_to_sheet_document(
                &source,
                "wb-1",
                "2026-01-01T00:00:00.000Z",
                &DEFAULT_CONVERSION_LIMITS
            ),
            Err(ConversionError::LimitExceeded(_))
        ));
    }
}
