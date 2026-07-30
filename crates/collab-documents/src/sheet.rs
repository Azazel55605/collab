//! Bounded structural validation for `.sheet` workbooks.
//!
//! This is the shared trust boundary between the native client and the server:
//! both refuse to persist a workbook whose structure is malformed, exceeds the
//! documented limits, or references rows, columns, styles, or worksheets that do
//! not exist. It deliberately does **not** evaluate formulas, resolve values, or
//! interpret styling — that belongs to the editor and to `collab-sheet`.
//!
//! Forward compatibility: a workbook declaring a `schemaVersion` newer than
//! [`CURRENT_SCHEMA_VERSION`] is checked only against the generic JSON bounds
//! applied to every structured document. A newer client may legitimately store
//! shapes this build does not know, and rejecting them would corrupt a vault
//! shared between versions. Unknown fields inside a known version are preserved
//! and ignored.
//!
//! Mirrors `SHEET_LIMITS` in `src/types/sheet.ts`; keep the two in sync.

use serde_json::Value;

pub const SHEET_DOCUMENT_KIND: &str = "collab-sheet";
pub const CURRENT_SCHEMA_VERSION: u64 = 1;

/// Structural limits. A document exceeding any of these is rejected outright
/// rather than truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetLimits {
    pub worksheets_per_workbook: usize,
    pub rows_per_worksheet: usize,
    pub columns_per_worksheet: usize,
    pub populated_cells_per_worksheet: usize,
    pub populated_cells_per_workbook: usize,
    pub formula_cells_per_workbook: usize,
    pub formula_source_length: usize,
    pub cell_text_length: usize,
    pub worksheet_name_length: usize,
    pub styles_per_workbook: usize,
    pub named_ranges_per_workbook: usize,
    pub data_connections_per_workbook: usize,
    pub merged_ranges_per_worksheet: usize,
    pub tables_per_worksheet: usize,
    pub validations_per_worksheet: usize,
    pub conditional_formats_per_worksheet: usize,
    pub protected_ranges_per_worksheet: usize,
    pub charts_per_worksheet: usize,
}

