//! Bounded `.xlsx` reader.
//!
//! A `.xlsx` is a ZIP of XML written by software we do not control, so every
//! step here is bounded before it is parsed: the archive is rejected on entry
//! count, per-entry expanded size, and total expansion, and each XML document is
//! read as a stream rather than materialized into a tree.
//!
//! What is deliberately *not* imported is as important as what is. Macros,
//! external links, data connections, and embedded objects are refused or
//! reported, never carried across, because importing them would mean importing
//! something executable or something that silently reaches the network.

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};

use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};
use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use super::model::{
    ConvertedBorders, ConvertedCell, ConvertedNumberFormat, ConvertedRange, ConvertedStyle,
    ConvertedValue, ConvertedWorkbook, ConvertedWorksheet,
};
use super::report::ConversionReport;
use super::{parse_a1, ConversionError, ConversionLimits, ConversionResult, Converted};

/// The function baseline `.sheet` actually evaluates. Mirrors
/// `SHEET_FUNCTIONS` in `src/lib/sheet/formulaFunctions.ts` and the proof in
/// `crates/collab-sheet/tests/formula_proof.rs`; keep all three in sync.
const SUPPORTED_FUNCTIONS: &[&str] = &[
    "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS",
    "AVERAGEIF", "AVERAGEIFS", "IF", "IFS", "AND", "OR", "NOT", "IFERROR", "ROUND", "ABS", "MOD",
    "SQRT", "POWER", "CONCAT", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "DATE", "YEAR", "MONTH",
    "DAY", "TODAY", "NOW", "INDEX", "MATCH", "VLOOKUP", "HLOOKUP", "XLOOKUP",
];

/// Archive members that mean the workbook carries something Collab refuses to
/// import, mapped to what the user is told.
const REFUSED_PARTS: &[(&str, &str, &str)] = &[
    (
        "xl/vbaProject.bin",
        "Macros",
        "The workbook contains VBA macros. Collab never imports or runs macro code, so they were left behind.",
    ),
];

/// Archive members that are recognized, reported, and not carried across.
const SKIPPED_PARTS: &[(&str, &str, &str)] = &[
    (
        "xl/externalLinks/",
        "External workbook links",
        "Links to other workbooks were dropped. The cells that referenced them keep their last stored value.",
    ),
    (
        "xl/connections.xml",
        "External data connections",
        "External data connections were dropped; Collab workbooks never fetch data on their own.",
    ),
    (
        "xl/queryTables/",
        "Power Query / query tables",
        "Query tables were dropped; their last refreshed values were imported as plain cells.",
    ),
    (
        "xl/pivotCache",
        "Pivot tables",
        "Pivot tables and their caches are not supported and were not imported.",
    ),
    (
        "xl/charts/",
        "Charts",
        "Source charts were not imported. Rebuild them from the imported ranges with the chart tools.",
    ),
    (
        "xl/drawings/",
        "Drawings and images",
        "Shapes, images, and other drawing objects were not imported.",
    ),
    (
        "xl/embeddings/",
        "Embedded objects",
        "Embedded objects were not imported.",
    ),
    (
        "xl/threadedComments/",
        "Threaded comments",
        "Threaded comments were not imported; cell notes are supported but comment threads are not.",
    ),
];

#[derive(Default)]
struct StyleTables {
    /// numFmtId -> format code, for the custom formats a workbook declares.
    number_formats: HashMap<u32, String>,
    fonts: Vec<FontRecord>,
    fills: Vec<Option<String>>,
    borders: Vec<ConvertedBorders>,
    /// One entry per `cellXfs` record.
    cell_formats: Vec<CellFormat>,
}

#[derive(Default, Clone)]
struct FontRecord {
    bold: bool,
    italic: bool,
    underline: bool,
    strikethrough: bool,
    size: Option<f64>,
    family: Option<String>,
    color: Option<String>,
}

#[derive(Default, Clone)]
struct CellFormat {
    number_format_id: u32,
    font_id: usize,
    fill_id: usize,
    border_id: usize,
    horizontal_align: Option<String>,
    vertical_align: Option<String>,
    wrap: bool,
    indent: Option<u32>,
}

/// Reads a bounded archive entry as text.
struct BoundedArchive {
    zip: zip::ZipArchive<Cursor<Vec<u8>>>,
    names: Vec<String>,
    expanded_budget: usize,
    entry_limit: usize,
}

