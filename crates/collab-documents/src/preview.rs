//! Bounded, self-contained content thumbnails. No scripts, network, assets,
//! formula evaluation, or editor runtime are involved.
use crate::{classify_path, DocumentKind};
use serde_json::Value;

pub const RENDERER_VERSION: i32 = 1;
pub const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;

fn escape(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(100)
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn text(x: usize, y: usize, value: &str, size: usize) -> String {
    format!(
        "<text x=\"{x}\" y=\"{y}\" font-size=\"{size}\" fill=\"#334155\">{}</text>",
        escape(value)
    )
}
fn lines(values: impl Iterator<Item = String>) -> String {
    values
        .take(12)
        .enumerate()
        .map(|(i, line)| text(24, 74 + i * 20, &line, 13))
        .collect()
}
fn label(value: &Value) -> String {
    [
        "title",
        "label",
        "text",
        "relativePath",
        "name",
        "type",
        "kind",
    ]
    .iter()
    .find_map(|key| value.get(key).and_then(Value::as_str))
    .unwrap_or("Item")
    .to_owned()
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn render(path: &str, content: &[u8]) -> Result<String, String> {
    if content.len() > MAX_SOURCE_BYTES {
        return Err("Document is too large for a preview.".into());
    }
    let kind = classify_path(path).ok_or("This format has no content preview.")?;
    let content = std::str::from_utf8(content).map_err(|_| "Document is not UTF-8.")?;
    let title = path.rsplit('/').next().unwrap_or(path);
    let body = if kind == DocumentKind::Note {
        let mut markdown = content;
        if let Some(after) = markdown.strip_prefix("---\n") {
            if let Some((_, rest)) = after.split_once("\n---\n") {
                markdown = rest;
            }
        }
        lines(
            markdown
                .lines()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim_start_matches(['#', '>', ' ']).to_owned()),
        )
    } else {
        let value: Value =
            serde_json::from_str(content).map_err(|_| "Document is not valid JSON.")?;
        match kind {
            DocumentKind::Sheet => sheet(&value),
            DocumentKind::Deck => deck(&value),
            DocumentKind::Ink => ink(&value),
            DocumentKind::Kanban => lines(array(&value, "columns").iter().flat_map(|column| {
                std::iter::once(label(column)).chain(
                    array(column, "cards")
                        .iter()
                        .take(4)
                        .map(|card| format!("  • {}", label(card))),
                )
            })),
            DocumentKind::Canvas | DocumentKind::Logic => lines(
                array(&value, "nodes")
                    .iter()
                    .map(|node| format!("• {}", label(node))),
            ),
            _ => return Err("This format has no content preview.".into()),
        }
    };
    Ok(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"480\" height=\"320\" viewBox=\"0 0 480 320\"><rect width=\"480\" height=\"320\" rx=\"12\" fill=\"#f8fafc\"/><g font-family=\"sans-serif\">{}<path d=\"M24 49H456\" stroke=\"#cbd5e1\"/>{body}</g></svg>", text(24, 32, title, 17)))
}

