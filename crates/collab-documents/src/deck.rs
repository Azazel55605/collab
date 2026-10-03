//! Bounded structural validation for `.deck` presentation documents.
//!
//! The shared trust boundary between the native client and the server: both
//! refuse to persist a deck whose structure is malformed, exceeds the frozen
//! limits, or carries content a renderer must never act on — non-finite
//! geometry, asset paths outside the vault, executable link schemes, or group
//! cycles. It does not resolve themes, lay out text, or render.
//!
//! Forward compatibility: a document declaring a `schemaVersion` newer than
//! [`CURRENT_SCHEMA_VERSION`] is checked only against the generic JSON bounds
//! every structured document gets, so a newer client's decks survive a vault
//! shared with an older build. Unknown fields inside a known version are
//! preserved and ignored.
//!
//! Mirrors `DECK_LIMITS` in `src/types/deck.ts` and the rules in
//! `src/lib/deck/validate.ts`; keep them in sync.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::ink::is_vault_relative_path;

pub const DECK_DOCUMENT_KIND: &str = "collab-deck";
pub const CURRENT_SCHEMA_VERSION: u64 = 1;

/// Deck units (1/100 pt) per inch.
const UNITS_PER_INCH: i64 = 7_200;
const FULL_TURN: i64 = 36_000;

const THEME_COLOR_TOKENS: [&str; 12] = [
    "dark1",
    "light1",
    "dark2",
    "light2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hyperlink",
    "followedHyperlink",
];

const SHAPE_GEOMETRIES: [&str; 14] = [
    "rect",
    "roundRect",
    "ellipse",
    "triangle",
    "rightTriangle",
    "diamond",
    "pentagon",
    "hexagon",
    "rightArrow",
    "leftArrow",
    "upArrow",
    "downArrow",
    "chevron",
    "star5",
];

const ALLOWED_MEDIA_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
];

/// Structural limits. A document exceeding any of these is rejected outright
/// rather than truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeckLimits {
    pub slides: usize,
    pub sections: usize,
    pub themes: usize,
    pub masters: usize,
    pub layouts: usize,
    pub elements_per_container: usize,
    pub elements_per_deck: usize,
    pub text_per_body: usize,
    pub text_per_deck: usize,
    pub paragraphs_per_body: usize,
    pub runs_per_paragraph: usize,
    pub list_levels: u64,
    pub group_depth: usize,
    pub image_pixels: u64,
    pub table_rows: usize,
    pub table_columns: usize,
    pub table_cells: usize,
    pub chart_series: usize,
    pub chart_points_per_series: usize,
    pub animations_per_slide: usize,
    pub animation_duration_ms: i64,
    pub min_slide_side: i64,
    pub max_slide_side: i64,
    pub canvas_overscan: i64,
    pub min_font_size: i64,
    pub max_font_size: i64,
    pub name_length: usize,
    pub alt_text_length: usize,
    pub link_length: usize,
    pub metadata_entries: usize,
}