impl BoundedArchive {
    fn open(bytes: Vec<u8>, limits: &ConversionLimits) -> ConversionResult<Self> {
        let zip = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| ConversionError::NotAWorkbook(error.to_string()))?;
        if zip.len() > limits.archive_entries {
            return Err(ConversionError::TooLarge {
                limit: limits.archive_entries,
            });
        }
        let names = zip.file_names().map(str::to_string).collect::<Vec<_>>();
        // Path traversal has no meaning for an in-memory read — nothing is
        // written to disk — but an entry name that escapes the package is a
        // strong signal the file is hostile rather than merely unusual.
        for name in &names {
            if name.contains("..") || name.starts_with('/') || name.contains('\\') {
                return Err(ConversionError::Refused(format!(
                    "the archive contains an unsafe entry name: {name}"
                )));
            }
        }
        Ok(Self {
            zip,
            names,
            expanded_budget: limits.expanded_bytes,
            entry_limit: limits.entry_bytes,
        })
    }

    fn contains(&self, needle: &str) -> bool {
        self.names.iter().any(|name| name.starts_with(needle))
    }

    fn read(&mut self, name: &str) -> ConversionResult<Option<String>> {
        if !self.names.iter().any(|entry| entry == name) {
            return Ok(None);
        }
        let mut entry = self
            .zip
            .by_name(name)
            .map_err(|error| ConversionError::Malformed(error.to_string()))?;

        // The declared size is a hint from the archive, not a promise, so the
        // read is capped independently and stops the moment it is exceeded.
        let cap = self.entry_limit.min(self.expanded_budget);
        let mut buffer = Vec::new();
        let read = entry
            .by_ref()
            .take(cap as u64 + 1)
            .read_to_end(&mut buffer)
            .map_err(|error| ConversionError::Malformed(error.to_string()))?;
        if read > cap {
            return Err(ConversionError::TooLarge { limit: cap });
        }
        self.expanded_budget = self.expanded_budget.saturating_sub(read);

        String::from_utf8(buffer)
            .map(Some)
            .map_err(|_| ConversionError::Malformed(format!("{name} is not valid UTF-8")))
    }
}

fn attribute(element: &BytesStart, key: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        (attribute.key.as_ref() == key)
            .then(|| String::from_utf8_lossy(&attribute.value).into_owned())
    })
}

fn reader_for(xml: &str) -> Reader<&[u8]> {
    let mut reader = Reader::from_str(xml);
    // A workbook writes most records self-closing (`<xf .../>`, `<f .../>`),
    // so without this every parser here would have to duplicate its end
    // handling — and would silently skip the records that matter most.
    reader.config_mut().expand_empty_elements = true;
    // Text is kept verbatim: a shared string may legitimately be whitespace.
    reader
}

/// Resolves one entity reference.
///
/// quick-xml reports `&amp;` and friends as their own events rather than
/// folding them into the surrounding text, so a parser that ignores them
/// silently deletes every escaped character — `Item &amp; Co` would import as
/// `Item  Co`.
fn resolve_entity(reference: &BytesRef) -> Option<char> {
    if let Ok(Some(character)) = reference.resolve_char_ref() {
        return Some(character);
    }
    match reference.decode().ok()?.as_ref() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

/* -------------------------------------------------------------------------- */
/* Shared strings                                                             */
/* -------------------------------------------------------------------------- */

fn parse_shared_strings(xml: &str, limits: &ConversionLimits) -> ConversionResult<Vec<String>> {
    let mut reader = reader_for(xml);
    let mut buffer = Vec::new();
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => match element.local_name().as_ref() {
                b"si" => {
                    in_item = true;
                    current.clear();
                }
                b"t" if in_item => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => {
                current.push_str(&text.xml_content(XmlVersion::Explicit1_0).unwrap_or_default());
            }
            Ok(Event::GeneralRef(reference)) if in_text => {
                if let Some(character) = resolve_entity(&reference) {
                    current.push(character);
                }
            }
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                b"t" => in_text = false,
                b"si" => {
                    in_item = false;
                    current.truncate(limits.cell_text_length);
                    strings.push(std::mem::take(&mut current));
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(ConversionError::Malformed(error.to_string())),
            _ => {}
        }
        buffer.clear();
    }
    Ok(strings)
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

fn normalize_color(raw: &str) -> Option<String> {
    // Workbook colors are `AARRGGBB`; `.sheet` stores `#rrggbb`.
    let hex = raw.trim();
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_lowercase()))
}

