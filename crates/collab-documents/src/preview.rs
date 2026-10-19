//! Bounded, self-contained content thumbnails. No scripts, network, assets,
//! formula evaluation, or editor runtime are involved.
use crate::{classify_path, DocumentKind};
use serde_json::Value;

pub const RENDERER_VERSION: i32 = 2;
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
        "content",
        "relativePath",
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
            DocumentKind::Kanban => kanban(&value),
            DocumentKind::Canvas | DocumentKind::Logic => diagram(&value),
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
fn number(value: &Value, fallback: f64) -> f64 {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 10_000_000.0)
        .unwrap_or(fallback)
}
fn color(value: &Value, theme: &Value, fallback: &str) -> String {
    let candidate = value
        .as_str()
        .or_else(|| value["value"].as_str())
        .or_else(|| {
            value["token"]
                .as_str()
                .and_then(|token| theme[token].as_str())
        });
    candidate
        .filter(|c| {
            [4, 7, 9].contains(&c.len())
                && c.starts_with('#')
                && c[1..].chars().all(|c| c.is_ascii_hexdigit())
        })
        .unwrap_or(fallback)
        .into()
}
fn kanban(value: &Value) -> String {
    let columns = array(value, "columns");
    let width = 432.0 / columns.len().clamp(1, 4) as f64;
    columns
        .iter()
        .take(4)
        .enumerate()
        .map(|(i, column)| {
            let x = 24 + (i as f64 * width) as usize;
            let mut out = format!(
                "<rect x=\"{x}\" y=\"64\" width=\"{}\" height=\"232\" rx=\"5\" fill=\"#e2e8f0\"/>",
                width - 6.0
            );
            out.push_str(&text(
                x + 7,
                83,
                &label(column).chars().take(16).collect::<String>(),
                11,
            ));
            for (r, card) in array(column, "cards").iter().take(5).enumerate() {
                let y = 94 + r * 38;
                out.push_str(&format!(
                    "<rect x=\"{}\" y=\"{y}\" width=\"{}\" height=\"32\" rx=\"4\" fill=\"white\"/>",
                    x + 5,
                    width - 16.0
                ));
                out.push_str(&text(
                    x + 10,
                    y + 20,
                    &label(card).chars().take(15).collect::<String>(),
                    10,
                ));
            }
            out
        })
        .collect()
}
fn diagram(value: &Value) -> String {
    let nodes = array(value, "nodes").iter().take(150).collect::<Vec<_>>();
    if nodes.is_empty() {
        return text(24, 80, "Empty diagram", 14);
    }
    let min_x = nodes
        .iter()
        .map(|n| number(&n["position"]["x"], 0.0))
        .fold(f64::INFINITY, f64::min);
    let min_y = nodes
        .iter()
        .map(|n| number(&n["position"]["y"], 0.0))
        .fold(f64::INFINITY, f64::min);
    let max_x = nodes
        .iter()
        .map(|n| number(&n["position"]["x"], 0.0) + number(&n["width"], 140.0).clamp(20.0, 4000.0))
        .fold(min_x + 1.0, f64::max);
    let max_y = nodes
        .iter()
        .map(|n| number(&n["position"]["y"], 0.0) + number(&n["height"], 70.0).clamp(20.0, 4000.0))
        .fold(min_y + 1.0, f64::max);
    let scale = (432.0 / (max_x - min_x))
        .min(230.0 / (max_y - min_y))
        .min(1.0);
    let bounds = |node: &Value| {
        (
            24.0 + (number(&node["position"]["x"], 0.0) - min_x) * scale,
            65.0 + (number(&node["position"]["y"], 0.0) - min_y) * scale,
            number(&node["width"], 140.0).clamp(20.0, 4000.0) * scale,
            number(&node["height"], 70.0).clamp(20.0, 4000.0) * scale,
        )
    };
    let mut out = String::new();
    for edge in array(value, "edges").iter().take(300) {
        let source = nodes.iter().find(|n| n["id"] == edge["source"]);
        let target = nodes.iter().find(|n| n["id"] == edge["target"]);
        if let (Some(a), Some(b)) = (source, target) {
            let (x, y, w, h) = bounds(a);
            let (tx, ty, tw, th) = bounds(b);
            out.push_str(&format!(
                "<path d=\"M{} {}L{} {}\" fill=\"none\" stroke=\"#64748b\" stroke-width=\"1.5\"/>",
                x + w / 2.0,
                y + h / 2.0,
                tx + tw / 2.0,
                ty + th / 2.0
            ));
        }
    }
    for (i, node) in nodes.iter().enumerate() {
        let (x, y, w, h) = bounds(node);
        out.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" rx=\"3\" fill=\"#eef2ff\" stroke=\"#818cf8\"/><clipPath id=\"n{i}\"><rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\"/></clipPath><g clip-path=\"url(#n{i})\">{}</g>", text((x+4.0) as usize, (y+15.0*scale.max(0.5)) as usize, &label(node), (12.0*scale).clamp(6.0,12.0) as usize)));
    }
    out
}
fn deck(value: &Value) -> String {
    let Some(id) = array(value, "slideOrder").first().and_then(Value::as_str) else {
        return text(24, 80, "Empty presentation", 14);
    };
    let slide = &value["slides"][id];
    let layout = &value["layouts"][slide["layoutId"].as_str().unwrap_or("")];
    let master = &value["masters"][layout["masterId"].as_str().unwrap_or("")];
    let theme = &value["themes"][value["themeId"].as_str().unwrap_or("")]["colors"];
    let width = number(&value["size"]["width"], 96000.0).max(1.0);
    let height = number(&value["size"]["height"], 54000.0).max(1.0);
    let scale = (432.0 / width).min(240.0 / height);
    let background = [slide, layout, master]
        .iter()
        .find_map(|v| v.get("background"))
        .unwrap_or(&Value::Null);
    let mut out = format!(
        "<rect x=\"24\" y=\"60\" width=\"{}\" height=\"{}\" fill=\"{}\"/>",
        width * scale,
        height * scale,
        color(&background["color"], theme, "#ffffff")
    );
    for (i, id) in array(slide, "elementOrder")
        .iter()
        .take(80)
        .filter_map(Value::as_str)
        .enumerate()
    {
        let element = &slide["elements"][id];
        let inherited = [layout, master].into_iter().find_map(|container| {
            container["elements"].as_object().and_then(|elements| {
                elements.values().take(100).find(|candidate| {
                    !element["placeholder"]["key"].is_null()
                        && candidate["placeholder"]["key"] == element["placeholder"]["key"]
                })
            })
        });
        let frame = element
            .get("frame")
            .or_else(|| inherited.and_then(|e| e.get("frame")));
        // Legacy frameless text remains visible without exposing private notes.
        let x = 24.0 + frame.map(|f| number(&f["x"], 0.0)).unwrap_or(0.0) * scale;
        let y = 60.0
            + frame
                .map(|f| number(&f["y"], 0.0))
                .unwrap_or(i as f64 * 6000.0)
                * scale;
        let w = frame
            .map(|f| number(&f["width"], width))
            .unwrap_or(width)
            .max(1.0)
            * scale;
        let h = frame
            .map(|f| number(&f["height"], 6000.0))
            .unwrap_or(6000.0)
            .max(1.0)
            * scale;
        let rotation = frame
            .map(|f| number(&f["rotation"], 0.0) / 100.0)
            .unwrap_or(0.0);
        out.push_str(&format!("<g transform=\"rotate({rotation} {} {})\"><clipPath id=\"e{i}\"><rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\"/></clipPath>",x+w/2.0,y+h/2.0));
        let fill = color(&element["fill"]["color"], theme, "#e2e8f0");
        match element["type"].as_str() {
            Some("shape") if element["geometry"] == "ellipse" => out.push_str(&format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{fill}\"/>", x+w/2.0,y+h/2.0,w/2.0,h/2.0)),
            Some("shape") => out.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" rx=\"3\" fill=\"{fill}\"/>")),
            Some("image") | Some("chart") | Some("table") => out.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" fill=\"#f1f5f9\" stroke=\"#94a3b8\"/>{}",text((x+4.0) as usize,(y+14.0) as usize,element["type"].as_str().unwrap_or(""),10))),
            _ => {}
        }
        out.push_str(&format!("<g clip-path=\"url(#e{i})\">"));
        for (r, paragraph) in array(&element["text"]["content"], "paragraphs")
            .iter()
            .take(12)
            .enumerate()
        {
            let line = array(paragraph, "runs")
                .iter()
                .take(30)
                .filter_map(|run| run["text"].as_str())
                .map(|s| s.chars().take(100).collect::<String>())
                .collect::<String>();
            let inherited_paragraph = inherited
                .and_then(|e| array(&e["text"]["content"], "paragraphs").first())
                .unwrap_or(&Value::Null);
            let role = match element["placeholder"]["type"].as_str() {
                Some("title") => "title",
                Some("body" | "subtitle" | "content") => "body",
                _ => "other",
            };
            let level = paragraph["style"]["level"].as_u64().unwrap_or(0).min(8) as usize;
            let master_styles = array(&master["textStyles"], role);
            let master_style = master_styles
                .get(level)
                .or_else(|| master_styles.first())
                .unwrap_or(&Value::Null);
            let run = array(paragraph, "runs").first().unwrap_or(&Value::Null);
            let inherited_run = array(inherited_paragraph, "runs")
                .first()
                .unwrap_or(&Value::Null);
            let run_property = |key: &str| {
                run["style"]
                    .get(key)
                    .or_else(|| inherited_run["style"].get(key))
                    .or_else(|| master_style["run"].get(key))
                    .unwrap_or(&Value::Null)
            };
            let size = (number(run_property("size"), 3000.0) * scale).clamp(8.0, 32.0);
            let foreground = color(run_property("color"), theme, "#334155");
            let align = paragraph["style"]["align"]
                .as_str()
                .or_else(|| inherited_paragraph["style"]["align"].as_str())
                .unwrap_or("left");
            let (text_x, anchor) = match align {
                "center" => (x + w / 2.0, "middle"),
                "right" => (x + w - 3.0, "end"),
                _ => (x + 3.0, "start"),
            };
            let weight = if run_property("bold").as_bool().unwrap_or(false) {
                700
            } else {
                400
            };
            out.push_str(&format!("<text x=\"{text_x}\" y=\"{}\" text-anchor=\"{anchor}\" font-size=\"{size}\" font-weight=\"{weight}\" fill=\"{foreground}\">{}</text>", y+size+r as f64*(size+2.0), escape(&line)));
        }
        out.push_str("</g></g>");
    }
    out
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
    fn diagrams_and_boards_render_spatial_structure() {
        let svg = render("Plan.canvas", br#"{"nodes":[{"id":"a","content":"First","position":{"x":0,"y":0},"width":100,"height":80},{"id":"b","content":"Second","position":{"x":200,"y":50},"width":100,"height":80}],"edges":[{"source":"a","target":"b"}]}"#).unwrap();
        assert!(svg.contains("First") && svg.contains("Second"));
        assert!(svg.contains("M74 105L274 155"));
        assert!(svg.contains("clip-path="));
        let svg = render("Tasks.kanban", br#"{"columns":[{"title":"Todo","cards":[{"title":"Implement"}]},{"title":"Done","cards":[{"title":"Review"}]}]}"#).unwrap();
        assert!(svg.matches("<rect").count() >= 5);
        assert!(svg.contains("Implement") && svg.contains("Review"));
    }

    #[test]
    fn slides_preserve_frames_and_theme_without_external_content() {
        let svg = render("Slides.deck", br##"{"size":{"width":1000,"height":600},"slideOrder":["s"],"slides":{"s":{"elementOrder":["a"],"elements":{"a":{"type":"shape","geometry":"ellipse","frame":{"x":100,"y":100,"width":200,"height":100},"fill":{"color":{"value":"#ff0000"}}}}}}}"##).unwrap();
        assert!(svg.contains("<ellipse") && svg.contains("#ff0000"));
        assert!(svg.contains("cx=\"104\""));
        assert!(!svg.contains("<image") && !svg.contains("<script"));
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
