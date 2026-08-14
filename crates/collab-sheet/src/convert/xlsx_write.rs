//! Minimal, valid `.xlsx` writer.
//!
//! The output is a newly generated copy, never the backing file of an open
//! document. It contains only the parts a spreadsheet application needs to open
//! the workbook: content types, the workbook part, per-worksheet parts, and a
//! style table. Nothing executable and nothing that reaches the network is ever
//! written, so an exported file cannot carry a capability the source `.sheet`
//! did not have.
//!
//! Strings are written inline rather than through a shared-string table. It
//! costs some size on repetitive sheets and removes an entire class of index
//! mismatch between two parts of the archive.

use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use chrono::NaiveDate;

use super::column_label;
use super::model::{
    ConvertedNumberFormat, ConvertedStyle, ConvertedValue, ConvertedWorkbook, ConvertedWorksheet,
};
use super::report::ConversionReport;
use super::{ConversionError, ConversionResult, Converted};

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids most control characters outright; dropping them
            // is the only way to produce a file that opens at all.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Worksheet names may not contain these, and may not be blank or over 31
/// characters — a stricter limit than `.sheet`'s own.
fn sanitize_worksheet_name(name: &str, index: usize, taken: &mut Vec<String>) -> (String, bool) {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | '?' | '*' | '[' | ']' | ':'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('\'');
    let mut candidate: String = if trimmed.is_empty() {
        format!("Sheet{}", index + 1)
    } else {
        trimmed.chars().take(31).collect()
    };
    let changed = candidate != name;
    let base = candidate.clone();
    let mut suffix = 2;
    while taken
        .iter()
        .any(|used| used.eq_ignore_ascii_case(&candidate))
    {
        let room = 31 - format!(" ({suffix})").len();
        candidate = format!("{} ({suffix})", base.chars().take(room).collect::<String>());
        suffix += 1;
    }
    taken.push(candidate.clone());
    let changed = changed || candidate != base;
    (candidate, changed)
}

/// Converts an ISO-8601 value back to a serial number in the 1900 system.
fn datetime_to_serial(value: &ConvertedValue) -> Option<f64> {
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    let (date_part, time_part) = match value {
        ConvertedValue::Date(iso) => (Some(iso.as_str()), None),
        ConvertedValue::Time(iso) => (None, Some(iso.as_str())),
        ConvertedValue::DateTime(iso) => match iso.split_once('T') {
            Some((date, time)) => (Some(date), Some(time)),
            None => (Some(iso.as_str()), None),
        },
        _ => return None,
    };

    let days = match date_part {
        Some(text) => {
            let date = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
            let days = (date - epoch).num_days();
            // Dates before 1900-03-01 sit one day earlier than the naive offset
            // because every spreadsheet reproduces the phantom 1900-02-29.
            if days <= 60 {
                days - 1
            } else {
                days
            }
        }
        None => 0,
    };

    let fraction = match time_part {
        Some(text) => {
            let text = text.trim_end_matches('Z');
            let text = text.split(['+']).next().unwrap_or(text);
            let mut parts = text.split(':');
            let hours: f64 = parts.next()?.parse().ok()?;
            let minutes: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
            let seconds: f64 = parts
                .next()
                .unwrap_or("0")
                .split('.')
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);
            (hours * 3600.0 + minutes * 60.0 + seconds) / 86_400.0
        }
        None => 0.0,
    };

    Some(days as f64 + fraction)
}

/// Number-format codes for the `.sheet` formats that have a faithful
/// equivalent. Anything else is written without a format and reported.
fn format_code(format: &ConvertedNumberFormat) -> Option<String> {
    let decimals = format.decimals.unwrap_or(2).min(10) as usize;
    let fraction = if decimals == 0 {
        String::new()
    } else {
        format!(".{}", "0".repeat(decimals))
    };
    let integer = if format.use_thousands_separator {
        "#,##0"
    } else {
        "0"
    };
    match format.kind.as_str() {
        "general" => None,
        "number" => Some(format!("{integer}{fraction}")),
        "percent" => Some(format!("0{fraction}%")),
        "currency" => {
            let symbol = match format.currency_code.as_deref() {
                Some("EUR") => "€",
                Some("GBP") => "£",
                Some("JPY") => "¥",
                _ => "$",
            };
            Some(format!("\"{symbol}\"{integer}{fraction}"))
        }
        "date" => Some("yyyy\\-mm\\-dd".into()),
        "time" => Some("hh:mm:ss".into()),
        "datetime" => Some("yyyy\\-mm\\-dd\\ hh:mm:ss".into()),
        "text" => Some("@".into()),
        "custom" => format.pattern.clone(),
        _ => None,
    }
}