pub const DEFAULT_DECK_LIMITS: DeckLimits = DeckLimits {
    slides: 1_000,
    sections: 200,
    themes: 16,
    masters: 16,
    layouts: 128,
    elements_per_container: 2_000,
    elements_per_deck: 100_000,
    text_per_body: 32_768,
    text_per_deck: 2_000_000,
    paragraphs_per_body: 2_000,
    runs_per_paragraph: 500,
    list_levels: 9,
    group_depth: 8,
    image_pixels: 40_000_000,
    table_rows: 500,
    table_columns: 64,
    table_cells: 10_000,
    chart_series: 32,
    chart_points_per_series: 1_000,
    animations_per_slide: 200,
    animation_duration_ms: 60_000,
    min_slide_side: UNITS_PER_INCH,
    max_slide_side: 56 * UNITS_PER_INCH,
    canvas_overscan: 56 * UNITS_PER_INCH,
    min_font_size: 100,
    max_font_size: 400_000,
    name_length: 256,
    alt_text_length: 4_096,
    link_length: 2_048,
    metadata_entries: 64,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeckValidationError {
    #[error("deck document must be a JSON object")]
    NotAnObject,
    #[error("deck document must declare kind \"{expected}\"")]
    WrongKind { expected: &'static str },
    #[error("deck document must declare a positive integer schemaVersion")]
    InvalidSchemaVersion,
    #[error("deck document field '{field}' is missing or has the wrong type")]
    WrongType { field: String },
    #[error("deck document exceeds the {limit}-{unit} limit")]
    LimitExceeded { limit: usize, unit: &'static str },
    #[error("deck document has a duplicate {kind} identifier '{id}'")]
    DuplicateId { kind: &'static str, id: String },
    #[error("deck document has an empty or invalid {kind} identifier")]
    InvalidId { kind: &'static str },
    #[error("deck document references a {kind} '{id}' that does not exist")]
    DanglingReference { kind: &'static str, id: String },
    #[error("deck {kind} '{id}' has geometry that cannot be drawn")]
    UndrawableGeometry { kind: &'static str, id: String },
    #[error(
        "deck element '{id}' must reference a vault-relative asset with an allowed media type"
    )]
    UnsafeAsset { id: String },
    #[error("deck link must be http(s), mailto, a slide, or a vault-relative path")]
    UnsafeLink,
    #[error("deck element '{id}' is part of a group cycle or nests too deeply")]
    InvalidGroup { id: String },
    #[error("deck slide size must be between 1 and 56 inches per side")]
    InvalidSlideSize,
}

/// Reads the declared schema version, if the document declares one at all.
pub fn schema_version(value: &Value) -> Option<u64> {
    value.get("schemaVersion")?.as_u64()
}

fn wrong(field: impl Into<String>) -> DeckValidationError {
    DeckValidationError::WrongType {
        field: field.into(),
    }
}

fn valid_id(value: Option<&Value>) -> Option<&str> {
    let id = value?.as_str()?;
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    Some(id)
}

/// A finite integer. Fractions and non-finite numbers are rejected, not
/// rounded: a NaN is not a position at zero.
fn integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let float = value.as_f64()?;
    if float.is_finite() && float.fract() == 0.0 && float.abs() <= 9.0e15 {
        Some(float as i64)
    } else {
        None
    }
}

fn check_len(
    value: Option<&Value>,
    max: usize,
    field: &str,
    required: bool,
) -> Result<(), DeckValidationError> {
    match value {
        None | Some(Value::Null) if !required => Ok(()),
        Some(Value::String(text)) if text.chars().count() <= max => Ok(()),
        Some(Value::String(_)) => Err(DeckValidationError::LimitExceeded {
            limit: max,
            unit: "character name",
        }),
        _ => Err(wrong(field)),
    }
}

fn is_hex_color(value: Option<&Value>) -> bool {
    matches!(value.and_then(Value::as_str), Some(text)
        if text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

/// Everything a single validation pass needs to share.
struct Context<'a> {
    limits: DeckLimits,
    extent: i64,
    slide_ids: HashSet<&'a str>,
    elements: usize,
    text: usize,
}

impl Context<'_> {
    fn coordinate(
        &self,
        value: Option<&Value>,
        kind: &'static str,
        id: &str,
    ) -> Result<i64, DeckValidationError> {
        match integer(value) {
            Some(number) if number.abs() <= self.extent => Ok(number),
            _ => Err(DeckValidationError::UndrawableGeometry {
                kind,
                id: id.to_string(),
            }),
        }
    }
}

fn check_color(color: &Value, field: &str) -> Result<(), DeckValidationError> {
    let object = color.as_object().ok_or_else(|| wrong(field))?;
    match object.get("kind").and_then(Value::as_str) {
        Some("rgb") if is_hex_color(object.get("value")) => {}
        Some("theme")
            if object
                .get("token")
                .and_then(Value::as_str)
                .is_some_and(|token| THEME_COLOR_TOKENS.contains(&token)) => {}
        _ => return Err(wrong(field)),
    }
    if let Some(alpha) = object.get("alpha") {
        if !matches!(integer(Some(alpha)), Some(0..=100)) {
            return Err(wrong(format!("{field}.alpha")));
        }
    }
    Ok(())
}

fn check_asset(ctx: &Context<'_>, asset: &Value, id: &str) -> Result<(), DeckValidationError> {
    let unsafe_asset = || DeckValidationError::UnsafeAsset { id: id.to_string() };
    let object = asset.as_object().ok_or_else(unsafe_asset)?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(unsafe_asset)?;
    let media_type = object
        .get("mediaType")
        .and_then(Value::as_str)
        .ok_or_else(unsafe_asset)?;
    if !is_vault_relative_path(path) || !ALLOWED_MEDIA_TYPES.contains(&media_type) {
        return Err(unsafe_asset());
    }
    let width = integer(object.get("pixelWidth")).filter(|value| *value >= 1);
    let height = integer(object.get("pixelHeight")).filter(|value| *value >= 1);
    match (width, height) {
        (Some(width), Some(height))
            if (width as u64).saturating_mul(height as u64) <= ctx.limits.image_pixels =>
        {
            Ok(())
        }
        (Some(_), Some(_)) => Err(DeckValidationError::LimitExceeded {
            limit: ctx.limits.image_pixels as usize,
            unit: "pixel image",
        }),
        _ => Err(unsafe_asset()),
    }
}

fn check_fill(
    ctx: &Context<'_>,
    fill: Option<&Value>,
    field: &str,
    id: &str,
) -> Result<(), DeckValidationError> {
    let Some(fill) = fill else { return Ok(()) };
    let object = fill.as_object().ok_or_else(|| wrong(field))?;
    match object.get("kind").and_then(Value::as_str) {
        Some("none") => Ok(()),
        Some("solid") => check_color(object.get("color").ok_or_else(|| wrong(field))?, field),
        Some("image") => check_asset(ctx, object.get("asset").ok_or_else(|| wrong(field))?, id),
        _ => Err(wrong(field)),
    }
}

fn check_line(line: Option<&Value>, field: &str) -> Result<(), DeckValidationError> {
    let Some(line) = line else { return Ok(()) };
    let object = line.as_object().ok_or_else(|| wrong(field))?;
    check_color(object.get("color").ok_or_else(|| wrong(field))?, field)?;
    match integer(object.get("width")) {
        Some(0..=10_000) => Ok(()),
        _ => Err(wrong(format!("{field}.width"))),
    }
}

fn check_link(ctx: &Context<'_>, link: &Value) -> Result<(), DeckValidationError> {
    let object = link.as_object().ok_or(DeckValidationError::UnsafeLink)?;
    let ok = match object.get("kind").and_then(Value::as_str) {
        Some("url") => object
            .get("href")
            .and_then(Value::as_str)
            .is_some_and(|href| {
                let lower = href.to_ascii_lowercase();
                href.len() <= ctx.limits.link_length
                    && (lower.starts_with("https://")
                        || lower.starts_with("http://")
                        || lower.starts_with("mailto:"))
            }),
        Some("slide") => object
            .get("slideId")
            .and_then(Value::as_str)
            .is_some_and(|slide| ctx.slide_ids.contains(slide)),
        Some("vault") => object
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_vault_relative_path),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(DeckValidationError::UnsafeLink)
    }
}

fn check_rich_text(
    ctx: &mut Context<'_>,
    text: &Value,
    field: &str,
) -> Result<(), DeckValidationError> {
    let paragraphs = text
        .get("paragraphs")
        .and_then(Value::as_array)
        .ok_or_else(|| wrong(field))?;
    if paragraphs.len() > ctx.limits.paragraphs_per_body {
        return Err(DeckValidationError::LimitExceeded {
            limit: ctx.limits.paragraphs_per_body,
            unit: "paragraph",
        });
    }
    let mut ids = HashSet::new();
    let mut characters = 0usize;
    for paragraph in paragraphs {
        let id = valid_id(paragraph.get("id"))
            .ok_or(DeckValidationError::InvalidId { kind: "paragraph" })?;
        if !ids.insert(id) {
            return Err(DeckValidationError::DuplicateId {
                kind: "paragraph",
                id: id.to_string(),
            });
        }
        if let Some(level) = paragraph.get("style").and_then(|style| style.get("level")) {
            if !matches!(level.as_u64(), Some(level) if level < ctx.limits.list_levels) {
                return Err(wrong(format!("{field}.level")));
            }
        }
        let runs = paragraph
            .get("runs")
            .and_then(Value::as_array)
            .ok_or_else(|| wrong(format!("{field}.runs")))?;
        if runs.len() > ctx.limits.runs_per_paragraph {
            return Err(DeckValidationError::LimitExceeded {
                limit: ctx.limits.runs_per_paragraph,
                unit: "run",
            });
        }
        for run in runs {
            match run.get("kind").and_then(Value::as_str) {
                Some("text") => {
                    let content = run
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| wrong(format!("{field}.text")))?;
                    characters += content.chars().count();
                    if let Some(link) = run.get("link") {
                        check_link(ctx, link)?;
                    }
                }
                Some("break") => {}
                _ => return Err(wrong(format!("{field}.run"))),
            }
            if let Some(style) = run.get("style") {
                if let Some(size) = style.get("size") {
                    let min = ctx.limits.min_font_size;
                    let max = ctx.limits.max_font_size;
                    if !matches!(integer(Some(size)), Some(size) if (min..=max).contains(&size)) {
                        return Err(wrong(format!("{field}.size")));
                    }
                }
                if let Some(color) = style.get("color") {
                    check_color(color, field)?;
                }
            }
        }
    }
    if characters > ctx.limits.text_per_body {
        return Err(DeckValidationError::LimitExceeded {
            limit: ctx.limits.text_per_body,
            unit: "character text body",
        });
    }
    ctx.text += characters;
    Ok(())
}

fn check_text_body(
    ctx: &mut Context<'_>,
    body: Option<&Value>,
    field: &str,
) -> Result<(), DeckValidationError> {
    let Some(body) = body else { return Ok(()) };
    let content = body.get("content").ok_or_else(|| wrong(field))?;
    check_rich_text(ctx, content, field)?;
    if let Some(insets) = body.get("insets") {
        let valid = insets.as_array().is_some_and(|values| {
            values.len() == 4
                && values
                    .iter()
                    .all(|inset| matches!(integer(Some(inset)), Some(0..)))
        });
        if !valid {
            return Err(wrong(format!("{field}.insets")));
        }
    }
    Ok(())
}

fn check_frame(ctx: &Context<'_>, frame: &Value, id: &str) -> Result<(), DeckValidationError> {
    let undrawable = || DeckValidationError::UndrawableGeometry {
        kind: "element",
        id: id.to_string(),
    };
    ctx.coordinate(frame.get("x"), "element", id)?;
    ctx.coordinate(frame.get("y"), "element", id)?;
    for key in ["width", "height"] {
        match integer(frame.get(key)) {
            Some(size) if (0..=ctx.extent * 2).contains(&size) => {}
            _ => return Err(undrawable()),
        }
    }
    if let Some(rotation) = frame.get("rotation") {
        if !matches!(integer(Some(rotation)), Some(rotation) if (0..FULL_TURN).contains(&rotation))
        {
            return Err(undrawable());
        }
    }
    Ok(())
}

fn check_element(
    ctx: &mut Context<'_>,
    id: &str,
    element: &Value,
) -> Result<(), DeckValidationError> {
    let object = element.as_object().ok_or_else(|| wrong("element"))?;
    check_len(object.get("name"), ctx.limits.name_length, "name", false)?;
    check_len(
        object.get("altText"),
        ctx.limits.alt_text_length,
        "altText",
        false,
    )?;
    if let Some(opacity) = object.get("opacity") {
        if !matches!(integer(Some(opacity)), Some(0..=100)) {
            return Err(wrong("opacity"));
        }
    }
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| wrong("element type"))?;
    match object.get("frame") {
        Some(frame) => check_frame(ctx, frame, id)?,
        None if object.contains_key("placeholder") || kind == "line" => {}
        None => {
            return Err(DeckValidationError::UndrawableGeometry {
                kind: "element",
                id: id.to_string(),
            })
        }
    }

    match kind {
        "text" => {
            check_text_body(ctx, object.get("text"), "text")?;
            check_fill(ctx, object.get("fill"), "fill", id)?;
            check_line(object.get("line"), "line")?;
        }
        "shape" => {
            let geometry = object.get("geometry").and_then(Value::as_str);
            if !geometry.is_some_and(|geometry| SHAPE_GEOMETRIES.contains(&geometry)) {
                return Err(wrong("geometry"));
            }
            check_text_body(ctx, object.get("text"), "text")?;
            check_fill(ctx, object.get("fill"), "fill", id)?;
            check_line(object.get("line"), "line")?;
        }
        "line" => {
            for end in ["from", "to"] {
                let point = object.get(end).ok_or_else(|| wrong(end))?;
                ctx.coordinate(point.get("x"), "element", id)?;
                ctx.coordinate(point.get("y"), "element", id)?;
            }
            check_line(object.get("line"), "line")?;
        }
        "image" => {
            check_asset(ctx, object.get("asset").ok_or_else(|| wrong("asset"))?, id)?;
            if let Some(crop) = object.get("crop") {
                let side = |key| integer(crop.get(key)).filter(|value| *value >= 0);
                match (side("left"), side("top"), side("right"), side("bottom")) {
                    (Some(left), Some(top), Some(right), Some(bottom))
                        if left + right < 1_000 && top + bottom < 1_000 => {}
                    _ => return Err(wrong("crop")),
                }
            }
            check_line(object.get("line"), "line")?;
        }
        "table" => {
            let rows = object
                .get("rowOrder")
                .and_then(Value::as_array)
                .ok_or_else(|| wrong("rowOrder"))?;
            let columns = object
                .get("columnOrder")
                .and_then(Value::as_array)
                .ok_or_else(|| wrong("columnOrder"))?;
            let cells = object
                .get("cells")
                .and_then(Value::as_object)
                .ok_or_else(|| wrong("cells"))?;
            if rows.len() > ctx.limits.table_rows {
                return Err(DeckValidationError::LimitExceeded {
                    limit: ctx.limits.table_rows,
                    unit: "table row",
                });
            }
            if columns.len() > ctx.limits.table_columns {
                return Err(DeckValidationError::LimitExceeded {
                    limit: ctx.limits.table_columns,
                    unit: "table column",
                });
            }
            if cells.len() > ctx.limits.table_cells {
                return Err(DeckValidationError::LimitExceeded {
                    limit: ctx.limits.table_cells,
                    unit: "table cell",
                });
            }
            let row_ids: HashSet<&str> = rows.iter().filter_map(Value::as_str).collect();
            let column_ids: HashSet<&str> = columns.iter().filter_map(Value::as_str).collect();
            for (key, cell) in cells {
                let (row, column) = key.split_once(':').ok_or_else(|| wrong("cell key"))?;
                if !row_ids.contains(row) || !column_ids.contains(column) {
                    return Err(DeckValidationError::DanglingReference {
                        kind: "table cell",
                        id: key.clone(),
                    });
                }
                check_text_body(ctx, cell.get("text"), "cell")?;
                check_fill(ctx, cell.get("fill"), "cell fill", id)?;
            }
        }
        "chart" => {
            let series = object
                .get("series")
                .and_then(Value::as_array)
                .ok_or_else(|| wrong("series"))?;
            if series.len() > ctx.limits.chart_series {
                return Err(DeckValidationError::LimitExceeded {
                    limit: ctx.limits.chart_series,
                    unit: "chart series",
                });
            }
            let categories = object
                .get("categories")
                .and_then(Value::as_array)
                .ok_or_else(|| wrong("categories"))?;
            if categories.len() > ctx.limits.chart_points_per_series {
                return Err(DeckValidationError::LimitExceeded {
                    limit: ctx.limits.chart_points_per_series,
                    unit: "chart category",
                });
            }
            for entry in series {
                let values = entry
                    .get("values")
                    .and_then(Value::as_array)
                    .ok_or_else(|| wrong("values"))?;
                if values.len() > ctx.limits.chart_points_per_series {
                    return Err(DeckValidationError::LimitExceeded {
                        limit: ctx.limits.chart_points_per_series,
                        unit: "chart point",
                    });
                }
                if !values
                    .iter()
                    .all(|value| value.as_f64().is_some_and(f64::is_finite))
                {
                    return Err(wrong("values"));
                }
            }
            if let Some(source) = object.get("source") {
                if !source
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(is_vault_relative_path)
                {
                    return Err(DeckValidationError::UnsafeAsset { id: id.to_string() });
                }
            }
        }
        "embed" => {
            let path = object
                .get("source")
                .and_then(|source| source.get("path"))
                .and_then(Value::as_str);
            if !path.is_some_and(is_vault_relative_path) {
                return Err(DeckValidationError::UnsafeAsset { id: id.to_string() });
            }
            if let Some(preview) = object.get("preview") {
                check_asset(ctx, preview, id)?;
            }
        }
        "group" => {
            object
                .get("childIds")
                .and_then(Value::as_array)
                .ok_or_else(|| wrong("childIds"))?;
        }
        _ => return Err(wrong("element type")),
    }
    Ok(())
}

/// Checks one id-keyed element map with its paint order and groups.
fn check_container(
    ctx: &mut Context<'_>,
    container: &Map<String, Value>,
) -> Result<(), DeckValidationError> {
    let elements = container
        .get("elements")
        .and_then(Value::as_object)
        .ok_or_else(|| wrong("elements"))?;
    let order = container
        .get("elementOrder")
        .and_then(Value::as_array)
        .ok_or_else(|| wrong("elementOrder"))?;
    if elements.len() > ctx.limits.elements_per_container {
        return Err(DeckValidationError::LimitExceeded {
            limit: ctx.limits.elements_per_container,
            unit: "element",
        });
    }
    ctx.elements += elements.len();

    let mut parents: HashMap<&str, &str> = HashMap::new();
    for (key, element) in elements {
        if valid_id(element.get("id")) != Some(key.as_str()) {
            return Err(DeckValidationError::InvalidId { kind: "element" });
        }
        check_element(ctx, key, element)?;
        if element.get("type").and_then(Value::as_str) == Some("group") {
            for child in element
                .get("childIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let child = child
                    .as_str()
                    .ok_or(DeckValidationError::InvalidId { kind: "element" })?;
                if !elements.contains_key(child) {
                    return Err(DeckValidationError::DanglingReference {
                        kind: "element",
                        id: child.to_string(),
                    });
                }
                if parents.insert(child, key).is_some() {
                    return Err(DeckValidationError::InvalidGroup {
                        id: child.to_string(),
                    });
                }
            }
        }
    }

    let mut seen = HashSet::new();
    for entry in order {
        let id = valid_id(Some(entry)).ok_or(DeckValidationError::InvalidId { kind: "element" })?;
        if !elements.contains_key(id) {
            return Err(DeckValidationError::DanglingReference {
                kind: "element",
                id: id.to_string(),
            });
        }
        if !seen.insert(id) {
            return Err(DeckValidationError::DuplicateId {
                kind: "element",
                id: id.to_string(),
            });
        }
        if parents.contains_key(id) {
            return Err(DeckValidationError::InvalidGroup { id: id.to_string() });
        }
    }

    // Walk each parent chain: a cycle or an over-deep nest fails.
    for id in elements.keys() {
        let mut depth = 0usize;
        let mut current = parents.get(id.as_str()).copied();
        let mut visited = HashSet::from([id.as_str()]);
        while let Some(parent) = current {
            depth += 1;
            if !visited.insert(parent) || depth > ctx.limits.group_depth {
                return Err(DeckValidationError::InvalidGroup { id: id.clone() });
            }
            current = parents.get(parent).copied();
        }
    }
    Ok(())
}

fn check_map<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
    limit: usize,
) -> Result<&'a Map<String, Value>, DeckValidationError> {
    let map = object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| wrong(field))?;
    if map.len() > limit {
        return Err(DeckValidationError::LimitExceeded { limit, unit: field });
    }
    for (key, entry) in map {
        if valid_id(entry.get("id")) != Some(key.as_str()) {
            return Err(DeckValidationError::InvalidId { kind: field });
        }
    }
    Ok(map)
}