fn parse_styles(xml: &str) -> ConversionResult<StyleTables> {
    let mut reader = reader_for(xml);
    let mut buffer = Vec::new();
    let mut tables = StyleTables::default();

    let mut section: Option<&'static str> = None;
    let mut font = FontRecord::default();
    let mut fill: Option<String> = None;
    let mut borders = ConvertedBorders::default();
    let mut cell_format: Option<CellFormat> = None;
    let mut in_cell_xfs = false;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| ConversionError::Malformed(error.to_string()))?;
        match event {
            Event::Eof => break,
            Event::Start(element) | Event::Empty(element) => {
                match element.local_name().as_ref() {
                    b"numFmt" => {
                        if let (Some(id), Some(code)) = (
                            attribute(&element, b"numFmtId").and_then(|v| v.parse::<u32>().ok()),
                            attribute(&element, b"formatCode"),
                        ) {
                            tables.number_formats.insert(id, code);
                        }
                    }
                    b"fonts" => section = Some("fonts"),
                    b"fills" => section = Some("fills"),
                    b"borders" => section = Some("borders"),
                    b"cellXfs" => {
                        section = Some("cellXfs");
                        in_cell_xfs = true;
                    }
                    b"font" if section == Some("fonts") => font = FontRecord::default(),
                    b"b" if section == Some("fonts") => font.bold = true,
                    b"i" if section == Some("fonts") => font.italic = true,
                    b"u" if section == Some("fonts") => font.underline = true,
                    b"strike" if section == Some("fonts") => font.strikethrough = true,
                    b"sz" if section == Some("fonts") => {
                        font.size = attribute(&element, b"val").and_then(|v| v.parse().ok());
                    }
                    b"name" if section == Some("fonts") => {
                        font.family = attribute(&element, b"val");
                    }
                    b"color" if section == Some("fonts") => {
                        font.color = attribute(&element, b"rgb").as_deref().and_then(normalize_color);
                    }
                    b"fill" if section == Some("fills") => fill = None,
                    b"patternFill" if section == Some("fills") => {
                        // `none` and `gray125` are the two default fills every
                        // workbook declares; treating them as a color would
                        // paint every cell.
                        let pattern = attribute(&element, b"patternType").unwrap_or_default();
                        if pattern != "none" && pattern != "gray125" {
                            fill = attribute(&element, b"fgColor").as_deref().and_then(normalize_color);
                        }
                    }
                    b"fgColor" if section == Some("fills") => {
                        if fill.is_none() {
                            fill = attribute(&element, b"rgb").as_deref().and_then(normalize_color);
                        }
                    }
                    b"border" if section == Some("borders") => borders = ConvertedBorders::default(),
                    b"top" if section == Some("borders") => {
                        borders.top = attribute(&element, b"style").is_some();
                    }
                    b"right" if section == Some("borders") => {
                        borders.right = attribute(&element, b"style").is_some();
                    }
                    b"bottom" if section == Some("borders") => {
                        borders.bottom = attribute(&element, b"style").is_some();
                    }
                    b"left" if section == Some("borders") => {
                        borders.left = attribute(&element, b"style").is_some();
                    }
                    b"xf" if in_cell_xfs => {
                        cell_format = Some(CellFormat {
                            number_format_id: attribute(&element, b"numFmtId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            font_id: attribute(&element, b"fontId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            fill_id: attribute(&element, b"fillId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            border_id: attribute(&element, b"borderId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            ..Default::default()
                        });
                    }
                    b"alignment" => {
                        if let Some(format) = cell_format.as_mut() {
                            format.horizontal_align = attribute(&element, b"horizontal")
                                .filter(|value| {
                                    matches!(value.as_str(), "left" | "center" | "right")
                                });
                            format.vertical_align = attribute(&element, b"vertical").map(|value| {
                                match value.as_str() {
                                    "center" => "middle".to_string(),
                                    "top" => "top".to_string(),
                                    _ => "bottom".to_string(),
                                }
                            });
                            format.wrap = attribute(&element, b"wrapText")
                                .is_some_and(|value| value == "1" || value == "true");
                            format.indent =
                                attribute(&element, b"indent").and_then(|v| v.parse().ok());
                        }
                    }
                    _ => {}
                }
            }
            Event::End(element) => match element.local_name().as_ref() {
                b"font" if section == Some("fonts") => tables.fonts.push(font.clone()),
                b"fill" if section == Some("fills") => tables.fills.push(fill.take()),
                b"border" if section == Some("borders") => tables.borders.push(borders),
                b"xf" if in_cell_xfs => {
                    if let Some(format) = cell_format.take() {
                        tables.cell_formats.push(format);
                    }
                }
                b"cellXfs" => {
                    in_cell_xfs = false;
                    section = None;
                }
                b"fonts" | b"fills" | b"borders" => section = None,
                _ => {}
            },
            _ => {}
        }
        buffer.clear();
    }

    Ok(tables)
}

/// Built-in number-format ids that mean a date, a time, or both.
fn builtin_temporal(id: u32) -> Option<&'static str> {
    match id {
        14..=17 => Some("date"),
        18..=21 => Some("time"),
        22 => Some("datetime"),
        45..=47 => Some("time"),
        _ => None,
    }
}

/// Classifies a custom format code without evaluating it.
///
/// `m` is the ambiguous token: it means months in a date code and minutes in a
/// time code. It is read as months only when the code carries no hour or second
/// token, which is the same rule every spreadsheet applies.
fn classify_format_code(code: &str) -> Option<&'static str> {
    let significant = |code: &str| -> Vec<char> {
        let mut out = Vec::new();
        let mut in_quotes = false;
        let mut chars = code.chars().peekable();
        while let Some(character) = chars.next() {
            match character {
                '"' => in_quotes = !in_quotes,
                '\\' => {
                    chars.next();
                }
                '[' => {
                    // `[$-409]` and `[Red]` are locale and color hints.
                    for skipped in chars.by_ref() {
                        if skipped == ']' {
                            break;
                        }
                    }
                }
                _ if in_quotes => {}
                other => out.push(other.to_ascii_lowercase()),
            }
        }
        out
    };

    let tokens = significant(code);
    let clock = tokens.iter().any(|c| matches!(c, 'h' | 's'));
    let mut has_date = false;
    let mut has_time = false;
    for token in tokens {
        match token {
            'y' | 'd' => has_date = true,
            'm' if !clock => has_date = true,
            'h' | 's' => has_time = true,
            _ => {}
        }
    }
    match (has_date, has_time) {
        (true, true) => Some("datetime"),
        (true, false) => Some("date"),
        (false, true) => Some("time"),
        (false, false) => None,
    }
}

