//! Filename and byte-fidelity contract for the source editor prototype.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLanguage {
    PlainText,
    Json,
    Python,
    C,
    CSharp,
}

pub fn classify_source_path(path: &str) -> Option<SourceLanguage> {
    if path.split('/').any(|segment| segment.starts_with('.')) {
        return None;
    }
    let name = path.rsplit('/').next()?.to_ascii_lowercase();
    if super::classify_path(&name).is_some() {
        return None;
    }
    let (_, extension) = name.rsplit_once('.')?;
    match extension {
        "txt" => Some(SourceLanguage::PlainText),
        "json" => Some(SourceLanguage::Json),
        "py" => Some(SourceLanguage::Python),
        "c" | "h" => Some(SourceLanguage::C),
        "cs" => Some(SourceLanguage::CSharp),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEndings {
    Lf,
    Crlf,
    /// Mixed LF/CRLF or bare CR. Retain the original bytes in a read-only view.
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceTextFormat {
    pub bom: bool,
    pub line_endings: LineEndings,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SourceText<'a> {
    /// Text without the leading BOM. The original line endings are retained.
    pub content: &'a str,
    pub format: SourceTextFormat,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SourceTextError {
    #[error("This file is not valid UTF-8")]
    InvalidUtf8,
    #[error("This file contains binary control bytes")]
    BinaryControls,
    #[error("This file uses mixed or unsupported line endings")]
    UnsupportedLineEndings,
    #[error("Editor text must use LF line endings before encoding")]
    NonCanonicalEditorText,
}

fn validate_controls(bytes: &[u8]) -> Result<(), SourceTextError> {
    if bytes
        .iter()
        .any(|byte| byte.is_ascii_control() && !matches!(byte, b'\t' | b'\n' | b'\r' | 0x0c))
    {
        return Err(SourceTextError::BinaryControls);
    }
    Ok(())
}

pub fn decode_source_text(bytes: &[u8]) -> Result<SourceText<'_>, SourceTextError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SourceTextError::InvalidUtf8)?;
    let content = text.strip_prefix('\u{feff}').unwrap_or(text);
    validate_controls(content.as_bytes())?;

    let mut leading_cr = false;
    let mut lf = false;
    let mut crlf = false;
    let mut bare_cr = false;
    for byte in content.bytes() {
        if byte == b'\n' {
            crlf |= leading_cr;
            lf |= !leading_cr;
        } else if leading_cr {
            bare_cr = true;
        }
        leading_cr = byte == b'\r';
    }
    let line_endings = if bare_cr || leading_cr || (lf && crlf) {
        LineEndings::Unsupported
    } else if crlf {
        LineEndings::Crlf
    } else {
        LineEndings::Lf
    };
    Ok(SourceText {
        content,
        format: SourceTextFormat {
            bom: content.len() != text.len(),
            line_endings,
        },
    })
}

impl SourceTextFormat {
    /// Encode editor text whose internal line separator is LF. Every LF in the
    /// buffer is significant, including an explicit final newline.
    pub fn encode(self, editor_text: &str) -> Result<Vec<u8>, SourceTextError> {
        let separator = match self.line_endings {
            LineEndings::Unsupported => return Err(SourceTextError::UnsupportedLineEndings),
            LineEndings::Lf => "\n",
            LineEndings::Crlf => "\r\n",
        };
        if editor_text.contains('\r') {
            return Err(SourceTextError::NonCanonicalEditorText);
        }
        validate_controls(editor_text.as_bytes())?;
        let mut bytes = Vec::with_capacity(editor_text.len());
        if self.bom {
            bytes.extend_from_slice("\u{feff}".as_bytes());
        }
        for (index, line) in editor_text.split('\n').enumerate() {
            if index != 0 {
                bytes.extend_from_slice(separator.as_bytes());
            }
            bytes.extend_from_slice(line.as_bytes());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_classifier_excludes_reserved_paths() {
        for (path, language) in [
            ("README.txt", SourceLanguage::PlainText),
            ("Settings/APP.JSON", SourceLanguage::Json),
            ("test.py", SourceLanguage::Python),
            ("main.c", SourceLanguage::C),
            ("main.H", SourceLanguage::C),
            ("Program.cs", SourceLanguage::CSharp),
        ] {
            assert_eq!(classify_source_path(path), Some(language), "{path}");
        }
        for path in [
            "Course.pdf.json",
            "Course.pdf-sidecar.json",
            ".private.json",
            ".collab/config.json",
            "README",
            "table.csv",
            "query.sql",
            "drawing.svg",
            "file.exe",
        ] {
            assert_eq!(classify_source_path(path), None, "{path}");
        }
    }

    #[test]
    fn round_trips_utf8_bom_and_line_endings_even_for_unfinished_source() {
        for text in [
            "",
            "\u{feff}",
            "{ \"unfinished\": ",
            "λ😀\n",
            "line\r\n\r\n",
            "\u{feff}日本語\r\nsecond",
            "\u{feff}emoji😀\r\n",
        ] {
            let decoded = decode_source_text(text.as_bytes()).unwrap();
            let editor_text = decoded.content.replace("\r\n", "\n");
            assert_eq!(
                decoded.format.encode(&editor_text).unwrap(),
                text.as_bytes()
            );
        }
        let decoded = decode_source_text("\u{feff}first\r\nlast".as_bytes()).unwrap();
        assert_eq!(
            decoded.format.encode("edited\nlast").unwrap(),
            "\u{feff}edited\r\nlast".as_bytes()
        );
    }

    #[test]
    fn preserves_original_mixed_bytes_for_preview_and_rejects_binary_inputs() {
        for bytes in [b"a\r\nb\n".as_slice(), b"a\rb", b"last\r"] {
            let decoded = decode_source_text(bytes).unwrap();
            assert_eq!(decoded.content.as_bytes(), bytes);
            assert_eq!(
                decoded.format.encode("edited"),
                Err(SourceTextError::UnsupportedLineEndings)
            );
        }
        assert_eq!(
            decode_source_text(b"bad\xff"),
            Err(SourceTextError::InvalidUtf8)
        );
        assert_eq!(
            decode_source_text(b"a\0b"),
            Err(SourceTextError::BinaryControls)
        );
    }
}