pub const DEFAULT_SHEET_LIMITS: SheetLimits = SheetLimits {
    worksheets_per_workbook: 200,
    rows_per_worksheet: 1_000_000,
    columns_per_worksheet: 16_384,
    populated_cells_per_worksheet: 500_000,
    populated_cells_per_workbook: 1_000_000,
    formula_cells_per_workbook: 200_000,
    formula_source_length: 8_192,
    cell_text_length: 32_768,
    worksheet_name_length: 64,
    styles_per_workbook: 10_000,
    named_ranges_per_workbook: 1_000,
    data_connections_per_workbook: 100,
    merged_ranges_per_worksheet: 10_000,
    tables_per_worksheet: 1_000,
    validations_per_worksheet: 1_000,
    conditional_formats_per_worksheet: 500,
    protected_ranges_per_worksheet: 1_000,
    charts_per_worksheet: 50,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SheetValidationError {
    #[error("sheet document must be a JSON object")]
    NotAnObject,
    #[error("sheet document must declare kind \"{expected}\"")]
    WrongKind { expected: &'static str },
    #[error("sheet document must declare a positive integer schemaVersion")]
    InvalidSchemaVersion,
    #[error("sheet document field '{field}' has the wrong type")]
    WrongType { field: &'static str },
    #[error("sheet document exceeds the {limit}-{unit} limit")]
    LimitExceeded { limit: usize, unit: &'static str },
    #[error("sheet document has a duplicate {kind} identifier '{id}'")]
    DuplicateId { kind: &'static str, id: String },
    #[error("sheet document has an empty or invalid {kind} identifier")]
    InvalidId { kind: &'static str },
    #[error("sheet document references a {kind} '{id}' that does not exist")]
    DanglingReference { kind: &'static str, id: String },
    #[error("sheet cell key '{key}' is not '<rowId>:<columnId>'")]
    InvalidCellKey { key: String },
}

/// Reads the declared schema version, if the document declares one at all.
pub fn schema_version(value: &Value) -> Option<u64> {
    value.get("schemaVersion")?.as_u64()
}

/// True when this build understands the document's schema version well enough
/// to validate its structure.
pub fn is_known_version(value: &Value) -> bool {
    matches!(schema_version(value), Some(version) if version <= CURRENT_SCHEMA_VERSION)
}

/// Validates a parsed `.sheet` document.
///
/// Callers pass documents that already cleared the generic JSON size, entry, and
/// depth bounds. Documents from a newer schema version return `Ok` untouched.
pub fn validate_document(value: &Value, limits: SheetLimits) -> Result<(), SheetValidationError> {
    let object = value.as_object().ok_or(SheetValidationError::NotAnObject)?;

    match schema_version(value) {
        Some(version) if version == 0 => return Err(SheetValidationError::InvalidSchemaVersion),
        Some(version) if version > CURRENT_SCHEMA_VERSION => return Ok(()),
        Some(_) => {}
        None => return Err(SheetValidationError::InvalidSchemaVersion),
    }

    if object.get("kind").and_then(Value::as_str) != Some(SHEET_DOCUMENT_KIND) {
        return Err(SheetValidationError::WrongKind {
            expected: SHEET_DOCUMENT_KIND,
        });
    }

    let styles = match object.get("styles") {
        None | Some(Value::Null) => None,
        Some(Value::Object(styles)) => Some(styles),
        Some(_) => return Err(SheetValidationError::WrongType { field: "styles" }),
    };
    if let Some(styles) = styles {
        check_limit(styles.len(), limits.styles_per_workbook, "style")?;
    }
    let style_exists = |id: &str| {
        styles
            .map(|styles| styles.contains_key(id))
            .unwrap_or(false)
    };

    let worksheets = object.get("worksheets").and_then(Value::as_array).ok_or(
        SheetValidationError::WrongType {
            field: "worksheets",
        },
    )?;
    check_limit(
        worksheets.len(),
        limits.worksheets_per_workbook,
        "worksheet",
    )?;

    let mut worksheet_ids: Vec<String> = Vec::with_capacity(worksheets.len());
    let mut worksheet_tracks: Vec<(String, Vec<String>, Vec<String>)> =
        Vec::with_capacity(worksheets.len());
    let mut workbook_cells = 0usize;
    let mut workbook_formulas = 0usize;

    for worksheet in worksheets {
        let worksheet = worksheet
            .as_object()
            .ok_or(SheetValidationError::WrongType { field: "worksheet" })?;
        let id = identifier(worksheet.get("id"), "worksheet")?;
        if worksheet_ids.iter().any(|existing| existing == &id) {
            return Err(SheetValidationError::DuplicateId {
                kind: "worksheet",
                id,
            });
        }
        worksheet_ids.push(id.clone());

        if let Some(name) = worksheet.get("name") {
            let name = name.as_str().ok_or(SheetValidationError::WrongType {
                field: "worksheet.name",
            })?;
            if name.chars().count() > limits.worksheet_name_length {
                return Err(SheetValidationError::LimitExceeded {
                    limit: limits.worksheet_name_length,
                    unit: "character worksheet name",
                });
            }
        }

        let row_ids = ordered_ids(worksheet.get("rowOrder"), "row", limits.rows_per_worksheet)?;
        let column_ids = ordered_ids(
            worksheet.get("columnOrder"),
            "column",
            limits.columns_per_worksheet,
        )?;
        worksheet_tracks.push((id, row_ids.clone(), column_ids.clone()));

        let cells = match worksheet.get("cells") {
            None | Some(Value::Null) => None,
            Some(Value::Object(cells)) => Some(cells),
            Some(_) => return Err(SheetValidationError::WrongType { field: "cells" }),
        };

        if let Some(cells) = cells {
            check_limit(
                cells.len(),
                limits.populated_cells_per_worksheet,
                "populated cell",
            )?;
            workbook_cells = workbook_cells.saturating_add(cells.len());
            check_limit(
                workbook_cells,
                limits.populated_cells_per_workbook,
                "populated cell",
            )?;

            for (key, cell) in cells {
                let (row_id, column_id) = split_cell_key(key)?;
                if !row_ids.iter().any(|id| id == row_id) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "row",
                        id: row_id.to_string(),
                    });
                }
                if !column_ids.iter().any(|id| id == column_id) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "column",
                        id: column_id.to_string(),
                    });
                }

                let cell = cell
                    .as_object()
                    .ok_or(SheetValidationError::WrongType { field: "cell" })?;

                if let Some(formula) = cell.get("formula") {
                    let formula = formula.as_str().ok_or(SheetValidationError::WrongType {
                        field: "cell.formula",
                    })?;
                    if formula.chars().count() > limits.formula_source_length {
                        return Err(SheetValidationError::LimitExceeded {
                            limit: limits.formula_source_length,
                            unit: "character formula",
                        });
                    }
                    workbook_formulas += 1;
                    check_limit(
                        workbook_formulas,
                        limits.formula_cells_per_workbook,
                        "formula cell",
                    )?;
                }

                if let Some(Value::String(text)) = cell.get("value") {
                    if text.chars().count() > limits.cell_text_length {
                        return Err(SheetValidationError::LimitExceeded {
                            limit: limits.cell_text_length,
                            unit: "character cell value",
                        });
                    }
                }

                if let Some(style_id) = cell.get("styleId") {
                    let style_id = style_id.as_str().ok_or(SheetValidationError::WrongType {
                        field: "cell.styleId",
                    })?;
                    if !style_exists(style_id) {
                        return Err(SheetValidationError::DanglingReference {
                            kind: "style",
                            id: style_id.to_string(),
                        });
                    }
                }
            }
        }

        check_optional_array_limit(
            worksheet.get("mergedRanges"),
            limits.merged_ranges_per_worksheet,
            "merged range",
        )?;
        check_optional_array_limit(
            worksheet.get("tables"),
            limits.tables_per_worksheet,
            "table",
        )?;
        check_optional_array_limit(
            worksheet.get("validations"),
            limits.validations_per_worksheet,
            "validation",
        )?;
        check_optional_array_limit(
            worksheet.get("conditionalFormats"),
            limits.conditional_formats_per_worksheet,
            "conditional format",
        )?;
        check_optional_array_limit(
            worksheet.get("protectedRanges"),
            limits.protected_ranges_per_worksheet,
            "protected range",
        )?;
        check_optional_array_limit(
            worksheet.get("charts"),
            limits.charts_per_worksheet,
            "chart",
        )?;

        for range in optional_array(worksheet.get("mergedRanges"), "mergedRanges")? {
            check_range(range, &row_ids, &column_ids)?;
        }
        for table in optional_array(worksheet.get("tables"), "tables")? {
            let table = table
                .as_object()
                .ok_or(SheetValidationError::WrongType { field: "table" })?;
            let range = table.get("range").ok_or(SheetValidationError::WrongType {
                field: "table.range",
            })?;
            check_range(range, &row_ids, &column_ids)?;
        }
        for validation in optional_array(worksheet.get("validations"), "validations")? {
            let validation = validation
                .as_object()
                .ok_or(SheetValidationError::WrongType {
                    field: "validation",
                })?;
            if let Some(range) = validation.get("sourceRange") {
                check_range(range, &row_ids, &column_ids)?;
            }
            if let Some(anchor) = validation.get("anchor") {
                let anchor = anchor.as_object().ok_or(SheetValidationError::WrongType {
                    field: "validation.anchor",
                })?;
                let row_id = anchor.get("rowId").and_then(Value::as_str).ok_or(
                    SheetValidationError::WrongType {
                        field: "validation.anchor.rowId",
                    },
                )?;
                let column_id = anchor.get("columnId").and_then(Value::as_str).ok_or(
                    SheetValidationError::WrongType {
                        field: "validation.anchor.columnId",
                    },
                )?;
                if !row_ids.iter().any(|id| id == row_id) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "row",
                        id: row_id.to_string(),
                    });
                }
                if !column_ids.iter().any(|id| id == column_id) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "column",
                        id: column_id.to_string(),
                    });
                }
            }
        }
        for format in optional_array(worksheet.get("conditionalFormats"), "conditionalFormats")? {
            let format = format.as_object().ok_or(SheetValidationError::WrongType {
                field: "conditionalFormat",
            })?;
            for range in optional_array(format.get("ranges"), "conditionalFormat.ranges")? {
                check_range(range, &row_ids, &column_ids)?;
            }
            if let Some(style_id) = format.get("styleId") {
                let style_id = style_id.as_str().ok_or(SheetValidationError::WrongType {
                    field: "conditionalFormat.styleId",
                })?;
                if !style_exists(style_id) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "style",
                        id: style_id.to_string(),
                    });
                }
            }
        }
        for protected_range in optional_array(worksheet.get("protectedRanges"), "protectedRanges")?
        {
            let protected_range =
                protected_range
                    .as_object()
                    .ok_or(SheetValidationError::WrongType {
                        field: "protectedRange",
                    })?;
            let range = protected_range
                .get("range")
                .ok_or(SheetValidationError::WrongType {
                    field: "protectedRange.range",
                })?;
            check_range(range, &row_ids, &column_ids)?;
        }
        let mut chart_ids = Vec::new();
        for chart in optional_array(worksheet.get("charts"), "charts")? {
            let chart = chart
                .as_object()
                .ok_or(SheetValidationError::WrongType { field: "chart" })?;
            let id = identifier(chart.get("id"), "chart")?;
            if chart_ids.iter().any(|existing| existing == &id) {
                return Err(SheetValidationError::DuplicateId { kind: "chart", id });
            }
            chart_ids.push(id);
            let kind = chart.get("kind").and_then(Value::as_str).ok_or(
                SheetValidationError::WrongType {
                    field: "chart.kind",
                },
            )?;
            if !matches!(
                kind,
                "column" | "bar" | "line" | "area" | "pie" | "scatter" | "sparkline"
            ) {
                return Err(SheetValidationError::WrongType {
                    field: "chart.kind",
                });
            }
            let anchor = chart.get("anchor").and_then(Value::as_object).ok_or(
                SheetValidationError::WrongType {
                    field: "chart.anchor",
                },
            )?;
            let anchor_row = anchor.get("rowId").and_then(Value::as_str).ok_or(
                SheetValidationError::WrongType {
                    field: "chart.anchor.rowId",
                },
            )?;
            let anchor_column = anchor.get("columnId").and_then(Value::as_str).ok_or(
                SheetValidationError::WrongType {
                    field: "chart.anchor.columnId",
                },
            )?;
            if !row_ids.iter().any(|row| row == anchor_row) {
                return Err(SheetValidationError::DanglingReference {
                    kind: "row",
                    id: anchor_row.to_string(),
                });
            }
            if !column_ids.iter().any(|column| column == anchor_column) {
                return Err(SheetValidationError::DanglingReference {
                    kind: "column",
                    id: anchor_column.to_string(),
                });
            }
            let series = optional_array(chart.get("series"), "chart.series")?;
            if series.is_empty() {
                return Err(SheetValidationError::WrongType {
                    field: "chart.series",
                });
            }
            let mut series_ids = Vec::new();
            for item in series {
                let item = item.as_object().ok_or(SheetValidationError::WrongType {
                    field: "chart.series",
                })?;
                let series_id = identifier(item.get("id"), "chart series")?;
                if series_ids.iter().any(|existing| existing == &series_id) {
                    return Err(SheetValidationError::DuplicateId {
                        kind: "chart series",
                        id: series_id,
                    });
                }
                series_ids.push(series_id);
                check_range(
                    item.get("valuesRange")
                        .ok_or(SheetValidationError::WrongType {
                            field: "chart.series.valuesRange",
                        })?,
                    &row_ids,
                    &column_ids,
                )?;
                if let Some(categories) = item.get("categoriesRange") {
                    check_range(categories, &row_ids, &column_ids)?;
                }
            }
        }
    }

    if let Some(active) = object.get("activeWorksheetId") {
        let active = active.as_str().ok_or(SheetValidationError::WrongType {
            field: "activeWorksheetId",
        })?;
        if !worksheet_ids.iter().any(|id| id == active) {
            return Err(SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: active.to_string(),
            });
        }
    }

    let named_ranges = optional_array(object.get("namedRanges"), "namedRanges")?;
    check_limit(
        named_ranges.len(),
        limits.named_ranges_per_workbook,
        "named range",
    )?;
    let mut named_range_ids: Vec<String> = Vec::with_capacity(named_ranges.len());
    let mut accepted_names: Vec<(String, Option<String>)> = Vec::with_capacity(named_ranges.len());
    for named_range in named_ranges {
        let named_range = named_range
            .as_object()
            .ok_or(SheetValidationError::WrongType {
                field: "namedRange",
            })?;
        let id = identifier(named_range.get("id"), "named range")?;
        if named_range_ids.iter().any(|existing| existing == &id) {
            return Err(SheetValidationError::DuplicateId {
                kind: "named range",
                id,
            });
        }
        named_range_ids.push(id);
        let name = named_range.get("name").and_then(Value::as_str).ok_or(
            SheetValidationError::WrongType {
                field: "namedRange.name",
            },
        )?;
        if !valid_named_range_name(name) {
            return Err(SheetValidationError::InvalidId {
                kind: "named range name",
            });
        }
        let worksheet_id = named_range
            .get("worksheetId")
            .and_then(Value::as_str)
            .ok_or(SheetValidationError::WrongType {
                field: "namedRange.worksheetId",
            })?;
        if !worksheet_ids.iter().any(|id| id == worksheet_id) {
            return Err(SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: worksheet_id.to_string(),
            });
        }
        let scope_worksheet_id = match named_range.get("scopeWorksheetId") {
            None => None,
            Some(value) => {
                let scope = value.as_str().ok_or(SheetValidationError::WrongType {
                    field: "namedRange.scopeWorksheetId",
                })?;
                if !worksheet_ids.iter().any(|id| id == scope) {
                    return Err(SheetValidationError::DanglingReference {
                        kind: "worksheet",
                        id: scope.to_string(),
                    });
                }
                Some(scope.to_string())
            }
        };
        let normalized_name = name.to_ascii_lowercase();
        if accepted_names
            .iter()
            .any(|(accepted_name, accepted_scope)| {
                accepted_name == &normalized_name
                    && (accepted_scope.is_none()
                        || scope_worksheet_id.is_none()
                        || accepted_scope == &scope_worksheet_id)
            })
        {
            return Err(SheetValidationError::DuplicateId {
                kind: "visible named range",
                id: name.to_string(),
            });
        }
        accepted_names.push((normalized_name, scope_worksheet_id));
        let (_, row_ids, column_ids) = worksheet_tracks
            .iter()
            .find(|(id, _, _)| id == worksheet_id)
            .expect("validated worksheet has track metadata");
        let range = named_range
            .get("range")
            .ok_or(SheetValidationError::WrongType {
                field: "namedRange.range",
            })?;
        check_range(range, row_ids, column_ids)?;
    }

    let data_connections = optional_array(object.get("dataConnections"), "dataConnections")?;
    check_limit(
        data_connections.len(),
        limits.data_connections_per_workbook,
        "data connection",
    )?;
    let mut connection_ids = Vec::new();
    for connection in data_connections {
        let connection = connection
            .as_object()
            .ok_or(SheetValidationError::WrongType {
                field: "dataConnection",
            })?;
        let id = identifier(connection.get("id"), "data connection")?;
        if connection_ids.iter().any(|existing| existing == &id) {
            return Err(SheetValidationError::DuplicateId {
                kind: "data connection",
                id,
            });
        }
        connection_ids.push(id);
        let kind = connection.get("kind").and_then(Value::as_str).ok_or(
            SheetValidationError::WrongType {
                field: "dataConnection.kind",
            },
        )?;
        if !matches!(kind, "kanbanTasks" | "calendarItems") {
            return Err(SheetValidationError::WrongType {
                field: "dataConnection.kind",
            });
        }
        let worksheet_id = connection
            .get("targetWorksheetId")
            .and_then(Value::as_str)
            .ok_or(SheetValidationError::WrongType {
                field: "dataConnection.targetWorksheetId",
            })?;
        let (_, rows, columns) = worksheet_tracks
            .iter()
            .find(|(candidate, _, _)| candidate == worksheet_id)
            .ok_or_else(|| SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: worksheet_id.to_string(),
            })?;
        check_range(
            connection
                .get("targetRange")
                .ok_or(SheetValidationError::WrongType {
                    field: "dataConnection.targetRange",
                })?,
            rows,
            columns,
        )?;
    }

    Ok(())
}