fn number_format_for(id: u32, code: Option<&str>) -> Option<ConvertedNumberFormat> {
    let decimals_from = |code: &str| -> Option<u32> {
        code.split_once('.')
            .map(|(_, rest)| rest.chars().take_while(|c| *c == '0' || *c == '#').count() as u32)
    };
    // The built-ins Collab has a first-class equivalent for.
    let format = match id {
        0 => return None,
        1 => ConvertedNumberFormat {
            kind: "number".into(),
            decimals: Some(0),
            ..Default::default()
        },
        2 => ConvertedNumberFormat {
            kind: "number".into(),
            decimals: Some(2),
            ..Default::default()
        },
        3 => ConvertedNumberFormat {
            kind: "number".into(),
            decimals: Some(0),
            use_thousands_separator: true,
            ..Default::default()
        },
        4 => ConvertedNumberFormat {
            kind: "number".into(),
            decimals: Some(2),
            use_thousands_separator: true,
            ..Default::default()
        },
        9 => ConvertedNumberFormat {
            kind: "percent".into(),
            decimals: Some(0),
            ..Default::default()
        },
        10 => ConvertedNumberFormat {
            kind: "percent".into(),
            decimals: Some(2),
            ..Default::default()
        },
        49 => ConvertedNumberFormat {
            kind: "text".into(),
            ..Default::default()
        },
        _ => {
            if let Some(kind) = builtin_temporal(id) {
                ConvertedNumberFormat {
                    kind: kind.into(),
                    ..Default::default()
                }
            } else if let Some(code) = code {
                if let Some(kind) = classify_format_code(code) {
                    ConvertedNumberFormat {
                        kind: kind.into(),
                        ..Default::default()
                    }
                } else if code.contains('%') {
                    ConvertedNumberFormat {
                        kind: "percent".into(),
                        decimals: decimals_from(code),
                        ..Default::default()
                    }
                } else if code.contains('$') || code.contains('€') || code.contains('£') {
                    ConvertedNumberFormat {
                        kind: "currency".into(),
                        decimals: decimals_from(code),
                        use_thousands_separator: code.contains(','),
                        ..Default::default()
                    }
                } else {
                    // Preserved declaratively so nothing is lost, but Collab
                    // never executes a pattern it does not understand.
                    ConvertedNumberFormat {
                        kind: "custom".into(),
                        pattern: Some(code.to_string()),
                        ..Default::default()
                    }
                }
            } else {
                return None;
            }
        }
    };
    Some(format)
}

/* -------------------------------------------------------------------------- */
/* Serial dates                                                               */
/* -------------------------------------------------------------------------- */

/// Converts an Excel serial number to a date/time in the 1900 system.
///
/// Serial 60 is the 1900 leap-year bug: a day that never existed. Serials at or
/// below it are offset from 1899-12-31, later ones from 1899-12-30, which is the
/// conversion every spreadsheet application agrees on.
pub(crate) fn serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    if !serial.is_finite() || serial < 0.0 || serial > 2_958_465.0 {
        return None;
    }
    let days = serial.trunc() as i64;
    let epoch = if days <= 60 {
        NaiveDate::from_ymd_opt(1899, 12, 31)?
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30)?
    };
    let date = epoch.checked_add_signed(Duration::days(days))?;
    let seconds = ((serial.fract() * 86_400.0).round() as i64).clamp(0, 86_399);
    date.and_hms_opt(0, 0, 0)?.checked_add_signed(Duration::seconds(seconds))
}

fn temporal_value(kind: &str, serial: f64) -> Option<ConvertedValue> {
    let moment = serial_to_datetime(serial)?;
    Some(match kind {
        "date" => ConvertedValue::Date(moment.date().format("%Y-%m-%d").to_string()),
        "time" => ConvertedValue::Time(moment.time().format("%H:%M:%S").to_string()),
        _ => {
            if moment.time().num_seconds_from_midnight() == 0 && kind == "datetime" {
                ConvertedValue::DateTime(moment.format("%Y-%m-%dT%H:%M:%S").to_string())
            } else {
                ConvertedValue::DateTime(moment.format("%Y-%m-%dT%H:%M:%S").to_string())
            }
        }
    })
}

/* -------------------------------------------------------------------------- */
/* Formulas                                                                   */
/* -------------------------------------------------------------------------- */

/// Shifts every relative A1 reference in a formula by a row/column delta.
///
/// Needed for shared formulas: a workbook stores one master formula and marks
/// the rest of the range as sharing it, so without this every shared cell would
/// import the master's references verbatim and compute the wrong answer.
pub(crate) fn translate_references(source: &str, row_delta: i64, column_delta: i64) -> String {
    let mut out = String::with_capacity(source.len());
    let bytes: Vec<char> = source.chars().collect();
    let mut index = 0usize;
    let mut in_string = false;

    while index < bytes.len() {
        let character = bytes[index];
        if in_string {
            out.push(character);
            if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            out.push(character);
            index += 1;
            continue;
        }

        // A reference starts at a `$` or a letter that is not part of a longer
        // identifier (a function name, a sheet name, a named range).
        let start = index;
        let mut cursor = index;
        let mut column_absolute = false;
        if bytes[cursor] == '$' {
            column_absolute = true;
            cursor += 1;
        }
        let letters_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        let letters = cursor - letters_start;
        let mut row_absolute = false;
        if cursor < bytes.len() && bytes[cursor] == '$' {
            row_absolute = true;
            cursor += 1;
        }
        let digits_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        let digits = cursor - digits_start;
        let followed_by_identifier = cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == '_' || bytes[cursor] == '(');
        let preceded_by_identifier = start > 0
            && (bytes[start - 1].is_ascii_alphanumeric()
                || bytes[start - 1] == '_'
                || bytes[start - 1] == '$'
                || bytes[start - 1] == '!');

        if letters > 0
            && letters <= 3
            && digits > 0
            && digits <= 7
            && !followed_by_identifier
            && !preceded_by_identifier
        {
            let column_label: String = bytes[letters_start..letters_start + letters].iter().collect();
            let row_text: String = bytes[digits_start..digits_start + digits].iter().collect();
            if let Some((row, column)) = parse_a1(&format!("{column_label}{row_text}")) {
                let new_row = if row_absolute {
                    row as i64
                } else {
                    row as i64 + row_delta
                };
                let new_column = if column_absolute {
                    column as i64
                } else {
                    column as i64 + column_delta
                };
                if new_row < 0 || new_column < 0 {
                    out.push_str("#REF!");
                } else {
                    if column_absolute {
                        out.push('$');
                    }
                    out.push_str(&super::column_label(new_column as usize));
                    if row_absolute {
                        out.push('$');
                    }
                    out.push_str(&(new_row + 1).to_string());
                }
                index = cursor;
                continue;
            }
        }

        out.push(character);
        index += 1;
    }
    out
}

