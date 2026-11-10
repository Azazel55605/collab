//! SQL Server client batch delimiters. Never decides whether arbitrary SQL writes.
use crate::{ContractError as E, SourceRange};
#[derive(Clone)]
pub struct SqlBatch {
    pub sql: String,
    pub source: SourceRange,
}
#[derive(Clone, Copy, PartialEq)]
enum Lex {
    Normal,
    String,
    Quoted,
    Bracket,
    Comment(u32),
}
pub fn selected_sql(sql: &str, selection: Option<SourceRange>) -> Result<(&str, u32), E> {
    if sql.len() > 1 << 20 {
        return Err(E::LimitReached);
    }
    let Some(range) = selection else {
        return Ok((sql, 0));
    };
    if range.start_utf16 >= range.end_utf16 {
        return Err(E::InvalidParameter);
    }
    let mut units = 0u32;
    let mut start = None;
    let mut end = None;
    for (byte, ch) in sql.char_indices() {
        if units == range.start_utf16 {
            start = Some(byte);
        }
        if units == range.end_utf16 {
            end = Some(byte);
        }
        units += ch.len_utf16() as u32;
    }
    if units == range.end_utf16 {
        end = Some(sql.len());
    }
    Ok((
        &sql[start.ok_or(E::InvalidParameter)?..end.ok_or(E::InvalidParameter)?],
        range.start_utf16,
    ))
}
pub fn sql_batches(sql: &str, selection: Option<SourceRange>) -> Result<Vec<SqlBatch>, E> {
    let (text, base) = selected_sql(sql, selection)?;
    let mut state = Lex::Normal;
    let mut batches = vec![];
    let mut start = 0usize;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        if state == Lex::Normal {
            if trimmed.starts_with(':') {
                return Err(E::Unsupported);
            }
            if trimmed
                .get(..2)
                .is_some_and(|head| head.eq_ignore_ascii_case("GO"))
                && (trimmed.len() == 2
                    || trimmed.as_bytes()[2].is_ascii_whitespace()
                    || trimmed[2..].starts_with("--"))
            {
                let tail = trimmed[2..].trim();
                if !tail.is_empty() && !tail.starts_with("--") {
                    return Err(E::Unsupported);
                }
                push(&mut batches, text, start, offset, base)?;
                start = offset + line.len();
                offset += line.len();
                continue;
            }
        }
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            let next = bytes.get(i + 1).copied();
            match state {
                Lex::Normal => match (c, next) {
                    (b'-', Some(b'-')) => break,
                    (b'/', Some(b'*')) => {
                        state = Lex::Comment(1);
                        i += 1;
                    }
                    (b'\'', _) => state = Lex::String,
                    (b'"', _) => state = Lex::Quoted,
                    (b'[', _) => state = Lex::Bracket,
                    _ => {}
                },
                Lex::Comment(depth) => match (c, next) {
                    (b'/', Some(b'*')) => {
                        state = Lex::Comment(depth + 1);
                        i += 1;
                    }
                    (b'*', Some(b'/')) => {
                        state = if depth == 1 {
                            Lex::Normal
                        } else {
                            Lex::Comment(depth - 1)
                        };
                        i += 1;
                    }
                    _ => {}
                },
                Lex::String | Lex::Quoted | Lex::Bracket => {
                    let close = match state {
                        Lex::String => b'\'',
                        Lex::Quoted => b'"',
                        _ => b']',
                    };
                    if c == close {
                        if next == Some(close) {
                            i += 1;
                        } else {
                            state = Lex::Normal;
                        }
                    }
                }
            }
            i += 1;
        }
        offset += line.len();
    }
    push(&mut batches, text, start, text.len(), base)?;
    if batches.is_empty() {
        return Err(E::InvalidParameter);
    }
    Ok(batches)
}
fn push(out: &mut Vec<SqlBatch>, text: &str, start: usize, end: usize, base: u32) -> Result<(), E> {
    if text[start..end].trim().is_empty() {
        return Ok(());
    }
    if out.len() >= 128 {
        return Err(E::LimitReached);
    }
    out.push(SqlBatch {
        sql: text[start..end].into(),
        source: SourceRange {
            start_utf16: base + text[..start].encode_utf16().count() as u32,
            end_utf16: base + text[..end].encode_utf16().count() as u32,
        },
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn go_respects_nested_comments_multiline_literals_and_escaped_identifiers() {
        let sql="SELECT N'hi\nGO\nthere';\n/* outer\n/* GO */\nGO\n*/\nGO -- split\nSELECT [a]]GO], \"GO\";\ngo\nSELECT 3";
        let batches = sql_batches(sql, None).unwrap();
        assert_eq!(batches.len(), 3);
        assert!(batches[0].sql.contains("outer"));
        assert!(batches[1].sql.contains("a]]GO"));
        assert!(sql_batches("SELECT 1\nGO 500000", None).is_err());
        assert_eq!(
            sql_batches("SELECT 1\nGO-- comment\nSELECT 2", None)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn selections_use_utf16_not_utf8_and_reject_half_surrogates() {
        let sql = "-- 👋\nSELECT 1\nGO\nSELECT 2";
        let start = "-- 👋\n".encode_utf16().count() as u32;
        let batches = sql_batches(
            sql,
            Some(SourceRange {
                start_utf16: start,
                end_utf16: sql.encode_utf16().count() as u32,
            }),
        )
        .unwrap();
        assert_eq!(batches[0].source.start_utf16, start);
        assert_eq!(batches.len(), 2);
        assert!(selected_sql(
            sql,
            Some(SourceRange {
                start_utf16: 4,
                end_utf16: 10
            })
        )
        .is_err());
    }
}