fn check_limit(
    actual: usize,
    limit: usize,
    unit: &'static str,
) -> Result<(), SheetValidationError> {
    if actual > limit {
        return Err(SheetValidationError::LimitExceeded { limit, unit });
    }
    Ok(())
}

fn optional_array<'a>(
    value: Option<&'a Value>,
    field: &'static str,
) -> Result<&'a [Value], SheetValidationError> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        Some(_) => Err(SheetValidationError::WrongType { field }),
    }
}

fn check_optional_array_limit(
    value: Option<&Value>,
    limit: usize,
    unit: &'static str,
) -> Result<(), SheetValidationError> {
    if let Some(Value::Array(values)) = value {
        check_limit(values.len(), limit, unit)?;
    }
    Ok(())
}

fn identifier(value: Option<&Value>, kind: &'static str) -> Result<String, SheetValidationError> {
    let id = value
        .and_then(Value::as_str)
        .ok_or(SheetValidationError::InvalidId { kind })?;
    if id.is_empty() || id.contains(':') {
        return Err(SheetValidationError::InvalidId { kind });
    }
    Ok(id.to_string())
}

/// Row and column orders are the positional truth of a worksheet, so their IDs
/// must be present, unique, and free of the `:` used as the cell-key separator.
fn ordered_ids(
    value: Option<&Value>,
    kind: &'static str,
    limit: usize,
) -> Result<Vec<String>, SheetValidationError> {
    let values = match value {
        Some(Value::Array(values)) => values,
        _ => {
            return Err(SheetValidationError::WrongType {
                field: if kind == "row" {
                    "rowOrder"
                } else {
                    "columnOrder"
                },
            })
        }
    };
    check_limit(values.len(), limit, kind)?;

    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let id = identifier(Some(value), kind)?;
        if ids.contains(&id) {
            return Err(SheetValidationError::DuplicateId { kind, id });
        }
        ids.push(id);
    }
    Ok(ids)
}

