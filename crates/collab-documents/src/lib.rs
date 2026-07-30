pub mod kanban;
pub mod pdf;
pub mod references;
pub mod sheet;

use quick_xml::{events::Event, Reader};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocumentKind {
    Note,
    Kanban,
    Canvas,
    Logic,
    Sheet,
    Svg,
    PdfSidecar,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Kanban => "kanban",
            Self::Canvas => "canvas",
            Self::Logic => "logic",
            Self::Sheet => "sheet",
            Self::Svg => "svg",
            Self::PdfSidecar => "pdf-sidecar",
        }
    }

    pub fn from_storage_name(value: &str) -> Option<Self> {
        match value {
            "note" => Some(Self::Note),
            "kanban" => Some(Self::Kanban),
            "canvas" => Some(Self::Canvas),
            "logic" => Some(Self::Logic),
            "sheet" => Some(Self::Sheet),
            "svg" => Some(Self::Svg),
            "pdf-sidecar" => Some(Self::PdfSidecar),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserLimits {
    pub max_bytes: usize,
    pub max_entries: usize,
    pub max_depth: usize,
}

pub const DEFAULT_PARSER_LIMITS: ParserLimits = ParserLimits {
    max_bytes: 16 * 1024 * 1024,
    max_entries: 100_000,
    max_depth: 128,
};

#[derive(Debug, Clone, Copy)]
pub struct DocumentInput<'a> {
    pub kind: DocumentKind,
    pub path: &'a str,
    pub content: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationReport {
    pub normalized: Option<Vec<u8>>,
    pub warnings: Vec<DocumentWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentWarning {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DocumentError {
    #[error("{kind} document exceeds the {max_bytes}-byte parser limit")]
    TooLarge {
        kind: &'static str,
        max_bytes: usize,
    },
    #[error("{kind} document is not valid UTF-8")]
    InvalidUtf8 { kind: &'static str },
    #[error("{kind} document is not valid JSON: {message}")]
    InvalidJson { kind: &'static str, message: String },
    #[error("{kind} document must be a JSON object")]
    InvalidShape { kind: &'static str },
    #[error("{kind} document exceeds the {max_entries}-entry parser limit")]
    TooManyEntries {
        kind: &'static str,
        max_entries: usize,
    },
    #[error("{kind} document exceeds the {max_depth}-level parser limit")]
    TooDeep {
        kind: &'static str,
        max_depth: usize,
    },
    #[error("SVG document is not well-formed XML: {0}")]
    InvalidSvg(String),
    #[error("SVG document must have an svg root element")]
    InvalidSvgRoot,
    #[error("sheet document is invalid: {0}")]
    InvalidSheet(#[from] sheet::SheetValidationError),
    #[error(transparent)]
    Reference(#[from] references::ReferenceError),
}

pub fn classify_path(path: &str) -> Option<DocumentKind> {
    let path = path.to_ascii_lowercase();
    if path.ends_with(".md") {
        Some(DocumentKind::Note)
    } else if path.ends_with(".kanban") {
        Some(DocumentKind::Kanban)
    } else if path.ends_with(".canvas") {
        Some(DocumentKind::Canvas)
    } else if path.ends_with(".logic") {
        Some(DocumentKind::Logic)
    } else if path.ends_with(".sheet") {
        Some(DocumentKind::Sheet)
    } else if path.ends_with(".svg") {
        Some(DocumentKind::Svg)
    } else if path.ends_with(".pdf.json") || path.ends_with(".pdf-sidecar.json") {
        Some(DocumentKind::PdfSidecar)
    } else {
        None
    }
}

pub fn canvas_node_count(content: &str) -> Option<usize> {
    let value = serde_json::from_str::<Value>(content).ok()?;
    value.get("nodes")?.as_array().map(Vec::len)
}

pub fn validate(
    input: DocumentInput<'_>,
    limits: ParserLimits,
) -> Result<ValidationReport, DocumentError> {
    if input.content.len() > limits.max_bytes {
        return Err(DocumentError::TooLarge {
            kind: input.kind.as_str(),
            max_bytes: limits.max_bytes,
        });
    }

    match input.kind {
        DocumentKind::Note => {
            std::str::from_utf8(input.content).map_err(|_| DocumentError::InvalidUtf8 {
                kind: input.kind.as_str(),
            })?;
        }
        DocumentKind::Kanban
        | DocumentKind::Canvas
        | DocumentKind::Logic
        | DocumentKind::Sheet
        | DocumentKind::PdfSidecar => validate_json(input, limits)?,
        DocumentKind::Svg => validate_svg(input, limits)?,
    }

    Ok(ValidationReport {
        normalized: None,
        warnings: Vec::new(),
    })
}

fn validate_json(input: DocumentInput<'_>, limits: ParserLimits) -> Result<(), DocumentError> {
    let value: Value =
        serde_json::from_slice(input.content).map_err(|error| DocumentError::InvalidJson {
            kind: input.kind.as_str(),
            message: error.to_string(),
        })?;
    if !value.is_object() {
        return Err(DocumentError::InvalidShape {
            kind: input.kind.as_str(),
        });
    }
    let mut entries = 0usize;
    validate_json_value(&value, input.kind, limits, 1, &mut entries)?;
    if input.kind == DocumentKind::Kanban {
        kanban::Board::parse(input.content).map_err(|error| DocumentError::InvalidJson {
            kind: input.kind.as_str(),
            message: error.to_string(),
        })?;
    }
    if input.kind == DocumentKind::Sheet {
        sheet::validate_document(&value, sheet::DEFAULT_SHEET_LIMITS)?;
    }
    Ok(())
}

fn validate_json_value(
    value: &Value,
    kind: DocumentKind,
    limits: ParserLimits,
    depth: usize,
    entries: &mut usize,
) -> Result<(), DocumentError> {
    if depth > limits.max_depth {
        return Err(DocumentError::TooDeep {
            kind: kind.as_str(),
            max_depth: limits.max_depth,
        });
    }
    let children = match value {
        Value::Array(values) => values.iter().collect::<Vec<_>>(),
        Value::Object(values) => values.values().collect::<Vec<_>>(),
        _ => return Ok(()),
    };
    *entries = entries
        .checked_add(children.len())
        .ok_or(DocumentError::TooManyEntries {
            kind: kind.as_str(),
            max_entries: limits.max_entries,
        })?;
    if *entries > limits.max_entries {
        return Err(DocumentError::TooManyEntries {
            kind: kind.as_str(),
            max_entries: limits.max_entries,
        });
    }
    for child in children {
        validate_json_value(child, kind, limits, depth + 1, entries)?;
    }
    Ok(())
}

fn validate_svg(input: DocumentInput<'_>, limits: ParserLimits) -> Result<(), DocumentError> {
    std::str::from_utf8(input.content).map_err(|_| DocumentError::InvalidUtf8 {
        kind: input.kind.as_str(),
    })?;
    let mut reader = Reader::from_reader(input.content);
    let mut depth = 0usize;
    let mut entries = 0usize;
    let mut saw_root = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                depth += 1;
                entries += 1;
                if depth == 1 {
                    saw_root = element.local_name().as_ref() == b"svg";
                }
                enforce_xml_limits(limits, depth, entries)?;
            }
            Ok(Event::Empty(element)) => {
                entries += 1;
                if depth == 0 {
                    saw_root = element.local_name().as_ref() == b"svg";
                }
                enforce_xml_limits(limits, depth.saturating_add(1), entries)?;
            }
            Ok(Event::End(_)) => depth = depth.saturating_sub(1),
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(DocumentError::InvalidSvg(error.to_string())),
        }
    }
    if !saw_root {
        return Err(DocumentError::InvalidSvgRoot);
    }
    Ok(())
}

fn enforce_xml_limits(
    limits: ParserLimits,
    depth: usize,
    entries: usize,
) -> Result<(), DocumentError> {
    if depth > limits.max_depth {
        return Err(DocumentError::TooDeep {
            kind: DocumentKind::Svg.as_str(),
            max_depth: limits.max_depth,
        });
    }
    if entries > limits.max_entries {
        return Err(DocumentError::TooManyEntries {
            kind: DocumentKind::Svg.as_str(),
            max_entries: limits.max_entries,
        });
    }
    Ok(())
}

pub struct ReferenceQuery<'a> {
    pub source_path: &'a str,
    pub target_path: &'a str,
    pub lookup: &'a [references::ReferenceLookupEntry],
}

pub struct ReferenceRewrite<'a> {
    pub old_path: &'a str,
    pub new_path: Option<&'a str>,
}

pub fn references(
    input: DocumentInput<'_>,
    query: ReferenceQuery<'_>,
) -> Result<Vec<references::FileReference>, DocumentError> {
    validate(input, DEFAULT_PARSER_LIMITS)?;
    let content = std::str::from_utf8(input.content).map_err(|_| DocumentError::InvalidUtf8 {
        kind: input.kind.as_str(),
    })?;
    match input.kind {
        DocumentKind::Note => Ok(references::collect_note_references(
            content,
            query.source_path,
            query.lookup,
            query.target_path,
        )),
        DocumentKind::Kanban => Ok(references::collect_kanban_references(
            content,
            query.source_path,
            query.target_path,
        )?),
        DocumentKind::Canvas => Ok(references::collect_canvas_references(
            content,
            query.source_path,
            query.target_path,
        )?),
        DocumentKind::Sheet => Ok(references::collect_sheet_references(
            content,
            query.source_path,
            query.target_path,
        )?),
        _ => Ok(Vec::new()),
    }
}

pub fn rewrite_references(
    input: DocumentInput<'_>,
    rewrite: ReferenceRewrite<'_>,
) -> Result<Vec<u8>, DocumentError> {
    validate(input, DEFAULT_PARSER_LIMITS)?;
    let content = std::str::from_utf8(input.content).map_err(|_| DocumentError::InvalidUtf8 {
        kind: input.kind.as_str(),
    })?;
    let rewritten = match input.kind {
        DocumentKind::Note => references::rewrite_note_references(
            content,
            input.path,
            rewrite.old_path,
            rewrite.new_path,
        ),
        DocumentKind::Kanban => {
            references::rewrite_kanban_references(content, rewrite.old_path, rewrite.new_path)?
        }
        DocumentKind::Canvas => {
            references::rewrite_canvas_references(content, rewrite.old_path, rewrite.new_path)?
        }
        DocumentKind::Sheet => {
            references::rewrite_sheet_references(content, rewrite.old_path, rewrite.new_path)?
        }
        _ => content.to_owned(),
    };
    Ok(rewritten.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(kind: DocumentKind, path: &'a str, content: &'a [u8]) -> DocumentInput<'a> {
        DocumentInput {
            kind,
            path,
            content,
        }
    }

    #[test]
    fn classifies_supported_document_paths_case_insensitively() {
        assert_eq!(classify_path("Notes/Test.MD"), Some(DocumentKind::Note));
        assert_eq!(
            classify_path("Boards/Roadmap.kanban"),
            Some(DocumentKind::Kanban)
        );
        assert_eq!(classify_path("Flow.logic"), Some(DocumentKind::Logic));
        assert_eq!(classify_path("Drawing.svg"), Some(DocumentKind::Svg));
        assert_eq!(classify_path("manual.pdf"), None);
        assert_eq!(
            DocumentKind::from_storage_name("canvas"),
            Some(DocumentKind::Canvas)
        );
        assert_eq!(DocumentKind::from_storage_name("asset"), None);
    }

    #[test]
    fn validates_bounded_json_and_svg_documents() {
        let limits = ParserLimits {
            max_bytes: 1024,
            max_entries: 8,
            max_depth: 4,
        };
        validate(
            input(DocumentKind::Canvas, "board.canvas", br#"{"nodes":[]}"#),
            limits,
        )
        .unwrap();
        validate(
            input(
                DocumentKind::Svg,
                "drawing.svg",
                br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>"#,
            ),
            limits,
        )
        .unwrap();
        assert!(matches!(
            validate(
                input(
                    DocumentKind::Canvas,
                    "board.canvas",
                    br#"{"a":{"b":{"c":1}}}"#
                ),
                ParserLimits {
                    max_depth: 2,
                    ..limits
                },
            ),
            Err(DocumentError::TooDeep { .. })
        ));
    }

    #[test]
    fn rejects_invalid_shapes_size_entry_counts_and_svg_roots() {
        let limits = ParserLimits {
            max_bytes: 32,
            max_entries: 2,
            max_depth: 4,
        };
        assert!(matches!(
            validate(input(DocumentKind::Canvas, "board.canvas", b"[]"), limits),
            Err(DocumentError::InvalidShape { .. })
        ));
        assert!(matches!(
            validate(
                input(
                    DocumentKind::Canvas,
                    "board.canvas",
                    br#"{"nodes":[1,2,3]}"#
                ),
                limits,
            ),
            Err(DocumentError::TooManyEntries { .. })
        ));
        assert!(matches!(
            validate(input(DocumentKind::Note, "large.md", &[b'x'; 33]), limits,),
            Err(DocumentError::TooLarge { .. })
        ));
        assert_eq!(
            validate(input(DocumentKind::Svg, "drawing.svg", b"<html/>"), limits,),
            Err(DocumentError::InvalidSvgRoot)
        );
        assert!(matches!(
            validate(
                input(DocumentKind::Svg, "drawing.svg", b"<svg><path></svg>"),
                limits,
            ),
            Err(DocumentError::InvalidSvg(_))
        ));
    }

    #[test]
    fn canvas_node_count_requires_a_nodes_array() {
        assert_eq!(canvas_node_count(r#"{"nodes":[{},{}]}"#), Some(2));
        assert_eq!(canvas_node_count(r#"{"nodes":{}}"#), None);
        assert_eq!(canvas_node_count("not json"), None);
    }

    #[test]
    fn generic_reference_apis_preserve_specialized_behavior() {
        let board = br#"{"columns":[{"cards":[{"attachmentPaths":["Docs/A.md"]}]}]}"#;
        let found = references(
            input(DocumentKind::Kanban, "Board.kanban", board),
            ReferenceQuery {
                source_path: "Board.kanban",
                target_path: "Docs/A.md",
                lookup: &[],
            },
        )
        .unwrap();
        assert_eq!(found.len(), 1);

        let rewritten = rewrite_references(
            input(DocumentKind::Kanban, "Board.kanban", board),
            ReferenceRewrite {
                old_path: "Docs/A.md",
                new_path: Some("Docs/B.md"),
            },
        )
        .unwrap();
        assert!(String::from_utf8(rewritten).unwrap().contains("Docs/B.md"));
    }
}