fn sheet(value: &Value) -> String {
    let Some(sheet) = array(value, "worksheets").first() else {
        return text(24, 80, "Empty workbook", 14);
    };
    let mut out = text(
        24,
        70,
        sheet.get("name").and_then(Value::as_str).unwrap_or("Sheet"),
        12,
    );
    for (r, row) in array(sheet, "rowOrder").iter().take(7).enumerate() {
        for (c, column) in array(sheet, "columnOrder").iter().take(5).enumerate() {
            let key = format!(
                "{}:{}",
                row.as_str().unwrap_or(""),
                column.as_str().unwrap_or("")
            );
            let cell = &sheet["cells"][&key];
            let cell_text = if let Some(formula) = cell["formula"].as_str() {
                formula.to_owned()
            } else if let Some(s) = cell["value"].as_str() {
                s.to_owned()
            } else if cell["value"].is_null() {
                String::new()
            } else {
                cell["value"].to_string()
            };
            let x = 24 + c * 86;
            let y = 80 + r * 30;
            out.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"86\" height=\"30\" fill=\"white\" stroke=\"#cbd5e1\"/>"));
            out.push_str(&text(
                x + 5,
                y + 20,
                &cell_text.chars().take(11).collect::<String>(),
                11,
            ));
        }
    }
    out
}
fn deck(value: &Value) -> String {
    let Some(id) = array(value, "slideOrder").first().and_then(Value::as_str) else {
        return text(24, 80, "Empty presentation", 14);
    };
    let slide = &value["slides"][id];
    let mut values = Vec::new();
    for id in array(slide, "elementOrder")
        .iter()
        .take(40)
        .filter_map(Value::as_str)
    {
        let element = &slide["elements"][id];
        for paragraph in array(&element["text"]["content"], "paragraphs")
            .iter()
            .take(12)
        {
            let line = array(paragraph, "runs")
                .iter()
                .filter_map(|run| run["text"].as_str())
                .take(30)
                .map(|s| s.chars().take(100).collect::<String>())
                .collect::<String>();
            if !line.is_empty() {
                values.push(line);
            }
        }
        if element["type"].as_str() != Some("text") {
            values.push(format!("[{}]", label(element)));
        }
    }
    if values.is_empty() {
        values.push("First slide · no text".into());
    }
    lines(values.into_iter())
}
fn ink(value: &Value) -> String {
    let Some(id) = array(value, "pageOrder").first().and_then(Value::as_str) else {
        return text(24, 80, "Empty ink document", 14);
    };
    let page = &value["pages"][id];
    let width = page["width"].as_f64().unwrap_or(1.0).max(1.0);
    let height = page["height"].as_f64().unwrap_or(1.0).max(1.0);
    let scale = (432.0 / width).min(240.0 / height);
    let scene = &page["scene"];
    let mut out = String::new();
    let mut remaining_points = 1800;
    for id in array(scene, "objectOrder")
        .iter()
        .take(200)
        .filter_map(Value::as_str)
    {
        let object = &scene["objects"][id];
        if let Some(layer_id) = object["layerId"].as_str() {
            if scene["layers"][layer_id]["visible"] == false {
                continue;
            }
        }
        if object["type"] != "stroke" {
            continue;
        }
        let xs = array(&object["samples"], "x");
        let ys = array(&object["samples"], "y");
        let (mut x, mut y) = (0.0, 0.0);
        let mut points = String::new();
        for (dx, dy) in xs.iter().zip(ys).take(remaining_points.min(1000)) {
            remaining_points -= 1;
            x += dx.as_f64().unwrap_or(0.0);
            y += dy.as_f64().unwrap_or(0.0);
            if x.is_finite() && y.is_finite() {
                points.push_str(&format!(
                    "{:.1},{:.1} ",
                    (24.0 + x * scale).clamp(-480.0, 960.0),
                    (64.0 + y * scale).clamp(-320.0, 640.0)
                ));
            }
        }
        out.push_str(&format!("<polyline points=\"{points}\" fill=\"none\" stroke=\"#334155\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"));
        if remaining_points == 0 || out.len() > 48 * 1024 {
            break;
        }
    }
    if out.is_empty() {
        text(24, 80, "First page · no visible strokes", 14)
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_are_bounded_escaped_and_do_not_fetch_embedded_content() {
        let svg = render(
            "<script>.md",
            b"# Hello\n<script>alert(1)</script>\n![x](https://example.com)",
        )
        .unwrap();
        assert!(svg.contains("Hello"));
        assert!(!svg.contains("<script>"));
        assert!(!svg.contains("href="));
        assert!(svg.len() < 4000);
        assert!(render("large.md", &vec![b'x'; MAX_SOURCE_BYTES + 1]).is_err());
        assert!(render("bad.sheet", b"{").is_err());
    }
    #[test]
    fn sheet_preview_uses_visible_cells_and_never_evaluates_formulas() {
        let svg = render("Book.sheet", br#"{"worksheets":[{"name":"Budget","rowOrder":["r1"],"columnOrder":["c1","c2"],"cells":{"r1:c1":{"value":42},"r1:c2":{"formula":"=SUM(A1)"}}}]}"#).unwrap();
        assert!(svg.contains("Budget"));
        assert!(svg.contains(">42<"));
        assert!(svg.contains("=SUM(A1)"));
    }
    #[test]
    fn presentation_previews_show_the_first_slide_without_private_notes() {
        let svg = render("Talk.deck", include_bytes!("../fixtures/deck-fixture.deck")).unwrap();
        assert!(svg.len() < 10000);
        assert!(!svg.contains("speakerNotes"));
        let svg = render("Talk.deck", br#"{"slideOrder":["s"],"slides":{"s":{"elementOrder":["e"],"elements":{"e":{"type":"text","text":{"content":{"paragraphs":[{"runs":[{"text":"First slide"}]}]}}}},"notes":"SECRET"}}}"#).unwrap();
        assert!(svg.contains("First slide"));
        assert!(!svg.contains("SECRET"));
    }
    #[test]
    fn every_internal_format_has_a_preview() {
        for path in [
            "a.canvas", "a.kanban", "a.logic", "a.ink", "a.deck", "a.sheet",
        ] {
            assert!(render(path, b"{}").unwrap().starts_with("<svg"));
        }
    }
}