/// Extracts the function names a formula calls.
fn called_functions(source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let characters: Vec<char> = source.chars().collect();
    let mut index = 0usize;
    let mut in_string = false;
    let mut current = String::new();
    while index < characters.len() {
        let character = characters[index];
        if in_string {
            if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match character {
            '"' => in_string = true,
            c if c.is_ascii_alphanumeric() || c == '_' || c == '.' => current.push(c),
            '(' => {
                if !current.is_empty() {
                    names.push(current.to_ascii_uppercase());
                }
                current.clear();
            }
            _ => current.clear(),
        }
        index += 1;
    }
    names
}

/* -------------------------------------------------------------------------- */
/* Worksheets                                                                 */
/* -------------------------------------------------------------------------- */

struct SheetEntry {
    name: String,
    hidden: bool,
    target: String,
}

fn parse_workbook_sheets(xml: &str, relationships: &HashMap<String, String>) -> Vec<SheetEntry> {
    let mut reader = reader_for(xml);
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if element.local_name().as_ref() == b"sheet" =>
            {
                let name = attribute(&element, b"name").unwrap_or_else(|| "Sheet".into());
                let state = attribute(&element, b"state").unwrap_or_default();
                let id = element
                    .attributes()
                    .flatten()
                    .find(|attribute| attribute.key.as_ref().ends_with(b"id"))
                    .map(|attribute| String::from_utf8_lossy(&attribute.value).into_owned())
                    .unwrap_or_default();
                let target = relationships
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| format!("worksheets/sheet{}.xml", sheets.len() + 1));
                sheets.push(SheetEntry {
                    name,
                    hidden: state == "hidden" || state == "veryHidden",
                    target,
                });
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }
    sheets
}