/// The style tables an export builds up as it walks the workbook.
#[derive(Default)]
struct StyleWriter {
    fonts: Vec<String>,
    fills: Vec<String>,
    borders: Vec<String>,
    number_formats: Vec<(u32, String)>,
    /// Rendered `xf` records, keyed by their own XML so identical styles share
    /// one entry.
    formats: Vec<String>,
    index: BTreeMap<String, usize>,
}

impl StyleWriter {
    fn new() -> Self {
        Self {
            // Index 0 of each table is the default every workbook must declare.
            fonts: vec!["<font><sz val=\"11\"/><name val=\"Calibri\"/></font>".into()],
            fills: vec![
                "<fill><patternFill patternType=\"none\"/></fill>".into(),
                "<fill><patternFill patternType=\"gray125\"/></fill>".into(),
            ],
            borders: vec!["<border><left/><right/><top/><bottom/><diagonal/></border>".into()],
            number_formats: Vec::new(),
            formats: vec![
                "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>".into(),
            ],
            index: BTreeMap::new(),
        }
    }

    fn intern(&mut self, style: &ConvertedStyle) -> usize {
        let key = format!("{style:?}");
        if let Some(existing) = self.index.get(&key) {
            return *existing;
        }

        let mut font = String::from("<font>");
        if style.bold {
            font.push_str("<b/>");
        }
        if style.italic {
            font.push_str("<i/>");
        }
        if style.underline {
            font.push_str("<u/>");
        }
        if style.strikethrough {
            font.push_str("<strike/>");
        }
        font.push_str(&format!(
            "<sz val=\"{}\"/>",
            style.font_size.unwrap_or(11.0)
        ));
        if let Some(color) = &style.color {
            font.push_str(&format!(
                "<color rgb=\"FF{}\"/>",
                color.trim_start_matches('#').to_ascii_uppercase()
            ));
        }
        font.push_str(&format!(
            "<name val=\"{}\"/></font>",
            escape(style.font_family.as_deref().unwrap_or("Calibri"))
        ));
        let font_id = self
            .fonts
            .iter()
            .position(|existing| *existing == font)
            .unwrap_or_else(|| {
                self.fonts.push(font);
                self.fonts.len() - 1
            });

        let fill_id = match &style.background_color {
            Some(color) => {
                let fill = format!(
                    "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{}\"/><bgColor indexed=\"64\"/></patternFill></fill>",
                    color.trim_start_matches('#').to_ascii_uppercase()
                );
                self.fills
                    .iter()
                    .position(|existing| *existing == fill)
                    .unwrap_or_else(|| {
                        self.fills.push(fill);
                        self.fills.len() - 1
                    })
            }
            None => 0,
        };

        let border_id = if style.borders.any() {
            let edge = |present: bool, name: &str| {
                if present {
                    format!("<{name} style=\"thin\"/>")
                } else {
                    format!("<{name}/>")
                }
            };
            let border = format!(
                "<border>{}{}{}{}<diagonal/></border>",
                edge(style.borders.left, "left"),
                edge(style.borders.right, "right"),
                edge(style.borders.top, "top"),
                edge(style.borders.bottom, "bottom"),
            );
            self.borders
                .iter()
                .position(|existing| *existing == border)
                .unwrap_or_else(|| {
                    self.borders.push(border);
                    self.borders.len() - 1
                })
        } else {
            0
        };

        let number_format_id = match style.number_format.as_ref().and_then(format_code) {
            Some(code) => {
                // Custom ids start at 164 by convention; below that is reserved
                // for the built-ins every application already knows.
                let existing = self
                    .number_formats
                    .iter()
                    .find(|(_, existing)| *existing == code)
                    .map(|(id, _)| *id);
                match existing {
                    Some(id) => id,
                    None => {
                        let id = 164 + self.number_formats.len() as u32;
                        self.number_formats.push((id, code));
                        id
                    }
                }
            }
            None => 0,
        };

        let mut xf = format!(
            "<xf numFmtId=\"{number_format_id}\" fontId=\"{font_id}\" fillId=\"{fill_id}\" borderId=\"{border_id}\" xfId=\"0\""
        );
        if number_format_id != 0 {
            xf.push_str(" applyNumberFormat=\"1\"");
        }
        if font_id != 0 {
            xf.push_str(" applyFont=\"1\"");
        }
        if fill_id != 0 {
            xf.push_str(" applyFill=\"1\"");
        }
        if border_id != 0 {
            xf.push_str(" applyBorder=\"1\"");
        }

        let alignment = style.horizontal_align.is_some()
            || style.vertical_align.is_some()
            || style.wrap
            || style.indent.is_some();
        if alignment {
            xf.push_str(" applyAlignment=\"1\"><alignment");
            if let Some(align) = &style.horizontal_align {
                xf.push_str(&format!(" horizontal=\"{align}\""));
            }
            if let Some(align) = &style.vertical_align {
                let mapped = if align == "middle" { "center" } else { align };
                xf.push_str(&format!(" vertical=\"{mapped}\""));
            }
            if style.wrap {
                xf.push_str(" wrapText=\"1\"");
            }
            if let Some(indent) = style.indent {
                xf.push_str(&format!(" indent=\"{indent}\""));
            }
            xf.push_str("/></xf>");
        } else {
            xf.push_str("/>");
        }

        let id = self
            .formats
            .iter()
            .position(|existing| *existing == xf)
            .unwrap_or_else(|| {
                self.formats.push(xf);
                self.formats.len() - 1
            });
        self.index.insert(key, id);
        id
    }

