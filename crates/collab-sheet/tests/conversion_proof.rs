//! Phase 10 conversion proof for the Advanced Tables plan.
//!
//! The unit tests inside `collab_sheet::convert` cover each piece in isolation.
//! This file proves the two things the compatibility contract actually promises:
//! that a workbook survives an import/export round trip in the features we say
//! are supported, and that a hostile or exotic `.xlsx` fails safely instead of
//! reaching the rest of the application.
//!
//! Fixtures are built here rather than checked in as binaries so that what a
//! test claims about a file is visible next to the assertion. The XML shapes
//! mirror what Excel and LibreOffice actually emit — shared strings, a shared
//! formula group, `numFmt` date styles, merges, and a frozen pane.

use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use collab_sheet::convert::{
    export_xlsx, import_xlsx, sheet_document_to_workbook, workbook_to_sheet_document,
    ConversionError, ConversionSeverity, ConvertedCell, ConvertedNumberFormat, ConvertedRange,
    ConvertedStyle, ConvertedValue, ConvertedWorkbook, ConvertedWorksheet,
    DEFAULT_CONVERSION_LIMITS,
};

fn zip_of(parts: &[(&str, &str)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in parts {
        archive.start_file(*name, options).unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#;

const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#;

const WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Budget" sheetId="1" r:id="rId1"/>
<sheet name="Notes" sheetId="2" state="hidden" r:id="rId2"/>
</sheets>
</workbook>"#;

const SHARED_STRINGS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>Rent</t></si>
<si><t>Amount</t></si>
<si><r><t>Rich </t></r><r><t>text</t></r></si>
</sst>"#;

/// Two custom formats plus a bold red font, one solid fill, one bottom border,
/// and four `xf` records — the shape a real workbook produces.
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/></numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FFCC0000"/><name val="Arial"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEE00"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"/><diagonal/></border>
</borders>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"#;

/// A1/B1 headers, a shared formula group in C2:C4, a date, a percentage, a
/// boolean, an error, an inline string, a merge, a frozen pane, and a custom
/// column width.
const SHEET1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F5"/>
<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<cols><col min="2" max="2" width="18.5" customWidth="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1">
<c r="A1" s="1" t="s"><v>0</v></c>
<c r="B1" s="1" t="s"><v>1</v></c>
</row>
<row r="2">
<c r="A2"><v>10</v></c>
<c r="B2"><v>2</v></c>
<c r="C2"><f t="shared" ref="C2:C4" si="0">A2*B2</f><v>20</v></c>
<c r="D2" s="2"><v>46085</v></c>
<c r="E2" s="3"><v>0.25</v></c>
<c r="F2" t="b"><v>1</v></c>
</row>
<row r="3">
<c r="A3"><v>20</v></c>
<c r="B3"><v>3</v></c>
<c r="C3"><f t="shared" si="0"/><v>60</v></c>
<c r="D3" t="inlineStr"><is><t>inline</t></is></c>
<c r="E3" t="e"><v>#DIV/0!</v></c>
<c r="F3" t="s"><v>2</v></c>
</row>
<row r="4">
<c r="A4"><v>30</v></c>
<c r="B4"><v>4</v></c>
<c r="C4"><f t="shared" si="0"/><v>120</v></c>
</row>
<row r="5">
<c r="A5"><f>SUM(A2:A4)</f><v>60</v></c>
<c r="B5"><f>STDEV.P(B2:B4)</f><v>0.8</v></c>
</row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>"#;

const SHEET2: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden sheet</t></is></c></row></sheetData>
</worksheet>"#;

fn realistic_workbook_parts() -> Vec<(&'static str, &'static str)> {
    vec![
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
        ("xl/sharedStrings.xml", SHARED_STRINGS),
        ("xl/styles.xml", STYLES),
        ("xl/worksheets/sheet1.xml", SHEET1),
        ("xl/worksheets/sheet2.xml", SHEET2),
    ]
}

fn import(parts: &[(&str, &str)]) -> collab_sheet::convert::Converted<ConvertedWorkbook> {
    import_xlsx(&zip_of(parts), "Imported", &DEFAULT_CONVERSION_LIMITS).unwrap()
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

#[test]
fn imports_worksheet_names_order_and_visibility() {
    let workbook = import(&realistic_workbook_parts()).value;
    assert_eq!(workbook.worksheets.len(), 2);
    assert_eq!(workbook.worksheets[0].name, "Budget");
    assert_eq!(workbook.worksheets[1].name, "Notes");
    assert!(!workbook.worksheets[0].hidden);
    assert!(workbook.worksheets[1].hidden);
}

#[test]
fn imports_every_supported_cell_type() {
    let workbook = import(&realistic_workbook_parts()).value;
    let sheet = &workbook.worksheets[0];

    assert_eq!(
        sheet.cell_at(0, 0).unwrap().value,
        ConvertedValue::Text("Rent".into()),
        "shared string"
    );
    assert_eq!(
        sheet.cell_at(1, 0).unwrap().value,
        ConvertedValue::Number(10.0),
        "number"
    );
    assert_eq!(
        sheet.cell_at(2, 3).unwrap().value,
        ConvertedValue::Text("inline".into()),
        "inline string"
    );
    assert_eq!(
        sheet.cell_at(1, 5).unwrap().value,
        ConvertedValue::Boolean(true),
        "boolean"
    );
    assert_eq!(
        sheet.cell_at(2, 4).unwrap().value,
        ConvertedValue::Error("#DIV/0!".into()),
        "error"
    );
    assert_eq!(
        sheet.cell_at(2, 5).unwrap().value,
        ConvertedValue::Text("Rich text".into()),
        "rich text runs are concatenated into plain text"
    );
}

#[test]
fn converts_a_date_serial_using_its_number_format() {
    // Without reading the style, 46085 would import as the number 46085.
    let workbook = import(&realistic_workbook_parts()).value;
    assert_eq!(
        workbook.worksheets[0].cell_at(1, 3).unwrap().value,
        ConvertedValue::Date("2026-03-04".into())
    );
}

#[test]
fn expands_a_shared_formula_group_with_translated_references() {
    // The archive stores `A2*B2` once; the other two cells only point at it.
    // Importing them verbatim would compute the first row's answer three times.
    let workbook = import(&realistic_workbook_parts()).value;
    let sheet = &workbook.worksheets[0];
    assert_eq!(
        sheet.cell_at(1, 2).unwrap().formula.as_deref(),
        Some("=A2*B2")
    );
    assert_eq!(
        sheet.cell_at(2, 2).unwrap().formula.as_deref(),
        Some("=A3*B3")
    );
    assert_eq!(
        sheet.cell_at(3, 2).unwrap().formula.as_deref(),
        Some("=A4*B4")
    );
}

#[test]
fn imports_merges_frozen_panes_and_explicit_dimensions() {
    let sheet = &import(&realistic_workbook_parts()).value.worksheets[0];
    assert_eq!(
        sheet.merges,
        vec![ConvertedRange {
            top: 0,
            left: 0,
            bottom: 0,
            right: 1
        }]
    );
    assert_eq!((sheet.frozen_rows, sheet.frozen_columns), (1, 1));
    assert!(sheet.column_widths.contains_key(&1), "custom column width");
    assert!(sheet.row_heights.contains_key(&0), "custom row height");
}

#[test]
fn imports_font_fill_border_and_alignment_styles() {
    let sheet = &import(&realistic_workbook_parts()).value.worksheets[0];
    let style = sheet.cell_at(0, 0).unwrap().style.clone().unwrap();
    assert!(style.bold);
    assert_eq!(style.font_size, Some(12.0));
    assert_eq!(style.font_family.as_deref(), Some("Arial"));
    assert_eq!(style.color.as_deref(), Some("#cc0000"));
    assert_eq!(style.background_color.as_deref(), Some("#ffee00"));
    assert_eq!(style.horizontal_align.as_deref(), Some("center"));
    assert!(style.wrap);
    assert!(style.borders.bottom);

    let percent = sheet.cell_at(1, 4).unwrap().style.clone().unwrap();
    assert_eq!(percent.number_format.unwrap().kind, "percent");
}

#[test]
fn reports_an_unsupported_function_instead_of_claiming_compatibility() {
    let converted = import(&realistic_workbook_parts());
    let note = converted
        .report
        .notes
        .iter()
        .find(|note| note.severity == ConversionSeverity::Unsupported)
        .expect("STDEV.P is outside the supported baseline");
    assert!(note.detail.contains("STDEV.P"));

    // The source is still kept, so nothing the user wrote is lost — the cell
    // shows an error rather than a wrong number.
    let sheet = &converted.value.worksheets[0];
    assert_eq!(
        sheet.cell_at(4, 1).unwrap().formula.as_deref(),
        Some("=STDEV.P(B2:B4)")
    );
    assert!(!converted.report.is_lossless());
}

#[test]
fn reports_features_it_refuses_to_carry_across() {
    let mut parts = realistic_workbook_parts();
    parts.push((
        "xl/vbaProject.bin",
        "not really a macro, but the part exists",
    ));
    parts.push(("xl/connections.xml", "<connections/>"));
    parts.push(("xl/externalLinks/externalLink1.xml", "<externalLink/>"));
    parts.push(("xl/charts/chart1.xml", "<chart/>"));

    let report = import(&parts).report;
    for feature in [
        "Macros",
        "External data connections",
        "External workbook links",
        "Charts",
    ] {
        assert!(
            report.notes.iter().any(|note| note.feature == feature),
            "{feature} was not reported"
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Failing safely                                                             */
/* -------------------------------------------------------------------------- */

#[test]
fn rejects_a_file_that_is_not_an_archive() {
    assert!(matches!(
        import_xlsx(b"this is a text file", "x", &DEFAULT_CONVERSION_LIMITS),
        Err(ConversionError::NotAWorkbook(_))
    ));
}

#[test]
fn rejects_an_archive_with_no_workbook_part() {
    assert!(matches!(
        import_xlsx(
            &zip_of(&[("readme.txt", "hello")]),
            "x",
            &DEFAULT_CONVERSION_LIMITS
        ),
        Err(ConversionError::NotAWorkbook(_))
    ));
}

#[test]
fn rejects_an_entry_name_that_escapes_the_package() {
    assert!(matches!(
        import_xlsx(
            &zip_of(&[("../../etc/passwd", "x"), ("xl/workbook.xml", WORKBOOK)]),
            "x",
            &DEFAULT_CONVERSION_LIMITS
        ),
        Err(ConversionError::Refused(_))
    ));
}

#[test]
fn rejects_an_archive_with_too_many_entries() {
    let mut limits = DEFAULT_CONVERSION_LIMITS;
    limits.archive_entries = 3;
    let bytes = zip_of(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
        ("xl/worksheets/sheet1.xml", SHEET1),
    ]);
    assert!(matches!(
        import_xlsx(&bytes, "x", &limits),
        Err(ConversionError::TooLarge { .. })
    ));
}

#[test]
fn refuses_to_expand_a_decompression_bomb() {
    // A megabyte of zeroes compresses to almost nothing; a real bomb is the
    // same trick at scale. The guard is the expanded size, never the stored one.
    let payload = "0".repeat(1024 * 1024);
    let bytes = zip_of(&[
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
        ("xl/worksheets/sheet1.xml", &payload),
    ]);
    assert!(
        bytes.len() < 16 * 1024,
        "the fixture must actually be highly compressed"
    );

    let mut limits = DEFAULT_CONVERSION_LIMITS;
    limits.entry_bytes = 4_096;
    assert!(matches!(
        import_xlsx(&bytes, "x", &limits),
        Err(ConversionError::TooLarge { .. })
    ));
}

#[test]
fn rejects_a_source_file_over_the_size_limit() {
    let mut limits = DEFAULT_CONVERSION_LIMITS;
    limits.source_bytes = 16;
    assert!(matches!(
        import_xlsx(&zip_of(&[("a", "b")]), "x", &limits),
        Err(ConversionError::TooLarge { limit: 16 })
    ));
}

#[test]
fn rejects_a_workbook_declaring_more_worksheets_than_allowed() {
    let mut limits = DEFAULT_CONVERSION_LIMITS;
    limits.worksheets = 1;
    assert!(matches!(
        import_xlsx(&zip_of(&realistic_workbook_parts()), "x", &limits),
        Err(ConversionError::LimitExceeded(_))
    ));
}

#[test]
fn survives_malformed_worksheet_xml_without_panicking() {
    let mut parts = realistic_workbook_parts();
    parts.retain(|(name, _)| *name != "xl/worksheets/sheet1.xml");
    parts.push(("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row"));
    let result = import_xlsx(&zip_of(&parts), "x", &DEFAULT_CONVERSION_LIMITS);
    assert!(matches!(result, Err(ConversionError::Malformed(_))));
}

/* -------------------------------------------------------------------------- */
/* Semantic round trip                                                        */
/* -------------------------------------------------------------------------- */

fn source_workbook() -> ConvertedWorkbook {
    ConvertedWorkbook {
        name: "Round trip".into(),
        worksheets: vec![ConvertedWorksheet {
            name: "Data".into(),
            row_count: 4,
            column_count: 4,
            cells: vec![
                ConvertedCell {
                    row: 0,
                    column: 0,
                    value: ConvertedValue::Text("Item & <qty>".into()),
                    formula: None,
                    style: Some(ConvertedStyle {
                        bold: true,
                        italic: true,
                        color: Some("#112233".into()),
                        background_color: Some("#ffee00".into()),
                        horizontal_align: Some("center".into()),
                        wrap: true,
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
                ConvertedCell {
                    row: 2,
                    column: 1,
                    value: ConvertedValue::Boolean(false),
                    formula: None,
                    style: None,
                },
                ConvertedCell {
                    row: 3,
                    column: 0,
                    value: ConvertedValue::Number(0.25),
                    formula: None,
                    style: Some(ConvertedStyle {
                        number_format: Some(ConvertedNumberFormat {
                            kind: "percent".into(),
                            decimals: Some(1),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                },
            ],
            column_widths: BTreeMap::from([(1usize, 180.0)]),
            merges: vec![ConvertedRange {
                top: 1,
                left: 2,
                bottom: 2,
                right: 3,
            }],
            frozen_rows: 1,
            frozen_columns: 1,
            ..Default::default()
        }],
    }
}

/// Compares the features the compatibility matrix claims survive a round trip.
/// Byte equality is explicitly *not* the contract.
#[test]
fn a_workbook_survives_export_and_reimport_semantically() {
    let source = source_workbook();
    let exported = export_xlsx(&source).unwrap();
    let reimported = import_xlsx(&exported.value, "Round trip", &DEFAULT_CONVERSION_LIMITS)
        .unwrap()
        .value;

    assert_eq!(reimported.worksheets.len(), 1);
    let before = &source.worksheets[0];
    let after = &reimported.worksheets[0];
    assert_eq!(after.name, before.name);
    assert_eq!(after.frozen_rows, before.frozen_rows);
    assert_eq!(after.frozen_columns, before.frozen_columns);
    assert_eq!(after.merges, before.merges);

    for cell in &before.cells {
        let round_tripped = after
            .cell_at(cell.row, cell.column)
            .unwrap_or_else(|| panic!("lost the cell at {},{}", cell.row, cell.column));
        assert_eq!(
            round_tripped.formula, cell.formula,
            "formula at {},{}",
            cell.row, cell.column
        );
        if cell.formula.is_none() {
            assert_eq!(
                round_tripped.value, cell.value,
                "value at {},{}",
                cell.row, cell.column
            );
        }
    }

    // Styles survive as properties, not as identity.
    let header = after.cell_at(0, 0).unwrap().style.clone().unwrap();
    assert!(header.bold && header.italic && header.wrap);
    assert_eq!(header.color.as_deref(), Some("#112233"));
    assert_eq!(header.background_color.as_deref(), Some("#ffee00"));
    assert_eq!(header.horizontal_align.as_deref(), Some("center"));

    let percent = after.cell_at(3, 0).unwrap().style.clone().unwrap();
    assert_eq!(percent.number_format.unwrap().kind, "percent");
}

#[test]
fn a_round_trip_through_the_sheet_document_keeps_the_same_content() {
    // The path a user actually takes: file -> .sheet -> file.
    let imported = import(&realistic_workbook_parts()).value;
    let document = workbook_to_sheet_document(
        &imported,
        "wb-1",
        "2026-01-01T00:00:00.000Z",
        &DEFAULT_CONVERSION_LIMITS,
    )
    .unwrap();
    let back = sheet_document_to_workbook(&document, &BTreeMap::new()).unwrap();
    let exported = export_xlsx(&back).unwrap();
    let reimported = import_xlsx(&exported.value, "Again", &DEFAULT_CONVERSION_LIMITS)
        .unwrap()
        .value;

    assert_eq!(reimported.worksheets.len(), 2);
    assert_eq!(reimported.worksheets[0].name, "Budget");
    assert!(reimported.worksheets[1].hidden);
    assert_eq!(
        reimported.worksheets[0].cell_at(0, 0).unwrap().value,
        ConvertedValue::Text("Rent".into())
    );
    assert_eq!(
        reimported.worksheets[0]
            .cell_at(2, 2)
            .unwrap()
            .formula
            .as_deref(),
        Some("=A3*B3"),
        "the expanded shared formula must survive, not the shared reference"
    );
    assert_eq!(
        reimported.worksheets[0].cell_at(1, 3).unwrap().value,
        ConvertedValue::Date("2026-03-04".into()),
        "a date must not degrade into a serial number across a round trip"
    );
}

#[test]
fn an_export_never_carries_anything_executable() {
    let exported = export_xlsx(&source_workbook()).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(exported.value)).unwrap();
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    for forbidden in [
        "vbaProject",
        "connections",
        "externalLink",
        "queryTable",
        "macro",
    ] {
        assert!(
            !names.iter().any(|name| name.contains(forbidden)),
            "export wrote {forbidden}"
        );
    }
    assert!(archive.by_name("xl/workbook.xml").is_ok());
}