fn split_cell_key(key: &str) -> Result<(&str, &str), SheetValidationError> {
    match key.split_once(':') {
        Some((row, column)) if !row.is_empty() && !column.is_empty() => Ok((row, column)),
        _ => Err(SheetValidationError::InvalidCellKey {
            key: key.to_string(),
        }),
    }
}

fn valid_named_range_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_')
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '.'
        })
    {
        return false;
    }

    let letter_count = name
        .chars()
        .take_while(|character| character.is_ascii_alphabetic())
        .count();
    let suffix = &name[letter_count..];
    !(letter_count > 0
        && letter_count <= 3
        && !suffix.is_empty()
        && !suffix.starts_with('0')
        && suffix.chars().all(|character| character.is_ascii_digit()))
}

fn check_range(
    range: &Value,
    row_ids: &[String],
    column_ids: &[String],
) -> Result<(), SheetValidationError> {
    let range = range
        .as_object()
        .ok_or(SheetValidationError::WrongType { field: "range" })?;
    for field in ["startRowId", "endRowId"] {
        let id = range
            .get(field)
            .and_then(Value::as_str)
            .ok_or(SheetValidationError::WrongType { field: "range.row" })?;
        if !row_ids.iter().any(|existing| existing == id) {
            return Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: id.to_string(),
            });
        }
    }
    for field in ["startColumnId", "endColumnId"] {
        let id =
            range
                .get(field)
                .and_then(Value::as_str)
                .ok_or(SheetValidationError::WrongType {
                    field: "range.column",
                })?;
        if !column_ids.iter().any(|existing| existing == id) {
            return Err(SheetValidationError::DanglingReference {
                kind: "column",
                id: id.to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workbook() -> Value {
        json!({
            "kind": "collab-sheet",
            "schemaVersion": 1,
            "id": "wb1",
            "name": "Book",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "activeWorksheetId": "ws1",
            "worksheets": [{
                "id": "ws1",
                "name": "Sheet1",
                "rowOrder": ["r1", "r2"],
                "columnOrder": ["c1", "c2"],
                "cells": {
                    "r1:c1": { "value": 1, "valueType": "number" },
                    "r2:c2": { "formula": "=A1+1" }
                }
            }],
            "styles": {}
        })
    }

    #[test]
    fn accepts_a_well_formed_workbook() {
        assert_eq!(validate_document(&workbook(), DEFAULT_SHEET_LIMITS), Ok(()));
    }

    #[test]
    fn preserves_unknown_fields_without_complaint() {
        let mut document = workbook();
        document["futureField"] = json!({ "anything": true });
        document["worksheets"][0]["futureWorksheetField"] = json!(7);
        document["worksheets"][0]["cells"]["r1:c1"]["futureCellField"] = json!("x");
        assert_eq!(validate_document(&document, DEFAULT_SHEET_LIMITS), Ok(()));
    }

    #[test]
    fn skips_structural_checks_for_newer_schema_versions() {
        let document = json!({
            "kind": "collab-sheet",
            "schemaVersion": CURRENT_SCHEMA_VERSION + 1,
            "worksheetsRenamedInTheFuture": []
        });
        assert_eq!(validate_document(&document, DEFAULT_SHEET_LIMITS), Ok(()));
    }

    #[test]
    fn rejects_a_missing_or_zero_schema_version() {
        let mut document = workbook();
        document.as_object_mut().unwrap().remove("schemaVersion");
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::InvalidSchemaVersion)
        );

        let mut document = workbook();
        document["schemaVersion"] = json!(0);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::InvalidSchemaVersion)
        );
    }

    #[test]
    fn rejects_the_wrong_document_kind() {
        let mut document = workbook();
        document["kind"] = json!("collab-canvas");
        assert!(matches!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::WrongKind { .. })
        ));
    }

    #[test]
    fn rejects_dangling_rows_columns_styles_and_worksheets() {
        let mut document = workbook();
        document["worksheets"][0]["cells"]["r9:c1"] = json!({ "value": 1 });
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: "r9".into()
            })
        );

        let mut document = workbook();
        document["worksheets"][0]["cells"]["r1:c9"] = json!({ "value": 1 });
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "column",
                id: "c9".into()
            })
        );

        let mut document = workbook();
        document["worksheets"][0]["cells"]["r1:c1"]["styleId"] = json!("missing");
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "style",
                id: "missing".into()
            })
        );

        let mut document = workbook();
        document["activeWorksheetId"] = json!("ws9");
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: "ws9".into()
            })
        );

        let mut document = workbook();
        document["namedRanges"] = json!([{ "id": "n1", "name": "Totals", "worksheetId": "ws9" }]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: "ws9".into()
            })
        );
    }

    #[test]
    fn validates_named_range_identity_scope_and_range() {
        let valid = json!({
            "id": "n1",
            "name": "Revenue",
            "worksheetId": "ws1",
            "scopeWorksheetId": "ws1",
            "range": {
                "startRowId": "r1",
                "endRowId": "r2",
                "startColumnId": "c1",
                "endColumnId": "c1"
            }
        });
        let mut document = workbook();
        document["namedRanges"] = json!([valid.clone()]);
        assert_eq!(validate_document(&document, DEFAULT_SHEET_LIMITS), Ok(()));

        let mut document = workbook();
        document["namedRanges"] = json!([valid.clone(), {
            "id": "n2",
            "name": "revenue",
            "worksheetId": "ws1",
            "range": valid["range"].clone()
        }]);
        assert!(matches!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DuplicateId {
                kind: "visible named range",
                ..
            })
        ));

        let mut document = workbook();
        document["namedRanges"] = json!([{
            "id": "n1",
            "name": "A1",
            "worksheetId": "ws1",
            "range": valid["range"].clone()
        }]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::InvalidId {
                kind: "named range name"
            })
        );

        let mut document = workbook();
        document["namedRanges"] = json!([{
            "id": "n1",
            "name": "Revenue",
            "worksheetId": "ws1",
            "scopeWorksheetId": "missing",
            "range": valid["range"].clone()
        }]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "worksheet",
                id: "missing".into()
            })
        );

        let mut document = workbook();
        document["namedRanges"] = json!([{
            "id": "n1",
            "name": "Revenue",
            "worksheetId": "ws1",
            "range": {
                "startRowId": "r9",
                "endRowId": "r9",
                "startColumnId": "c1",
                "endColumnId": "c1"
            }
        }]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: "r9".into()
            })
        );
    }

    #[test]
    fn validates_chart_and_data_connection_stable_references() {
        let mut document = workbook();
        document["worksheets"][0]["charts"] = json!([{
            "id": "chart1",
            "kind": "line",
            "anchor": {"rowId": "r1", "columnId": "c1", "width": 480, "height": 280},
            "series": [{
                "id": "series1",
                "valuesRange": {
                    "startRowId": "r1",
                    "endRowId": "r2",
                    "startColumnId": "c1",
                    "endColumnId": "c1"
                }
            }]
        }]);
        document["dataConnections"] = json!([{
            "id": "conn1",
            "kind": "kanbanTasks",
            "sourcePath": "Project.kanban",
            "targetWorksheetId": "ws1",
            "targetRange": {
                "startRowId": "r1",
                "endRowId": "r2",
                "startColumnId": "c1",
                "endColumnId": "c2"
            },
            "columns": [
                {"key": "title", "label": "Task", "columnId": "c1"}
            ],
            "refreshedAt": "2026-01-01T00:00:00Z",
            "itemCount": 1
        }]);
        assert_eq!(validate_document(&document, DEFAULT_SHEET_LIMITS), Ok(()));

        document["worksheets"][0]["charts"][0]["series"][0]["valuesRange"]["endRowId"] =
            json!("missing");
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: "missing".into()
            })
        );
    }

    #[test]
    fn rejects_malformed_identifiers_and_cell_keys() {
        let mut document = workbook();
        document["worksheets"][0]["rowOrder"] = json!(["r1", "r1"]);
        assert!(matches!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DuplicateId { kind: "row", .. })
        ));

        // `:` is the cell-key separator, so it may never appear in an ID.
        let mut document = workbook();
        document["worksheets"][0]["rowOrder"] = json!(["r:1", "r2"]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::InvalidId { kind: "row" })
        );

        let mut document = workbook();
        document["worksheets"][0]["cells"] = json!({ "r1c1": { "value": 1 } });
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::InvalidCellKey { key: "r1c1".into() })
        );
    }

    #[test]
    fn rejects_duplicate_worksheet_ids() {
        let mut document = workbook();
        let worksheet = document["worksheets"][0].clone();
        document["worksheets"] = json!([worksheet.clone(), worksheet]);
        assert!(matches!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DuplicateId {
                kind: "worksheet",
                ..
            })
        ));
    }

    #[test]
    fn enforces_structural_limits() {
        let limits = SheetLimits {
            worksheets_per_workbook: 1,
            ..DEFAULT_SHEET_LIMITS
        };
        let mut document = workbook();
        let mut second = document["worksheets"][0].clone();
        second["id"] = json!("ws2");
        document["worksheets"] = json!([document["worksheets"][0].clone(), second]);
        assert_eq!(
            validate_document(&document, limits),
            Err(SheetValidationError::LimitExceeded {
                limit: 1,
                unit: "worksheet"
            })
        );

        let limits = SheetLimits {
            formula_source_length: 4,
            ..DEFAULT_SHEET_LIMITS
        };
        let mut document = workbook();
        document["worksheets"][0]["cells"]["r2:c2"]["formula"] = json!("=SUM(A1:A9)");
        assert!(matches!(
            validate_document(&document, limits),
            Err(SheetValidationError::LimitExceeded { limit: 4, .. })
        ));
    }

    #[test]
    fn rejects_merged_ranges_pointing_at_missing_tracks() {
        let mut document = workbook();
        document["worksheets"][0]["mergedRanges"] = json!([{
            "startRowId": "r1",
            "startColumnId": "c1",
            "endRowId": "r9",
            "endColumnId": "c2"
        }]);
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: "r9".into()
            })
        );
    }

    #[test]
    fn validates_protected_ranges() {
        let mut document = workbook();
        document["worksheets"][0]["protectedRanges"] = json!([{
            "id": "protected1",
            "range": {
                "startRowId": "r1",
                "endRowId": "r2",
                "startColumnId": "c1",
                "endColumnId": "c2"
            }
        }]);
        assert_eq!(validate_document(&document, DEFAULT_SHEET_LIMITS), Ok(()));

        document["worksheets"][0]["protectedRanges"][0]["range"]["endRowId"] = json!("missing");
        assert_eq!(
            validate_document(&document, DEFAULT_SHEET_LIMITS),
            Err(SheetValidationError::DanglingReference {
                kind: "row",
                id: "missing".into()
            })
        );
    }
}