/// Validates a parsed `.deck` document.
///
/// Callers pass documents that already cleared the generic JSON size, entry,
/// and depth bounds. Documents from a newer schema version return `Ok`.
pub fn validate_document(value: &Value, limits: DeckLimits) -> Result<(), DeckValidationError> {
    let object = value.as_object().ok_or(DeckValidationError::NotAnObject)?;
    match schema_version(value) {
        Some(0) | None => return Err(DeckValidationError::InvalidSchemaVersion),
        Some(version) if version > CURRENT_SCHEMA_VERSION => return Ok(()),
        Some(_) => {}
    }
    if object.get("kind").and_then(Value::as_str) != Some(DECK_DOCUMENT_KIND) {
        return Err(DeckValidationError::WrongKind {
            expected: DECK_DOCUMENT_KIND,
        });
    }
    check_len(object.get("id"), limits.name_length, "id", true)?;
    check_len(object.get("name"), limits.name_length, "name", true)?;

    let size = object.get("size").ok_or_else(|| wrong("size"))?;
    let width = integer(size.get("width"));
    let height = integer(size.get("height"));
    let side = limits.min_slide_side..=limits.max_slide_side;
    let (Some(width), Some(height)) = (width, height) else {
        return Err(DeckValidationError::InvalidSlideSize);
    };
    if !side.contains(&width) || !side.contains(&height) {
        return Err(DeckValidationError::InvalidSlideSize);
    }

    let themes = check_map(object, "themes", limits.themes)?;
    for theme in themes.values() {
        let colors = theme.get("colors").ok_or_else(|| wrong("theme colors"))?;
        if !THEME_COLOR_TOKENS
            .iter()
            .all(|token| is_hex_color(colors.get(*token)))
        {
            return Err(wrong("theme colors"));
        }
    }
    let theme_id = object
        .get("themeId")
        .and_then(Value::as_str)
        .ok_or_else(|| wrong("themeId"))?;
    if !themes.contains_key(theme_id) {
        return Err(DeckValidationError::DanglingReference {
            kind: "theme",
            id: theme_id.to_string(),
        });
    }

    let masters = check_map(object, "masters", limits.masters)?;
    if masters.is_empty() {
        return Err(wrong("masters"));
    }
    let layouts = check_map(object, "layouts", limits.layouts)?;
    let slides = check_map(object, "slides", limits.slides)?;

    let mut ctx = Context {
        limits,
        extent: width.max(height) + limits.canvas_overscan,
        slide_ids: slides.keys().map(String::as_str).collect(),
        elements: 0,
        text: 0,
    };

    for master in masters.values() {
        let master = master.as_object().ok_or_else(|| wrong("master"))?;
        if let Some(theme) = master.get("themeId").and_then(Value::as_str) {
            if !themes.contains_key(theme) {
                return Err(DeckValidationError::DanglingReference {
                    kind: "theme",
                    id: theme.to_string(),
                });
            }
        }
        check_fill(&ctx, master.get("background"), "background", "master")?;
        check_container(&mut ctx, master)?;
    }
    for layout in layouts.values() {
        let layout = layout.as_object().ok_or_else(|| wrong("layout"))?;
        let master = layout
            .get("masterId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !masters.contains_key(master) {
            return Err(DeckValidationError::DanglingReference {
                kind: "master",
                id: master.to_string(),
            });
        }
        check_fill(&ctx, layout.get("background"), "background", "layout")?;
        check_container(&mut ctx, layout)?;
    }
    for (slide_id, slide) in slides {
        let slide = slide.as_object().ok_or_else(|| wrong("slide"))?;
        if let Some(layout) = slide.get("layoutId").and_then(Value::as_str) {
            if !layouts.contains_key(layout) {
                return Err(DeckValidationError::DanglingReference {
                    kind: "layout",
                    id: layout.to_string(),
                });
            }
        }
        check_fill(&ctx, slide.get("background"), "background", slide_id)?;
        check_container(&mut ctx, slide)?;
        if let Some(reading_order) = slide.get("readingOrder") {
            let reading_order = reading_order
                .as_array()
                .ok_or_else(|| wrong("readingOrder"))?;
            let elements = slide
                .get("elements")
                .and_then(Value::as_object)
                .ok_or_else(|| wrong("elements"))?;
            let mut seen = HashSet::new();
            for entry in reading_order {
                let id = entry.as_str().ok_or_else(|| wrong("readingOrder"))?;
                if !elements.contains_key(id) {
                    return Err(DeckValidationError::DanglingReference {
                        kind: "reading order",
                        id: id.to_string(),
                    });
                }
                if elements
                    .get(id)
                    .and_then(|element| element.get("type"))
                    .and_then(Value::as_str)
                    == Some("group")
                {
                    return Err(wrong("reading order group"));
                }
                if !seen.insert(id) {
                    return Err(DeckValidationError::DuplicateId {
                        kind: "reading order",
                        id: id.to_string(),
                    });
                }
            }
        }
        if let Some(notes) = slide.get("speakerNotes") {
            check_rich_text(&mut ctx, notes, "speakerNotes")?;
        }
        if let Some(transition) = slide.get("transition") {
            let kind = transition.get("kind").and_then(Value::as_str);
            if !matches!(kind, Some("none" | "fade" | "push" | "wipe")) {
                return Err(wrong("transition kind"));
            }
            let duration = limits.animation_duration_ms;
            if !matches!(integer(transition.get("durationMs")), Some(ms) if (0..=duration).contains(&ms))
            {
                return Err(wrong("transition durationMs"));
            }
        }
        let animations = slide.get("animations").and_then(Value::as_array);
        if let Some(animations) = animations {
            if animations.len() > limits.animations_per_slide {
                return Err(DeckValidationError::LimitExceeded {
                    limit: limits.animations_per_slide,
                    unit: "animation",
                });
            }
            let elements = slide.get("elements").and_then(Value::as_object);
            let mut animation_ids = HashSet::new();
            for animation in animations {
                let id = valid_id(animation.get("id"))
                    .ok_or(DeckValidationError::InvalidId { kind: "animation" })?;
                if !animation_ids.insert(id) {
                    return Err(DeckValidationError::DuplicateId {
                        kind: "animation",
                        id: id.to_string(),
                    });
                }
                let target = animation
                    .get("elementId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !elements.is_some_and(|elements| elements.contains_key(target)) {
                    return Err(DeckValidationError::DanglingReference {
                        kind: "animation target",
                        id: target.to_string(),
                    });
                }
                let duration = limits.animation_duration_ms;
                if !matches!(integer(animation.get("durationMs")), Some(ms) if (0..=duration).contains(&ms))
                {
                    return Err(wrong("durationMs"));
                }
                if animation.get("delayMs").is_some()
                    && !matches!(integer(animation.get("delayMs")), Some(ms) if (0..=duration).contains(&ms))
                {
                    return Err(wrong("delayMs"));
                }
                if !matches!(
                    animation.get("effect").and_then(Value::as_str),
                    Some("appear" | "fade" | "fly" | "zoom")
                ) || !matches!(
                    animation.get("phase").and_then(Value::as_str),
                    Some("entrance" | "emphasis" | "exit")
                ) || !matches!(
                    animation.get("trigger").and_then(Value::as_str),
                    Some("click" | "withPrevious" | "afterPrevious")
                ) {
                    return Err(wrong("animation kind"));
                }
            }
        }
    }

    let order = object
        .get("slideOrder")
        .and_then(Value::as_array)
        .ok_or_else(|| wrong("slideOrder"))?;
    let mut ordered = HashSet::new();
    for entry in order {
        let id = valid_id(Some(entry)).ok_or(DeckValidationError::InvalidId { kind: "slide" })?;
        if !slides.contains_key(id) {
            return Err(DeckValidationError::DanglingReference {
                kind: "slide",
                id: id.to_string(),
            });
        }
        if !ordered.insert(id) {
            return Err(DeckValidationError::DuplicateId {
                kind: "slide",
                id: id.to_string(),
            });
        }
    }
    if ordered.len() != slides.len() {
        return Err(wrong("slideOrder"));
    }

    if let Some(sections) = object.get("sections") {
        let sections = sections.as_array().ok_or_else(|| wrong("sections"))?;
        if sections.len() > limits.sections {
            return Err(DeckValidationError::LimitExceeded {
                limit: limits.sections,
                unit: "section",
            });
        }
        for section in sections {
            let first = section
                .get("firstSlideId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !slides.contains_key(first) {
                return Err(DeckValidationError::DanglingReference {
                    kind: "slide",
                    id: first.to_string(),
                });
            }
        }
    }

    if let Some(metadata) = object.get("metadata") {
        let metadata = metadata.as_object().ok_or_else(|| wrong("metadata"))?;
        if metadata.len() > limits.metadata_entries
            || !metadata.values().all(|value| match value {
                Value::String(text) => text.len() <= limits.link_length,
                Value::Number(_) | Value::Bool(_) => true,
                _ => false,
            })
        {
            return Err(wrong("metadata"));
        }
    }

    if ctx.elements > limits.elements_per_deck {
        return Err(DeckValidationError::LimitExceeded {
            limit: limits.elements_per_deck,
            unit: "element",
        });
    }
    if ctx.text > limits.text_per_deck {
        return Err(DeckValidationError::LimitExceeded {
            limit: limits.text_per_deck,
            unit: "character",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The TypeScript fixture, kept identical by `src/lib/deck/sharedFixture.test.ts`.
    const FIXTURE: &str = include_str!("../fixtures/deck-fixture.deck");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    fn check(value: &Value) -> Result<(), DeckValidationError> {
        validate_document(value, DEFAULT_DECK_LIMITS)
    }

    fn element<'a>(deck: &'a mut Value, slide: &str, id: &str) -> &'a mut Value {
        &mut deck["slides"][slide]["elements"][id]
    }

    #[test]
    fn accepts_the_shared_fixture() {
        assert_eq!(check(&fixture()), Ok(()));
    }

    #[test]
    fn passes_generic_bounds_and_classification_end_to_end() {
        let report = crate::validate(
            crate::DocumentInput {
                kind: crate::DocumentKind::Deck,
                path: "Talks/Fixture.deck",
                content: FIXTURE.as_bytes(),
            },
            crate::DEFAULT_PARSER_LIMITS,
        );
        assert!(report.is_ok(), "{report:?}");
        assert_eq!(
            crate::classify_path("Talks/Q3.DECK"),
            Some(crate::DocumentKind::Deck)
        );
    }

    #[test]
    fn rejects_the_wrong_kind_and_a_missing_version() {
        let mut deck = fixture();
        deck["kind"] = json!("collab-ink");
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::WrongKind { .. })
        ));
        let mut deck = fixture();
        deck.as_object_mut().unwrap().remove("schemaVersion");
        assert_eq!(check(&deck), Err(DeckValidationError::InvalidSchemaVersion));
    }

    #[test]
    fn leaves_newer_schema_versions_to_newer_clients() {
        let deck = json!({ "kind": DECK_DOCUMENT_KIND, "schemaVersion": 99, "shape": "unknown" });
        assert_eq!(check(&deck), Ok(()));
    }

    #[test]
    fn rejects_non_integer_and_out_of_range_geometry() {
        let mut deck = fixture();
        element(&mut deck, "slide-5", "s5-note")["frame"]["x"] = json!(10.5);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::UndrawableGeometry { .. })
        ));

        let mut deck = fixture();
        element(&mut deck, "slide-5", "s5-note")["frame"]["y"] = json!(100_000_000);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::UndrawableGeometry { .. })
        ));

        let mut deck = fixture();
        element(&mut deck, "slide-3", "s3-arrow")["frame"]["rotation"] = json!(36_000);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::UndrawableGeometry { .. })
        ));
    }

    #[test]
    fn requires_a_frame_unless_a_placeholder_supplies_one() {
        let mut deck = fixture();
        element(&mut deck, "slide-5", "s5-note")
            .as_object_mut()
            .unwrap()
            .remove("frame");
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::UndrawableGeometry { .. })
        ));
        let mut deck = fixture();
        element(&mut deck, "slide-2", "s2-title")
            .as_object_mut()
            .unwrap()
            .remove("frame");
        assert_eq!(check(&deck), Ok(()));
    }

    #[test]
    fn rejects_assets_outside_the_vault_or_of_unsafe_types() {
        for (path, media) in [
            ("https://example.com/a.png", "image/png"),
            ("../outside.png", "image/png"),
            ("/etc/passwd", "image/png"),
            ("assets/page.html", "text/html"),
        ] {
            let mut deck = fixture();
            element(&mut deck, "slide-3", "s3-image")["asset"]["path"] = json!(path);
            element(&mut deck, "slide-3", "s3-image")["asset"]["mediaType"] = json!(media);
            assert!(
                matches!(check(&deck), Err(DeckValidationError::UnsafeAsset { .. })),
                "{path} {media}"
            );
        }
    }

    #[test]
    fn rejects_executable_links() {
        for href in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
        ] {
            let mut deck = fixture();
            element(&mut deck, "slide-2", "s2-body")["text"]["content"]["paragraphs"][0]["runs"]
                [0]["link"] = json!({ "kind": "url", "href": href });
            assert_eq!(check(&deck), Err(DeckValidationError::UnsafeLink), "{href}");
        }
    }

    #[test]
    fn rejects_group_cycles_and_shared_children() {
        let mut deck = fixture();
        element(&mut deck, "slide-3", "s3-group")["childIds"]
            .as_array_mut()
            .unwrap()
            .push(json!("s3-group"));
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::InvalidGroup { .. })
        ));
    }

    #[test]
    fn rejects_broken_references() {
        let mut deck = fixture();
        deck["slides"]["slide-2"]["layoutId"] = json!("missing");
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::DanglingReference { .. })
        ));

        let mut deck = fixture();
        deck["slideOrder"]
            .as_array_mut()
            .unwrap()
            .push(json!("slide-1"));
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::DuplicateId { .. })
        ));

        let mut deck = fixture();
        deck["slideOrder"].as_array_mut().unwrap().pop();
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::WrongType { .. })
        ));
    }

    #[test]
    fn validates_transitions_and_animation_timelines() {
        let mut deck = fixture();
        deck["slides"]["slide-1"]["transition"] = json!({ "kind": "wipe", "durationMs": 350 });
        deck["slides"]["slide-1"]["animations"] = json!([{
            "id": "animation-1",
            "elementId": "s1-title",
            "effect": "fly",
            "phase": "entrance",
            "trigger": "click",
            "durationMs": 500,
            "delayMs": 100
        }]);
        assert_eq!(check(&deck), Ok(()));

        deck["slides"]["slide-1"]["animations"][0]["delayMs"] = json!(-1);
        assert!(check(&deck).is_err());
    }

    #[test]
    fn validates_accessibility_reading_order() {
        let mut deck = fixture();
        deck["slides"]["slide-3"]["readingOrder"] = json!(["s3-image", "s3-title"]);
        assert_eq!(check(&deck), Ok(()));

        deck["slides"]["slide-3"]["readingOrder"] = json!(["s3-image", "missing"]);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::DanglingReference {
                kind: "reading order",
                ..
            })
        ));

        deck["slides"]["slide-3"]["readingOrder"] = json!(["s3-image", "s3-image"]);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::DuplicateId {
                kind: "reading order",
                ..
            })
        ));
    }

    #[test]
    fn rejects_slides_outside_powerpoints_size_range() {
        let mut deck = fixture();
        deck["size"]["width"] = json!(100);
        assert_eq!(check(&deck), Err(DeckValidationError::InvalidSlideSize));
    }

    #[test]
    fn enforces_text_limits() {
        let mut deck = fixture();
        element(&mut deck, "slide-5", "s5-note")["text"]["content"]["paragraphs"][0]["runs"] =
            json!([{ "kind": "text", "text": "x".repeat(DEFAULT_DECK_LIMITS.text_per_body + 1) }]);
        assert!(matches!(
            check(&deck),
            Err(DeckValidationError::LimitExceeded { .. })
        ));
    }

    mod references {
        use super::*;
        use crate::references::{collect_deck_references, rewrite_deck_references};

        fn kinds(deck: &str, target: &str) -> Vec<(String, String)> {
            collect_deck_references(deck, "Talks/Fixture.deck", target)
                .unwrap()
                .into_iter()
                .map(|reference| (reference.reference_kind, reference.referenced_relative_path))
                .collect()
        }

        #[test]
        fn collects_images_and_vault_links() {
            assert_eq!(
                kinds(FIXTURE, "assets"),
                vec![("deck-image".into(), "assets/deck-fixture.png".into())]
            );
            assert_eq!(
                kinds(FIXTURE, "docs/plans/presentation-tool-plan.md"),
                vec![(
                    "deck-link".into(),
                    "docs/plans/presentation-tool-plan.md".into()
                )]
            );
            assert!(kinds(FIXTURE, "elsewhere").is_empty());
        }

        #[test]
        fn collects_chart_sheet_and_embed_sources_and_background_fills() {
            let mut deck = fixture();
            element(&mut deck, "slide-5", "s5-chart")["source"] = json!({ "path": "Data/q3.sheet", "range": "A1:C4", "refreshedAt": "2026-01-01T00:00:00Z" });
            deck["slides"]["slide-4"]["background"] = json!({
                "kind": "image",
                "fit": "cover",
                "asset": { "path": "Data/bg.png", "mediaType": "image/png", "pixelWidth": 10, "pixelHeight": 10 }
            });
            deck["slides"]["slide-4"]["elements"]["s4-embed"] = json!({
                "id": "s4-embed", "type": "embed",
                "frame": { "x": 0, "y": 0, "width": 100, "height": 100 },
                "source": { "path": "Data/notes.md" }
            });
            deck["slides"]["slide-4"]["elementOrder"]
                .as_array_mut()
                .unwrap()
                .push(json!("s4-embed"));
            assert_eq!(check(&deck), Ok(()));
            let mut found = kinds(&serde_json::to_string(&deck).unwrap(), "Data");
            found.sort();
            assert_eq!(
                found,
                vec![
                    ("deck-embed".into(), "Data/notes.md".into()),
                    ("deck-image".into(), "Data/bg.png".into()),
                    ("deck-sheet".into(), "Data/q3.sheet".into()),
                ]
            );
        }

        #[test]
        fn rewrites_a_renamed_file_and_a_moved_folder() {
            let renamed = rewrite_deck_references(
                FIXTURE,
                "assets/deck-fixture.png",
                Some("media/diagram.png"),
            )
            .unwrap();
            assert!(renamed.contains("\"path\": \"media/diagram.png\""));
            assert!(!renamed.contains("assets/deck-fixture.png"));
            assert!(renamed.ends_with("}\n"));
            assert_eq!(check(&serde_json::from_str(&renamed).unwrap()), Ok(()));

            let moved = rewrite_deck_references(FIXTURE, "assets", Some("media")).unwrap();
            assert!(moved.contains("media/deck-fixture.png"));
        }

        #[test]
        fn keeps_a_deleted_target_so_the_placeholder_stays_repairable() {
            assert_eq!(
                rewrite_deck_references(FIXTURE, "assets/deck-fixture.png", None).unwrap(),
                FIXTURE
            );
        }

        #[test]
        fn leaves_an_unaffected_document_byte_for_byte() {
            assert_eq!(
                rewrite_deck_references(FIXTURE, "elsewhere", Some("other")).unwrap(),
                FIXTURE
            );
        }

        #[test]
        fn keeps_the_typescript_serialization_layout() {
            // Rewriting a path must change only that line, so history diffs stay small.
            let renamed = rewrite_deck_references(
                FIXTURE,
                "assets/deck-fixture.png",
                Some("assets/renamed.png"),
            )
            .unwrap();
            let changed: Vec<_> = FIXTURE
                .lines()
                .zip(renamed.lines())
                .filter(|(before, after)| before != after)
                .collect();
            assert_eq!(changed.len(), 1, "{changed:?}");
            assert_eq!(FIXTURE.lines().count(), renamed.lines().count());
        }
    }
}
