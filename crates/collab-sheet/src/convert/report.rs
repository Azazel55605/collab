//! What a conversion did, in terms the user can act on.
//!
//! The plan is explicit that Collab must never claim compatibility it does not
//! have. Every feature encountered during a conversion ends up in exactly one
//! severity here, and the UI shows the whole list before the user relies on the
//! result.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversionSeverity {
    /// Carried across with its meaning intact.
    Imported,
    /// Carried across in a reduced form — a formula became its last value, a
    /// style lost a property. The data is there; the behavior is not.
    Flattened,
    /// Recognized and deliberately left out, because carrying it would be
    /// misleading or unsafe.
    Skipped,
    /// Not understood by this build at all.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionNote {
    pub severity: ConversionSeverity,
    /// Short feature name, e.g. `"Merged ranges"` or `"Pivot table"`.
    pub feature: String,
    /// One sentence the user can act on.
    pub detail: String,
    /// Where it happened, e.g. `"Budget!C4"`. Never a filesystem path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// How many times this note was collapsed from.
    pub count: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionReport {
    pub notes: Vec<ConversionNote>,
    /// Set when content was dropped because a Collab limit was reached, rather
    /// than because the feature is unsupported.
    pub truncated: bool,
}

/// Repeated notes are collapsed to this many before only the count grows, so a
/// workbook with 50,000 unsupported formulas produces a readable report.
const MAX_NOTES_PER_FEATURE: usize = 5;

impl ConversionReport {
    pub fn push(
        &mut self,
        severity: ConversionSeverity,
        feature: impl Into<String>,
        detail: impl Into<String>,
        location: Option<String>,
    ) {
        let feature = feature.into();
        let detail = detail.into();

        let existing = self
            .notes
            .iter()
            .filter(|note| note.feature == feature && note.severity == severity)
            .count();
        if existing >= MAX_NOTES_PER_FEATURE {
            if let Some(note) = self
                .notes
                .iter_mut()
                .rev()
                .find(|note| note.feature == feature && note.severity == severity)
            {
                note.count = note.count.saturating_add(1);
            }
            return;
        }

        self.notes.push(ConversionNote {
            severity,
            feature,
            detail,
            location,
            count: 1,
        });
    }

    pub fn imported(&mut self, feature: impl Into<String>, detail: impl Into<String>) {
        self.push(ConversionSeverity::Imported, feature, detail, None);
    }

    pub fn flattened(
        &mut self,
        feature: impl Into<String>,
        detail: impl Into<String>,
        location: Option<String>,
    ) {
        self.push(ConversionSeverity::Flattened, feature, detail, location);
    }

    pub fn skipped(
        &mut self,
        feature: impl Into<String>,
        detail: impl Into<String>,
        location: Option<String>,
    ) {
        self.push(ConversionSeverity::Skipped, feature, detail, location);
    }

    pub fn unsupported(
        &mut self,
        feature: impl Into<String>,
        detail: impl Into<String>,
        location: Option<String>,
    ) {
        self.push(ConversionSeverity::Unsupported, feature, detail, location);
    }

    pub fn has(&self, severity: ConversionSeverity) -> bool {
        self.notes.iter().any(|note| note.severity == severity)
    }

    /// True when nothing was lost: every note is an `Imported` one.
    pub fn is_lossless(&self) -> bool {
        !self.truncated
            && self
                .notes
                .iter()
                .all(|note| note.severity == ConversionSeverity::Imported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_repeated_notes_instead_of_growing_without_bound() {
        let mut report = ConversionReport::default();
        for index in 0..1_000 {
            report.skipped(
                "Pivot table",
                "Not supported.",
                Some(format!("Sheet1!A{index}")),
            );
        }
        assert_eq!(report.notes.len(), MAX_NOTES_PER_FEATURE);
        assert_eq!(
            report.notes.last().unwrap().count,
            1 + 1_000 - MAX_NOTES_PER_FEATURE as u32
        );
    }

    #[test]
    fn keeps_severities_separate() {
        let mut report = ConversionReport::default();
        report.imported("Formulas", "Imported 3 formulas.");
        report.flattened("Formulas", "Kept the last value.", None);
        assert_eq!(report.notes.len(), 2);
        assert!(!report.is_lossless());
    }

    #[test]
    fn a_clean_import_reports_as_lossless() {
        let mut report = ConversionReport::default();
        report.imported("Worksheets", "Imported 2 worksheets.");
        assert!(report.is_lossless());
    }
}