    fn render(&self) -> String {
        let number_formats = if self.number_formats.is_empty() {
            String::new()
        } else {
            format!(
                "<numFmts count=\"{}\">{}</numFmts>",
                self.number_formats.len(),
                self.number_formats
                    .iter()
                    .map(|(id, code)| format!(
                        "<numFmt numFmtId=\"{id}\" formatCode=\"{}\"/>",
                        escape(code)
                    ))
                    .collect::<String>()
            )
        };
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
{number_formats}\
<fonts count=\"{}\">{}</fonts>\
<fills count=\"{}\">{}</fills>\
<borders count=\"{}\">{}</borders>\
<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
<cellXfs count=\"{}\">{}</cellXfs>\
</styleSheet>",
            self.fonts.len(),
            self.fonts.concat(),
            self.fills.len(),
            self.fills.concat(),
            self.borders.len(),
            self.borders.concat(),
            self.formats.len(),
            self.formats.concat(),
        )
    }
}

fn worksheet_xml(worksheet: &ConvertedWorksheet, styles: &mut StyleWriter) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
    );

    if worksheet.row_count > 0 && worksheet.column_count > 0 {
        xml.push_str(&format!(
            "<dimension ref=\"A1:{}{}\"/>",
            column_label(worksheet.column_count - 1),
            worksheet.row_count
        ));
    }

    // Frozen panes.
    xml.push_str("<sheetViews><sheetView workbookViewId=\"0\"");
    if worksheet.frozen_rows > 0 || worksheet.frozen_columns > 0 {
        xml.push('>');
        xml.push_str(&format!(
            "<pane xSplit=\"{}\" ySplit=\"{}\" topLeftCell=\"{}{}\" activePane=\"bottomRight\" state=\"frozen\"/>",
            worksheet.frozen_columns,
            worksheet.frozen_rows,
            column_label(worksheet.frozen_columns),
            worksheet.frozen_rows + 1,
        ));
        xml.push_str("</sheetView>");
    } else {
        xml.push_str("/>");
    }
    xml.push_str("</sheetViews>");

    if !worksheet.column_widths.is_empty() {
        xml.push_str("<cols>");
        for (index, pixels) in &worksheet.column_widths {
            // Inverse of the import conversion.
            let characters = ((pixels - 5.0) / 7.0).max(0.5);
            xml.push_str(&format!(
                "<col min=\"{}\" max=\"{}\" width=\"{characters:.2}\" customWidth=\"1\"/>",
                index + 1,
                index + 1
            ));
        }
        xml.push_str("</cols>");
    }

    xml.push_str("<sheetData>");
    let mut by_row: BTreeMap<usize, Vec<&super::model::ConvertedCell>> = BTreeMap::new();
    for cell in &worksheet.cells {
        by_row.entry(cell.row).or_default().push(cell);
    }
    for (row, cells) in by_row {
        let height = worksheet.row_heights.get(&row);
        xml.push_str(&format!("<row r=\"{}\"", row + 1));
        match height {
            Some(pixels) if *pixels <= 0.0 => xml.push_str(" hidden=\"1\""),
            Some(pixels) => xml.push_str(&format!(
                " ht=\"{:.2}\" customHeight=\"1\"",
                pixels * 72.0 / 96.0
            )),
            None => {}
        }
        xml.push('>');

        for cell in cells {
            let reference = format!("{}{}", column_label(cell.column), cell.row + 1);
            let style_id = cell
                .style
                .as_ref()
                .filter(|style| !style.is_empty())
                .map(|style| styles.intern(style))
                .unwrap_or(0);
            let style_attribute = if style_id == 0 {
                String::new()
            } else {
                format!(" s=\"{style_id}\"")
            };

            let formula = cell
                .formula
                .as_ref()
                .map(|source| format!("<f>{}</f>", escape(source.trim_start_matches('='))));

            let (type_attribute, body) = match &cell.value {
                ConvertedValue::Number(number) => (String::new(), format!("<v>{number}</v>")),
                ConvertedValue::Boolean(value) => (
                    " t=\"b\"".to_string(),
                    format!("<v>{}</v>", u8::from(*value)),
                ),
                ConvertedValue::Error(code) => {
                    (" t=\"e\"".to_string(), format!("<v>{}</v>", escape(code)))
                }
                ConvertedValue::Text(text) => (
                    " t=\"inlineStr\"".to_string(),
                    format!("<is><t xml:space=\"preserve\">{}</t></is>", escape(text)),
                ),
                value @ (ConvertedValue::Date(_)
                | ConvertedValue::Time(_)
                | ConvertedValue::DateTime(_)) => match datetime_to_serial(value) {
                    Some(serial) => (String::new(), format!("<v>{serial}</v>")),
                    None => (String::new(), String::new()),
                },
                ConvertedValue::Blank => (String::new(), String::new()),
            };

            // A formula cell with a text result cannot use `inlineStr`; the
            // cached result is simply omitted and the consumer recalculates.
            let (type_attribute, body) = match (&formula, type_attribute.as_str()) {
                (Some(_), " t=\"inlineStr\"") => (" t=\"str\"".to_string(), String::new()),
                _ => (type_attribute, body),
            };

            xml.push_str(&format!(
                "<c r=\"{reference}\"{style_attribute}{type_attribute}>"
            ));
            if let Some(formula) = formula {
                xml.push_str(&formula);
            }
            xml.push_str(&body);
            xml.push_str("</c>");
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData>");

    if !worksheet.merges.is_empty() {
        xml.push_str(&format!(
            "<mergeCells count=\"{}\">",
            worksheet.merges.len()
        ));
        for merge in &worksheet.merges {
            xml.push_str(&format!(
                "<mergeCell ref=\"{}{}:{}{}\"/>",
                column_label(merge.left),
                merge.top + 1,
                column_label(merge.right),
                merge.bottom + 1,
            ));
        }
        xml.push_str("</mergeCells>");
    }

    xml.push_str("</worksheet>");
    xml
}

/// Writes a workbook as a new `.xlsx` archive.
pub fn export_xlsx(workbook: &ConvertedWorkbook) -> ConversionResult<Converted<Vec<u8>>> {
    if workbook.worksheets.is_empty() {
        return Err(ConversionError::Malformed(
            "the workbook contains no worksheets".into(),
        ));
    }

    let mut report = ConversionReport::default();
    let mut styles = StyleWriter::new();
    let mut names = Vec::new();
    let mut sheet_parts = Vec::new();

    for (index, worksheet) in workbook.worksheets.iter().enumerate() {
        let (name, renamed) = sanitize_worksheet_name(&worksheet.name, index, &mut names);
        if renamed {
            report.flattened(
                "Worksheet names",
                format!(
                    "Renamed \"{}\" to \"{name}\" to satisfy the stricter .xlsx naming rules.",
                    worksheet.name
                ),
                None,
            );
        }
        sheet_parts.push((name, worksheet_xml(worksheet, &mut styles)));
    }

    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let write = |archive: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
                 name: &str,
                 body: &str|
     -> ConversionResult<()> {
        archive
            .start_file(name, options)
            .map_err(|error| ConversionError::Malformed(error.to_string()))?;
        archive
            .write_all(body.as_bytes())
            .map_err(|error| ConversionError::Malformed(error.to_string()))
    };

    let content_types = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\
{}</Types>",
        (1..=sheet_parts.len())
            .map(|index| format!(
                "<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            ))
            .collect::<String>()
    );
    write(&mut archive, "[Content_Types].xml", &content_types)?;

    write(
        &mut archive,
        "_rels/.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
</Relationships>",
    )?;

    let sheets_xml = sheet_parts
        .iter()
        .enumerate()
        .map(|(index, (name, _))| {
            let hidden = workbook.worksheets[index]
                .hidden
                .then_some(" state=\"hidden\"")
                .unwrap_or_default();
            format!(
                "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"{hidden}/>",
                escape(name),
                index + 1,
                index + 1
            )
        })
        .collect::<String>();
    write(
        &mut archive,
        "xl/workbook.xml",
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
<sheets>{sheets_xml}</sheets></workbook>"
        ),
    )?;

    let workbook_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
{}<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
</Relationships>",
        (1..=sheet_parts.len())
            .map(|index| format!(
                "<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>"
            ))
            .collect::<String>(),
        sheet_parts.len() + 1,
    );
    write(&mut archive, "xl/_rels/workbook.xml.rels", &workbook_rels)?;

    for (index, (_, xml)) in sheet_parts.iter().enumerate() {
        write(
            &mut archive,
            &format!("xl/worksheets/sheet{}.xml", index + 1),
            xml,
        )?;
    }
    // Styles are written last because interning happens while worksheets render.
    write(&mut archive, "xl/styles.xml", &styles.render())?;

    let bytes = archive
        .finish()
        .map_err(|error| ConversionError::Malformed(error.to_string()))?
        .into_inner();

    report.imported(
        "Worksheets",
        format!(
            "Exported {} worksheet(s) with {} populated cell(s).",
            workbook.worksheets.len(),
            workbook.populated_cells()
        ),
    );
    let formulas = workbook.formula_cells();
    if formulas > 0 {
        report.imported(
            "Formulas",
            format!("Exported {formulas} formula(s) as source; the receiving application recalculates them."),
        );
    }
    report.skipped(
        "Collab-only features",
        "Charts, conditional formatting, data validation, structured tables, named ranges, protected ranges, cell links, attachments, and notes are not written to .xlsx.",
        None,
    );

    Ok(Converted {
        value: bytes,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::model::{ConvertedBorders, ConvertedCell, ConvertedRange};

    fn workbook() -> ConvertedWorkbook {
        ConvertedWorkbook {
            name: "Budget".into(),
            worksheets: vec![ConvertedWorksheet {
                name: "Q1".into(),
                row_count: 3,
                column_count: 3,
                cells: vec![
                    ConvertedCell {
                        row: 0,
                        column: 0,
                        value: ConvertedValue::Text("Rent & <utilities>".into()),
                        formula: None,
                        style: Some(ConvertedStyle {
                            bold: true,
                            background_color: Some("#ffcc00".into()),
                            borders: ConvertedBorders {
                                bottom: true,
                                ..Default::default()
                            },
                            ..Default::default()
                        }),
                    },
                    ConvertedCell {
                        row: 0,
                        column: 1,
                        value: ConvertedValue::Number(1240.5),
                        formula: None,
                        style: None,
                    },
                    ConvertedCell {
                        row: 1,
                        column: 1,
                        value: ConvertedValue::Number(2481.0),
                        formula: Some("=B1*2".into()),
                        style: None,
                    },
                    ConvertedCell {
                        row: 2,
                        column: 0,
                        value: ConvertedValue::Date("2026-03-04".into()),
                        formula: None,
                        style: Some(ConvertedStyle {
                            number_format: Some(ConvertedNumberFormat {
                                kind: "date".into(),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }),
                    },
                ],
                merges: vec![ConvertedRange {
                    top: 1,
                    left: 0,
                    bottom: 1,
                    right: 0,
                }],
                frozen_rows: 1,
                ..Default::default()
            }],
        }
    }

    fn part(bytes: &[u8], name: &str) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut text = String::new();
        use std::io::Read;
        entry.read_to_string(&mut text).unwrap();
        text
    }

    #[test]
    fn writes_an_archive_with_the_required_parts() {
        let converted = export_xlsx(&workbook()).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(converted.value.clone())).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_string).collect();
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
            "xl/styles.xml",
        ] {
            assert!(names.contains(&required.to_string()), "missing {required}");
        }
        assert!(archive.by_name("xl/workbook.xml").is_ok());
    }

    #[test]
    fn escapes_text_so_the_archive_stays_valid_xml() {
        let converted = export_xlsx(&workbook()).unwrap();
        let sheet = part(&converted.value, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("Rent &amp; &lt;utilities&gt;"));
        assert!(!sheet.contains("Rent & <utilities>"));
    }

    #[test]
    fn writes_formulas_without_their_leading_equals() {
        let sheet = part(
            &export_xlsx(&workbook()).unwrap().value,
            "xl/worksheets/sheet1.xml",
        );
        assert!(sheet.contains("<f>B1*2</f>"));
        assert!(!sheet.contains("<f>=B1*2</f>"));
    }

    #[test]
    fn writes_merges_and_frozen_panes() {
        let sheet = part(
            &export_xlsx(&workbook()).unwrap().value,
            "xl/worksheets/sheet1.xml",
        );
        assert!(sheet.contains("<mergeCell ref=\"A2:A2\"/>"));
        assert!(sheet.contains("ySplit=\"1\""));
        assert!(sheet.contains("state=\"frozen\""));
    }

    #[test]
    fn writes_dates_as_serials_with_a_date_number_format() {
        let sheet = part(
            &export_xlsx(&workbook()).unwrap().value,
            "xl/worksheets/sheet1.xml",
        );
        // 2026-03-04 is serial 46085.
        assert!(sheet.contains("<v>46085</v>"), "{sheet}");
        let styles = part(&export_xlsx(&workbook()).unwrap().value, "xl/styles.xml");
        assert!(styles.contains("yyyy"));
    }

    #[test]
    fn deduplicates_identical_styles() {
        let mut source = workbook();
        let bold = Some(ConvertedStyle {
            bold: true,
            ..Default::default()
        });
        source.worksheets[0].cells[0].style = bold.clone();
        source.worksheets[0].cells[1].style = bold.clone();
        source.worksheets[0].cells[2].style = bold;
        source.worksheets[0].cells[3].style = None;

        let styles = part(&export_xlsx(&source).unwrap().value, "xl/styles.xml");
        // The default plus exactly one interned format.
        assert!(styles.contains("<cellXfs count=\"2\">"), "{styles}");
    }

    #[test]
    fn sanitizes_worksheet_names_and_reports_it() {
        let source = ConvertedWorkbook {
            name: "Book".into(),
            worksheets: vec![ConvertedWorksheet {
                name: "Q1/Q2 [draft]".into(),
                row_count: 1,
                column_count: 1,
                ..Default::default()
            }],
        };
        let converted = export_xlsx(&source).unwrap();
        let workbook_xml = part(&converted.value, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Q1Q2 draft\""));
        assert!(converted
            .report
            .notes
            .iter()
            .any(|note| note.feature == "Worksheet names"));
    }

    #[test]
    fn always_reports_the_collab_only_features_it_cannot_write() {
        let converted = export_xlsx(&workbook()).unwrap();
        assert!(!converted.report.is_lossless());
        assert!(converted
            .report
            .notes
            .iter()
            .any(|note| note.feature == "Collab-only features"));
    }

    #[test]
    fn serial_conversion_round_trips_with_the_reader() {
        for iso in ["1900-01-01", "1900-03-01", "2026-03-04", "2100-12-31"] {
            let serial = datetime_to_serial(&ConvertedValue::Date(iso.into())).unwrap();
            let back = super::super::xlsx_read::serial_to_datetime(serial).unwrap();
            assert_eq!(back.date().format("%Y-%m-%d").to_string(), iso);
        }
    }

    #[test]
    fn rejects_an_empty_workbook() {
        assert!(matches!(
            export_xlsx(&ConvertedWorkbook::default()),
            Err(ConversionError::Malformed(_))
        ));
    }
}
