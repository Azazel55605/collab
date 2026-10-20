//! Conservative, resource-bounded line merging shared by native and server saves.
//! Budget exhaustion is a conflict, never permission to overwrite another edit.

const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_INPUT_LINES: usize = 128 * 1024;
const MAX_TABLE_CELLS: usize = 1024 * 1024;
const MAX_COMPARISON_BYTES: usize = 64 * 1024 * 1024;

struct WorkBudget {
    cells: usize,
    comparison_bytes: usize,
}

impl WorkBudget {
    fn lines_equal(&mut self, left: &str, right: &str) -> Option<bool> {
        if left.len() != right.len() {
            return Some(false);
        }
        self.comparison_bytes = self.comparison_bytes.checked_sub(left.len().max(1))?;
        Some(left == right)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct TextEditHunk<'a> {
    base_start: usize,
    base_end: usize,
    replacement: Vec<&'a str>,
}

/// Merge non-overlapping line edits, preserving exact UTF-8 bytes/newlines.
///
/// Unchanged/equal inputs take a linear fast path. Otherwise the combined input
/// is capped at 8 MiB/128k lines, each diff table at 1M u32 cells (4 MiB), and
/// both diffs together at 2M cells and 64 MiB of line-comparison work. Common
/// prefixes/suffixes are removed before allocating a table. A conflicting or
/// over-budget merge returns `None`; callers must retain their conflict policy.
pub fn try_auto_merge_text(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || base == theirs {
        return Some(ours.to_owned());
    }
    if base == ours {
        return Some(theirs.to_owned());
    }
    if base
        .len()
        .checked_add(ours.len())?
        .checked_add(theirs.len())?
        > MAX_INPUT_BYTES
    {
        return None;
    }
    let line_count = [base, ours, theirs]
        .iter()
        .map(|text| text.split_inclusive('\n').count())
        .sum::<usize>();
    if line_count > MAX_INPUT_LINES {
        return None;
    }
    let base_lines: Vec<_> = base.split_inclusive('\n').collect();
    let our_lines: Vec<_> = ours.split_inclusive('\n').collect();
    let their_lines: Vec<_> = theirs.split_inclusive('\n').collect();
    let mut budget = WorkBudget {
        cells: 2 * MAX_TABLE_CELLS,
        comparison_bytes: MAX_COMPARISON_BYTES,
    };
    let our_hunks = compute_line_edit_hunks(&base_lines, &our_lines, &mut budget)?;
    let their_hunks = compute_line_edit_hunks(&base_lines, &their_lines, &mut budget)?;
    let mut ours = our_hunks.into_iter().peekable();
    let mut theirs = their_hunks.into_iter().peekable();
    let mut merged = String::new();
    let mut cursor = 0;
    while ours.peek().is_some() || theirs.peek().is_some() {
        let hunk = match (ours.peek(), theirs.peek()) {
            (Some(left), Some(right)) if left == right => {
                theirs.next();
                ours.next()?
            }
            // Different insertions at the same position have no safe ordering.
            (Some(left), Some(right)) if left.base_start == right.base_start => return None,
            (Some(left), Some(right)) if left.base_end <= right.base_start => ours.next()?,
            (Some(left), Some(right)) if right.base_end <= left.base_start => theirs.next()?,
            (Some(_), Some(_)) => return None,
            (Some(_), None) => ours.next()?,
            (None, Some(_)) => theirs.next()?,
            (None, None) => break,
        };
        for line in &base_lines[cursor..hunk.base_start] {
            merged.push_str(line);
        }
        for line in hunk.replacement {
            merged.push_str(line);
        }
        cursor = hunk.base_end;
    }
    for line in &base_lines[cursor..] {
        merged.push_str(line);
    }
    Some(merged)
}

fn compute_line_edit_hunks<'a>(
    base: &[&str],
    modified: &[&'a str],
    budget: &mut WorkBudget,
) -> Option<Vec<TextEditHunk<'a>>> {
    let mut prefix = 0;
    while prefix < base.len().min(modified.len())
        && budget.lines_equal(base[prefix], modified[prefix])?
    {
        prefix += 1;
    }
    let mut n = base.len();
    let mut m = modified.len();
    while n > prefix && m > prefix && budget.lines_equal(base[n - 1], modified[m - 1])? {
        n -= 1;
        m -= 1;
    }
    let base = &base[prefix..n];
    let modified = &modified[prefix..m];
    let (n, m) = (base.len(), modified.len());
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    // Pure insertion/deletion needs no LCS allocation.
    if n == 0 || m == 0 {
        return Some(vec![TextEditHunk {
            base_start: prefix,
            base_end: prefix + n,
            replacement: modified.to_vec(),
        }]);
    }
    let stride = m.checked_add(1)?;
    let cells = n.checked_add(1)?.checked_mul(stride)?;
    if cells > MAX_TABLE_CELLS {
        return None;
    }
    budget.cells = budget.cells.checked_sub(cells)?;
    let mut lcs = vec![0u32; cells];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * stride + j] = if budget.lines_equal(base[i], modified[j])? {
                lcs[(i + 1) * stride + j + 1] + 1
            } else {
                lcs[(i + 1) * stride + j].max(lcs[i * stride + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut hunks = Vec::new();
    let mut active_start = None;
    let mut replacement = Vec::new();
    while i < n || j < m {
        if i < n && j < m && budget.lines_equal(base[i], modified[j])? {
            if let Some(start) = active_start.take() {
                hunks.push(TextEditHunk {
                    base_start: prefix + start,
                    base_end: prefix + i,
                    replacement: std::mem::take(&mut replacement),
                });
            }
            i += 1;
            j += 1;
            continue;
        }
        active_start.get_or_insert(i);
        if j < m && (i == n || lcs[i * stride + j + 1] >= lcs[(i + 1) * stride + j]) {
            replacement.push(modified[j]);
            j += 1;
        } else {
            i += 1;
        }
    }
    if let Some(start) = active_start {
        hunks.push(TextEditHunk {
            base_start: prefix + start,
            base_end: prefix + i,
            replacement,
        });
    }
    Some(hunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_unicode_crlf_and_missing_final_newline() {
        assert_eq!(
            try_auto_merge_text("α\r\nβ\r\n終", "一\r\nβ\r\n終", "α\r\nβ\r\n三"),
            Some("一\r\nβ\r\n三".into())
        );
        assert_eq!(
            try_auto_merge_text("a\nb", "a\n", "A\nb"),
            Some("A\n".into())
        );
    }

    #[test]
    fn merges_distant_edits_in_ten_thousand_lines() {
        let base = (0..10_000)
            .map(|i| format!("line {i}\n"))
            .collect::<String>();
        let ours = base.replace("line 10\n", "our change\n");
        let theirs = base.replace("line 9990\n", "their change\n");
        assert_eq!(
            try_auto_merge_text(&base, &ours, &theirs),
            Some(ours.replace("line 9990\n", "their change\n"))
        );
    }

    #[test]
    fn identical_insertions_are_applied_once_and_different_insertions_conflict() {
        assert_eq!(
            try_auto_merge_text("a\nb\nc\n", "a\nx\nb\nC\n", "a\nx\nb\nc\n"),
            Some("a\nx\nb\nC\n".into())
        );
        assert_eq!(
            try_auto_merge_text("a\nb\n", "a\nx\nb\n", "a\ny\nb\n"),
            None
        );
        assert_eq!(try_auto_merge_text("", "x", "y"), None);
    }

    #[test]
    fn overlapping_edits_conflict_and_fast_paths_keep_exact_bytes() {
        assert_eq!(try_auto_merge_text("a\nb\n", "A\nb\n", "other\nb\n"), None);
        for (base, ours, theirs, expected) in [
            ("old", "same", "same", "same"),
            ("base", "base", "new", "new"),
            ("base", "new", "base", "new"),
            ("", "", "", ""),
        ] {
            assert_eq!(
                try_auto_merge_text(base, ours, theirs).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn rejects_unrelated_ten_thousand_line_inputs_before_allocating_a_table() {
        let base = "base\n".repeat(10_000);
        let ours = "ours\n".repeat(10_000);
        let theirs = "theirs\n".repeat(10_000);
        assert_eq!(try_auto_merge_text(&base, &ours, &theirs), None);
        let mut budget = WorkBudget {
            cells: 2 * MAX_TABLE_CELLS,
            comparison_bytes: MAX_COMPARISON_BYTES,
        };
        assert!(compute_line_edit_hunks(
            &base.split_inclusive('\n').collect::<Vec<_>>(),
            &ours.split_inclusive('\n').collect::<Vec<_>>(),
            &mut budget
        )
        .is_none());
        assert_eq!(budget.cells, 2 * MAX_TABLE_CELLS);
        assert!(crate::merge_external_content(
            crate::LiveDocumentKind::NoteText, &base, &ours, &theirs,
        ).is_none(), "server live/REST reconciliation must preserve an over-budget conflict");
    }

    #[test]
    fn bounds_bytes_lines_and_line_comparison_work() {
        assert_eq!(
            try_auto_merge_text(&"b".repeat(MAX_INPUT_BYTES), "ours", "theirs"),
            None
        );
        assert_eq!(
            try_auto_merge_text(&"b\n".repeat(MAX_INPUT_LINES), "ours", "theirs"),
            None
        );
        let mut budget = WorkBudget {
            cells: MAX_TABLE_CELLS,
            comparison_bytes: 1,
        };
        assert!(compute_line_edit_hunks(&["long line"], &["elsewhere"], &mut budget).is_none());
        let mut budget = WorkBudget {
            cells: 3,
            comparison_bytes: MAX_COMPARISON_BYTES,
        };
        assert!(compute_line_edit_hunks(&["a"], &["b"], &mut budget).is_none());
    }

    #[test]
    fn diff_hunks_reconstruct_all_small_repeated_line_inputs() {
        // Repeated lines stress ambiguous LCS alignments and trimmed boundaries.
        let inputs = (0..81)
            .map(|mut value| {
                let mut text = String::new();
                for _ in 0..4 {
                    match value % 3 {
                        1 => text.push_str("a\n"),
                        2 => text.push_str("b\n"),
                        _ => {}
                    }
                    value /= 3;
                }
                text
            })
            .collect::<Vec<_>>();
        for base in &inputs {
            for modified in &inputs {
                let base_lines = base.split_inclusive('\n').collect::<Vec<_>>();
                let modified_lines = modified.split_inclusive('\n').collect::<Vec<_>>();
                let mut budget = WorkBudget {
                    cells: 2 * MAX_TABLE_CELLS,
                    comparison_bytes: MAX_COMPARISON_BYTES,
                };
                let hunks =
                    compute_line_edit_hunks(&base_lines, &modified_lines, &mut budget).unwrap();
                let mut cursor = 0;
                let mut reconstructed = String::new();
                for hunk in hunks {
                    reconstructed.extend(base_lines[cursor..hunk.base_start].iter().copied());
                    reconstructed.extend(hunk.replacement);
                    cursor = hunk.base_end;
                }
                reconstructed.extend(base_lines[cursor..].iter().copied());
                assert_eq!(&reconstructed, modified);
            }
        }
    }
}