fn parse_relationships(xml: &str) -> HashMap<String, String> {
    let mut reader = reader_for(xml);
    let mut buffer = Vec::new();
    let mut map = HashMap::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if element.local_name().as_ref() == b"Relationship" =>
            {
                if let (Some(id), Some(target)) =
                    (attribute(&element, b"Id"), attribute(&element, b"Target"))
                {
                    map.insert(id, target.trim_start_matches('/').to_string());
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }
    map
}

struct WorksheetParse {
    worksheet: ConvertedWorksheet,
    unsupported_functions: Vec<(String, String)>,
    array_formulas: usize,
}

#[allow(clippy::too_many_lines)]
fn parse_worksheet(
    xml: &str,
    name: &str,
    hidden: bool,
    shared_strings: &[String],
    styles: &StyleTables,
    limits: &ConversionLimits,
    report: &mut ConversionReport,
) -> ConversionResult<WorksheetParse> {
    let mut reader = reader_for(xml);
    let mut buffer = Vec::new();

    let mut worksheet = ConvertedWorksheet {
        name: name.to_string(),
        hidden,
        ..Default::default()
    };
    let mut unsupported_functions = Vec::new();
    let mut array_formulas = 0usize;

    // Shared formulas: si -> (origin row, origin column, source).
    let mut shared: HashMap<String, (usize, usize, String)> = HashMap::new();

    let mut position: Option<(usize, usize)> = None;
    let mut cell_type = String::new();
    let mut style_index: Option<usize> = None;
    let mut value = String::new();
    let mut formula = String::new();
    let mut formula_kind = String::new();
    let mut formula_si = String::new();
    let mut in_value = false;
    let mut in_formula = false;
    let mut in_inline_text = false;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| ConversionError::Malformed(error.to_string()))?;
        match event {
            Event::Eof => break,
            Event::Start(element) | Event::Empty(element) => {
                match element.local_name().as_ref() {
                    b"dimension" => {
                        if let Some(reference) = attribute(&element, b"ref") {
                            if let Some((_, end)) = reference.split_once(':') {
                                if let Some((row, column)) = parse_a1(end) {
                                    worksheet.ensure_extent(
                                        row.min(limits.rows_per_worksheet - 1),
                                        column.min(limits.columns_per_worksheet - 1),
                                    );
                                }
                            }
                        }
                    }
                    b"pane" => {
                        worksheet.frozen_rows = attribute(&element, b"ySplit")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0) as usize;
                        worksheet.frozen_columns = attribute(&element, b"xSplit")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0) as usize;
                    }
                    b"col" => {
                        let width = attribute(&element, b"width").and_then(|v| v.parse::<f64>().ok());
                        let custom = attribute(&element, b"customWidth")
                            .is_some_and(|value| value == "1" || value == "true");
                        if let (Some(width), true) = (width, custom) {
                            let min = attribute(&element, b"min")
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(1);
                            let max = attribute(&element, b"max")
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(min);
                            // Workbook column widths are in character units;
                            // roughly 7 CSS pixels each plus cell padding.
                            let pixels = (width * 7.0 + 5.0).round();
                            for index in min..=max.min(limits.columns_per_worksheet) {
                                worksheet.column_widths.insert(index - 1, pixels);
                            }
                        }
                    }
                    b"row" => {
                        let index = attribute(&element, b"r")
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(1)
                            .saturating_sub(1);
                        if attribute(&element, b"customHeight")
                            .is_some_and(|value| value == "1" || value == "true")
                        {
                            if let Some(height) =
                                attribute(&element, b"ht").and_then(|v| v.parse::<f64>().ok())
                            {
                                // Points to CSS pixels.
                                worksheet
                                    .row_heights
                                    .insert(index, (height * 96.0 / 72.0).round());
                            }
                        }
                        if attribute(&element, b"hidden")
                            .is_some_and(|value| value == "1" || value == "true")
                        {
                            worksheet.row_heights.insert(index, 0.0);
                        }
                    }
                    b"c" => {
                        position = attribute(&element, b"r").as_deref().and_then(parse_a1);
                        cell_type = attribute(&element, b"t").unwrap_or_default();
                        style_index = attribute(&element, b"s").and_then(|v| v.parse().ok());
                        value.clear();
                        formula.clear();
                        formula_kind.clear();
                        formula_si.clear();
                    }
                    b"f" => {
                        in_formula = true;
                        formula.clear();
                        formula_kind = attribute(&element, b"t").unwrap_or_default();
                        formula_si = attribute(&element, b"si").unwrap_or_default();
                    }
                    b"v" => {
                        in_value = true;
                        value.clear();
                    }
                    b"t" => in_inline_text = true,
                    b"mergeCell" => {
                        if let Some(reference) = attribute(&element, b"ref") {
                            if let Some((start, end)) = reference.split_once(':') {
                                if let (Some((top, left)), Some((bottom, right))) =
                                    (parse_a1(start), parse_a1(end))
                                {
                                    if worksheet.merges.len() < limits.merged_ranges_per_worksheet {
                                        worksheet.merges.push(ConvertedRange {
                                            top: top.min(bottom),
                                            left: left.min(right),
                                            bottom: top.max(bottom),
                                            right: left.max(right),
                                        });
                                        worksheet.ensure_extent(bottom, right);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(text) => {
                let decoded = text.xml_content(XmlVersion::Explicit1_0).unwrap_or_default();
                if in_value || in_inline_text {
                    value.push_str(&decoded);
                } else if in_formula {
                    formula.push_str(&decoded);
                }
            }
            Event::GeneralRef(reference) => {
                // Escaped characters arrive as their own events; dropping them
                // would quietly delete every `&`, `<`, and `>` a user typed.
                if let Some(character) = resolve_entity(&reference) {
                    if in_value || in_inline_text {
                        value.push(character);
                    } else if in_formula {
                        formula.push(character);
                    }
                }
            }
            Event::End(element) => match element.local_name().as_ref() {
                b"v" => in_value = false,
                b"f" => in_formula = false,
                b"t" => in_inline_text = false,
                b"c" => {
                    let Some((row, column)) = position.take() else {
                        continue;
                    };
                    if row >= limits.rows_per_worksheet || column >= limits.columns_per_worksheet {
                        report.truncated = true;
                        continue;
                    }

                    let mut source = if formula.is_empty() {
                        None
                    } else {
                        Some(formula.trim().to_string())
                    };
                    match formula_kind.as_str() {
                        "shared" => {
                            if let Some(text) = source.clone() {
                                shared.insert(formula_si.clone(), (row, column, text));
                            } else if let Some((origin_row, origin_column, text)) =
                                shared.get(&formula_si)
                            {
                                source = Some(translate_references(
                                    text,
                                    row as i64 - *origin_row as i64,
                                    column as i64 - *origin_column as i64,
                                ));
                            }
                        }
                        "array" | "dataTable" => {
                            array_formulas += 1;
                        }
                        _ => {}
                    }

                    let style = style_index
                        .and_then(|index| styles.cell_formats.get(index))
                        .map(|format| {
                            let font = styles.fonts.get(format.font_id).cloned().unwrap_or_default();
                            ConvertedStyle {
                                bold: font.bold,
                                italic: font.italic,
                                underline: font.underline,
                                strikethrough: font.strikethrough,
                                font_size: font.size,
                                font_family: font.family,
                                color: font.color,
                                background_color: styles
                                    .fills
                                    .get(format.fill_id)
                                    .cloned()
                                    .flatten(),
                                horizontal_align: format.horizontal_align.clone(),
                                vertical_align: format.vertical_align.clone(),
                                wrap: format.wrap,
                                indent: format.indent,
                                borders: styles
                                    .borders
                                    .get(format.border_id)
                                    .copied()
                                    .unwrap_or_default(),
                                number_format: number_format_for(
                                    format.number_format_id,
                                    styles.number_formats.get(&format.number_format_id).map(String::as_str),
                                ),
                            }
                        })
                        .filter(|style| !style.is_empty());

                    let temporal_kind = style
                        .as_ref()
                        .and_then(|style| style.number_format.as_ref())
                        .map(|format| format.kind.as_str())
                        .filter(|kind| matches!(*kind, "date" | "time" | "datetime"));

                    let converted = match cell_type.as_str() {
                        "s" => value
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| shared_strings.get(index))
                            .map(|text| ConvertedValue::Text(text.clone()))
                            .unwrap_or(ConvertedValue::Blank),
                        "inlineStr" | "str" => {
                            if value.is_empty() {
                                ConvertedValue::Blank
                            } else {
                                let mut text = value.clone();
                                text.truncate(limits.cell_text_length);
                                ConvertedValue::Text(text)
                            }
                        }
                        "b" => ConvertedValue::Boolean(value.trim() == "1"),
                        "e" => ConvertedValue::Error(value.trim().to_string()),
                        _ => match value.trim().parse::<f64>() {
                            Ok(number) => temporal_kind
                                .and_then(|kind| temporal_value(kind, number))
                                .unwrap_or(ConvertedValue::Number(number)),
                            Err(_) if value.trim().is_empty() => ConvertedValue::Blank,
                            Err(_) => ConvertedValue::Text(value.trim().to_string()),
                        },
                    };

                    if let Some(text) = &source {
                        if text.len() > limits.formula_source_length {
                            report.flattened(
                                "Formulas",
                                "A formula was longer than Collab allows and was imported as its last value.",
                                Some(format!("{name}!{}{}", super::column_label(column), row + 1)),
                            );
                            source = None;
                        } else {
                            for function in called_functions(text) {
                                if !SUPPORTED_FUNCTIONS.contains(&function.as_str()) {
                                    unsupported_functions.push((
                                        function,
                                        format!("{name}!{}{}", super::column_label(column), row + 1),
                                    ));
                                }
                            }
                        }
                    }

                    if source.is_none() && converted.is_blank() && style.is_none() {
                        continue;
                    }
                    if worksheet.cells.len() >= limits.cells_per_worksheet {
                        report.truncated = true;
                        continue;
                    }
                    worksheet.ensure_extent(row, column);
                    worksheet.cells.push(ConvertedCell {
                        row,
                        column,
                        value: converted,
                        formula: source.map(|text| {
                            if text.starts_with('=') {
                                text
                            } else {
                                format!("={text}")
                            }
                        }),
                        style,
                    });
                }
                _ => {}
            },
            _ => {}
        }
        buffer.clear();
    }

    worksheet.cells.sort_by_key(|cell| (cell.row, cell.column));
    worksheet.row_count = worksheet.row_count.max(1);
    worksheet.column_count = worksheet.column_count.max(1);
    Ok(WorksheetParse {
        worksheet,
        unsupported_functions,
        array_formulas,
    })
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

pub fn import_xlsx(
    bytes: &[u8],
    workbook_name: &str,
    limits: &ConversionLimits,
) -> ConversionResult<Converted<ConvertedWorkbook>> {
    if bytes.len() > limits.source_bytes {
        return Err(ConversionError::TooLarge {
            limit: limits.source_bytes,
        });
    }

    let mut report = ConversionReport::default();
    let mut archive = BoundedArchive::open(bytes.to_vec(), limits)?;

    for (part, feature, detail) in REFUSED_PARTS {
        if archive.contains(part) {
            report.skipped(*feature, *detail, None);
        }
    }
    for (part, feature, detail) in SKIPPED_PARTS {
        if archive.contains(part) {
            report.skipped(*feature, *detail, None);
        }
    }

    let relationships = archive
        .read("xl/_rels/workbook.xml.rels")?
        .map(|xml| parse_relationships(&xml))
        .unwrap_or_default();
    let workbook_xml = archive.read("xl/workbook.xml")?.ok_or_else(|| {
        ConversionError::NotAWorkbook("the archive has no xl/workbook.xml".into())
    })?;
    let sheets = parse_workbook_sheets(&workbook_xml, &relationships);
    if sheets.is_empty() {
        return Err(ConversionError::Malformed(
            "the workbook declares no worksheets".into(),
        ));
    }
    if sheets.len() > limits.worksheets {
        return Err(ConversionError::LimitExceeded(format!(
            "a workbook may not have more than {} worksheets",
            limits.worksheets
        )));
    }

    let shared_strings = match archive.read("xl/sharedStrings.xml")? {
        Some(xml) => parse_shared_strings(&xml, limits)?,
        None => Vec::new(),
    };
    let styles = match archive.read("xl/styles.xml")? {
        Some(xml) => parse_styles(&xml)?,
        None => StyleTables::default(),
    };

    let mut worksheets = Vec::with_capacity(sheets.len());
    let mut unsupported: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut array_formulas = 0usize;
    let mut total_cells = 0usize;

    for sheet in &sheets {
        let path = format!("xl/{}", sheet.target);
        let Some(xml) = archive.read(&path)? else {
            report.skipped(
                "Worksheet",
                format!("The worksheet \"{}\" is missing from the file and was not imported.", sheet.name),
                None,
            );
            continue;
        };
        let parsed = parse_worksheet(
            &xml,
            &sheet.name,
            sheet.hidden,
            &shared_strings,
            &styles,
            limits,
            &mut report,
        )?;
        total_cells += parsed.worksheet.cells.len();
        if total_cells > limits.cells_per_workbook {
            return Err(ConversionError::LimitExceeded(format!(
                "a workbook may not have more than {} populated cells",
                limits.cells_per_workbook
            )));
        }
        for (function, location) in parsed.unsupported_functions {
            let entry = unsupported.entry(function).or_insert((0, location));
            entry.0 += 1;
        }
        array_formulas += parsed.array_formulas;
        worksheets.push(parsed.worksheet);
    }

    if worksheets.is_empty() {
        return Err(ConversionError::Malformed(
            "no worksheet in the workbook could be read".into(),
        ));
    }

    report.imported(
        "Worksheets",
        format!(
            "Imported {} worksheet(s) with {total_cells} populated cell(s).",
            worksheets.len()
        ),
    );
    let formula_cells: usize = worksheets
        .iter()
        .flat_map(|sheet| sheet.cells.iter())
        .filter(|cell| cell.formula.is_some())
        .count();
    if formula_cells > 0 {
        report.imported(
            "Formulas",
            format!("Imported {formula_cells} formula(s) as source; Collab recalculates them on open."),
        );
    }
    for (function, (count, location)) in unsupported {
        report.unsupported(
            "Formula function",
            format!(
                "{function} is not supported and will show an error in {count} cell(s). The formula source was kept so nothing is lost."
            ),
            Some(location),
        );
    }
    if array_formulas > 0 {
        report.flattened(
            "Array formulas",
            format!("{array_formulas} array or data-table formula(s) were imported as ordinary single-cell formulas; they may compute a different result."),
            None,
        );
    }

    Ok(Converted {
        value: ConvertedWorkbook {
            name: workbook_name.to_string(),
            worksheets,
        },
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_relative_references_and_keeps_absolute_ones() {
        assert_eq!(translate_references("=A1+B2", 1, 0), "=A2+B3");
        assert_eq!(translate_references("=$A$1+B2", 1, 1), "=$A$1+C3");
        assert_eq!(translate_references("=$A1", 2, 3), "=$A3");
        assert_eq!(translate_references("=A$1", 2, 3), "=D$1");
    }

    #[test]
    fn does_not_translate_function_names_or_strings() {
        assert_eq!(translate_references("=SUM(A1:A3)", 1, 0), "=SUM(A2:A4)");
        assert_eq!(translate_references("=\"A1\"&A1", 1, 0), "=\"A1\"&A2");
        assert_eq!(translate_references("=LOG10(A1)", 1, 0), "=LOG10(A2)");
    }

    #[test]
    fn reports_a_reference_pushed_off_the_grid() {
        assert_eq!(translate_references("=A1", -5, 0), "=#REF!");
    }

    #[test]
    fn extracts_called_function_names() {
        assert_eq!(
            called_functions("=SUM(A1)+xlfn.STDEV.P(B1:B2)"),
            vec!["SUM".to_string(), "XLFN.STDEV.P".to_string()]
        );
        assert!(called_functions("=A1+B1").is_empty());
        assert!(called_functions("=\"SUM(\"").is_empty());
    }

    #[test]
    fn converts_serial_numbers_using_the_1900_system() {
        // 1900-03-01 is serial 61 in every spreadsheet, because serial 60 is
        // the day that never existed.
        assert_eq!(
            serial_to_datetime(61.0).unwrap().date(),
            NaiveDate::from_ymd_opt(1900, 3, 1).unwrap()
        );
        assert_eq!(
            serial_to_datetime(1.0).unwrap().date(),
            NaiveDate::from_ymd_opt(1900, 1, 1).unwrap()
        );
        assert_eq!(
            serial_to_datetime(46_000.0).unwrap().date(),
            NaiveDate::from_ymd_opt(2025, 12, 9).unwrap()
        );
        assert!(serial_to_datetime(-1.0).is_none());
        assert!(serial_to_datetime(f64::NAN).is_none());
    }

    #[test]
    fn converts_the_fractional_part_to_a_time() {
        let moment = serial_to_datetime(45_000.5).unwrap();
        assert_eq!(moment.time().format("%H:%M:%S").to_string(), "12:00:00");
    }

    #[test]
    fn classifies_number_formats_without_evaluating_them() {
        assert_eq!(classify_format_code("yyyy-mm-dd"), Some("date"));
        assert_eq!(classify_format_code("hh:mm:ss"), Some("time"));
        assert_eq!(classify_format_code("yyyy-mm-dd hh:mm"), Some("datetime"));
        assert_eq!(classify_format_code("0.00"), None);
        // Quoted literals must not turn a plain number format into a date.
        assert_eq!(classify_format_code("0.00\" days\""), None);
        // Locale and color hints must not be read as format tokens.
        assert_eq!(classify_format_code("[$-409]0.00"), None);
        assert_eq!(classify_format_code("mm"), Some("date"));
        assert_eq!(classify_format_code("[h]:mm:ss"), Some("time"));
    }

    #[test]
    fn maps_common_builtin_number_formats() {
        assert_eq!(number_format_for(0, None), None);
        assert_eq!(number_format_for(9, None).unwrap().kind, "percent");
        assert_eq!(number_format_for(4, None).unwrap().use_thousands_separator, true);
        assert_eq!(number_format_for(14, None).unwrap().kind, "date");
        assert_eq!(number_format_for(49, None).unwrap().kind, "text");
        let custom = number_format_for(200, Some("[$€-x-euro2] #,##0.00")).unwrap();
        assert_eq!(custom.kind, "currency");
        assert!(custom.use_thousands_separator);
    }

    #[test]
    fn normalizes_argb_colors() {
        assert_eq!(normalize_color("FFAABBCC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_color("AABBCC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_color("nope"), None);
    }
}
