#[cfg(any(target_os = "android", test))]
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
#[cfg(any(target_os = "android", test))]
use collab_calendar::{
    query_calendar_items, CalendarAttendee, CalendarDefinition, CalendarItem, CalendarItemKind,
    CalendarLocation, CalendarQueryRange, CalendarStore, CalendarTimeValue, MAX_RANGE_QUERY_ITEMS,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "android", test))]
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
#[cfg(any(target_os = "android", test))]
use std::time::Instant;

pub(crate) const WIDGET_SCHEMA_VERSION: u32 = 1;
#[cfg(any(target_os = "android", test))]
const MAX_DATE_LABEL_BYTES: usize = 32;
const MAX_TEXT_BYTES: usize = 160;
const MAX_ID_BYTES: usize = 128;
const MAX_CONFIGURATIONS: usize = 32;
const MAX_CONFIGURATION_TOMBSTONES: usize = 128;
const MAX_SOURCE_IDS: usize = 64;
const MAX_SNAPSHOT_ITEMS: usize = 24;
const MAX_SNAPSHOT_DAYS: usize = 42;
/// Stacked bar lanes available in one week row of the month grid. A day may
/// start at most this many segments, so it also bounds `items` per day.
const MAX_MONTH_LANES: usize = 3;
const MAX_MONTH_ITEM_TITLE_BYTES: usize = 40;
const MAX_STORE_BYTES: u64 = 64 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 262_144;
const MIN_MONTH_OFFSET: i8 = -6;
const MAX_MONTH_OFFSET: i8 = 6;
const MAX_CAPTURE_ACTIONS: usize = 6;
const MAX_PINNED_SHORTCUTS: usize = 16;
/// Upper bound on replica entries inspected while building shortcut rows, so a
/// large vault cannot turn a widget refresh into an unbounded scan.
#[cfg(any(target_os = "android", test))]
const MAX_SHORTCUT_CANDIDATES: usize = 400;

static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn store_lock() -> &'static Mutex<()> {
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetKind {
    Agenda,
    Month,
    Birthday,
    Countdown,
    Tasks,
    Capture,
    Shortcuts,
    Sync,
}

/// A quick-capture tile. Each one only opens an existing mobile flow; the
/// widget itself never captures content or requests a permission.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetCaptureAction {
    Note,
    Task,
    Event,
    Files,
}

#[cfg(any(target_os = "android", test))]
impl WidgetCaptureAction {
    fn destination(self) -> &'static str {
        match self {
            Self::Note => "capture-note",
            Self::Task => "capture-task",
            Self::Event => "calendar-create",
            Self::Files => "capture-files",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Note => "New note",
            Self::Task => "New task",
            Self::Event => "New event",
            Self::Files => "Add files",
        }
    }

    fn detail(self) -> &'static str {
        match self {
            Self::Note => "Opens the note creator",
            Self::Task => "Opens the task creator",
            Self::Event => "Opens the event creator",
            Self::Files => "Opens the file picker",
        }
    }
}

/// The coarse type of a pinned or recent vault entry. Kotlin renders an icon
/// from this rather than parsing names or paths.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetEntryKind {
    Note,
    Board,
    Canvas,
    Sheet,
    Pdf,
    Folder,
    File,
}

#[cfg(any(target_os = "android", test))]
impl WidgetEntryKind {
    /// The generic label used when privacy reduction removes the real name.
    fn private_label(self) -> &'static str {
        match self {
            Self::Note => "Note",
            Self::Board => "Board",
            Self::Canvas => "Canvas",
            Self::Sheet => "Sheet",
            Self::Pdf => "PDF",
            Self::Folder => "Folder",
            Self::File => "File",
        }
    }
}

/// Where a projected task came from. Calendar tasks are writable through the
/// local pending-operation queue; Kanban assignments are read-only projections
/// of hosted cards and can only be completed in the app.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetTaskSource {
    Calendar,
    Kanban,
}

/// What a launcher tap may do with a task. Anything other than `available`
/// keeps the mutation inside the app, where authorization, conflicts, and
/// recurrence choices are visible.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetTaskCompletion {
    /// Completable natively after an explicit launcher confirmation.
    Available,
    /// Requires the app: Kanban write-through, recurrence choices, or a source
    /// whose current state cannot be trusted.
    ConfirmInApp,
    /// Not completable at all (read-only calendar, or the action is disabled).
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetPrivacy {
    Full,
    TitleOnly,
    Private,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetFreshness {
    Fresh,
    Stale,
    Unavailable,
}

/// The operational rollup a sync widget renders.
///
/// Rust decides this from the persistent background ledger and the replica
/// queues so the launcher never infers operational meaning from raw counts, and
/// so the same precedence applies wherever the rollup is shown.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetSyncState {
    UpToDate,
    Syncing,
    PendingChanges,
    ActionRequired,
    AuthenticationRequired,
    Offline,
    Paused,
}

#[cfg(any(target_os = "android", test))]
impl WidgetSyncState {
    /// The row-independent headline. It never names an account, a vault, or a
    /// server, so it reads the same at every privacy level.
    fn label(self, summary: &WidgetSyncSummary) -> String {
        match self {
            Self::UpToDate => "Up to date".into(),
            Self::Syncing => "Syncing…".into(),
            Self::PendingChanges => match summary.pending_operations {
                1 => "1 change waiting to sync".into(),
                count => format!("{count} changes waiting to sync"),
            },
            Self::ActionRequired => {
                match summary.attention_required + summary.failed_operations {
                    1 => "1 item needs attention".into(),
                    count => format!("{count} items need attention"),
                }
            }
            Self::AuthenticationRequired => "Sign in again to sync".into(),
            Self::Offline => "Offline · changes sync later".into(),
            Self::Paused => "Background sync is paused".into(),
        }
    }

    /// Whether the state is one the user has to act on. These states deep-link
    /// into the app's own recovery settings instead of offering a launcher fix.
    fn needs_attention(self) -> bool {
        matches!(self, Self::ActionRequired | Self::AuthenticationRequired)
    }
}

/// The privacy-safe operational rollup carried by a sync snapshot.
///
/// Every field is a count, a coarse state, or a timestamp. No server URL,
/// account name, or error body is ever published: an authentication failure
/// becomes `AuthenticationRequired` and nothing more.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSyncSummary {
    pub state: WidgetSyncState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    /// The rendered "Synced 5 min ago" phrasing. Rust owns it so the launcher
    /// never has to decide what an age means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_label: Option<String>,
    pub pending_operations: u32,
    pub failed_operations: u32,
    pub active_jobs: u32,
    pub attention_required: u32,
    pub accounts: u32,
    pub vaults: u32,
    /// Coarse progress across the jobs currently running. `progress_total` is
    /// absent whenever any running job cannot state a total, so the launcher
    /// shows an indeterminate state rather than an invented percentage.
    pub progress_completed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_total: Option<u64>,
    /// What the running work is on right now — a vault name, or the phase the
    /// executor reported. Absent when nothing is running.
    ///
    /// This is the job's own progress detail, which is a vault name or a
    /// vault-relative file path. Vault names already appear in this widget's
    /// rows, but a path does not, so the detail is reduced to its last segment
    /// and never carries a server, an account, or a directory tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_label: Option<String>,
    /// The rendered "12 of 40" or "45%" phrasing. Rust owns it so the launcher
    /// never has to decide what a pair of counts means, and it is absent
    /// whenever the running work cannot state a total.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_label: Option<String>,
    /// False when there is nothing registered to sync, so the launcher does not
    /// offer an action that would enqueue no work.
    pub can_sync_now: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetDisplayOptions {
    #[serde(default = "default_horizon_days")]
    pub horizon_days: u16,
    #[serde(default = "default_max_items")]
    pub max_items: u8,
    #[serde(default)]
    pub show_completed: bool,
}

fn default_horizon_days() -> u16 {
    7
}

fn default_max_items() -> u8 {
    6
}

impl Default for WidgetDisplayOptions {
    fn default() -> Self {
        Self {
            horizon_days: default_horizon_days(),
            max_items: default_max_items(),
            show_completed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetActionOptions {
    #[serde(default)]
    pub open_item: bool,
    #[serde(default)]
    pub toggle_task: bool,
}

impl Default for WidgetActionOptions {
    fn default() -> Self {
        Self {
            open_item: true,
            toggle_task: false,
        }
    }
}

/// Task-widget source selection. Account, vault, and assignee filtering are
/// expressed through `selected_source_ids`, because each hosted account and
/// each Kanban origin owns its own calendar and the Kanban projection is
/// already scoped to the signed-in user's assignments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetTaskOptions {
    #[serde(default = "default_true")]
    pub include_calendar_tasks: bool,
    #[serde(default = "default_true")]
    pub include_kanban_tasks: bool,
    #[serde(default = "default_true")]
    pub include_undated: bool,
    /// Opaque Kanban board file identifiers. Empty means every board.
    #[serde(default)]
    pub selected_board_ids: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn default_capture_actions() -> Vec<WidgetCaptureAction> {
    vec![
        WidgetCaptureAction::Note,
        WidgetCaptureAction::Task,
        WidgetCaptureAction::Event,
        WidgetCaptureAction::Files,
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetCaptureOptions {
    #[serde(default = "default_capture_actions")]
    pub actions: Vec<WidgetCaptureAction>,
}

impl Default for WidgetCaptureOptions {
    fn default() -> Self {
        Self {
            actions: default_capture_actions(),
        }
    }
}

/// A user-pinned vault entry, addressed only by stable opaque identity. The
/// owning server is resolved from the replica inventory at publication time and
/// never stored in the configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetPinnedTarget {
    pub vault_id: String,
    pub file_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetShortcutOptions {
    #[serde(default)]
    pub pinned: Vec<WidgetPinnedTarget>,
    /// Fills any remaining rows from bounded replica metadata.
    #[serde(default = "default_true")]
    pub include_recent: bool,
}

impl Default for WidgetShortcutOptions {
    fn default() -> Self {
        Self {
            pinned: Vec::new(),
            include_recent: true,
        }
    }
}

impl Default for WidgetTaskOptions {
    fn default() -> Self {
        Self {
            include_calendar_tasks: true,
            include_kanban_tasks: true,
            include_undated: true,
            selected_board_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetConfiguration {
    #[serde(default = "widget_schema_version")]
    pub schema_version: u32,
    pub configuration_id: String,
    pub kind: WidgetKind,
    #[serde(default)]
    pub selected_source_ids: Vec<String>,
    #[serde(default)]
    pub selected_item_ids: Vec<String>,
    pub privacy: WidgetPrivacy,
    #[serde(default)]
    pub display: WidgetDisplayOptions,
    #[serde(default)]
    pub actions: WidgetActionOptions,
    #[serde(default)]
    pub tasks: WidgetTaskOptions,
    #[serde(default)]
    pub capture: WidgetCaptureOptions,
    #[serde(default)]
    pub shortcuts: WidgetShortcutOptions,
    pub updated_at: String,
}

fn widget_schema_version() -> u32 {
    WIDGET_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSourceFreshness {
    pub source_id: String,
    pub freshness: WidgetFreshness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetItemInput {
    pub stable_id: String,
    pub source_id: String,
    pub sort_key: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub title_only_detail: String,
    #[serde(default = "default_private_item_title")]
    pub private_title: String,
    #[serde(default)]
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<WidgetAgendaSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_kind: Option<WidgetAgendaItemKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<WidgetTaskDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<WidgetShortcutDetails>,
}

fn default_private_item_title() -> String {
    "Private item".into()
}

/// The bounded descriptor a capture tile or vault shortcut row taps through.
/// Targets are addressed by stable opaque identity only: no path, URL, or
/// server origin is ever persisted for the launcher to hand back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetShortcutDetails {
    pub destination: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_kind: Option<WidgetEntryKind>,
    #[serde(default)]
    pub pinned: bool,
}

/// Destinations a capture, shortcut, or sync-recovery row is allowed to carry.
const SHORTCUT_DESTINATIONS: [&str; 8] = [
    "capture-note",
    "capture-task",
    "calendar-create",
    "capture-files",
    "vault-file",
    "vault-folder",
    // Sync recovery opens the app's own settings rather than offering a fix in
    // the launcher, where authorization and errors are not visible.
    "settings-background",
    "settings-account",
];

/// When a task is due relative to the profile-timezone day the snapshot was
/// generated for. Rust decides this so Kotlin never infers calendar semantics.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetTaskDue {
    Overdue,
    Today,
    Upcoming,
    Unscheduled,
}

/// The bounded, privacy-independent task projection carried by task snapshots.
/// Every identifier here is opaque; no server URL, board name, or document body
/// crosses into launcher-readable storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetTaskDetails {
    pub source: WidgetTaskSource,
    pub due: WidgetTaskDue,
    pub completion: WidgetTaskCompletion,
    /// The item revision the row was rendered from. Native completion refuses
    /// to act when the stored item has moved on.
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetAgendaSection {
    Overdue,
    Today,
    Upcoming,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetAgendaItemKind {
    Event,
    Task,
    Birthday,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSnapshotItem {
    pub stable_id: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<WidgetAgendaSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_kind: Option<WidgetAgendaItemKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<WidgetTaskDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<WidgetShortcutDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetDaySummary {
    pub day_key: String,
    pub count: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub colors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<WidgetDayItem>,
    pub in_month: bool,
    pub is_today: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// One bar segment in the month grid, stored on the day it starts.
///
/// A multi-day entry is published once per week row it crosses rather than
/// once per day, so the launcher can draw a continuous bar instead of
/// repeating the same title in every cell. `span` counts the columns the
/// segment covers inside its own week row, and the `continues_*` flags say
/// whether the underlying entry runs past that row's edge — either into the
/// next week or beyond the rendered grid entirely.
pub(crate) struct WidgetDayItem {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Columns covered within this week row, always `1..=7`.
    #[serde(default = "default_span")]
    pub span: u8,
    /// Stacked lane index within the week row, always `< MAX_MONTH_LANES`.
    #[serde(default)]
    pub lane: u8,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub continues_before: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub continues_after: bool,
}

fn default_span() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetMonthPage {
    pub offset: i8,
    pub month_label: String,
    pub days: Vec<WidgetDaySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSnapshot {
    pub schema_version: u32,
    pub profile_id_hash: String,
    pub configuration_id: String,
    pub kind: WidgetKind,
    pub generated_at: String,
    pub date_label: String,
    pub state_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_day_key: Option<String>,
    #[serde(default = "default_widget_theme")]
    pub theme: String,
    #[serde(default = "default_widget_accent")]
    pub accent: String,
    #[serde(default = "default_widget_font_scale")]
    pub font_scale: f32,
    pub freshness: Vec<WidgetSourceFreshness>,
    pub items: Vec<WidgetSnapshotItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<WidgetDaySummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub months: Vec<WidgetMonthPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<WidgetSyncSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetBuildRequest {
    pub configuration: WidgetConfiguration,
    pub generated_at: String,
    pub date_label: String,
    #[serde(default)]
    pub appearance: Option<WidgetAppearanceSnapshot>,
    #[serde(default)]
    pub freshness: Vec<WidgetSourceFreshness>,
    #[serde(default)]
    pub items: Vec<WidgetItemInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetPublishOutcome {
    pub changed: bool,
    pub snapshot: WidgetSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetDiagnostics {
    pub schema_version: u32,
    pub configuration_id: String,
    pub last_attempt_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub update_cause: String,
    pub generation_duration_ms: u64,
    pub serialized_bytes: u64,
    pub item_count: u32,
    pub truncated: bool,
    pub fresh_sources: u32,
    pub stale_sources: u32,
    pub unavailable_sources: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetActionKind {
    OpenAgenda,
    OpenMonth,
    OpenBirthdays,
    OpenCountdowns,
    OpenTasks,
    OpenCapture,
    OpenShortcuts,
    OpenSync,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetActionRequest {
    pub configuration_id: String,
    pub action: WidgetActionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetPreparedAction {
    pub configuration_id: String,
    pub destination_kind: String,
}

/// A launcher-confirmed request to complete one task. The caller must supply
/// the revision it displayed so a stale row cannot silently overwrite newer
/// state.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetTaskCompletionRequest {
    pub configuration_id: String,
    pub item_id: String,
    pub expected_revision: i64,
    /// Set by the launcher only after the user confirmed the action in place.
    #[serde(default)]
    pub confirmed: bool,
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetTaskCompletionResult {
    /// True when the native queue accepted the mutation. Only then may the
    /// launcher show the row as completed.
    pub applied: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetAppearanceSnapshot {
    pub schema_version: u32,
    pub theme: String,
    pub accent: String,
    pub font_scale: f32,
    #[serde(default = "default_widget_time_zone")]
    pub time_zone: String,
    #[serde(default = "default_widget_time_format")]
    pub time_format: String,
    #[serde(default)]
    pub show_declined: bool,
}

fn default_widget_time_zone() -> String {
    "UTC".into()
}

fn default_widget_theme() -> String {
    "dark".into()
}

fn default_widget_accent() -> String {
    "violet".into()
}

fn default_widget_font_scale() -> f32 {
    1.0
}

fn default_widget_time_format() -> String {
    "system".into()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWidgetProfile {
    schema_version: u32,
    profile_id: String,
}

#[cfg(any(target_os = "android", test))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetDeviceIdentity {
    schema_version: u32,
    device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetConfigurationDocument {
    schema_version: u32,
    revision: u64,
    configurations: Vec<WidgetConfiguration>,
    #[serde(default)]
    deleted_configuration_ids: Vec<String>,
}

impl Default for WidgetConfigurationDocument {
    fn default() -> Self {
        Self {
            schema_version: WIDGET_SCHEMA_VERSION,
            revision: 0,
            configurations: Vec::new(),
            deleted_configuration_ids: Vec::new(),
        }
    }
}

pub(crate) struct WidgetStore {
    profile_dir: PathBuf,
    profile_id_hash: String,
}

impl WidgetStore {
    pub(crate) fn open(config_root: &Path, profile_id: &str) -> Result<Self, String> {
        validate_identifier(profile_id, "profile")?;
        let profile_id_hash = profile_hash(profile_id);
        Ok(Self {
            profile_dir: config_root
                .join("widgets")
                .join("profiles")
                .join(&profile_id_hash),
            profile_id_hash,
        })
    }

    pub(crate) fn list_configurations(&self) -> Result<Vec<WidgetConfiguration>, String> {
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        Ok(self.read_configuration_document()?.configurations)
    }

    pub(crate) fn save_configuration(
        &self,
        configuration: WidgetConfiguration,
    ) -> Result<WidgetConfiguration, String> {
        validate_configuration(&configuration)?;
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        let mut document = self.read_configuration_document()?;
        if document
            .deleted_configuration_ids
            .iter()
            .any(|id| id == &configuration.configuration_id)
        {
            return Err("The widget configuration was removed and cannot be restored.".into());
        }
        if let Some(existing) = document
            .configurations
            .iter_mut()
            .find(|entry| entry.configuration_id == configuration.configuration_id)
        {
            *existing = configuration.clone();
        } else {
            if document.configurations.len() >= MAX_CONFIGURATIONS {
                return Err("Too many widget configurations are stored for this profile.".into());
            }
            document.configurations.push(configuration.clone());
        }
        document
            .configurations
            .sort_by(|left, right| left.configuration_id.cmp(&right.configuration_id));
        document.revision = document.revision.saturating_add(1);
        self.write_configuration_document(&document)?;
        Ok(configuration)
    }

    pub(crate) fn delete_configuration(&self, configuration_id: &str) -> Result<bool, String> {
        validate_identifier(configuration_id, "widget configuration")?;
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        let mut document = self.read_configuration_document()?;
        let before = document.configurations.len();
        document
            .configurations
            .retain(|entry| entry.configuration_id != configuration_id);
        let removed = document.configurations.len() != before;
        if removed {
            if !document
                .deleted_configuration_ids
                .iter()
                .any(|id| id == configuration_id)
            {
                document
                    .deleted_configuration_ids
                    .push(configuration_id.to_string());
                if document.deleted_configuration_ids.len() > MAX_CONFIGURATION_TOMBSTONES {
                    document.deleted_configuration_ids.remove(0);
                }
            }
            document.revision = document.revision.saturating_add(1);
            self.write_configuration_document(&document)?;
        }
        let snapshot_path = self.snapshot_path(configuration_id);
        if snapshot_path.exists() {
            fs::remove_file(snapshot_path).map_err(|_| store_error())?;
        }
        let diagnostics_path = self.diagnostics_path(configuration_id);
        if diagnostics_path.exists() {
            fs::remove_file(diagnostics_path).map_err(|_| store_error())?;
        }
        Ok(removed)
    }

    pub(crate) fn publish(&self, snapshot: WidgetSnapshot) -> Result<WidgetPublishOutcome, String> {
        validate_snapshot(&snapshot, &self.profile_id_hash)?;
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        let document = self.read_configuration_document()?;
        if !document
            .configurations
            .iter()
            .any(|entry| entry.configuration_id == snapshot.configuration_id)
        {
            return Err("The widget configuration no longer exists.".into());
        }
        let path = self.snapshot_path(&snapshot.configuration_id);
        if let Some(existing) =
            read_json_optional::<WidgetSnapshot>(&path, MAX_SNAPSHOT_BYTES as u64)?
        {
            if snapshot_content_eq(&existing, &snapshot) {
                return Ok(WidgetPublishOutcome {
                    changed: false,
                    snapshot: existing,
                });
            }
        }
        let encoded = encode_bounded(&snapshot, MAX_SNAPSHOT_BYTES)?;
        atomic_replace(&path, &encoded)?;
        Ok(WidgetPublishOutcome {
            changed: true,
            snapshot,
        })
    }

    pub(crate) fn read_snapshot(
        &self,
        configuration_id: &str,
    ) -> Result<Option<WidgetSnapshot>, String> {
        validate_identifier(configuration_id, "widget configuration")?;
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        let snapshot = read_json_optional(
            &self.snapshot_path(configuration_id),
            MAX_SNAPSHOT_BYTES as u64,
        )?;
        if let Some(snapshot) = &snapshot {
            validate_snapshot(snapshot, &self.profile_id_hash)?;
        }
        Ok(snapshot)
    }

    pub(crate) fn list_diagnostics(&self) -> Result<Vec<WidgetDiagnostics>, String> {
        let configurations = self.list_configurations()?;
        configurations
            .into_iter()
            .filter_map(|configuration| {
                let path = self.diagnostics_path(&configuration.configuration_id);
                match read_json_optional::<WidgetDiagnostics>(&path, MAX_STORE_BYTES) {
                    Ok(Some(value)) => Some(Ok(value)),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .collect()
    }

    #[cfg(any(target_os = "android", test))]
    pub(crate) fn record_refresh_failure(
        &self,
        attempted_at: &str,
        update_cause: &str,
    ) -> Result<(), String> {
        validate_text(attempted_at, MAX_TEXT_BYTES, "widget update time")?;
        validate_text(update_cause, 64, "widget update cause")?;
        for configuration in self.list_configurations()? {
            let existing = read_json_optional::<WidgetDiagnostics>(
                &self.diagnostics_path(&configuration.configuration_id),
                MAX_STORE_BYTES,
            )?;
            self.write_diagnostics(&WidgetDiagnostics {
                schema_version: WIDGET_SCHEMA_VERSION,
                configuration_id: configuration.configuration_id,
                last_attempt_at: attempted_at.to_string(),
                last_success_at: existing
                    .as_ref()
                    .and_then(|value| value.last_success_at.clone()),
                last_error: Some("Widget refresh failed. Open Collab and try again.".into()),
                update_cause: update_cause.to_string(),
                generation_duration_ms: existing
                    .as_ref()
                    .map(|value| value.generation_duration_ms)
                    .unwrap_or_default(),
                serialized_bytes: existing
                    .as_ref()
                    .map(|value| value.serialized_bytes)
                    .unwrap_or_default(),
                item_count: existing
                    .as_ref()
                    .map(|value| value.item_count)
                    .unwrap_or_default(),
                truncated: existing
                    .as_ref()
                    .map(|value| value.truncated)
                    .unwrap_or(false),
                fresh_sources: existing
                    .as_ref()
                    .map(|value| value.fresh_sources)
                    .unwrap_or_default(),
                stale_sources: existing
                    .as_ref()
                    .map(|value| value.stale_sources)
                    .unwrap_or_default(),
                unavailable_sources: existing
                    .as_ref()
                    .map(|value| value.unavailable_sources)
                    .unwrap_or_default(),
            })?;
        }
        Ok(())
    }

    #[cfg(any(target_os = "android", test))]
    fn write_diagnostics(&self, diagnostics: &WidgetDiagnostics) -> Result<(), String> {
        validate_identifier(&diagnostics.configuration_id, "widget configuration")?;
        let encoded = encode_bounded(diagnostics, MAX_STORE_BYTES as usize)?;
        atomic_replace(
            &self.diagnostics_path(&diagnostics.configuration_id),
            &encoded,
        )
    }

    pub(crate) fn prepare_action(
        &self,
        request: WidgetActionRequest,
    ) -> Result<WidgetPreparedAction, String> {
        validate_identifier(&request.configuration_id, "widget configuration")?;
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        let document = self.read_configuration_document()?;
        let configuration = document
            .configurations
            .iter()
            .find(|entry| entry.configuration_id == request.configuration_id)
            .ok_or_else(|| "The widget configuration no longer exists.".to_string())?;
        let destination_kind = match (configuration.kind, request.action) {
            (WidgetKind::Agenda, WidgetActionKind::OpenAgenda) => "calendar-today",
            (WidgetKind::Month, WidgetActionKind::OpenMonth) => "calendar-today",
            (WidgetKind::Birthday, WidgetActionKind::OpenBirthdays) => "calendar-today",
            (WidgetKind::Countdown, WidgetActionKind::OpenCountdowns) => "calendar-today",
            (WidgetKind::Tasks, WidgetActionKind::OpenTasks) => "calendar-today",
            (WidgetKind::Capture, WidgetActionKind::OpenCapture) => "capture-note",
            // The shortcuts header opens the vault list rather than guessing a
            // target the user did not tap.
            (WidgetKind::Shortcuts, WidgetActionKind::OpenShortcuts) => "vault-list",
            // The sync header opens the background settings the widget reports
            // on, so the app is always where the state is explained and fixed.
            (WidgetKind::Sync, WidgetActionKind::OpenSync) => "settings-background",
            _ => return Err("The widget action does not match its configuration.".into()),
        };
        Ok(WidgetPreparedAction {
            configuration_id: request.configuration_id,
            destination_kind: destination_kind.into(),
        })
    }

    pub(crate) fn cleanup_profile(self) -> Result<(), String> {
        let _guard = store_lock().lock().map_err(|_| store_error())?;
        if self.profile_dir.exists() {
            fs::remove_dir_all(self.profile_dir).map_err(|_| store_error())?;
        }
        Ok(())
    }

    fn read_configuration_document(&self) -> Result<WidgetConfigurationDocument, String> {
        let path = self.profile_dir.join("configurations.json");
        let Some(raw) = read_bounded_optional(&path, MAX_STORE_BYTES)? else {
            return Ok(WidgetConfigurationDocument::default());
        };
        let mut document = match serde_json::from_slice::<WidgetConfigurationDocument>(&raw) {
            Ok(document) => document,
            Err(_) => {
                // Phase 1 migration: early development builds wrote a bare
                // configuration array before the versioned document landed.
                let configurations: Vec<WidgetConfiguration> = serde_json::from_slice(&raw)
                    .map_err(|_| "The widget configuration store is invalid.".to_string())?;
                WidgetConfigurationDocument {
                    schema_version: WIDGET_SCHEMA_VERSION,
                    revision: 0,
                    configurations,
                    deleted_configuration_ids: Vec::new(),
                }
            }
        };
        if document.schema_version != WIDGET_SCHEMA_VERSION {
            return Err("The widget configuration store uses an unsupported schema.".into());
        }
        if document.configurations.len() > MAX_CONFIGURATIONS {
            return Err("The widget configuration store exceeds its item limit.".into());
        }
        if document.deleted_configuration_ids.len() > MAX_CONFIGURATION_TOMBSTONES {
            return Err("The widget configuration store exceeds its tombstone limit.".into());
        }
        for configuration_id in &document.deleted_configuration_ids {
            validate_identifier(configuration_id, "widget configuration")?;
        }
        for configuration in &mut document.configurations {
            configuration.schema_version = WIDGET_SCHEMA_VERSION;
            validate_configuration(configuration)?;
        }
        document
            .configurations
            .sort_by(|left, right| left.configuration_id.cmp(&right.configuration_id));
        Ok(document)
    }

    fn write_configuration_document(
        &self,
        document: &WidgetConfigurationDocument,
    ) -> Result<(), String> {
        let encoded = encode_bounded(document, MAX_STORE_BYTES as usize)?;
        atomic_replace(&self.profile_dir.join("configurations.json"), &encoded)
    }

    fn snapshot_path(&self, configuration_id: &str) -> PathBuf {
        self.profile_dir
            .join("snapshots")
            .join(format!("{configuration_id}.json"))
    }

    fn diagnostics_path(&self, configuration_id: &str) -> PathBuf {
        self.profile_dir
            .join("diagnostics")
            .join(format!("{configuration_id}.json"))
    }
}

pub(crate) fn set_active_profile(config_root: &Path, profile_id: &str) -> Result<(), String> {
    validate_identifier(profile_id, "profile")?;
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let encoded = encode_bounded(
        &ActiveWidgetProfile {
            schema_version: WIDGET_SCHEMA_VERSION,
            profile_id: profile_id.into(),
        },
        1024,
    )?;
    atomic_replace(
        &config_root.join("widgets").join("active-profile.json"),
        &encoded,
    )
}

pub(crate) fn save_appearance(
    config_root: &Path,
    appearance: WidgetAppearanceSnapshot,
) -> Result<WidgetAppearanceSnapshot, String> {
    validate_appearance(&appearance)?;
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let encoded = encode_bounded(&appearance, 1024)?;
    atomic_replace(
        &config_root.join("widgets").join("appearance.json"),
        &encoded,
    )?;
    Ok(appearance)
}

#[allow(dead_code)]
pub(crate) fn read_appearance(
    config_root: &Path,
) -> Result<Option<WidgetAppearanceSnapshot>, String> {
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let appearance = read_json_optional::<WidgetAppearanceSnapshot>(
        &config_root.join("widgets").join("appearance.json"),
        1024,
    )?;
    if let Some(appearance) = &appearance {
        validate_appearance(appearance)?;
    }
    Ok(appearance)
}

#[allow(dead_code)]
pub(crate) fn active_profile(config_root: &Path) -> Result<Option<String>, String> {
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let Some(profile) = read_json_optional::<ActiveWidgetProfile>(
        &config_root.join("widgets").join("active-profile.json"),
        1024,
    )?
    else {
        return Ok(None);
    };
    if profile.schema_version != WIDGET_SCHEMA_VERSION {
        return Err("The active widget profile uses an unsupported schema.".into());
    }
    validate_identifier(&profile.profile_id, "profile")?;
    Ok(Some(profile.profile_id))
}

/// Returns the stable device identifier stamped onto widget-originated
/// calendar operations, creating it on first use. Widget writes are attributed
/// to their own device so they stay distinguishable from webview edits during
/// synchronization.
#[cfg(any(target_os = "android", test))]
fn widget_device_id(config_root: &Path) -> Result<String, String> {
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let path = config_root.join("widgets").join("device.json");
    if let Some(existing) = read_json_optional::<WidgetDeviceIdentity>(&path, 1024)? {
        if existing.schema_version == WIDGET_SCHEMA_VERSION
            && validate_identifier(&existing.device_id, "widget device").is_ok()
        {
            return Ok(existing.device_id);
        }
    }
    let identity = WidgetDeviceIdentity {
        schema_version: WIDGET_SCHEMA_VERSION,
        device_id: format!("widget-{}", uuid::Uuid::new_v4()),
    };
    atomic_replace(&path, &encode_bounded(&identity, 1024)?)?;
    Ok(identity.device_id)
}

pub(crate) fn clear_active_profile(
    config_root: &Path,
    expected_profile_id: &str,
) -> Result<bool, String> {
    validate_identifier(expected_profile_id, "profile")?;
    let _guard = store_lock().lock().map_err(|_| store_error())?;
    let path = config_root.join("widgets").join("active-profile.json");
    let Some(profile) = read_json_optional::<ActiveWidgetProfile>(&path, 1024)? else {
        return Ok(false);
    };
    if profile.profile_id != expected_profile_id {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|_| store_error())?;
    Ok(true)
}

pub(crate) fn build_snapshot(
    profile_id: &str,
    request: WidgetBuildRequest,
) -> Result<WidgetSnapshot, String> {
    validate_identifier(profile_id, "profile")?;
    validate_configuration(&request.configuration)?;
    validate_text(&request.generated_at, MAX_TEXT_BYTES, "generation time")?;
    validate_text(&request.date_label, MAX_TEXT_BYTES, "date label")?;
    let appearance = request
        .appearance
        .clone()
        .unwrap_or(WidgetAppearanceSnapshot {
            schema_version: WIDGET_SCHEMA_VERSION,
            theme: default_widget_theme(),
            accent: default_widget_accent(),
            font_scale: default_widget_font_scale(),
            time_zone: default_widget_time_zone(),
            time_format: default_widget_time_format(),
            show_declined: false,
        });
    validate_appearance(&appearance)?;
    if request.items.len() > MAX_SNAPSHOT_ITEMS * 4 {
        return Err("Too many candidate widget items were supplied.".into());
    }
    if request.freshness.len() > MAX_SOURCE_IDS {
        return Err("Too many widget freshness records were supplied.".into());
    }

    let selected: HashSet<&str> = request
        .configuration
        .selected_source_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut freshness: Vec<_> = request
        .freshness
        .into_iter()
        .filter(|entry| selected.is_empty() || selected.contains(entry.source_id.as_str()))
        .collect();
    freshness.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    freshness.dedup_by(|left, right| left.source_id == right.source_id);
    for entry in &freshness {
        validate_identifier(&entry.source_id, "widget source")?;
    }

    let mut candidates: Vec<_> = request
        .items
        .into_iter()
        .filter(|item| selected.is_empty() || selected.contains(item.source_id.as_str()))
        .filter(|item| request.configuration.display.show_completed || !item.completed)
        .collect();
    for item in &candidates {
        validate_identifier(&item.stable_id, "widget item")?;
        validate_identifier(&item.source_id, "widget source")?;
        validate_text(&item.sort_key, MAX_TEXT_BYTES, "widget item sort key")?;
        validate_text(&item.title, MAX_TEXT_BYTES, "widget item title")?;
        validate_text(
            &item.private_title,
            MAX_TEXT_BYTES,
            "private widget item title",
        )?;
        if !item.detail.is_empty() {
            validate_text(&item.detail, MAX_TEXT_BYTES, "widget item detail")?;
        }
        if !item.title_only_detail.is_empty() {
            validate_text(
                &item.title_only_detail,
                MAX_TEXT_BYTES,
                "privacy-reduced widget item detail",
            )?;
        }
    }
    candidates.sort_by(|left, right| {
        left.sort_key
            .cmp(&right.sort_key)
            .then_with(|| left.stable_id.cmp(&right.stable_id))
    });
    candidates.truncate(usize::from(request.configuration.display.max_items));
    let items = candidates
        .into_iter()
        .map(|item| reduce_item(item, request.configuration.privacy))
        .collect::<Vec<_>>();

    let stale = freshness
        .iter()
        .filter(|entry| entry.freshness == WidgetFreshness::Stale)
        .count();
    let unavailable = freshness
        .iter()
        .filter(|entry| entry.freshness == WidgetFreshness::Unavailable)
        .count();
    let state_label = if unavailable > 0 {
        "Some sources unavailable"
    } else if stale > 0 {
        "Some sources may be stale"
    } else if items.is_empty() {
        match request.configuration.kind {
            WidgetKind::Birthday => "No birthdays upcoming",
            WidgetKind::Countdown if request.configuration.selected_item_ids.is_empty() => {
                "Choose events in Collab settings"
            }
            WidgetKind::Countdown => "No selected events upcoming",
            WidgetKind::Month => "No items today",
            WidgetKind::Tasks => "No tasks due",
            WidgetKind::Capture => "Choose actions in Collab settings",
            WidgetKind::Shortcuts => "Pin files in Collab settings",
            // Replaced below with the rollup headline once the sync summary is
            // attached; this only shows for a profile with no offline copies.
            WidgetKind::Sync => "No offline vaults yet",
            WidgetKind::Agenda => "Nothing upcoming",
        }
    } else {
        "Up to date"
    };
    let snapshot = WidgetSnapshot {
        schema_version: WIDGET_SCHEMA_VERSION,
        profile_id_hash: profile_hash(profile_id),
        configuration_id: request.configuration.configuration_id,
        kind: request.configuration.kind,
        generated_at: request.generated_at,
        date_label: request.date_label,
        state_label: state_label.into(),
        month_label: None,
        selected_day_key: None,
        theme: appearance.theme,
        accent: appearance.accent,
        font_scale: appearance.font_scale,
        freshness,
        items,
        days: Vec::new(),
        months: Vec::new(),
        sync: None,
    };
    validate_snapshot(&snapshot, &snapshot.profile_id_hash)?;
    encode_bounded(&snapshot, MAX_SNAPSHOT_BYTES)?;
    Ok(snapshot)
}

/// Whether a publication has to read the calendar at all.
///
/// Capture, shortcut, and sync widgets never render a calendar item. A profile
/// holding only those must not pay for the shared projection, which reaches a
/// year back so past-starting recurrences still expand and is therefore the
/// most expensive part of a publication.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub(crate) fn profile_needs_calendar(configurations: &[WidgetConfiguration]) -> bool {
    configurations.iter().any(|configuration| {
        matches!(
            configuration.kind,
            WidgetKind::Agenda
                | WidgetKind::Month
                | WidgetKind::Birthday
                | WidgetKind::Countdown
                | WidgetKind::Tasks
        )
    })
}

#[cfg(any(target_os = "android", test))]
pub(crate) async fn build_and_publish_agenda_profile(
    config_root: &Path,
    profile_id: &str,
    calendar_store: &CalendarStore,
    now: DateTime<Utc>,
    update_cause: &str,
) -> Result<Vec<WidgetPublishOutcome>, String> {
    validate_text(update_cause, 64, "widget update cause")?;
    let widget_store = WidgetStore::open(config_root, profile_id)?;
    let configurations = widget_store.list_configurations()?;
    if configurations.is_empty() {
        return Ok(Vec::new());
    }
    let appearance = read_appearance(config_root)?.unwrap_or(WidgetAppearanceSnapshot {
        schema_version: WIDGET_SCHEMA_VERSION,
        theme: "dark".into(),
        accent: "violet".into(),
        font_scale: 1.0,
        time_zone: default_widget_time_zone(),
        time_format: default_widget_time_format(),
        show_declined: false,
    });
    let time_zone = appearance
        .time_zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| "The widget time zone is invalid.".to_string())?;
    let local_now = now.with_timezone(&time_zone);
    let today = local_now.date_naive();
    let oldest = today - Duration::days(366);
    let max_horizon = configurations
        .iter()
        .map(|configuration| match configuration.kind {
            WidgetKind::Month => configuration.display.horizon_days.max(220),
            WidgetKind::Birthday | WidgetKind::Countdown => {
                configuration.display.horizon_days.max(31)
            }
            WidgetKind::Agenda | WidgetKind::Tasks => configuration.display.horizon_days,
            // Not calendar-ranged; they must not widen the shared query.
            WidgetKind::Capture | WidgetKind::Shortcuts | WidgetKind::Sync => 1,
        })
        .max()
        .unwrap_or(default_horizon_days());
    // Only the tasks widget renders tasks that were never scheduled, so the
    // shared projection stays as narrow as the placed widgets require.
    let include_unscheduled_tasks = configurations.iter().any(|configuration| {
        configuration.kind == WidgetKind::Tasks && configuration.tasks.include_undated
    });
    // Replica metadata is only read when a shortcut widget is actually placed.
    let shortcut_candidates = if configurations
        .iter()
        .any(|configuration| configuration.kind == WidgetKind::Shortcuts)
    {
        read_shortcut_candidates(config_root)
    } else {
        Vec::new()
    };
    let last_day = today + Duration::days(i64::from(max_horizon));
    let query_from = local_midnight_utc(time_zone, oldest)?;
    let query_to = local_midnight_utc(time_zone, last_day + Duration::days(1))?;

    // Capture, shortcut, and sync widgets never render a calendar item, so a
    // profile holding only those must not pay for the shared projection. It
    // reaches a year back so a recurrence that started in the past still
    // expands, which makes it the most expensive part of a publication — and
    // this runs on every republication, not just the first.
    let needs_calendar = profile_needs_calendar(&configurations);

    let calendars = if needs_calendar {
        calendar_store
            .list_calendars()
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|calendar| !calendar.archived && calendar.deleted_at.is_none())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let active_calendar_ids = calendars
        .iter()
        .map(|calendar| calendar.id.as_str())
        .collect::<HashSet<_>>();
    let projected = if needs_calendar {
        let candidates = calendar_store
            .list_items_in_range(
                &query_from.to_rfc3339(),
                &query_to.to_rfc3339(),
                MAX_RANGE_QUERY_ITEMS,
                false,
            )
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|item| active_calendar_ids.contains(item.calendar_id.as_str()))
            .collect::<Vec<_>>();
        query_calendar_items(
            &candidates,
            CalendarQueryRange {
                from: query_from,
                to: query_to,
                limit: MAX_RANGE_QUERY_ITEMS as usize,
                include_deleted: false,
                include_unscheduled_tasks,
            },
        )
        .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    let subscriptions = if needs_calendar {
        calendar_store
            .list_subscriptions()
            .await
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    let subscriptions = subscriptions
        .into_iter()
        .map(|subscription| (subscription.id.clone(), subscription))
        .collect::<HashMap<_, _>>();
    let calendar_by_id = calendars
        .iter()
        .map(|calendar| (calendar.id.as_str(), calendar))
        .collect::<HashMap<_, _>>();
    let mut freshness = Vec::with_capacity(calendars.len());
    for calendar in &calendars {
        freshness.push(WidgetSourceFreshness {
            source_id: calendar.id.clone(),
            freshness: source_freshness(calendar, &subscriptions, calendar_store, now).await?,
        });
    }

    let mut outcomes = Vec::with_capacity(configurations.len());
    for mut configuration in configurations {
        // The shared item limit is a calendar-list concept. Capture tiles and
        // pinned shortcuts are explicit user choices, so they raise the limit
        // (still inside the snapshot bound) instead of being silently cut.
        match configuration.kind {
            WidgetKind::Capture => {
                configuration.display.max_items =
                    (configuration.capture.actions.len().max(1)).min(MAX_SNAPSHOT_ITEMS) as u8;
            }
            WidgetKind::Shortcuts => {
                let recent = if configuration.shortcuts.include_recent {
                    usize::from(configuration.display.max_items)
                } else {
                    0
                };
                configuration.display.max_items = (configuration.shortcuts.pinned.len() + recent)
                    .clamp(1, MAX_SNAPSHOT_ITEMS)
                    as u8;
            }
            _ => {}
        }
        // The sync widget reports on durable local state instead of the shared
        // calendar projection, so its rows and freshness are built up front and
        // replace the calendar ones entirely.
        let sync_rollup = if configuration.kind == WidgetKind::Sync {
            Some(sync_item_inputs(config_root, &configuration, now))
        } else {
            None
        };
        let generation_started = Instant::now();
        let configuration_id = configuration.configuration_id.clone();
        let max_items = usize::from(configuration.display.max_items);
        let horizon_end = today + Duration::days(i64::from(configuration.display.horizon_days));
        let mut items = Vec::new();
        // Capture and shortcut widgets are not calendar projections; they build
        // their rows directly and skip the item scan entirely.
        match configuration.kind {
            WidgetKind::Capture => items = capture_item_inputs(&configuration),
            WidgetKind::Shortcuts => {
                items = shortcut_item_inputs(&configuration, &shortcut_candidates)
            }
            WidgetKind::Sync => {
                if let Some((rows, _, _)) = &sync_rollup {
                    items = rows.clone();
                }
            }
            _ => {}
        }
        for item in &projected {
            if matches!(
                configuration.kind,
                WidgetKind::Capture | WidgetKind::Shortcuts | WidgetKind::Sync
            ) {
                break;
            }
            if !configuration.selected_source_ids.is_empty()
                && !configuration
                    .selected_source_ids
                    .iter()
                    .any(|source_id| source_id == &item.calendar_id)
            {
                continue;
            }
            let Some(calendar) = calendar_by_id.get(item.calendar_id.as_str()).copied() else {
                continue;
            };
            if !appearance.show_declined && is_declined_for_calendar(item, calendar) {
                continue;
            }
            if configuration.kind == WidgetKind::Tasks {
                let source_freshness = freshness
                    .iter()
                    .find(|entry| entry.source_id == item.calendar_id)
                    .map(|entry| entry.freshness)
                    .unwrap_or(WidgetFreshness::Fresh);
                let Some(input) = task_item_input(
                    item,
                    calendar,
                    &configuration,
                    source_freshness,
                    now,
                    today,
                    horizon_end,
                    time_zone,
                    &appearance.time_format,
                )?
                else {
                    continue;
                };
                if !configuration.display.show_completed && input.completed {
                    continue;
                }
                items.push(input);
                if items.len() >= MAX_SNAPSHOT_ITEMS * 4 {
                    break;
                }
                continue;
            }
            if configuration.kind == WidgetKind::Birthday && item.kind != CalendarItemKind::Birthday
            {
                continue;
            }
            if configuration.kind == WidgetKind::Countdown {
                if item.kind != CalendarItemKind::Event
                    || !countdown_item_is_selected(item, &configuration.selected_item_ids)
                {
                    continue;
                }
            }
            let Some(mut input) = agenda_item_input(
                item,
                calendar,
                now,
                today,
                horizon_end,
                time_zone,
                &appearance.time_format,
            )?
            else {
                continue;
            };
            if configuration.kind == WidgetKind::Month
                && input.day_key.as_deref() != Some(&today.format("%Y-%m-%d").to_string())
            {
                continue;
            }
            if matches!(
                configuration.kind,
                WidgetKind::Birthday | WidgetKind::Countdown
            ) {
                let day = input
                    .day_key
                    .as_deref()
                    .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
                if let Some(day) = day {
                    let days = (day - today).num_days();
                    let countdown = match days {
                        0 => "Today".to_string(),
                        1 => "Tomorrow".to_string(),
                        value => format!("In {value} days"),
                    };
                    input.detail = format!("{countdown} · {}", day.format("%b %-d"));
                    input.title_only_detail = input.detail.clone();
                }
            }
            if !configuration.actions.open_item {
                input.calendar_id = None;
                input.item_id = None;
            }
            if !configuration.display.show_completed && input.completed {
                continue;
            }
            items.push(input);
            if items.len() >= MAX_SNAPSHOT_ITEMS * 4 {
                break;
            }
        }
        let candidate_count = items.len();
        let snapshot_configuration = configuration.clone();
        let mut snapshot = build_snapshot(
            profile_id,
            WidgetBuildRequest {
                configuration,
                generated_at: now.to_rfc3339(),
                date_label: today.format("%Y-%m-%d").to_string(),
                appearance: Some(appearance.clone()),
                freshness: match &sync_rollup {
                    Some((_, accounts, _)) => accounts.clone(),
                    None => freshness.clone(),
                },
                items,
            },
        )?;
        if let Some((_, _, summary)) = sync_rollup {
            // The rollup decides the headline, replacing the generic
            // stale/unavailable phrasing the shared builder produces.
            snapshot.state_label = summary.state.label(&summary);
            snapshot.sync = Some(summary);
        }
        if snapshot.kind == WidgetKind::Month {
            let mut months =
                Vec::with_capacity(usize::from((MAX_MONTH_OFFSET - MIN_MONTH_OFFSET + 1) as u8));
            for offset in MIN_MONTH_OFFSET..=MAX_MONTH_OFFSET {
                let anchor = shift_month(today, i32::from(offset))?;
                let (month_label, days) = month_day_summaries(
                    &projected,
                    &snapshot_configuration,
                    &calendar_by_id,
                    anchor,
                    today,
                    time_zone,
                    appearance.show_declined,
                )?;
                months.push(WidgetMonthPage {
                    offset,
                    month_label,
                    days,
                });
            }
            snapshot.month_label = months
                .iter()
                .find(|month| month.offset == 0)
                .map(|month| month.month_label.clone());
            snapshot.selected_day_key = Some(today.format("%Y-%m-%d").to_string());
            snapshot.months = months;
        }
        let outcome = widget_store.publish(snapshot)?;
        let fresh_sources = outcome
            .snapshot
            .freshness
            .iter()
            .filter(|entry| entry.freshness == WidgetFreshness::Fresh)
            .count() as u32;
        let stale_sources = outcome
            .snapshot
            .freshness
            .iter()
            .filter(|entry| entry.freshness == WidgetFreshness::Stale)
            .count() as u32;
        let unavailable_sources = outcome
            .snapshot
            .freshness
            .iter()
            .filter(|entry| entry.freshness == WidgetFreshness::Unavailable)
            .count() as u32;
        widget_store.write_diagnostics(&WidgetDiagnostics {
            schema_version: WIDGET_SCHEMA_VERSION,
            configuration_id,
            last_attempt_at: now.to_rfc3339(),
            last_success_at: Some(now.to_rfc3339()),
            last_error: None,
            update_cause: update_cause.to_string(),
            generation_duration_ms: generation_started.elapsed().as_millis() as u64,
            serialized_bytes: serde_json::to_vec(&outcome.snapshot)
                .map_err(|_| store_error())?
                .len() as u64,
            item_count: outcome.snapshot.items.len() as u32,
            truncated: candidate_count > max_items,
            fresh_sources,
            stale_sources,
            unavailable_sources,
        })?;
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

/// Applies a launcher-confirmed task completion.
///
/// Every gate the launcher already evaluated is re-checked here against current
/// state, because the snapshot the user tapped may be minutes old: the
/// configuration must still exist and still enable the action, the item must
/// still be an incomplete non-recurring calendar task at the revision that was
/// displayed, and its calendar must still be writable. Only then is the normal
/// calendar pending-operation path used, with an idempotency key derived from
/// the item and revision so a repeated tap or retry cannot queue a second
/// mutation. The caller republishes snapshots afterwards, so the launcher only
/// ever shows state the native queue accepted.
#[cfg(any(target_os = "android", test))]
pub(crate) async fn complete_task(
    config_root: &Path,
    profile_id: &str,
    calendar_store: &CalendarStore,
    request: WidgetTaskCompletionRequest,
    now: DateTime<Utc>,
) -> Result<WidgetTaskCompletionResult, String> {
    validate_identifier(&request.configuration_id, "widget configuration")?;
    validate_identifier(&request.item_id, "widget calendar item")?;
    if !request.confirmed {
        return Err("The task completion was not confirmed.".into());
    }
    if request.expected_revision < 0 {
        return Err("The task revision is invalid.".into());
    }
    let widget_store = WidgetStore::open(config_root, profile_id)?;
    let configuration = widget_store
        .list_configurations()?
        .into_iter()
        .find(|entry| entry.configuration_id == request.configuration_id)
        .ok_or_else(|| "The widget configuration no longer exists.".to_string())?;
    if configuration.kind != WidgetKind::Tasks || !configuration.actions.toggle_task {
        return Err("This widget cannot complete tasks.".into());
    }

    let Some(item) = calendar_store
        .read_item(&request.item_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("The task is no longer available on this device.".into());
    };
    if item.deleted_at.is_some() {
        return Err("The task was deleted.".into());
    }
    if item.kind != CalendarItemKind::Task {
        return Err("Only tasks can be completed from a widget.".into());
    }
    if !configuration.selected_source_ids.is_empty()
        && !configuration
            .selected_source_ids
            .iter()
            .any(|source_id| source_id == &item.calendar_id)
    {
        return Err("The task is not part of this widget.".into());
    }
    if item.revision != request.expected_revision {
        return Err("The task changed since the widget last updated.".into());
    }
    if item.completed_at.is_some()
        || item
            .status
            .as_deref()
            .is_some_and(|status| status == "completed")
    {
        return Ok(WidgetTaskCompletionResult {
            applied: false,
            message: "Already completed.".into(),
        });
    }
    if item.recurrence.is_some() || item.recurrence_id.is_some() {
        return Err("Open Collab to complete a repeating task.".into());
    }
    if matches!(
        item.source_binding,
        Some(collab_calendar::CalendarSourceBinding::Kanban { .. })
    ) {
        return Err("Open Collab to complete a Kanban task.".into());
    }

    let calendar = calendar_store
        .list_calendars()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|calendar| calendar.id == item.calendar_id)
        .ok_or_else(|| "The task's calendar is no longer available.".to_string())?;
    if calendar.archived || calendar.deleted_at.is_some() {
        return Err("The task's calendar is no longer available.".into());
    }
    if calendar.read_only || calendar.location.is_inherently_read_only() {
        return Err("The task's calendar is read only.".into());
    }

    let timestamp = now.to_rfc3339();
    let completed = CalendarItem {
        status: Some("completed".into()),
        completed_at: Some(timestamp.clone()),
        revision: item.revision.saturating_add(1),
        updated_at: timestamp,
        ..item.clone()
    };
    // Deterministic in the item and the revision it was completed from, so a
    // retried JNI call replays into the same already-recorded operation.
    let operation = collab_calendar::CalendarOperation {
        client_operation_id: format!("widget-complete-{}-{}", item.id, item.revision),
        device_id: widget_device_id(config_root)?,
        expected_revision: Some(item.revision),
        source_change_id: None,
        propagation_lineage: Vec::new(),
        mutation: collab_calendar::CalendarMutation::UpsertItem {
            item: completed.clone(),
        },
    };
    calendar_store
        .upsert_item_with_operation(&completed, &operation)
        .await
        .map_err(|error| error.to_string())?;
    if matches!(calendar.location, CalendarLocation::Local { .. }) {
        // Local calendars have no server to acknowledge the queue entry, which
        // matches how the mobile calendar editor persists local writes.
        calendar_store
            .acknowledge_operations(std::slice::from_ref(&operation.client_operation_id))
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(WidgetTaskCompletionResult {
        applied: true,
        message: "Task completed.".into(),
    })
}

#[cfg(any(target_os = "android", test))]
async fn source_freshness(
    calendar: &CalendarDefinition,
    subscriptions: &HashMap<String, collab_calendar::CalendarSubscription>,
    store: &CalendarStore,
    now: DateTime<Utc>,
) -> Result<WidgetFreshness, String> {
    let state = match &calendar.location {
        CalendarLocation::Local { .. } | CalendarLocation::Kanban { .. } => {
            return Ok(WidgetFreshness::Fresh)
        }
        CalendarLocation::Hosted {
            server_url,
            user_id,
        } => {
            let origin = format!("{}::{user_id}", server_url.trim_end_matches('/'));
            store
                .read_sync_state(&origin)
                .await
                .map_err(|error| error.to_string())?
                .map(|state| (state.last_synced_at, state.last_error))
        }
        CalendarLocation::Subscription {
            subscription_id, ..
        } => subscriptions.get(subscription_id).map(|subscription| {
            (
                subscription.last_refreshed_at.clone(),
                subscription.last_error.clone(),
            )
        }),
    };
    let Some((last_synced_at, last_error)) = state else {
        return Ok(WidgetFreshness::Unavailable);
    };
    if last_error.is_some() {
        return Ok(WidgetFreshness::Stale);
    }
    let Some(last_synced_at) = last_synced_at else {
        return Ok(WidgetFreshness::Unavailable);
    };
    let synced_at = DateTime::parse_from_rfc3339(&last_synced_at)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| "A calendar source has an invalid freshness timestamp.".to_string())?;
    Ok(if now - synced_at > Duration::hours(24) {
        WidgetFreshness::Stale
    } else {
        WidgetFreshness::Fresh
    })
}

#[cfg(any(target_os = "android", test))]
fn agenda_item_input(
    item: &CalendarItem,
    calendar: &CalendarDefinition,
    now: DateTime<Utc>,
    today: NaiveDate,
    horizon_end: NaiveDate,
    time_zone: chrono_tz::Tz,
    time_format: &str,
) -> Result<Option<WidgetItemInput>, String> {
    let time_value = match item.kind {
        CalendarItemKind::Event => item.start.as_ref(),
        CalendarItemKind::Task => item.due.as_ref().or(item.start.as_ref()),
        CalendarItemKind::Birthday => None,
    };
    let (instant, mut day, all_day) = if item.kind == CalendarItemKind::Birthday {
        let Some(date) = item.date.as_deref() else {
            return Ok(None);
        };
        let birthday = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "A birthday has an invalid date.".to_string())?;
        let Some(projected) =
            NaiveDate::from_ymd_opt(today.year(), birthday.month(), birthday.day())
                .or_else(|| NaiveDate::from_ymd_opt(today.year(), birthday.month(), 28))
        else {
            return Ok(None);
        };
        let projected = if projected < today {
            NaiveDate::from_ymd_opt(today.year() + 1, birthday.month(), birthday.day())
                .or_else(|| NaiveDate::from_ymd_opt(today.year() + 1, birthday.month(), 28))
                .unwrap()
        } else {
            projected
        };
        (local_midnight_utc(time_zone, projected)?, projected, true)
    } else {
        let Some(value) = time_value else {
            return Ok(None);
        };
        match value {
            CalendarTimeValue::Date { date } => {
                let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_err(|_| "A calendar item has an invalid date.".to_string())?;
                (local_midnight_utc(time_zone, day)?, day, true)
            }
            CalendarTimeValue::DateTime { date_time, .. } => {
                let instant = DateTime::parse_from_rfc3339(date_time)
                    .map(|value| value.with_timezone(&Utc))
                    .map_err(|_| "A calendar item has an invalid date-time.".to_string())?;
                (
                    instant,
                    instant.with_timezone(&time_zone).date_naive(),
                    false,
                )
            }
        }
    };
    let completed = item.completed_at.is_some()
        || item
            .status
            .as_deref()
            .is_some_and(|status| status == "completed");
    let section = if item.kind == CalendarItemKind::Task && !completed && instant < now {
        day = today;
        WidgetAgendaSection::Overdue
    } else if day <= today {
        day = today;
        WidgetAgendaSection::Today
    } else if day <= horizon_end {
        WidgetAgendaSection::Upcoming
    } else {
        return Ok(None);
    };
    let time_detail = if all_day {
        "All day".to_string()
    } else {
        let local = instant.with_timezone(&time_zone);
        match time_format {
            "12-hour" => local.format("%-I:%M %p").to_string(),
            _ => local.format("%H:%M").to_string(),
        }
    };
    let kind = match item.kind {
        CalendarItemKind::Event => WidgetAgendaItemKind::Event,
        CalendarItemKind::Task => WidgetAgendaItemKind::Task,
        CalendarItemKind::Birthday => WidgetAgendaItemKind::Birthday,
    };
    let kind_label = match item.kind {
        CalendarItemKind::Event => "Event",
        CalendarItemKind::Task => "Task",
        CalendarItemKind::Birthday => "Birthday",
    };
    let section_order = match section {
        WidgetAgendaSection::Overdue => 0,
        WidgetAgendaSection::Today => 1,
        WidgetAgendaSection::Upcoming => 2,
    };
    Ok(Some(WidgetItemInput {
        stable_id: item.id.clone(),
        source_id: item.calendar_id.clone(),
        sort_key: format!("{section_order}:{}:{}", instant.to_rfc3339(), item.id),
        title: item.title.clone(),
        detail: format!("{time_detail} · {} · {kind_label}", calendar.name),
        title_only_detail: time_detail,
        private_title: match item.kind {
            CalendarItemKind::Event => "Private event".into(),
            CalendarItemKind::Task => "Private task".into(),
            CalendarItemKind::Birthday => "Private birthday".into(),
        },
        completed,
        section: Some(section),
        item_kind: Some(kind),
        calendar_id: Some(item.calendar_id.clone()),
        item_id: Some(item.id.clone()),
        day_key: Some(day.format("%Y-%m-%d").to_string()),
        start_at: Some(instant.to_rfc3339()),
        all_day,
        source_color: Some(calendar.color.clone()),
        task: None,
        shortcut: None,
    }))
}

/// Projects one calendar or Kanban-assigned task into the shared task row used
/// by the tasks widget. Unlike the agenda projection this keeps tasks that have
/// no due date, and it decides the completion capability in Rust so the
/// launcher can never offer an action the app would reject.
#[cfg(any(target_os = "android", test))]
#[allow(clippy::too_many_arguments)]
fn task_item_input(
    item: &CalendarItem,
    calendar: &CalendarDefinition,
    configuration: &WidgetConfiguration,
    source_freshness: WidgetFreshness,
    now: DateTime<Utc>,
    today: NaiveDate,
    horizon_end: NaiveDate,
    time_zone: chrono_tz::Tz,
    time_format: &str,
) -> Result<Option<WidgetItemInput>, String> {
    if item.kind != CalendarItemKind::Task {
        return Ok(None);
    }
    let kanban_binding = match &item.source_binding {
        Some(collab_calendar::CalendarSourceBinding::Kanban {
            vault_id,
            file_id,
            card_id,
            ..
        }) => Some((vault_id.clone(), file_id.clone(), card_id.clone())),
        _ => None,
    };
    let source = if kanban_binding.is_some() || matches!(calendar.location, CalendarLocation::Kanban { .. }) {
        WidgetTaskSource::Kanban
    } else {
        WidgetTaskSource::Calendar
    };
    match source {
        WidgetTaskSource::Kanban if !configuration.tasks.include_kanban_tasks => {
            return Ok(None)
        }
        WidgetTaskSource::Calendar if !configuration.tasks.include_calendar_tasks => {
            return Ok(None)
        }
        _ => {}
    }
    if !configuration.tasks.selected_board_ids.is_empty() {
        let board_id = kanban_binding.as_ref().map(|(_, file_id, _)| file_id);
        match board_id {
            Some(board_id)
                if configuration
                    .tasks
                    .selected_board_ids
                    .iter()
                    .any(|selected| selected == board_id) => {}
            Some(_) => return Ok(None),
            // A board filter is a Kanban filter; calendar tasks are governed by
            // the calendar selection instead.
            None if source == WidgetTaskSource::Kanban => return Ok(None),
            None => {}
        }
    }

    let completed = item.completed_at.is_some()
        || item
            .status
            .as_deref()
            .is_some_and(|status| status == "completed");
    let time_value = item.due.as_ref().or(item.start.as_ref());
    let scheduled = match time_value {
        None => None,
        Some(CalendarTimeValue::Date { date }) => {
            let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| "A calendar task has an invalid date.".to_string())?;
            Some((local_midnight_utc(time_zone, day)?, day, true))
        }
        Some(CalendarTimeValue::DateTime { date_time, .. }) => {
            let instant = DateTime::parse_from_rfc3339(date_time)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| "A calendar task has an invalid date-time.".to_string())?;
            Some((
                instant,
                instant.with_timezone(&time_zone).date_naive(),
                false,
            ))
        }
    };
    let (due, day, all_day, instant) = match scheduled {
        None => {
            if !configuration.tasks.include_undated {
                return Ok(None);
            }
            (WidgetTaskDue::Unscheduled, None, false, None)
        }
        Some((instant, day, all_day)) => {
            // An all-day task is due for the whole day, so it only becomes
            // overdue once that day has passed; a timed task is overdue the
            // moment its due instant does.
            let passed = if all_day { day < today } else { instant < now };
            let due = if !completed && passed {
                WidgetTaskDue::Overdue
            } else if day <= today {
                WidgetTaskDue::Today
            } else if day <= horizon_end {
                WidgetTaskDue::Upcoming
            } else {
                return Ok(None);
            };
            (due, Some(day), all_day, Some(instant))
        }
    };

    let completion = if !configuration.actions.toggle_task || completed {
        WidgetTaskCompletion::Unavailable
    } else if source == WidgetTaskSource::Kanban {
        // Kanban completion needs the hosted card write-through, which requires
        // the authenticated app; the launcher process must never make it.
        WidgetTaskCompletion::ConfirmInApp
    } else if calendar.read_only || calendar.location.is_inherently_read_only() {
        WidgetTaskCompletion::Unavailable
    } else if item.recurrence.is_some() || item.recurrence_id.is_some() {
        // Completing an occurrence is a scope decision the user makes in the app.
        WidgetTaskCompletion::ConfirmInApp
    } else if source_freshness == WidgetFreshness::Unavailable {
        WidgetTaskCompletion::ConfirmInApp
    } else {
        WidgetTaskCompletion::Available
    };

    let due_label = match (due, all_day, instant) {
        (WidgetTaskDue::Unscheduled, _, _) => "No due date".to_string(),
        (_, true, _) => day
            .map(|day| day.format("%b %-d").to_string())
            .unwrap_or_else(|| "All day".into()),
        (_, false, Some(instant)) => {
            let local = instant.with_timezone(&time_zone);
            match time_format {
                "12-hour" => local.format("%b %-d, %-I:%M %p").to_string(),
                _ => local.format("%b %-d, %H:%M").to_string(),
            }
        }
        (_, false, None) => "No due date".to_string(),
    };
    let due_order = match due {
        WidgetTaskDue::Overdue => 0,
        WidgetTaskDue::Today => 1,
        WidgetTaskDue::Upcoming => 2,
        WidgetTaskDue::Unscheduled => 3,
    };
    let section = match due {
        WidgetTaskDue::Overdue => Some(WidgetAgendaSection::Overdue),
        WidgetTaskDue::Today => Some(WidgetAgendaSection::Today),
        WidgetTaskDue::Upcoming => Some(WidgetAgendaSection::Upcoming),
        WidgetTaskDue::Unscheduled => None,
    };
    // Unscheduled tasks sort after every dated one, deterministically by id.
    let sort_instant = instant
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| "9999".into());
    Ok(Some(WidgetItemInput {
        stable_id: item.id.clone(),
        source_id: item.calendar_id.clone(),
        sort_key: format!("{due_order}:{sort_instant}:{}", item.id),
        title: item.title.clone(),
        detail: format!("{due_label} · {}", calendar.name),
        title_only_detail: due_label,
        private_title: "Private task".into(),
        completed,
        section,
        item_kind: Some(WidgetAgendaItemKind::Task),
        calendar_id: configuration
            .actions
            .open_item
            .then(|| item.calendar_id.clone()),
        item_id: configuration.actions.open_item.then(|| item.id.clone()),
        day_key: day.map(|day| day.format("%Y-%m-%d").to_string()),
        start_at: instant.map(|value| value.to_rfc3339()),
        all_day,
        source_color: Some(calendar.color.clone()),
        task: Some(WidgetTaskDetails {
            source,
            due,
            completion,
            revision: item.revision.max(0),
            vault_id: kanban_binding
                .as_ref()
                .and_then(|(vault_id, _, _)| vault_id.clone())
                .filter(|value| validate_identifier(value, "vault").is_ok()),
            file_id: kanban_binding
                .as_ref()
                .map(|(_, file_id, _)| file_id.clone())
                .filter(|value| validate_identifier(value, "file").is_ok()),
            card_id: kanban_binding
                .as_ref()
                .map(|(_, _, card_id)| card_id.clone())
                .filter(|value| validate_identifier(value, "card").is_ok()),
        }),
        shortcut: None,
    }))
}

/// One resolvable vault entry gathered from the native replica inventory.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone)]
struct ShortcutCandidate {
    vault_id: String,
    vault_name: String,
    file_id: String,
    name: String,
    entry_kind: WidgetEntryKind,
    updated_at: String,
}

/// Reads bounded shortcut candidates from the offline replica manifests.
///
/// This is metadata only — no document body is opened and no network request is
/// made. Entries are filtered at publication time so a trashed, tombstoned, or
/// no-longer-authorized file can never be published to the launcher: a replica
/// the user has lost `vault.read` on contributes nothing at all.
#[cfg(any(target_os = "android", test))]
fn read_shortcut_candidates(config_root: &Path) -> Vec<ShortcutCandidate> {
    let Ok(replicas) = collab_replica::ReplicaStore::list(config_root) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for replica in replicas {
        if !replica
            .capabilities
            .iter()
            .any(|capability| capability == "vault.read")
        {
            continue;
        }
        let Some(store) = collab_replica::ReplicaStore::open_existing(
            config_root,
            &replica.server_url,
            &replica.vault_id,
        ) else {
            continue;
        };
        let Ok(Some(manifest)) = store.read_manifest() else {
            continue;
        };
        for entry in manifest.files {
            if entry.state != collab_protocol::HostedFileState::Active {
                continue;
            }
            if validate_identifier(&replica.vault_id, "vault").is_err()
                || validate_identifier(&entry.id, "file").is_err()
            {
                continue;
            }
            candidates.push(ShortcutCandidate {
                vault_id: replica.vault_id.clone(),
                vault_name: replica.vault_name.clone(),
                file_id: entry.id.clone(),
                name: entry.name.clone(),
                entry_kind: entry_kind_for(&entry),
                updated_at: entry.updated_at.clone(),
            });
            if candidates.len() >= MAX_SHORTCUT_CANDIDATES {
                return candidates;
            }
        }
    }
    candidates
}

#[cfg(any(target_os = "android", test))]
fn entry_kind_for(entry: &collab_protocol::HostedFileEntry) -> WidgetEntryKind {
    use collab_protocol::{HostedDocumentType, HostedFileKind};
    match entry.kind {
        HostedFileKind::Folder => WidgetEntryKind::Folder,
        HostedFileKind::Document => match entry.document_type {
            Some(HostedDocumentType::Note) => WidgetEntryKind::Note,
            Some(HostedDocumentType::Kanban) => WidgetEntryKind::Board,
            Some(HostedDocumentType::Canvas) => WidgetEntryKind::Canvas,
            Some(HostedDocumentType::Sheet) => WidgetEntryKind::Sheet,
            None => WidgetEntryKind::File,
        },
        HostedFileKind::Asset => {
            if entry.name.to_ascii_lowercase().ends_with(".pdf") {
                WidgetEntryKind::Pdf
            } else {
                WidgetEntryKind::File
            }
        }
    }
}

/// Builds the quick-capture tiles. Labels are fixed app strings that contain no
/// user content, so they read the same at every privacy level.
#[cfg(any(target_os = "android", test))]
fn capture_item_inputs(configuration: &WidgetConfiguration) -> Vec<WidgetItemInput> {
    configuration
        .capture
        .actions
        .iter()
        .enumerate()
        .map(|(index, action)| WidgetItemInput {
            stable_id: action.destination().into(),
            source_id: "capture".into(),
            sort_key: format!("{index:02}"),
            title: action.label().into(),
            detail: action.detail().into(),
            title_only_detail: action.detail().into(),
            private_title: action.label().into(),
            completed: false,
            section: None,
            item_kind: None,
            calendar_id: None,
            item_id: None,
            day_key: None,
            start_at: None,
            all_day: false,
            source_color: None,
            task: None,
            shortcut: Some(WidgetShortcutDetails {
                destination: action.destination().into(),
                vault_id: None,
                file_id: None,
                entry_kind: None,
                pinned: false,
            }),
        })
        .collect()
}

/// Builds vault shortcut rows: every resolvable pin first, in the order the
/// user pinned them, then the most recently updated remaining entries.
#[cfg(any(target_os = "android", test))]
fn shortcut_item_inputs(
    configuration: &WidgetConfiguration,
    candidates: &[ShortcutCandidate],
) -> Vec<WidgetItemInput> {
    let mut rows = Vec::new();
    let mut used = HashSet::new();
    for pin in &configuration.shortcuts.pinned {
        // An unresolved pin is dropped rather than published: the target is
        // trashed, removed, or no longer authorized on this device.
        let Some(candidate) = candidates
            .iter()
            .find(|entry| entry.vault_id == pin.vault_id && entry.file_id == pin.file_id)
        else {
            continue;
        };
        used.insert((candidate.vault_id.clone(), candidate.file_id.clone()));
        rows.push(shortcut_row(candidate, true, rows.len()));
    }
    if configuration.shortcuts.include_recent {
        let mut recent = candidates
            .iter()
            .filter(|candidate| {
                !used.contains(&(candidate.vault_id.clone(), candidate.file_id.clone()))
            })
            .collect::<Vec<_>>();
        recent.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.file_id.cmp(&right.file_id))
        });
        for candidate in recent
            .into_iter()
            .take(usize::from(configuration.display.max_items))
        {
            rows.push(shortcut_row(candidate, false, rows.len()));
        }
    }
    rows
}

#[cfg(any(target_os = "android", test))]
fn shortcut_row(candidate: &ShortcutCandidate, pinned: bool, order: usize) -> WidgetItemInput {
    let destination = if candidate.entry_kind == WidgetEntryKind::Folder {
        "vault-folder"
    } else {
        "vault-file"
    };
    let kind_label = candidate.entry_kind.private_label();
    WidgetItemInput {
        stable_id: format!("{}:{}", candidate.vault_id, candidate.file_id),
        source_id: candidate.vault_id.clone(),
        // Pins keep their configured order ahead of every recent entry.
        sort_key: format!("{}:{order:03}", if pinned { 0 } else { 1 }),
        title: truncate_utf8(&candidate.name, MAX_TEXT_BYTES),
        detail: format!("{kind_label} · {}", truncate_utf8(&candidate.vault_name, 64)),
        // Title-only drops the vault (account) detail but keeps the type.
        title_only_detail: kind_label.into(),
        private_title: kind_label.into(),
        completed: false,
        section: None,
        item_kind: None,
        calendar_id: None,
        item_id: None,
        day_key: None,
        start_at: None,
        all_day: false,
        source_color: None,
        task: None,
        shortcut: Some(WidgetShortcutDetails {
            destination: destination.into(),
            vault_id: Some(candidate.vault_id.clone()),
            file_id: Some(candidate.file_id.clone()),
            entry_kind: Some(candidate.entry_kind),
            pinned,
        }),
    }
}

/// One hosted account a sync widget can be scoped to.
///
/// `account_id` is the opaque identity used in widget configurations and
/// snapshots. `label` is the server URL and exists only so the in-app settings
/// screen can name the account the user is choosing; it must never be written
/// into a snapshot or any launcher-readable storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSyncAccount {
    pub account_id: String,
    pub label: String,
    pub vaults: u32,
}

/// Lists the accounts a sync widget could be scoped to: every registered server
/// plus every server an offline replica belongs to, so an account whose
/// registration was dropped is still selectable while its replicas remain.
pub(crate) fn list_sync_accounts(config_root: &Path) -> Result<Vec<WidgetSyncAccount>, String> {
    let mut accounts: Vec<WidgetSyncAccount> = Vec::new();
    let mut record = |server_url: &str, vault: bool| {
        let account_id = account_hash(server_url);
        match accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
        {
            Some(account) => {
                if vault {
                    account.vaults += 1;
                }
            }
            None => accounts.push(WidgetSyncAccount {
                account_id,
                label: server_url.to_string(),
                vaults: u32::from(vault),
            }),
        }
    };
    if let Ok(view) = crate::background::read_ledger_view(config_root) {
        for server in view.servers {
            record(&server.server_url, false);
        }
    }
    // Only identities are needed here, so this must not take the inventory path
    // that counts queued operations — it would decrypt every replica's queue to
    // produce numbers this screen never shows.
    for server_url in collab_replica::ReplicaStore::list_server_urls(config_root).unwrap_or_default()
    {
        record(&server_url, true);
    }
    accounts.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(accounts)
}

/// The opaque identity a sync widget groups and filters accounts by.
///
/// Hashing the server URL lets a configuration select accounts, and lets rows
/// carry their owning account, without the URL ever reaching launcher-readable
/// storage or a widget configuration file.
fn account_hash(server_url: &str) -> String {
    let digest = Sha256::digest(server_url.as_bytes());
    format!("account-{}", hex::encode(&digest[..8]))
}

/// A stable, content-free row identity. The vault id is hashed with its account
/// so the launcher's own preference storage cannot be mined for vault ids.
#[cfg(any(target_os = "android", test))]
fn sync_row_id(account: &str, vault_id: &str) -> String {
    let digest = Sha256::digest(format!("{account}/{vault_id}").as_bytes());
    format!("sync-{}", hex::encode(&digest[..8]))
}

/// How long ago something happened, in the coarse terms the widget shows.
#[cfg(any(target_os = "android", test))]
fn relative_time_label(now: DateTime<Utc>, then: &str) -> Option<String> {
    let parsed = DateTime::parse_from_rfc3339(then).ok()?.with_timezone(&Utc);
    let minutes = (now - parsed).num_minutes();
    Some(match minutes {
        // A clock that has moved backwards must not render a negative age.
        value if value < 1 => "just now".into(),
        value if value < 60 => format!("{value} min ago"),
        value if value < 60 * 24 => format!("{} h ago", value / 60),
        value => format!("{} d ago", value / (60 * 24)),
    })
}

/// Builds the sync widget's rows and its privacy-safe rollup.
///
/// Everything read here is durable local state — the background ledger the
/// coordinator writes, plus the replica queues — so the launcher process makes
/// no network request and starts no webview. Accounts appear only as hashes,
/// and a failure becomes a coarse state rather than a message: the ledger's
/// error text and server URLs never leave this function.
#[cfg(any(target_os = "android", test))]
fn sync_item_inputs(
    config_root: &Path,
    configuration: &WidgetConfiguration,
    now: DateTime<Utc>,
) -> (
    Vec<WidgetItemInput>,
    Vec<WidgetSourceFreshness>,
    WidgetSyncSummary,
) {
    use crate::background::BackgroundJobStatus;
    use collab_replica::models::SyncStatus;

    let view = crate::background::read_ledger_view(config_root).ok();
    let settings = view
        .as_ref()
        .map(|view| view.settings.clone())
        .unwrap_or_default();
    let jobs = view.as_ref().map(|view| view.jobs.as_slice()).unwrap_or(&[]);
    let selected: HashSet<&str> = configuration
        .selected_source_ids
        .iter()
        .map(String::as_str)
        .collect();
    let includes = |account: &str| selected.is_empty() || selected.contains(account);

    // Accounts are every registered server plus every server a replica belongs
    // to, so a vault whose registration was dropped still reports honestly.
    let mut accounts: HashMap<String, AccountRollup> = HashMap::new();
    for server in view.iter().flat_map(|view| view.servers.iter()) {
        let account = account_hash(&server.server_url);
        if includes(&account) {
            accounts.entry(account).or_default();
        }
    }

    let mut summary = WidgetSyncSummary {
        state: WidgetSyncState::UpToDate,
        last_success_at: None,
        last_success_label: None,
        pending_operations: 0,
        failed_operations: 0,
        active_jobs: 0,
        attention_required: 0,
        accounts: 0,
        vaults: 0,
        progress_completed: 0,
        progress_total: None,
        activity_label: None,
        progress_label: None,
        can_sync_now: false,
    };
    let mut progress_total_known = true;
    // The activity line names one thing, so the job furthest along its own work
    // wins: that is the one actually moving, rather than a queued job that has
    // reported nothing yet.
    let mut activity_detail: Option<(u64, String)> = None;
    for job in jobs {
        let account = job.server_url.as_deref().map(account_hash);
        // A job without a server is profile-local maintenance; it still counts
        // toward the rollup unless the user narrowed to specific accounts.
        let counted = match &account {
            Some(account) => includes(account),
            None => selected.is_empty(),
        };
        if !counted {
            continue;
        }
        let entry = account
            .as_ref()
            .map(|account| accounts.entry(account.clone()).or_default());
        match job.status {
            BackgroundJobStatus::Queued | BackgroundJobStatus::Running => {
                summary.active_jobs += 1;
                summary.progress_completed = summary
                    .progress_completed
                    .saturating_add(job.progress.completed);
                match job.progress.total {
                    Some(total) => {
                        summary.progress_total =
                            Some(summary.progress_total.unwrap_or(0).saturating_add(total))
                    }
                    // One unbounded job makes the whole total a guess, so the
                    // launcher is told to render an indeterminate state.
                    None => progress_total_known = false,
                }
                if let Some(detail) = job.progress.detail.as_deref() {
                    let detail = sync_activity_detail(detail);
                    if !detail.is_empty()
                        && activity_detail
                            .as_ref()
                            .is_none_or(|(best, _)| job.progress.completed >= *best)
                    {
                        activity_detail = Some((job.progress.completed, detail));
                    }
                }
                if let Some(entry) = entry {
                    entry.running = true;
                }
            }
            BackgroundJobStatus::Succeeded => {
                if job.finished_at > summary.last_success_at {
                    summary.last_success_at = job.finished_at.clone();
                }
                if let Some(entry) = entry {
                    if job.finished_at > entry.last_success_at {
                        entry.last_success_at = job.finished_at.clone();
                    }
                }
            }
            BackgroundJobStatus::AuthenticationRequired => {
                summary.attention_required += 1;
                if let Some(entry) = entry {
                    entry.authentication_required = true;
                }
            }
            BackgroundJobStatus::Partial
            | BackgroundJobStatus::PermissionDenied
            | BackgroundJobStatus::Conflict
            | BackgroundJobStatus::Failed => {
                summary.attention_required += 1;
                if let Some(entry) = entry {
                    entry.attention_required += 1;
                }
            }
            BackgroundJobStatus::Deferred | BackgroundJobStatus::Cancelled => {}
        }
    }
    if !progress_total_known {
        summary.progress_total = None;
    }

    let mut rows = Vec::new();
    let mut vaults = Vec::new();
    for replica in collab_replica::ReplicaStore::list(config_root).unwrap_or_default() {
        let account = account_hash(&replica.server_url);
        if !includes(&account) {
            continue;
        }
        let entry = accounts.entry(account.clone()).or_default();
        entry.replicas += 1;
        if replica.status == SyncStatus::Offline {
            entry.offline_replicas += 1;
        }
        if replica.status == SyncStatus::Syncing {
            entry.running = true;
        }
        if replica.last_synced_at > entry.last_success_at {
            entry.last_success_at = replica.last_synced_at.clone();
        }
        if replica.last_synced_at > summary.last_success_at {
            summary.last_success_at = replica.last_synced_at.clone();
        }
        // Both counts come from the single inventory pass. Re-opening the
        // replica to count failures again would decrypt and parse every queued
        // payload a second time, and this runs on every widget publication.
        let pending = replica.pending_count.min(u32::MAX as usize) as u32;
        let failed = replica.failed_count.min(u32::MAX as usize) as u32;
        summary.pending_operations = summary.pending_operations.saturating_add(pending);
        summary.failed_operations = summary.failed_operations.saturating_add(failed);
        entry.attention_required += failed;
        vaults.push(SyncVaultRow {
            account,
            vault_id: replica.vault_id,
            name: replica.vault_name,
            pending,
            failed,
            offline: replica.status == SyncStatus::Offline,
            syncing: replica.status == SyncStatus::Syncing,
            last_synced_at: replica.last_synced_at,
        });
    }

    summary.vaults = vaults.len() as u32;
    summary.accounts = accounts.len() as u32;
    summary.can_sync_now = summary.accounts > 0;
    let authentication_required = accounts
        .values()
        .any(|account| account.authentication_required);
    let all_offline = !vaults.is_empty() && vaults.iter().all(|vault| vault.offline);
    summary.state = if authentication_required {
        WidgetSyncState::AuthenticationRequired
    } else if summary.attention_required > 0 || summary.failed_operations > 0 {
        WidgetSyncState::ActionRequired
    } else if summary.active_jobs > 0 || vaults.iter().any(|vault| vault.syncing) {
        WidgetSyncState::Syncing
    } else if all_offline {
        WidgetSyncState::Offline
    } else if settings.paused || !settings.background_sync {
        WidgetSyncState::Paused
    } else if summary.pending_operations > 0 {
        WidgetSyncState::PendingChanges
    } else {
        WidgetSyncState::UpToDate
    };
    summary.last_success_label = summary
        .last_success_at
        .as_deref()
        .and_then(|value| relative_time_label(now, value))
        .map(|value| format!("Synced {value}"));

    // Progress phrasing belongs to a run in flight. Reporting it in any other
    // state would leave the last run's counts frozen on the launcher long after
    // it finished.
    if summary.state == WidgetSyncState::Syncing {
        summary.activity_label = activity_detail
            .map(|(_, detail)| detail)
            .or_else(|| Some("Checking for changes".to_string()));
        summary.progress_label = summary.progress_total.and_then(|total| {
            (total > 0).then(|| {
                let completed = summary.progress_completed.min(total);
                format!("{completed} of {total}")
            })
        });
    }

    // The recovery row is the only launcher affordance for an attention state,
    // and it opens the app rather than attempting a fix in the launcher.
    if summary.state.needs_attention() {
        let destination = if summary.state == WidgetSyncState::AuthenticationRequired {
            "settings-account"
        } else {
            "settings-background"
        };
        let title = if summary.state == WidgetSyncState::AuthenticationRequired {
            "Sign in again"
        } else {
            "Review sync problems"
        };
        let source_id = accounts
            .iter()
            .find(|(_, account)| account.authentication_required || account.attention_required > 0)
            .map(|(id, _)| id.clone())
            .or_else(|| accounts.keys().next().cloned())
            .unwrap_or_else(|| "account-unknown".into());
        rows.push(WidgetItemInput {
            stable_id: "sync-recovery".into(),
            source_id,
            sort_key: "0".into(),
            title: title.into(),
            detail: "Opens Collab settings".into(),
            title_only_detail: "Opens Collab settings".into(),
            private_title: title.into(),
            completed: false,
            section: None,
            item_kind: None,
            calendar_id: None,
            item_id: None,
            day_key: None,
            start_at: None,
            all_day: false,
            source_color: None,
            task: None,
            shortcut: Some(WidgetShortcutDetails {
                destination: destination.into(),
                vault_id: None,
                file_id: None,
                entry_kind: None,
                pinned: false,
            }),
        });
    }

    // Vaults that need something rank above vaults that are simply waiting,
    // which rank above vaults with nothing to report.
    vaults.sort_by(|left, right| {
        right
            .failed
            .cmp(&left.failed)
            .then_with(|| right.pending.cmp(&left.pending))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.vault_id.cmp(&right.vault_id))
    });
    for (order, vault) in vaults.iter().enumerate() {
        rows.push(WidgetItemInput {
            stable_id: sync_row_id(&vault.account, &vault.vault_id),
            source_id: vault.account.clone(),
            sort_key: format!("1:{order:03}"),
            title: truncate_utf8(&vault.name, MAX_TEXT_BYTES),
            detail: sync_row_detail(vault, now),
            title_only_detail: sync_row_detail(vault, now),
            private_title: "Vault".into(),
            completed: false,
            section: None,
            item_kind: None,
            calendar_id: None,
            item_id: None,
            day_key: None,
            start_at: None,
            all_day: false,
            source_color: None,
            task: None,
            // A vault with nothing to recover has no destination of its own and
            // falls back to the widget header. One that does opens the sync
            // settings, where the conflict actually has a recovery UI.
            shortcut: (vault.failed > 0).then(|| WidgetShortcutDetails {
                destination: "settings-background".into(),
                vault_id: None,
                file_id: None,
                entry_kind: None,
                pinned: false,
            }),
        });
    }

    let mut freshness = accounts
        .iter()
        .map(|(account, rollup)| WidgetSourceFreshness {
            source_id: account.clone(),
            freshness: rollup.freshness(),
        })
        .collect::<Vec<_>>();
    freshness.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    (rows, freshness, summary)
}

/// Per-account totals used to derive the rollup and each account's freshness.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Default)]
struct AccountRollup {
    running: bool,
    authentication_required: bool,
    attention_required: u32,
    replicas: u32,
    offline_replicas: u32,
    last_success_at: Option<String>,
}

#[cfg(any(target_os = "android", test))]
impl AccountRollup {
    fn freshness(&self) -> WidgetFreshness {
        if self.authentication_required
            || (self.replicas > 0 && self.offline_replicas == self.replicas)
        {
            WidgetFreshness::Unavailable
        } else if self.attention_required > 0 || self.last_success_at.is_none() {
            WidgetFreshness::Stale
        } else {
            WidgetFreshness::Fresh
        }
    }
}

/// One replica's row in the sync widget.
#[cfg(any(target_os = "android", test))]
struct SyncVaultRow {
    account: String,
    vault_id: String,
    name: String,
    pending: u32,
    failed: u32,
    offline: bool,
    syncing: bool,
    last_synced_at: Option<String>,
}

/// Reduces a background job's progress detail to something a launcher may show.
///
/// The executors report either a vault name or a vault-relative file path.
/// A vault name is already published in this widget's own rows, but a path is
/// not: the directories above a file describe how someone organises their work,
/// and nothing in the widget needs them. Only the last segment survives, and it
/// is bounded like every other published string.
///
/// Anything that could carry an origin is dropped outright rather than trimmed,
/// because a URL's last segment is still part of a URL.
#[cfg(any(target_os = "android", test))]
pub(crate) fn sync_activity_detail(detail: &str) -> String {
    let detail = detail.trim();
    if detail.contains("://") || detail.contains('@') {
        return String::new();
    }
    let last = detail
        .rsplit(['/', '\\'])
        .find(|segment| !segment.trim().is_empty())
        .unwrap_or("")
        .trim();
    truncate_utf8(last, MAX_TEXT_BYTES)
}

/// The row detail. It carries counts and an age only — never a path, a server,
/// or a failure message — so it is identical at every privacy level.
#[cfg(any(target_os = "android", test))]
fn sync_row_detail(vault: &SyncVaultRow, now: DateTime<Utc>) -> String {
    if vault.failed > 0 {
        return match vault.failed {
            1 => "1 change needs attention".into(),
            count => format!("{count} changes need attention"),
        };
    }
    if vault.syncing {
        return "Syncing…".into();
    }
    if vault.pending > 0 {
        let pending = match vault.pending {
            1 => "1 change waiting".to_string(),
            count => format!("{count} changes waiting"),
        };
        return if vault.offline {
            format!("Offline · {pending}")
        } else {
            pending
        };
    }
    match vault
        .last_synced_at
        .as_deref()
        .and_then(|value| relative_time_label(now, value))
    {
        Some(age) if vault.offline => format!("Offline · synced {age}"),
        Some(age) => format!("Synced {age}"),
        None if vault.offline => "Offline".into(),
        None => "Not synced yet".into(),
    }
}

#[cfg(any(target_os = "android", test))]
fn countdown_item_is_selected(item: &CalendarItem, selected_item_ids: &[String]) -> bool {
    selected_item_ids.iter().any(|selected| {
        selected == &item.id
            || item
                .recurrence_series_id
                .as_deref()
                .is_some_and(|series_id| series_id == selected)
    })
}

#[cfg(any(target_os = "android", test))]
fn month_day_summaries(
    items: &[CalendarItem],
    configuration: &WidgetConfiguration,
    calendar_by_id: &HashMap<&str, &CalendarDefinition>,
    month_anchor: NaiveDate,
    actual_today: NaiveDate,
    time_zone: chrono_tz::Tz,
    show_declined: bool,
) -> Result<(String, Vec<WidgetDaySummary>), String> {
    let month_start = month_anchor
        .with_day(1)
        .ok_or_else(|| "The widget month boundary is invalid.".to_string())?;
    let grid_start =
        month_start - Duration::days(i64::from(month_start.weekday().num_days_from_monday()));
    let grid_end = grid_start + Duration::days(MAX_SNAPSHOT_DAYS as i64);
    let selected_sources = configuration
        .selected_source_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut summaries = (0..MAX_SNAPSHOT_DAYS)
        .map(|offset| {
            let day = grid_start + Duration::days(offset as i64);
            WidgetDaySummary {
                day_key: day.format("%Y-%m-%d").to_string(),
                count: 0,
                colors: Vec::new(),
                items: Vec::new(),
                in_month: day.year() == month_start.year() && day.month() == month_start.month(),
                is_today: day == actual_today,
            }
        })
        .collect::<Vec<_>>();
    let mut segments: Vec<MonthSegment> = Vec::new();
    for item in items {
        if !selected_sources.is_empty() && !selected_sources.contains(item.calendar_id.as_str()) {
            continue;
        }
        let Some(calendar) = calendar_by_id.get(item.calendar_id.as_str()).copied() else {
            continue;
        };
        if !show_declined && is_declined_for_calendar(item, calendar) {
            continue;
        }
        let Some((start, end)) = calendar_item_day_span(item, month_anchor, time_zone)? else {
            continue;
        };
        let first = start.max(grid_start);
        let last = end.min(grid_end - Duration::days(1));
        if first > last {
            continue;
        }
        let first_offset = (first - grid_start).num_days() as usize;
        let last_offset = (last - grid_start).num_days() as usize;
        for offset in first_offset..=last_offset {
            let Some(summary) = summaries.get_mut(offset) else {
                continue;
            };
            summary.count = summary.count.saturating_add(1);
            if configuration.privacy == WidgetPrivacy::Full
                && summary.colors.len() < 3
                && !summary.colors.iter().any(|color| color == &calendar.color)
            {
                summary.colors.push(calendar.color.clone());
            }
        }
        let title = match configuration.privacy {
            WidgetPrivacy::Full | WidgetPrivacy::TitleOnly => &item.title,
            WidgetPrivacy::Private => match item.kind {
                CalendarItemKind::Event => "Private event",
                CalendarItemKind::Task => "Private task",
                CalendarItemKind::Birthday => "Private birthday",
            },
        };
        segments.extend(week_row_segments(
            first_offset,
            last_offset,
            // The entry itself may reach past the rendered grid, which is a
            // continuation the launcher should mark even though no further
            // week row exists to carry it.
            start < grid_start,
            end > grid_end - Duration::days(1),
            truncate_utf8(title, MAX_MONTH_ITEM_TITLE_BYTES),
            (configuration.privacy == WidgetPrivacy::Full).then(|| calendar.color.clone()),
        ));
    }
    assign_month_lanes(segments, &mut summaries);
    Ok((month_start.format("%B %Y").to_string(), summaries))
}

#[cfg(any(target_os = "android", test))]
/// One bar segment before a lane has been chosen for it.
struct MonthSegment {
    week: usize,
    column: usize,
    span: usize,
    continues_before: bool,
    continues_after: bool,
    title: String,
    color: Option<String>,
}

#[cfg(any(target_os = "android", test))]
/// Splits a day range into one segment per week row it crosses, because a bar
/// can only be drawn across a single row of the grid.
fn week_row_segments(
    first_offset: usize,
    last_offset: usize,
    clipped_before: bool,
    clipped_after: bool,
    title: String,
    color: Option<String>,
) -> Vec<MonthSegment> {
    let mut segments = Vec::new();
    let mut offset = first_offset;
    while offset <= last_offset {
        let week = offset / 7;
        let row_end = (week * 7 + 6).min(last_offset);
        segments.push(MonthSegment {
            week,
            column: offset % 7,
            span: row_end - offset + 1,
            continues_before: offset > first_offset || clipped_before,
            continues_after: row_end < last_offset || clipped_after,
            title: title.clone(),
            color: color.clone(),
        });
        offset = row_end + 1;
    }
    segments
}

#[cfg(any(target_os = "android", test))]
/// Packs each week row's segments into stacked lanes and records them on the
/// day each segment starts.
///
/// Longest-first ordering keeps the bars that carry the most meaning in the
/// top lanes, so the ones dropped when a widget is too short to show every
/// lane are always the shortest. Ties fall back to position and title so the
/// same month renders identically on every refresh.
fn assign_month_lanes(mut segments: Vec<MonthSegment>, summaries: &mut [WidgetDaySummary]) {
    segments.sort_by(|left, right| {
        left.week
            .cmp(&right.week)
            .then(right.span.cmp(&left.span))
            .then(left.column.cmp(&right.column))
            .then_with(|| left.title.cmp(&right.title))
    });
    // Occupied columns per lane, reset at every week row.
    let mut lanes = [[false; 7]; MAX_MONTH_LANES];
    let mut current_week = usize::MAX;
    for segment in segments {
        if segment.week != current_week {
            lanes = [[false; 7]; MAX_MONTH_LANES];
            current_week = segment.week;
        }
        let columns = segment.column..segment.column + segment.span;
        let Some(lane) = lanes
            .iter()
            .position(|lane| columns.clone().all(|column| !lane[column]))
        else {
            // Every lane is taken for this span; the day's `count` still
            // reports the entry, so nothing is silently lost.
            continue;
        };
        for column in columns {
            lanes[lane][column] = true;
        }
        let Some(summary) = summaries.get_mut(segment.week * 7 + segment.column) else {
            continue;
        };
        summary.items.push(WidgetDayItem {
            title: segment.title,
            color: segment.color,
            span: segment.span as u8,
            lane: lane as u8,
            continues_before: segment.continues_before,
            continues_after: segment.continues_after,
        });
    }
}

#[cfg(any(target_os = "android", test))]
fn shift_month(date: NaiveDate, offset: i32) -> Result<NaiveDate, String> {
    let total_months = date
        .year()
        .checked_mul(12)
        .and_then(|value| value.checked_add(date.month0() as i32))
        .and_then(|value| value.checked_add(offset))
        .ok_or_else(|| "The widget month offset is invalid.".to_string())?;
    let year = total_months.div_euclid(12);
    let month = total_months.rem_euclid(12) as u32 + 1;
    NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| "The widget month offset is invalid.".to_string())
}

#[cfg(any(target_os = "android", test))]
fn calendar_item_day_span(
    item: &CalendarItem,
    today: NaiveDate,
    time_zone: chrono_tz::Tz,
) -> Result<Option<(NaiveDate, NaiveDate)>, String> {
    if item.kind == CalendarItemKind::Birthday {
        let Some(value) = item.date.as_deref() else {
            return Ok(None);
        };
        let birthday = NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| "A birthday has an invalid date.".to_string())?;
        let day = NaiveDate::from_ymd_opt(today.year(), birthday.month(), birthday.day())
            .or_else(|| NaiveDate::from_ymd_opt(today.year(), birthday.month(), 28));
        return Ok(day.map(|value| (value, value)));
    }
    let start_value = match item.kind {
        CalendarItemKind::Event => item.start.as_ref(),
        CalendarItemKind::Task => item.due.as_ref().or(item.start.as_ref()),
        CalendarItemKind::Birthday => None,
    };
    let Some(start_value) = start_value else {
        return Ok(None);
    };
    let start = calendar_time_day(start_value, time_zone)?;
    let end = match item.end.as_ref() {
        Some(CalendarTimeValue::Date { date }) => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "A calendar item has an invalid end date.".to_string())?
            .pred_opt()
            .unwrap_or(start),
        Some(value) => calendar_time_day(value, time_zone)?,
        None => start,
    };
    Ok(Some((start, end.max(start))))
}

#[cfg(any(target_os = "android", test))]
fn calendar_time_day(
    value: &CalendarTimeValue,
    time_zone: chrono_tz::Tz,
) -> Result<NaiveDate, String> {
    match value {
        CalendarTimeValue::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "A calendar item has an invalid date.".to_string()),
        CalendarTimeValue::DateTime { date_time, .. } => DateTime::parse_from_rfc3339(date_time)
            .map(|value| value.with_timezone(&time_zone).date_naive())
            .map_err(|_| "A calendar item has an invalid date-time.".to_string()),
    }
}

#[cfg(any(target_os = "android", test))]
fn is_declined_for_calendar(item: &CalendarItem, calendar: &CalendarDefinition) -> bool {
    let CalendarLocation::Hosted {
        server_url,
        user_id,
    } = &calendar.location
    else {
        return false;
    };
    item.attendees.iter().any(|attendee| {
        matches!(
            attendee,
            CalendarAttendee::CollabUser {
                server_url: attendee_server,
                user_id: attendee_user,
                response,
                ..
            } if attendee_server.trim_end_matches('/') == server_url.trim_end_matches('/')
                && attendee_user == user_id
                && response == "declined"
        )
    })
}

#[cfg(any(target_os = "android", test))]
fn local_midnight_utc(time_zone: chrono_tz::Tz, date: NaiveDate) -> Result<DateTime<Utc>, String> {
    let local = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "The widget date boundary is invalid.".to_string())?;
    match time_zone.from_local_datetime(&local) {
        LocalResult::Single(value) | LocalResult::Ambiguous(value, _) => {
            Ok(value.with_timezone(&Utc))
        }
        LocalResult::None => {
            Err("The widget date boundary does not exist in its time zone.".into())
        }
    }
}

fn reduce_item(item: WidgetItemInput, privacy: WidgetPrivacy) -> WidgetSnapshotItem {
    let source_color = if privacy == WidgetPrivacy::Full {
        item.source_color
    } else {
        None
    };
    let metadata = (
        item.section,
        item.item_kind,
        item.calendar_id,
        item.item_id,
        item.day_key,
        item.start_at,
        item.all_day,
        source_color,
        item.task,
        item.shortcut,
    );
    let (title, detail) = match privacy {
        WidgetPrivacy::Full => (item.title, item.detail),
        WidgetPrivacy::TitleOnly => (item.title, item.title_only_detail),
        WidgetPrivacy::Private => (item.private_title, item.title_only_detail),
    };
    let (
        section,
        item_kind,
        calendar_id,
        item_id,
        day_key,
        start_at,
        all_day,
        source_color,
        task,
        shortcut,
    ) = metadata;
    WidgetSnapshotItem {
        stable_id: item.stable_id,
        title,
        detail,
        section,
        item_kind,
        calendar_id,
        item_id,
        day_key,
        start_at,
        all_day,
        source_color,
        task,
        shortcut,
    }
}

fn validate_configuration(configuration: &WidgetConfiguration) -> Result<(), String> {
    if configuration.schema_version != WIDGET_SCHEMA_VERSION {
        return Err("The widget configuration uses an unsupported schema.".into());
    }
    validate_identifier(&configuration.configuration_id, "widget configuration")?;
    validate_text(
        &configuration.updated_at,
        MAX_TEXT_BYTES,
        "widget update time",
    )?;
    if configuration.selected_source_ids.len() > MAX_SOURCE_IDS {
        return Err("Too many widget sources were selected.".into());
    }
    let mut unique = HashSet::new();
    for source_id in &configuration.selected_source_ids {
        validate_identifier(source_id, "widget source")?;
        if !unique.insert(source_id) {
            return Err("A widget source was selected more than once.".into());
        }
    }
    if configuration.selected_item_ids.len() > MAX_SNAPSHOT_ITEMS {
        return Err("Too many countdown events were selected.".into());
    }
    let mut unique_items = HashSet::new();
    for item_id in &configuration.selected_item_ids {
        validate_identifier(item_id, "widget item")?;
        if !unique_items.insert(item_id) {
            return Err("A countdown event was selected more than once.".into());
        }
    }
    if configuration.tasks.selected_board_ids.len() > MAX_SOURCE_IDS {
        return Err("Too many Kanban boards were selected.".into());
    }
    let mut unique_boards = HashSet::new();
    for board_id in &configuration.tasks.selected_board_ids {
        validate_text(board_id, MAX_ID_BYTES, "widget Kanban board")?;
        if !unique_boards.insert(board_id) {
            return Err("A Kanban board was selected more than once.".into());
        }
    }
    if configuration.capture.actions.len() > MAX_CAPTURE_ACTIONS {
        return Err("Too many quick capture actions were selected.".into());
    }
    let mut unique_actions = HashSet::new();
    for action in &configuration.capture.actions {
        if !unique_actions.insert(*action) {
            return Err("A quick capture action was selected more than once.".into());
        }
    }
    if configuration.shortcuts.pinned.len() > MAX_PINNED_SHORTCUTS {
        return Err("Too many shortcuts were pinned.".into());
    }
    let mut unique_pins = HashSet::new();
    for pin in &configuration.shortcuts.pinned {
        validate_identifier(&pin.vault_id, "widget vault")?;
        validate_identifier(&pin.file_id, "widget file")?;
        if !unique_pins.insert((&pin.vault_id, &pin.file_id)) {
            return Err("A shortcut was pinned more than once.".into());
        }
    }
    let max_horizon = match configuration.kind {
        WidgetKind::Agenda => 31,
        WidgetKind::Month => 42,
        WidgetKind::Tasks => 90,
        // Capture and shortcut widgets are not time-ranged; the horizon is
        // carried only so one configuration shape covers every kind.
        WidgetKind::Capture | WidgetKind::Shortcuts | WidgetKind::Sync => 366,
        WidgetKind::Birthday | WidgetKind::Countdown => 366,
    };
    if !(1..=max_horizon).contains(&configuration.display.horizon_days) {
        return Err(format!(
            "Widget horizon must be between 1 and {max_horizon} days."
        ));
    }
    if !(1..=MAX_SNAPSHOT_ITEMS as u8).contains(&configuration.display.max_items) {
        return Err(format!(
            "Widget item limit must be between 1 and {MAX_SNAPSHOT_ITEMS}."
        ));
    }
    Ok(())
}

fn validate_appearance(appearance: &WidgetAppearanceSnapshot) -> Result<(), String> {
    if appearance.schema_version != WIDGET_SCHEMA_VERSION
        || !matches!(
            appearance.theme.as_str(),
            "dark" | "midnight" | "warm" | "light"
        )
        || !matches!(
            appearance.accent.as_str(),
            "violet" | "blue" | "emerald" | "rose" | "orange" | "cyan"
        )
        || !appearance.font_scale.is_finite()
        || !(0.85..=1.3).contains(&appearance.font_scale)
        || appearance.time_zone.parse::<chrono_tz::Tz>().is_err()
        || !matches!(
            appearance.time_format.as_str(),
            "system" | "12-hour" | "24-hour"
        )
    {
        return Err("The widget appearance settings are invalid.".into());
    }
    Ok(())
}

fn validate_snapshot(snapshot: &WidgetSnapshot, expected_profile_hash: &str) -> Result<(), String> {
    if snapshot.schema_version != WIDGET_SCHEMA_VERSION
        || snapshot.profile_id_hash != expected_profile_hash
    {
        return Err("The widget snapshot does not belong to this profile.".into());
    }
    validate_identifier(&snapshot.configuration_id, "widget configuration")?;
    validate_text(&snapshot.generated_at, MAX_TEXT_BYTES, "generation time")?;
    validate_text(&snapshot.date_label, MAX_TEXT_BYTES, "date label")?;
    validate_text(&snapshot.state_label, MAX_TEXT_BYTES, "state label")?;
    if !matches!(
        snapshot.theme.as_str(),
        "dark" | "midnight" | "warm" | "light"
    ) || !matches!(
        snapshot.accent.as_str(),
        "violet" | "blue" | "emerald" | "rose" | "orange" | "cyan"
    ) || !snapshot.font_scale.is_finite()
        || !(0.85..=1.3).contains(&snapshot.font_scale)
    {
        return Err("The widget snapshot appearance is invalid.".into());
    }
    if snapshot.items.len() > MAX_SNAPSHOT_ITEMS || snapshot.freshness.len() > MAX_SOURCE_IDS {
        return Err("The widget snapshot exceeds its item limit.".into());
    }
    if snapshot.days.len() > MAX_SNAPSHOT_DAYS {
        return Err("The widget snapshot exceeds its day-summary limit.".into());
    }
    if snapshot.sync.is_some() && snapshot.kind != WidgetKind::Sync {
        return Err("Only a sync widget may carry a synchronization rollup.".into());
    }
    if let Some(sync) = &snapshot.sync {
        if let Some(value) = &sync.last_success_at {
            validate_text(value, MAX_TEXT_BYTES, "widget sync time")?;
        }
        if let Some(value) = &sync.activity_label {
            validate_text(value, MAX_TEXT_BYTES, "widget sync activity")?;
            // The activity line is derived from a job's progress detail, which
            // is the one published string with a path or an origin anywhere
            // upstream of it. Re-check the reduction here, at the boundary that
            // writes launcher-readable state.
            if value.contains("://")
                || value.contains('@')
                || value.contains('/')
                || value.contains('\\')
            {
                return Err("The widget sync activity is not privacy-reduced.".into());
            }
        }
        if let Some(value) = &sync.progress_label {
            validate_text(value, MAX_TEXT_BYTES, "widget sync progress")?;
        }
        // A total below what has already completed would render as a progress
        // bar running past its own end.
        if sync
            .progress_total
            .is_some_and(|total| total < sync.progress_completed)
        {
            return Err("The widget sync progress is inconsistent.".into());
        }
    }
    if let Some(value) = &snapshot.month_label {
        validate_text(value, MAX_TEXT_BYTES, "widget month label")?;
    }
    if let Some(value) = &snapshot.selected_day_key {
        validate_text(value, MAX_TEXT_BYTES, "widget selected day")?;
    }
    validate_widget_days(&snapshot.days)?;
    if snapshot.months.len() > usize::from((MAX_MONTH_OFFSET - MIN_MONTH_OFFSET + 1) as u8) {
        return Err("The widget snapshot contains too many month pages.".into());
    }
    let mut offsets = HashSet::new();
    for month in &snapshot.months {
        if !(MIN_MONTH_OFFSET..=MAX_MONTH_OFFSET).contains(&month.offset)
            || !offsets.insert(month.offset)
            || month.days.len() != MAX_SNAPSHOT_DAYS
        {
            return Err("The widget snapshot contains an invalid month page.".into());
        }
        validate_text(
            &month.month_label,
            MAX_TEXT_BYTES,
            "widget month page label",
        )?;
        validate_widget_days(&month.days)?;
    }
    for item in &snapshot.items {
        validate_identifier(&item.stable_id, "widget item")?;
        validate_text(&item.title, MAX_TEXT_BYTES, "widget item title")?;
        if !item.detail.is_empty() {
            validate_text(&item.detail, MAX_TEXT_BYTES, "widget item detail")?;
        }
        if let Some(value) = &item.calendar_id {
            validate_identifier(value, "widget calendar")?;
        }
        if let Some(value) = &item.item_id {
            validate_identifier(value, "widget calendar item")?;
        }
        if let Some(value) = &item.day_key {
            validate_text(value, MAX_TEXT_BYTES, "widget day key")?;
        }
        if let Some(value) = &item.start_at {
            validate_text(value, MAX_TEXT_BYTES, "widget item start")?;
        }
        if let Some(value) = &item.source_color {
            validate_text(value, MAX_TEXT_BYTES, "widget source color")?;
        }
        if let Some(task) = &item.task {
            if task.revision < 0 {
                return Err("A widget task has an invalid revision.".into());
            }
            // Kanban destinations are resolved from these opaque identifiers in
            // app routing. Anything that is not a strict identifier is dropped
            // rather than persisted, so a tap falls back to the calendar item.
            for value in [&task.vault_id, &task.file_id, &task.card_id]
                .into_iter()
                .flatten()
            {
                validate_identifier(value, "widget Kanban reference")?;
            }
            if task.source == WidgetTaskSource::Kanban
                && task.completion == WidgetTaskCompletion::Available
            {
                return Err("Kanban tasks cannot be completed from the launcher.".into());
            }
        }
        if let Some(shortcut) = &item.shortcut {
            if !SHORTCUT_DESTINATIONS.contains(&shortcut.destination.as_str()) {
                return Err("A widget shortcut uses an unsupported destination.".into());
            }
            for value in [&shortcut.vault_id, &shortcut.file_id].into_iter().flatten() {
                validate_identifier(value, "widget shortcut reference")?;
            }
            // A vault destination without a resolved target would hand the app
            // an unopenable route, so it must never reach the launcher.
            if matches!(shortcut.destination.as_str(), "vault-file" | "vault-folder")
                && (shortcut.vault_id.is_none() || shortcut.file_id.is_none())
            {
                return Err("A widget shortcut is missing its vault target.".into());
            }
        }
    }
    Ok(())
}

fn validate_widget_days(days: &[WidgetDaySummary]) -> Result<(), String> {
    // A populated grid is always the full six week rows, so a day's position in
    // it is its column and no date parsing is needed to bound a bar.
    let full_grid = days.len() == MAX_SNAPSHOT_DAYS;
    for (index, day) in days.iter().enumerate() {
        validate_text(&day.day_key, MAX_TEXT_BYTES, "widget day")?;
        if day.colors.len() > 3 {
            return Err("A widget day contains too many colors.".into());
        }
        if day.items.len() > MAX_MONTH_LANES {
            return Err("A widget day contains too many preview items.".into());
        }
        let column = index % 7;
        for item in &day.items {
            validate_text(
                &item.title,
                MAX_MONTH_ITEM_TITLE_BYTES,
                "widget day item title",
            )?;
            if let Some(color) = &item.color {
                validate_text(color, MAX_TEXT_BYTES, "widget day item color")?;
            }
            // A bar that claims more columns than its week row has would be
            // drawn past the edge of the grid.
            if item.span < 1 || usize::from(item.span) > 7 {
                return Err("A widget day item spans past its week.".into());
            }
            if full_grid && column + usize::from(item.span) > 7 {
                return Err("A widget day item spans past its week.".into());
            }
            if usize::from(item.lane) >= MAX_MONTH_LANES {
                return Err("A widget day item uses an unknown lane.".into());
            }
        }
        for color in &day.colors {
            validate_text(color, MAX_TEXT_BYTES, "widget day color")?;
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

#[cfg(any(target_os = "android", test))]
fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn profile_hash(profile_id: &str) -> String {
    let digest = Sha256::digest(profile_id.as_bytes());
    hex::encode(&digest[..16])
}

fn snapshot_content_eq(left: &WidgetSnapshot, right: &WidgetSnapshot) -> bool {
    left.schema_version == right.schema_version
        && left.profile_id_hash == right.profile_id_hash
        && left.configuration_id == right.configuration_id
        && left.kind == right.kind
        && left.date_label == right.date_label
        && left.state_label == right.state_label
        && left.month_label == right.month_label
        && left.selected_day_key == right.selected_day_key
        && left.theme == right.theme
        && left.accent == right.accent
        && left.font_scale == right.font_scale
        && left.freshness == right.freshness
        && left.items == right.items
        && left.days == right.days
        && left.months == right.months
        && left.sync == right.sync
}

fn encode_bounded<T: Serialize>(value: &T, max_bytes: usize) -> Result<Vec<u8>, String> {
    let encoded = serde_json::to_vec(value).map_err(|_| store_error())?;
    if encoded.len() > max_bytes {
        return Err("The widget data exceeded its size limit.".into());
    }
    Ok(encoded)
}

fn read_bounded_optional(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(store_error()),
    };
    if file.metadata().map_err(|_| store_error())?.len() > max_bytes {
        return Err("The widget data exceeded its size limit.".into());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| store_error())?;
    if bytes.len() as u64 > max_bytes {
        return Err("The widget data exceeded its size limit.".into());
    }
    Ok(Some(bytes))
}

fn read_json_optional<T: for<'de> Deserialize<'de>>(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<T>, String> {
    read_bounded_optional(path, max_bytes)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| store_error()))
        .transpose()
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(store_error)?;
    fs::create_dir_all(parent).map_err(|_| store_error())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("widget"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| store_error())?;
        file.write_all(bytes).map_err(|_| store_error())?;
        file.sync_all().map_err(|_| store_error())?;
        fs::rename(&temporary, path).map_err(|_| store_error())?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn store_error() -> String {
    "The native widget store could not complete the operation.".into()
}

/// Builds the deliberately non-private Phase 0 payload used only when Android
/// has no profile/configuration binding yet.
#[cfg(any(target_os = "android", test))]
pub(crate) fn build_phase0_agenda_preview(date_label: &str) -> Result<String, String> {
    if date_label.trim().is_empty()
        || date_label.len() > MAX_DATE_LABEL_BYTES
        || date_label.chars().any(char::is_control)
    {
        return Err("The agenda widget date label is invalid.".into());
    }
    let configuration = WidgetConfiguration {
        schema_version: WIDGET_SCHEMA_VERSION,
        configuration_id: "phase0-bootstrap".into(),
        kind: WidgetKind::Agenda,
        selected_source_ids: Vec::new(),
        selected_item_ids: Vec::new(),
        privacy: WidgetPrivacy::Full,
        display: WidgetDisplayOptions {
            max_items: 6,
            ..WidgetDisplayOptions::default()
        },
        actions: WidgetActionOptions::default(),
        tasks: WidgetTaskOptions::default(),
        capture: WidgetCaptureOptions::default(),
        shortcuts: WidgetShortcutOptions::default(),
        updated_at: date_label.into(),
    };
    let snapshot = build_snapshot(
        "phase0-bootstrap-profile",
        WidgetBuildRequest {
            configuration,
            generated_at: date_label.into(),
            date_label: date_label.into(),
            appearance: None,
            freshness: Vec::new(),
            items: vec![
                preview_item("preview-1", "Design review", "09:30 · Event", "1"),
                preview_item("preview-2", "Project follow-up", "Today · Task", "2"),
                preview_item("preview-3", "Team planning", "Tomorrow · Event", "3"),
            ],
        },
    )?;
    let legacy = serde_json::json!({
        "schemaVersion": WIDGET_SCHEMA_VERSION,
        "dateLabel": snapshot.date_label,
        "stateLabel": "Phase 0 native preview",
        "items": snapshot.items,
    });
    String::from_utf8(encode_bounded(&legacy, MAX_SNAPSHOT_BYTES)?)
        .map_err(|_| "Could not encode the agenda widget preview.".into())
}

#[cfg(any(target_os = "android", test))]
fn preview_item(stable_id: &str, title: &str, detail: &str, sort_key: &str) -> WidgetItemInput {
    WidgetItemInput {
        stable_id: stable_id.into(),
        source_id: "preview".into(),
        sort_key: sort_key.into(),
        title: title.into(),
        detail: detail.into(),
        title_only_detail: detail.into(),
        private_title: default_private_item_title(),
        completed: false,
        section: None,
        item_kind: None,
        calendar_id: None,
        item_id: None,
        day_key: None,
        start_at: None,
        all_day: false,
        source_color: None,
        task: None,
        shortcut: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "collab-widget-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn configuration(id: &str, privacy: WidgetPrivacy) -> WidgetConfiguration {
        WidgetConfiguration {
            schema_version: WIDGET_SCHEMA_VERSION,
            configuration_id: id.into(),
            kind: WidgetKind::Agenda,
            selected_source_ids: vec!["calendar-a".into(), "calendar-b".into()],
            selected_item_ids: Vec::new(),
            privacy,
            display: WidgetDisplayOptions::default(),
            actions: WidgetActionOptions::default(),
            tasks: WidgetTaskOptions::default(),
            capture: WidgetCaptureOptions::default(),
            shortcuts: WidgetShortcutOptions::default(),
            updated_at: "2026-08-01T10:00:00Z".into(),
        }
    }

    fn request(configuration: WidgetConfiguration, generated_at: &str) -> WidgetBuildRequest {
        WidgetBuildRequest {
            configuration,
            generated_at: generated_at.into(),
            date_label: "Today".into(),
            appearance: None,
            freshness: vec![
                WidgetSourceFreshness {
                    source_id: "calendar-b".into(),
                    freshness: WidgetFreshness::Stale,
                },
                WidgetSourceFreshness {
                    source_id: "calendar-a".into(),
                    freshness: WidgetFreshness::Fresh,
                },
            ],
            items: vec![
                WidgetItemInput {
                    stable_id: "later".into(),
                    source_id: "calendar-a".into(),
                    sort_key: "2026-08-01T12:00:00Z".into(),
                    title: "Later".into(),
                    detail: "Room B".into(),
                    title_only_detail: String::new(),
                    private_title: default_private_item_title(),
                    completed: false,
                    section: None,
                    item_kind: None,
                    calendar_id: None,
                    item_id: None,
                    day_key: None,
                    start_at: None,
                    all_day: false,
                    source_color: None,
                    task: None,
                    shortcut: None,
                },
                WidgetItemInput {
                    stable_id: "earlier".into(),
                    source_id: "calendar-b".into(),
                    sort_key: "2026-08-01T08:00:00Z".into(),
                    title: "Earlier".into(),
                    detail: "Room A".into(),
                    title_only_detail: String::new(),
                    private_title: default_private_item_title(),
                    completed: false,
                    section: None,
                    item_kind: None,
                    calendar_id: None,
                    item_id: None,
                    day_key: None,
                    start_at: None,
                    all_day: false,
                    source_color: None,
                    task: None,
                    shortcut: None,
                },
            ],
        }
    }

    #[test]
    fn snapshot_is_deterministic_and_reports_mixed_freshness() {
        let snapshot = build_snapshot(
            "profile-1",
            request(
                configuration("config-1", WidgetPrivacy::Full),
                "2026-08-01T10:00:00Z",
            ),
        )
        .unwrap();
        assert_eq!(snapshot.items[0].stable_id, "earlier");
        assert_eq!(snapshot.freshness[0].source_id, "calendar-a");
        assert_eq!(snapshot.state_label, "Some sources may be stale");
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= MAX_SNAPSHOT_BYTES);
    }

    #[test]
    fn privacy_reduction_happens_before_persistence() {
        let title_only = build_snapshot(
            "profile-1",
            request(
                configuration("config-1", WidgetPrivacy::TitleOnly),
                "2026-08-01T10:00:00Z",
            ),
        )
        .unwrap();
        assert_eq!(title_only.items[0].title, "Earlier");
        assert_eq!(title_only.items[0].detail, "");
        let private = build_snapshot(
            "profile-1",
            request(
                configuration("config-1", WidgetPrivacy::Private),
                "2026-08-01T10:00:00Z",
            ),
        )
        .unwrap();
        assert!(private
            .items
            .iter()
            .all(|item| item.title == "Private item"));
        assert!(!serde_json::to_string(&private).unwrap().contains("Room A"));
    }

    #[test]
    fn store_migrates_bare_configuration_array_and_orders_it() {
        let root = test_root();
        let store = WidgetStore::open(&root, "profile-1").unwrap();
        fs::create_dir_all(&store.profile_dir).unwrap();
        fs::write(
            store.profile_dir.join("configurations.json"),
            serde_json::to_vec(&vec![
                configuration("config-b", WidgetPrivacy::Full),
                configuration("config-a", WidgetPrivacy::Full),
            ])
            .unwrap(),
        )
        .unwrap();
        let listed = store.list_configurations().unwrap();
        assert_eq!(listed[0].configuration_id, "config-a");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identical_publish_is_idempotent_and_delete_prevents_resurrection() {
        let root = test_root();
        let store = WidgetStore::open(&root, "profile-1").unwrap();
        let config = store
            .save_configuration(configuration("config-1", WidgetPrivacy::Full))
            .unwrap();
        let first = build_snapshot("profile-1", request(config.clone(), "first")).unwrap();
        assert!(store.publish(first).unwrap().changed);
        let second = build_snapshot("profile-1", request(config, "second")).unwrap();
        let outcome = store.publish(second.clone()).unwrap();
        assert!(!outcome.changed);
        assert_eq!(outcome.snapshot.generated_at, "first");
        assert!(store.delete_configuration("config-1").unwrap());
        assert!(store.publish(second).is_err());
        assert!(store
            .save_configuration(configuration("config-1", WidgetPrivacy::Full))
            .is_err());
        assert!(store.read_snapshot("config-1").unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn appearance_only_changes_republish_the_launcher_snapshot() {
        let root = test_root();
        let store = WidgetStore::open(&root, "profile-1").unwrap();
        let config = store
            .save_configuration(configuration("config-1", WidgetPrivacy::Full))
            .unwrap();
        let first = build_snapshot("profile-1", request(config.clone(), "first")).unwrap();
        assert!(store.publish(first).unwrap().changed);

        let mut themed_request = request(config, "second");
        themed_request.appearance = Some(WidgetAppearanceSnapshot {
            schema_version: WIDGET_SCHEMA_VERSION,
            theme: "light".into(),
            accent: "cyan".into(),
            font_scale: 1.2,
            time_zone: "UTC".into(),
            time_format: "system".into(),
            show_declined: false,
        });
        let outcome = store
            .publish(build_snapshot("profile-1", themed_request).unwrap())
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.snapshot.theme, "light");
        assert_eq!(outcome.snapshot.accent, "cyan");
        assert_eq!(outcome.snapshot.font_scale, 1.2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profiles_are_isolated_and_cleanup_removes_only_one_profile() {
        let root = test_root();
        let one = WidgetStore::open(&root, "profile-1").unwrap();
        let two = WidgetStore::open(&root, "profile-2").unwrap();
        one.save_configuration(configuration("config-1", WidgetPrivacy::Full))
            .unwrap();
        two.save_configuration(configuration("config-2", WidgetPrivacy::Full))
            .unwrap();
        one.cleanup_profile().unwrap();
        assert!(WidgetStore::open(&root, "profile-1")
            .unwrap()
            .list_configurations()
            .unwrap()
            .is_empty());
        assert_eq!(two.list_configurations().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_profile_is_bounded_and_round_trips() {
        let root = test_root();
        assert_eq!(active_profile(&root).unwrap(), None);
        set_active_profile(&root, "profile-1").unwrap();
        assert_eq!(active_profile(&root).unwrap().as_deref(), Some("profile-1"));
        assert!(set_active_profile(&root, "../other-profile").is_err());
        assert!(clear_active_profile(&root, "profile-1").unwrap());
        assert_eq!(active_profile(&root).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn item_and_size_limits_are_enforced() {
        let mut config = configuration("config-1", WidgetPrivacy::Full);
        config.display.max_items = MAX_SNAPSHOT_ITEMS as u8 + 1;
        assert!(build_snapshot("profile-1", request(config, "now")).is_err());
        let encoded = build_phase0_agenda_preview("2026-08-01").unwrap();
        assert!(encoded.len() <= MAX_SNAPSHOT_BYTES);
        assert!(build_phase0_agenda_preview(&"x".repeat(MAX_DATE_LABEL_BYTES + 1)).is_err());
    }

    #[test]
    fn action_preparation_is_configuration_scoped_and_allowlisted() {
        let root = test_root();
        let store = WidgetStore::open(&root, "profile-1").unwrap();
        store
            .save_configuration(configuration("config-1", WidgetPrivacy::Full))
            .unwrap();
        let action = store
            .prepare_action(WidgetActionRequest {
                configuration_id: "config-1".into(),
                action: WidgetActionKind::OpenAgenda,
            })
            .unwrap();
        assert_eq!(action.destination_kind, "calendar-today");
        assert!(store
            .prepare_action(WidgetActionRequest {
                configuration_id: "missing".into(),
                action: WidgetActionKind::OpenAgenda,
            })
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn appearance_snapshot_is_bounded_validated_and_replaced() {
        let root = test_root();
        let first = WidgetAppearanceSnapshot {
            schema_version: WIDGET_SCHEMA_VERSION,
            theme: "dark".into(),
            accent: "violet".into(),
            font_scale: 1.0,
            time_zone: "Europe/Berlin".into(),
            time_format: "24-hour".into(),
            show_declined: false,
        };
        save_appearance(&root, first).unwrap();
        let second = WidgetAppearanceSnapshot {
            schema_version: WIDGET_SCHEMA_VERSION,
            theme: "light".into(),
            accent: "cyan".into(),
            font_scale: 1.25,
            time_zone: "America/New_York".into(),
            time_format: "12-hour".into(),
            show_declined: true,
        };
        save_appearance(&root, second.clone()).unwrap();
        assert_eq!(read_appearance(&root).unwrap(), Some(second));
        assert!(save_appearance(
            &root,
            WidgetAppearanceSnapshot {
                schema_version: WIDGET_SCHEMA_VERSION,
                theme: "unknown".into(),
                accent: "violet".into(),
                font_scale: 1.0,
                time_zone: "UTC".into(),
                time_format: "system".into(),
                show_declined: false,
            },
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agenda_items_use_profile_time_zone_sections_and_safe_privacy_details() {
        let calendar = CalendarDefinition {
            schema_version: 1,
            id: "calendar-a".into(),
            global_id: "calendar-a-global".into(),
            location: CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
            name: "Work".into(),
            color: "#a174ff".into(),
            default_time_zone: "Europe/Berlin".into(),
            archived: false,
            read_only: false,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        let item = CalendarItem {
            id: "event-1".into(),
            uid: "event-1".into(),
            calendar_id: calendar.id.clone(),
            kind: CalendarItemKind::Event,
            title: "Design review".into(),
            description: None,
            url: None,
            reminders: vec![],
            attendees: vec![],
            attachments: vec![],
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![],
            start: Some(CalendarTimeValue::DateTime {
                date_time: "2026-08-01T08:30:00Z".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            end: Some(CalendarTimeValue::DateTime {
                date_time: "2026-08-01T09:30:00Z".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: None,
            priority: None,
            status: None,
            completed_at: None,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        let now = DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let input = agenda_item_input(
            &item,
            &calendar,
            now,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
            chrono_tz::Europe::Berlin,
            "24-hour",
        )
        .unwrap()
        .unwrap();
        assert_eq!(input.section, Some(WidgetAgendaSection::Today));
        assert_eq!(input.title_only_detail, "10:30");
        assert_eq!(input.detail, "10:30 · Work · Event");

        let mut config = configuration("config-1", WidgetPrivacy::TitleOnly);
        config.selected_source_ids = vec![calendar.id];
        let snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: config,
                generated_at: now.to_rfc3339(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: vec![input],
            },
        )
        .unwrap();
        assert_eq!(snapshot.items[0].detail, "10:30");
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("Work"));
    }

    #[test]
    fn month_density_is_six_weeks_and_privacy_removes_source_colors() {
        let calendar = CalendarDefinition {
            schema_version: 1,
            id: "calendar-a".into(),
            global_id: "calendar-a-global".into(),
            location: CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
            name: "Work".into(),
            color: "#a174ff".into(),
            default_time_zone: "UTC".into(),
            archived: false,
            read_only: false,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        let item = CalendarItem {
            id: "event-1".into(),
            uid: "event-1".into(),
            calendar_id: calendar.id.clone(),
            kind: CalendarItemKind::Event,
            title: "Private plan".into(),
            description: None,
            url: None,
            reminders: vec![],
            attendees: vec![],
            attachments: vec![],
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![],
            start: Some(CalendarTimeValue::Date {
                date: "2026-08-01".into(),
            }),
            end: Some(CalendarTimeValue::Date {
                date: "2026-08-03".into(),
            }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: None,
            priority: None,
            status: None,
            completed_at: None,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        let calendar_by_id = HashMap::from([(calendar.id.as_str(), &calendar)]);
        let mut config = configuration("month-1", WidgetPrivacy::Full);
        config.kind = WidgetKind::Month;
        config.display.horizon_days = 42;
        config.selected_source_ids = vec![calendar.id.clone()];
        let (_, full) = month_day_summaries(
            std::slice::from_ref(&item),
            &config,
            &calendar_by_id,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            chrono_tz::UTC,
            true,
        )
        .unwrap();
        assert_eq!(full.len(), 42);
        let august_first = full.iter().find(|day| day.day_key == "2026-08-01").unwrap();
        assert_eq!(august_first.count, 1);
        assert_eq!(august_first.colors, vec!["#a174ff"]);
        assert_eq!(august_first.items[0].title, "Private plan");
        assert_eq!(august_first.items[0].color.as_deref(), Some("#a174ff"));

        config.privacy = WidgetPrivacy::Private;
        let (_, private) = month_day_summaries(
            &[item],
            &config,
            &calendar_by_id,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            chrono_tz::UTC,
            true,
        )
        .unwrap();
        assert!(private.iter().all(|day| day.colors.is_empty()));
        let august_first = private
            .iter()
            .find(|day| day.day_key == "2026-08-01")
            .unwrap();
        assert_eq!(august_first.items[0].title, "Private event");
        assert_eq!(august_first.items[0].color, None);
        assert!(!serde_json::to_string(&private)
            .unwrap()
            .contains("Private plan"));
    }

    #[test]
    fn multi_day_entries_publish_one_bar_segment_per_week_row() {
        let calendar = CalendarDefinition {
            schema_version: 1,
            id: "calendar-a".into(),
            global_id: "calendar-a-global".into(),
            location: CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
            name: "Work".into(),
            color: "#a174ff".into(),
            default_time_zone: "UTC".into(),
            archived: false,
            read_only: false,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        let all_day = |id: &str, title: &str, start: &str, end: &str| CalendarItem {
            id: id.into(),
            uid: id.into(),
            calendar_id: calendar.id.clone(),
            kind: CalendarItemKind::Event,
            title: title.into(),
            description: None,
            url: None,
            reminders: vec![],
            attendees: vec![],
            attachments: vec![],
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![],
            start: Some(CalendarTimeValue::Date {
                date: start.into(),
            }),
            end: Some(CalendarTimeValue::Date { date: end.into() }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: None,
            priority: None,
            status: None,
            completed_at: None,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        };
        // All-day end dates are exclusive, so these cover Aug 1-5 and Aug 3-4.
        // August 2026 starts on a Saturday, which puts the Sunday week boundary
        // inside the longer entry and forces it to break into two bars.
        let items = vec![
            all_day("offsite", "Team offsite", "2026-08-01", "2026-08-06"),
            all_day("review", "Design review", "2026-08-03", "2026-08-05"),
        ];
        let calendar_by_id = HashMap::from([(calendar.id.as_str(), &calendar)]);
        let mut config = configuration("month-1", WidgetPrivacy::Full);
        config.kind = WidgetKind::Month;
        config.display.horizon_days = 42;
        config.selected_source_ids = vec![calendar.id.clone()];
        let (_, days) = month_day_summaries(
            &items,
            &config,
            &calendar_by_id,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            chrono_tz::UTC,
            true,
        )
        .unwrap();
        let day = |key: &str| days.iter().find(|day| day.day_key == key).unwrap();

        // The five-day entry is published twice, not five times.
        let offsite_segments = days
            .iter()
            .flat_map(|day| day.items.iter())
            .filter(|item| item.title == "Team offsite")
            .count();
        assert_eq!(offsite_segments, 2);

        let saturday = day("2026-08-01");
        assert_eq!(saturday.items.len(), 1);
        assert_eq!(saturday.items[0].span, 2, "Saturday and Sunday only");
        assert_eq!(saturday.items[0].lane, 0);
        assert!(!saturday.items[0].continues_before);
        assert!(saturday.items[0].continues_after);

        // A covered day in the middle of a bar carries no segment of its own,
        // but still counts the entry for the collapsed density marker.
        let sunday = day("2026-08-02");
        assert!(sunday.items.is_empty());
        assert_eq!(sunday.count, 1);

        let monday = day("2026-08-03");
        assert_eq!(monday.count, 2);
        assert_eq!(monday.items.len(), 2);
        let continued = monday
            .items
            .iter()
            .find(|item| item.title == "Team offsite")
            .unwrap();
        assert_eq!(continued.span, 3, "Monday through Wednesday");
        assert!(continued.continues_before);
        assert!(!continued.continues_after);
        // The longer bar keeps the top lane, so a widget too short to draw
        // every lane drops the shortest entry rather than the longest.
        assert_eq!(continued.lane, 0);
        let overlapping = monday
            .items
            .iter()
            .find(|item| item.title == "Design review")
            .unwrap();
        assert_eq!(overlapping.span, 2);
        assert_eq!(overlapping.lane, 1);

        // Every published bar stays inside its own week row.
        for (index, day) in days.iter().enumerate() {
            for item in &day.items {
                assert!(index % 7 + usize::from(item.span) <= 7);
            }
        }
        validate_widget_days(&days).unwrap();
    }

    #[test]
    fn old_appearance_snapshot_defaults_new_calendar_preferences() {
        let root = test_root();
        let path = root.join("widgets").join("appearance.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"schemaVersion":1,"theme":"dark","accent":"violet","fontScale":1.0}"#,
        )
        .unwrap();
        let appearance = read_appearance(&root).unwrap().unwrap();
        assert_eq!(appearance.time_zone, "UTC");
        assert_eq!(appearance.time_format, "system");
        assert!(!appearance.show_declined);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn agenda_profile_pipeline_publishes_a_safe_empty_cached_snapshot() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        let mut config = configuration("config-1", WidgetPrivacy::Full);
        config.selected_source_ids.clear();
        widget_store.save_configuration(config).unwrap();
        save_appearance(
            &root,
            WidgetAppearanceSnapshot {
                schema_version: WIDGET_SCHEMA_VERSION,
                theme: "dark".into(),
                accent: "violet".into(),
                font_scale: 1.0,
                time_zone: "Europe/Berlin".into(),
                time_format: "24-hour".into(),
                show_declined: false,
            },
        )
        .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let outcomes =
            build_and_publish_agenda_profile(&root, "profile-1", &calendar_store, now, "test")
                .await
                .unwrap();
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].changed);
        assert!(outcomes[0].snapshot.items.is_empty());
        assert_eq!(outcomes[0].snapshot.state_label, "Nothing upcoming");
        let diagnostics = widget_store.list_diagnostics().unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].update_cause, "test");
        assert!(diagnostics[0].last_error.is_none());
        widget_store
            .record_refresh_failure("2026-08-01T09:00:00Z", "periodic-fallback")
            .unwrap();
        let failed = widget_store.list_diagnostics().unwrap();
        assert_eq!(failed[0].last_success_at, diagnostics[0].last_success_at);
        assert_eq!(failed[0].update_cause, "periodic-fallback");
        assert_eq!(
            failed[0].last_error.as_deref(),
            Some("Widget refresh failed. Open Collab and try again.")
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn task_calendar(id: &str, read_only: bool, location: CalendarLocation) -> CalendarDefinition {
        CalendarDefinition {
            schema_version: 1,
            id: id.into(),
            global_id: format!("{id}-global"),
            location,
            name: "Work".into(),
            color: "#a174ff".into(),
            default_time_zone: "Europe/Berlin".into(),
            archived: false,
            read_only,
            revision: 1,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        }
    }

    fn task_item(id: &str, calendar_id: &str, due: Option<CalendarTimeValue>) -> CalendarItem {
        CalendarItem {
            id: id.into(),
            uid: format!("{id}@collab"),
            calendar_id: calendar_id.into(),
            kind: CalendarItemKind::Task,
            title: "Ship the release".into(),
            description: None,
            url: None,
            reminders: vec![],
            attendees: vec![],
            attachments: vec![],
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![],
            start: None,
            end: None,
            due,
            date: None,
            birth_year: None,
            location: None,
            availability: None,
            priority: None,
            status: Some("needs-action".into()),
            completed_at: None,
            revision: 3,
            created_at: "2026-08-01T00:00:00Z".into(),
            updated_at: "2026-08-01T00:00:00Z".into(),
            deleted_at: None,
        }
    }

    fn tasks_configuration(id: &str) -> WidgetConfiguration {
        let mut configuration = configuration(id, WidgetPrivacy::Full);
        configuration.kind = WidgetKind::Tasks;
        configuration.selected_source_ids.clear();
        configuration.display.horizon_days = 7;
        configuration.actions.toggle_task = true;
        configuration
    }

    fn project_task(
        item: &CalendarItem,
        calendar: &CalendarDefinition,
        configuration: &WidgetConfiguration,
        source_freshness: WidgetFreshness,
    ) -> Option<WidgetItemInput> {
        let now = DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        task_item_input(
            item,
            calendar,
            configuration,
            source_freshness,
            now,
            NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 8).unwrap(),
            chrono_tz::Europe::Berlin,
            "24-hour",
        )
        .unwrap()
    }

    #[test]
    fn task_projection_orders_due_states_and_keeps_unscheduled_last() {
        let calendar = task_calendar(
            "calendar-a",
            false,
            CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
        );
        let configuration = tasks_configuration("tasks-1");
        let overdue = project_task(
            &task_item(
                "task-overdue",
                &calendar.id,
                Some(CalendarTimeValue::DateTime {
                    date_time: "2026-07-30T09:00:00Z".into(),
                    time_zone: "Europe/Berlin".into(),
                }),
            ),
            &calendar,
            &configuration,
            WidgetFreshness::Fresh,
        )
        .unwrap();
        let upcoming = project_task(
            &task_item(
                "task-upcoming",
                &calendar.id,
                Some(CalendarTimeValue::Date {
                    date: "2026-08-05".into(),
                }),
            ),
            &calendar,
            &configuration,
            WidgetFreshness::Fresh,
        )
        .unwrap();
        let unscheduled =
            project_task(&task_item("task-none", &calendar.id, None), &calendar, &configuration, WidgetFreshness::Fresh)
                .unwrap();
        assert_eq!(overdue.task.as_ref().unwrap().due, WidgetTaskDue::Overdue);
        assert_eq!(upcoming.task.as_ref().unwrap().due, WidgetTaskDue::Upcoming);
        assert_eq!(
            unscheduled.task.as_ref().unwrap().due,
            WidgetTaskDue::Unscheduled
        );
        assert!(overdue.sort_key < upcoming.sort_key);
        assert!(upcoming.sort_key < unscheduled.sort_key);
        assert_eq!(
            overdue.task.as_ref().unwrap().completion,
            WidgetTaskCompletion::Available
        );
        assert_eq!(overdue.task.as_ref().unwrap().revision, 3);

        // A task beyond the configured horizon is dropped entirely.
        assert!(project_task(
            &task_item(
                "task-far",
                &calendar.id,
                Some(CalendarTimeValue::Date {
                    date: "2026-09-30".into()
                })
            ),
            &calendar,
            &configuration,
            WidgetFreshness::Fresh,
        )
        .is_none());

        let mut without_undated = configuration.clone();
        without_undated.tasks.include_undated = false;
        assert!(project_task(
            &task_item("task-none", &calendar.id, None),
            &calendar,
            &without_undated,
            WidgetFreshness::Fresh
        )
        .is_none());
    }

    #[test]
    fn task_completion_capability_keeps_unsafe_mutations_in_the_app() {
        let local = task_calendar(
            "calendar-a",
            false,
            CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
        );
        let configuration = tasks_configuration("tasks-1");
        let due = Some(CalendarTimeValue::Date {
            date: "2026-08-01".into(),
        });

        let mut recurring = task_item("task-recurring", &local.id, due.clone());
        recurring.recurrence = Some(collab_calendar::CalendarRecurrence {
            rrule: "FREQ=DAILY".into(),
            rdates: Vec::new(),
            exdates: Vec::new(),
        });
        assert_eq!(
            project_task(&recurring, &local, &configuration, WidgetFreshness::Fresh)
                .unwrap()
                .task
                .unwrap()
                .completion,
            WidgetTaskCompletion::ConfirmInApp,
        );

        assert_eq!(
            project_task(
                &task_item("task-1", &local.id, due.clone()),
                &local,
                &configuration,
                WidgetFreshness::Unavailable,
            )
            .unwrap()
            .task
            .unwrap()
            .completion,
            WidgetTaskCompletion::ConfirmInApp,
        );

        let subscription = task_calendar(
            "calendar-a",
            true,
            CalendarLocation::Subscription {
                subscription_id: "subscription-1".into(),
                server_url: None,
                user_id: None,
            },
        );
        assert_eq!(
            project_task(
                &task_item("task-1", &subscription.id, due.clone()),
                &subscription,
                &configuration,
                WidgetFreshness::Fresh,
            )
            .unwrap()
            .task
            .unwrap()
            .completion,
            WidgetTaskCompletion::Unavailable,
        );

        let mut disabled = configuration.clone();
        disabled.actions.toggle_task = false;
        assert_eq!(
            project_task(
                &task_item("task-1", &local.id, due),
                &local,
                &disabled,
                WidgetFreshness::Fresh,
            )
            .unwrap()
            .task
            .unwrap()
            .completion,
            WidgetTaskCompletion::Unavailable,
        );
    }

    #[test]
    fn kanban_tasks_carry_opaque_destinations_and_never_complete_natively() {
        let kanban = task_calendar(
            "calendar-kanban",
            true,
            CalendarLocation::Kanban {
                origin_key: "https://collab.example::vault-1".into(),
            },
        );
        let mut item = task_item(
            "task-kanban",
            &kanban.id,
            Some(CalendarTimeValue::Date {
                date: "2026-08-01".into(),
            }),
        );
        item.source_binding = Some(collab_calendar::CalendarSourceBinding::Kanban {
            server_url: Some("https://collab.example".into()),
            vault_id: Some("vault-1".into()),
            file_id: "file-1".into(),
            card_id: "card-1".into(),
            path: Some("Boards/Team.kanban".into()),
            source_revision: Some(4),
        });
        let configuration = tasks_configuration("tasks-1");
        let projected = project_task(&item, &kanban, &configuration, WidgetFreshness::Fresh).unwrap();
        let task = projected.task.clone().unwrap();
        assert_eq!(task.source, WidgetTaskSource::Kanban);
        assert_eq!(task.completion, WidgetTaskCompletion::ConfirmInApp);
        assert_eq!(task.vault_id.as_deref(), Some("vault-1"));
        assert_eq!(task.card_id.as_deref(), Some("card-1"));

        let snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: configuration.clone(),
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: vec![projected],
            },
        )
        .unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("collab.example"));
        assert!(!encoded.contains("Boards/Team.kanban"));

        // Board filters exclude other boards but never calendar tasks.
        let mut filtered = configuration.clone();
        filtered.tasks.selected_board_ids = vec!["file-other".into()];
        assert!(project_task(&item, &kanban, &filtered, WidgetFreshness::Fresh).is_none());
        let mut excluded = configuration;
        excluded.tasks.include_kanban_tasks = false;
        assert!(project_task(&item, &kanban, &excluded, WidgetFreshness::Fresh).is_none());
    }

    #[test]
    fn kanban_rows_can_never_claim_native_completion() {
        let mut item = WidgetSnapshotItem {
            stable_id: "task-1".into(),
            title: "Ship".into(),
            detail: "Today".into(),
            section: Some(WidgetAgendaSection::Today),
            item_kind: Some(WidgetAgendaItemKind::Task),
            calendar_id: None,
            item_id: None,
            day_key: None,
            start_at: None,
            all_day: false,
            source_color: None,
            shortcut: None,
            task: Some(WidgetTaskDetails {
                source: WidgetTaskSource::Kanban,
                due: WidgetTaskDue::Today,
                completion: WidgetTaskCompletion::Available,
                revision: 1,
                vault_id: None,
                file_id: None,
                card_id: None,
            }),
        };
        let mut snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: tasks_configuration("tasks-1"),
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: vec![],
            },
        )
        .unwrap();
        let profile_hash = snapshot.profile_id_hash.clone();
        snapshot.items = vec![item.clone()];
        assert!(validate_snapshot(&snapshot, &profile_hash).is_err());
        item.task.as_mut().unwrap().completion = WidgetTaskCompletion::ConfirmInApp;
        snapshot.items = vec![item];
        assert!(validate_snapshot(&snapshot, &profile_hash).is_ok());
    }

    #[tokio::test]
    async fn confirmed_completion_queues_one_idempotent_operation() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        let calendar = task_calendar(
            "calendar-a",
            false,
            CalendarLocation::Hosted {
                server_url: "https://collab.example".into(),
                user_id: "user-1".into(),
            },
        );
        calendar_store.upsert_calendar(&calendar).await.unwrap();
        let item = task_item(
            "task-1",
            &calendar.id,
            Some(CalendarTimeValue::Date {
                date: "2026-08-01".into(),
            }),
        );
        let seed = collab_calendar::CalendarOperation {
            client_operation_id: "seed-1".into(),
            device_id: "test-device".into(),
            expected_revision: None,
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: collab_calendar::CalendarMutation::UpsertItem { item: item.clone() },
        };
        calendar_store
            .upsert_item_with_operation(&item, &seed)
            .await
            .unwrap();
        calendar_store
            .acknowledge_operations(&["seed-1".to_string()])
            .await
            .unwrap();

        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        widget_store
            .save_configuration(tasks_configuration("tasks-1"))
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-01T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let request = WidgetTaskCompletionRequest {
            configuration_id: "tasks-1".into(),
            item_id: "task-1".into(),
            expected_revision: 3,
            confirmed: true,
        };

        // An unconfirmed launcher tap must never mutate shared data.
        let mut unconfirmed = request.clone();
        unconfirmed.confirmed = false;
        assert!(
            complete_task(&root, "profile-1", &calendar_store, unconfirmed, now)
                .await
                .is_err()
        );
        assert!(calendar_store
            .list_pending_operations()
            .await
            .unwrap()
            .is_empty());

        let result = complete_task(&root, "profile-1", &calendar_store, request.clone(), now)
            .await
            .unwrap();
        assert!(result.applied);
        let stored = calendar_store.read_item("task-1").await.unwrap().unwrap();
        assert_eq!(stored.status.as_deref(), Some("completed"));
        assert_eq!(stored.revision, 4);
        let pending = calendar_store.list_pending_operations().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].client_operation_id, "widget-complete-task-1-3");

        // Replaying the same confirmed tap is a no-op, and a stale revision is
        // refused rather than overwriting the newer state.
        assert!(complete_task(&root, "profile-1", &calendar_store, request, now)
            .await
            .is_err());
        assert_eq!(
            calendar_store.list_pending_operations().await.unwrap().len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completion_refuses_read_only_kanban_and_disabled_widgets() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        let mut generated = task_calendar(
            "calendar-kanban",
            true,
            CalendarLocation::Kanban {
                origin_key: "https://collab.example::vault-1".into(),
            },
        );
        generated.name = "Assigned tasks".into();
        let mut item = task_item("task-kanban", &generated.id, None);
        item.source_binding = Some(collab_calendar::CalendarSourceBinding::Kanban {
            server_url: Some("https://collab.example".into()),
            vault_id: Some("vault-1".into()),
            file_id: "file-1".into(),
            card_id: "card-1".into(),
            path: None,
            source_revision: Some(1),
        });
        calendar_store
            .replace_generated_kanban_calendar(&generated, std::slice::from_ref(&item))
            .await
            .unwrap();

        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        widget_store
            .save_configuration(tasks_configuration("tasks-1"))
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-01T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let request = WidgetTaskCompletionRequest {
            configuration_id: "tasks-1".into(),
            item_id: "task-kanban".into(),
            expected_revision: item.revision,
            confirmed: true,
        };
        assert!(
            complete_task(&root, "profile-1", &calendar_store, request.clone(), now)
                .await
                .is_err()
        );
        assert!(calendar_store
            .list_pending_operations()
            .await
            .unwrap()
            .is_empty());

        // An agenda configuration must not be usable as a task mutation surface.
        widget_store
            .save_configuration(configuration("agenda-1", WidgetPrivacy::Full))
            .unwrap();
        let mut wrong_kind = request;
        wrong_kind.configuration_id = "agenda-1".into();
        assert!(
            complete_task(&root, "profile-1", &calendar_store, wrong_kind, now)
                .await
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn task_profile_pipeline_publishes_completion_capable_rows() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        let calendar = task_calendar(
            "calendar-a",
            false,
            CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
        );
        calendar_store.upsert_calendar(&calendar).await.unwrap();
        let item = task_item(
            "task-1",
            &calendar.id,
            Some(CalendarTimeValue::Date {
                date: "2026-08-01".into(),
            }),
        );
        let operation = collab_calendar::CalendarOperation {
            client_operation_id: "seed-1".into(),
            device_id: "test-device".into(),
            expected_revision: None,
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: collab_calendar::CalendarMutation::UpsertItem { item: item.clone() },
        };
        calendar_store
            .upsert_item_with_operation(&item, &operation)
            .await
            .unwrap();

        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        widget_store
            .save_configuration(tasks_configuration("tasks-1"))
            .unwrap();
        save_appearance(
            &root,
            WidgetAppearanceSnapshot {
                schema_version: WIDGET_SCHEMA_VERSION,
                theme: "dark".into(),
                accent: "violet".into(),
                font_scale: 1.0,
                time_zone: "Europe/Berlin".into(),
                time_format: "24-hour".into(),
                show_declined: false,
            },
        )
        .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let outcomes =
            build_and_publish_agenda_profile(&root, "profile-1", &calendar_store, now, "test")
                .await
                .unwrap();
        assert_eq!(outcomes.len(), 1);
        let snapshot = &outcomes[0].snapshot;
        assert_eq!(snapshot.kind, WidgetKind::Tasks);
        assert_eq!(snapshot.items.len(), 1);
        let task = snapshot.items[0].task.as_ref().unwrap();
        assert_eq!(task.source, WidgetTaskSource::Calendar);
        assert_eq!(task.completion, WidgetTaskCompletion::Available);
        assert_eq!(task.due, WidgetTaskDue::Today);

        // Completing it through the confirmed path removes it from the next
        // publication instead of leaving the launcher on optimistic state.
        complete_task(
            &root,
            "profile-1",
            &calendar_store,
            WidgetTaskCompletionRequest {
                configuration_id: "tasks-1".into(),
                item_id: "task-1".into(),
                expected_revision: task.revision,
                confirmed: true,
            },
            now,
        )
        .await
        .unwrap();
        let republished =
            build_and_publish_agenda_profile(&root, "profile-1", &calendar_store, now, "test")
                .await
                .unwrap();
        assert!(republished[0].snapshot.items.is_empty());
        assert_eq!(republished[0].snapshot.state_label, "No tasks due");
        fs::remove_dir_all(root).unwrap();
    }

    fn hosted_entry(
        id: &str,
        name: &str,
        kind: collab_protocol::HostedFileKind,
        document_type: Option<collab_protocol::HostedDocumentType>,
        state: collab_protocol::HostedFileState,
        updated_at: &str,
    ) -> collab_protocol::HostedFileEntry {
        collab_protocol::HostedFileEntry {
            id: id.into(),
            parent_id: None,
            name: name.into(),
            relative_path: name.into(),
            kind,
            document_type,
            state,
            current_revision: None,
            trashed_by_display_name: None,
            trashed_at: None,
            created_at: "2026-07-01T00:00:00Z".into(),
            updated_at: updated_at.into(),
        }
    }

    fn seed_replica(
        root: &Path,
        vault_id: &str,
        capabilities: &[String],
        files: Vec<collab_protocol::HostedFileEntry>,
    ) {
        let store = collab_replica::ReplicaStore::open_or_create(
            root,
            "https://collab.example",
            vault_id,
            "Team vault",
            Some("editor"),
            capabilities,
        )
        .unwrap();
        store
            .write_manifest(&collab_protocol::HostedVaultManifest {
                vault_id: vault_id.into(),
                sequence: 4,
                files,
            })
            .unwrap();
    }

    fn shortcuts_configuration(id: &str) -> WidgetConfiguration {
        let mut configuration = configuration(id, WidgetPrivacy::Full);
        configuration.kind = WidgetKind::Shortcuts;
        configuration.selected_source_ids.clear();
        configuration.display.max_items = 3;
        configuration
    }

    #[test]
    fn capture_tiles_only_carry_allow_listed_destinations() {
        let mut configuration = configuration("capture-1", WidgetPrivacy::Private);
        configuration.kind = WidgetKind::Capture;
        configuration.selected_source_ids.clear();
        configuration.capture.actions = vec![WidgetCaptureAction::Note, WidgetCaptureAction::Files];
        configuration.display.max_items = 2;

        let items = capture_item_inputs(&configuration);
        assert_eq!(items.len(), 2);
        let snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration,
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items,
            },
        )
        .unwrap();
        assert_eq!(
            snapshot
                .items
                .iter()
                .map(|item| item.shortcut.as_ref().unwrap().destination.as_str())
                .collect::<Vec<_>>(),
            vec!["capture-note", "capture-files"],
        );
        // Capture labels carry no user content, so privacy reduction keeps them
        // readable instead of replacing them with a generic placeholder.
        assert_eq!(snapshot.items[0].title, "New note");
        assert!(snapshot
            .items
            .iter()
            .all(|item| item.shortcut.as_ref().unwrap().vault_id.is_none()));
    }

    #[test]
    fn shortcut_rows_exclude_trashed_and_unauthorized_entries() {
        let root = test_root();
        seed_replica(
            &root,
            "vault-1",
            &["vault.read".to_string()],
            vec![
                hosted_entry(
                    "file-note",
                    "Roadmap.md",
                    collab_protocol::HostedFileKind::Document,
                    Some(collab_protocol::HostedDocumentType::Note),
                    collab_protocol::HostedFileState::Active,
                    "2026-08-01T10:00:00Z",
                ),
                hosted_entry(
                    "file-trashed",
                    "Old.md",
                    collab_protocol::HostedFileKind::Document,
                    Some(collab_protocol::HostedDocumentType::Note),
                    collab_protocol::HostedFileState::Trashed,
                    "2026-08-01T11:00:00Z",
                ),
                hosted_entry(
                    "file-gone",
                    "Removed.md",
                    collab_protocol::HostedFileKind::Document,
                    Some(collab_protocol::HostedDocumentType::Note),
                    collab_protocol::HostedFileState::Tombstoned,
                    "2026-08-01T12:00:00Z",
                ),
            ],
        );
        // A replica the user has lost read access to contributes nothing.
        seed_replica(
            &root,
            "vault-revoked",
            &["vault.search".to_string()],
            vec![hosted_entry(
                "file-secret",
                "Secret.md",
                collab_protocol::HostedFileKind::Document,
                Some(collab_protocol::HostedDocumentType::Note),
                collab_protocol::HostedFileState::Active,
                "2026-08-02T10:00:00Z",
            )],
        );

        let candidates = read_shortcut_candidates(&root);
        assert_eq!(
            candidates.iter().map(|entry| entry.file_id.as_str()).collect::<Vec<_>>(),
            vec!["file-note"],
        );
        assert_eq!(candidates[0].entry_kind, WidgetEntryKind::Note);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_shortcuts_lead_and_unresolvable_pins_are_dropped() {
        let candidates = vec![
            ShortcutCandidate {
                vault_id: "vault-1".into(),
                vault_name: "Team vault".into(),
                file_id: "file-board".into(),
                name: "Sprint.kanban".into(),
                entry_kind: WidgetEntryKind::Board,
                updated_at: "2026-08-01T09:00:00Z".into(),
            },
            ShortcutCandidate {
                vault_id: "vault-1".into(),
                vault_name: "Team vault".into(),
                file_id: "file-recent".into(),
                name: "Notes.md".into(),
                entry_kind: WidgetEntryKind::Note,
                updated_at: "2026-08-01T18:00:00Z".into(),
            },
            ShortcutCandidate {
                vault_id: "vault-1".into(),
                vault_name: "Team vault".into(),
                file_id: "file-folder".into(),
                name: "Designs".into(),
                entry_kind: WidgetEntryKind::Folder,
                updated_at: "2026-08-01T08:00:00Z".into(),
            },
        ];
        let mut configuration = shortcuts_configuration("shortcuts-1");
        configuration.shortcuts.pinned = vec![
            WidgetPinnedTarget {
                vault_id: "vault-1".into(),
                file_id: "file-board".into(),
            },
            // A pin whose target is gone must not publish a dead row.
            WidgetPinnedTarget {
                vault_id: "vault-1".into(),
                file_id: "file-missing".into(),
            },
        ];

        let rows = shortcut_item_inputs(&configuration, &candidates);
        assert_eq!(
            rows.iter().map(|row| row.stable_id.as_str()).collect::<Vec<_>>(),
            vec![
                "vault-1:file-board",
                "vault-1:file-recent",
                "vault-1:file-folder",
            ],
        );
        assert!(rows[0].shortcut.as_ref().unwrap().pinned);
        assert!(!rows[1].shortcut.as_ref().unwrap().pinned);
        // Recent rows come newest-first behind every resolvable pin.
        assert!(rows[1].sort_key < rows[2].sort_key);
        assert_eq!(
            rows[2].shortcut.as_ref().unwrap().destination,
            "vault-folder",
        );
        assert_eq!(rows[0].shortcut.as_ref().unwrap().destination, "vault-file");

        let mut without_recent = configuration;
        without_recent.shortcuts.include_recent = false;
        assert_eq!(shortcut_item_inputs(&without_recent, &candidates).len(), 1);
    }

    #[test]
    fn shortcut_privacy_replaces_names_and_never_persists_a_path() {
        let candidates = vec![ShortcutCandidate {
            vault_id: "vault-1".into(),
            vault_name: "Team vault".into(),
            file_id: "file-note".into(),
            name: "Salary review.md".into(),
            entry_kind: WidgetEntryKind::Note,
            updated_at: "2026-08-01T09:00:00Z".into(),
        }];
        let mut configuration = shortcuts_configuration("shortcuts-1");
        configuration.privacy = WidgetPrivacy::Private;
        let snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: configuration.clone(),
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: shortcut_item_inputs(&configuration, &candidates),
            },
        )
        .unwrap();
        assert_eq!(snapshot.items[0].title, "Note");
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("Salary review"));
        assert!(!encoded.contains("Team vault"));
        // The opaque identity the app routes by must survive reduction.
        assert_eq!(
            snapshot.items[0].shortcut.as_ref().unwrap().file_id.as_deref(),
            Some("file-note"),
        );

        let mut title_only = configuration.clone();
        title_only.privacy = WidgetPrivacy::TitleOnly;
        let snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: title_only.clone(),
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: shortcut_item_inputs(&title_only, &candidates),
            },
        )
        .unwrap();
        assert_eq!(snapshot.items[0].title, "Salary review.md");
        // Title-only keeps the name but drops the owning account detail.
        assert_eq!(snapshot.items[0].detail, "Note");
    }

    #[test]
    fn vault_destinations_require_a_resolved_target() {
        let mut snapshot = build_snapshot(
            "profile-1",
            WidgetBuildRequest {
                configuration: shortcuts_configuration("shortcuts-1"),
                generated_at: "2026-08-01T08:00:00Z".into(),
                date_label: "2026-08-01".into(),
                appearance: None,
                freshness: vec![],
                items: vec![],
            },
        )
        .unwrap();
        let profile_hash = snapshot.profile_id_hash.clone();
        let mut item = WidgetSnapshotItem {
            stable_id: "vault-1:file-1".into(),
            title: "Notes".into(),
            detail: "Note".into(),
            section: None,
            item_kind: None,
            calendar_id: None,
            item_id: None,
            day_key: None,
            start_at: None,
            all_day: false,
            source_color: None,
            task: None,
            shortcut: Some(WidgetShortcutDetails {
                destination: "vault-file".into(),
                vault_id: Some("vault-1".into()),
                file_id: None,
                entry_kind: Some(WidgetEntryKind::Note),
                pinned: true,
            }),
        };
        snapshot.items = vec![item.clone()];
        assert!(validate_snapshot(&snapshot, &profile_hash).is_err());

        item.shortcut.as_mut().unwrap().file_id = Some("file-1".into());
        snapshot.items = vec![item.clone()];
        assert!(validate_snapshot(&snapshot, &profile_hash).is_ok());

        // An unknown destination fails closed rather than reaching the launcher.
        item.shortcut.as_mut().unwrap().destination = "open-anything".into();
        snapshot.items = vec![item];
        assert!(validate_snapshot(&snapshot, &profile_hash).is_err());
    }

    #[tokio::test]
    async fn capture_and_shortcut_profiles_publish_without_calendar_data() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        seed_replica(
            &root,
            "vault-1",
            &["vault.read".to_string()],
            vec![hosted_entry(
                "file-note",
                "Roadmap.md",
                collab_protocol::HostedFileKind::Document,
                Some(collab_protocol::HostedDocumentType::Note),
                collab_protocol::HostedFileState::Active,
                "2026-08-01T10:00:00Z",
            )],
        );
        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        let mut capture = configuration("capture-1", WidgetPrivacy::Full);
        capture.kind = WidgetKind::Capture;
        capture.selected_source_ids.clear();
        widget_store.save_configuration(capture).unwrap();
        widget_store
            .save_configuration(shortcuts_configuration("shortcuts-1"))
            .unwrap();

        let now = DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let outcomes =
            build_and_publish_agenda_profile(&root, "profile-1", &calendar_store, now, "test")
                .await
                .unwrap();
        assert_eq!(outcomes.len(), 2);
        let capture_snapshot = outcomes
            .iter()
            .find(|outcome| outcome.snapshot.kind == WidgetKind::Capture)
            .unwrap();
        // All four default tiles survive even though max_items defaults to 6.
        assert_eq!(capture_snapshot.snapshot.items.len(), 4);
        let shortcut_snapshot = outcomes
            .iter()
            .find(|outcome| outcome.snapshot.kind == WidgetKind::Shortcuts)
            .unwrap();
        assert_eq!(shortcut_snapshot.snapshot.items.len(), 1);
        assert_eq!(
            shortcut_snapshot.snapshot.items[0]
                .shortcut
                .as_ref()
                .unwrap()
                .file_id
                .as_deref(),
            Some("file-note"),
        );
        // No server URL reaches launcher-readable storage.
        assert!(!serde_json::to_string(&shortcut_snapshot.snapshot)
            .unwrap()
            .contains("collab.example"));
        fs::remove_dir_all(root).unwrap();
    }

    fn sync_configuration(id: &str) -> WidgetConfiguration {
        let mut configuration = configuration(id, WidgetPrivacy::Full);
        configuration.kind = WidgetKind::Sync;
        configuration.selected_source_ids.clear();
        configuration.display.max_items = 6;
        configuration
    }

    #[test]
    fn only_calendar_backed_widgets_pay_for_the_shared_projection() {
        let of_kind = |kind: WidgetKind| {
            let mut configuration = configuration("widget-1", WidgetPrivacy::Full);
            configuration.kind = kind;
            configuration
        };

        // These render nothing from the calendar, so a profile holding only
        // them must not run the year-deep recurrence projection on every
        // republication.
        for kind in [WidgetKind::Capture, WidgetKind::Shortcuts, WidgetKind::Sync] {
            assert!(
                !profile_needs_calendar(&[of_kind(kind)]),
                "{kind:?} does not render calendar data"
            );
        }
        for kind in [
            WidgetKind::Agenda,
            WidgetKind::Month,
            WidgetKind::Birthday,
            WidgetKind::Countdown,
            WidgetKind::Tasks,
        ] {
            assert!(
                profile_needs_calendar(&[of_kind(kind)]),
                "{kind:?} renders calendar data"
            );
        }

        // One calendar-backed widget anywhere in the profile is enough.
        assert!(profile_needs_calendar(&[
            of_kind(WidgetKind::Sync),
            of_kind(WidgetKind::Agenda),
        ]));
        assert!(!profile_needs_calendar(&[]));
    }

    fn seed_sync_replica(
        root: &Path,
        server_url: &str,
        vault_id: &str,
        vault_name: &str,
        status: collab_replica::models::SyncStatus,
        last_synced_at: Option<&str>,
        pending: &[collab_replica::PendingOpStatus],
    ) {
        let store = collab_replica::ReplicaStore::open_or_create(
            root,
            server_url,
            vault_id,
            vault_name,
            Some("editor"),
            &["vault.read".to_string()],
        )
        .unwrap();
        store
            .write_sync_state(&collab_replica::ReplicaSyncState {
                manifest_sequence: 3,
                last_synced_at: last_synced_at.map(str::to_string),
                offline_available_at: None,
                status,
            })
            .unwrap();
        for (index, status) in pending.iter().enumerate() {
            store
                .enqueue_operation(&collab_replica::PendingOperation {
                    id: format!("op-{index}"),
                    kind: collab_replica::models::PendingOpKind::Edit,
                    file_id: Some("file-1".into()),
                    relative_path: Some("Note.md".into()),
                    payload: serde_json::json!({}),
                    base_manifest_sequence: 3,
                    created_at: "2026-08-01T07:00:00Z".into(),
                    status: *status,
                    failure_code: None,
                    failure_message: None,
                })
                .unwrap();
        }
    }

    fn write_background_state(
        root: &Path,
        jobs: serde_json::Value,
        servers: serde_json::Value,
        settings: Option<serde_json::Value>,
    ) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("background-jobs.json"),
            serde_json::json!({ "schemaVersion": 1, "jobs": jobs }).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("background-servers.json"),
            serde_json::json!({ "schemaVersion": 1, "servers": servers }).to_string(),
        )
        .unwrap();
        if let Some(settings) = settings {
            fs::write(root.join("background-settings.json"), settings.to_string()).unwrap();
        }
    }

    fn background_job(
        id: &str,
        server_url: &str,
        status: &str,
        finished_at: Option<&str>,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "idempotencyKey": id,
            "kind": "replica_sync",
            "serverUrl": server_url,
            "profileId": serde_json::Value::Null,
            "vaultId": serde_json::Value::Null,
            "trigger": "periodic",
            "attempt": 1,
            "status": status,
            "createdAt": "2026-08-01T07:00:00Z",
            "startedAt": "2026-08-01T07:00:00Z",
            "finishedAt": finished_at,
            "nextRetryAt": serde_json::Value::Null,
            "progress": { "completed": 0, "total": serde_json::Value::Null, "detail": serde_json::Value::Null },
            "summary": serde_json::Value::Null,
            "errorCategory": serde_json::Value::Null,
            "errorMessage": serde_json::Value::Null,
            "retryable": false,
        })
    }

    fn sync_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-01T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn sync_rollup_reports_pending_work_without_naming_a_server() {
        let root = test_root();
        write_background_state(
            &root,
            serde_json::json!([background_job(
                "job-1",
                "https://collab.example",
                "succeeded",
                Some("2026-08-01T07:40:00Z"),
            )]),
            serde_json::json!([{
                "serverUrl": "https://collab.example",
                "allowInvalidCertificates": false,
                "persistAcrossReboots": false,
                "backgroundSyncEnabled": true,
                "profileIds": ["profile-1"],
                "updatedAt": "2026-08-01T07:00:00Z",
            }]),
            None,
        );
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:40:00Z"),
            &[collab_replica::PendingOpStatus::Pending],
        );

        let (rows, freshness, summary) =
            sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::PendingChanges);
        assert_eq!(summary.pending_operations, 1);
        assert_eq!(summary.failed_operations, 0);
        assert_eq!(summary.vaults, 1);
        assert_eq!(summary.accounts, 1);
        assert!(summary.can_sync_now);
        assert_eq!(
            summary.last_success_label.as_deref(),
            Some("Synced 20 min ago"),
        );
        assert_eq!(summary.state.label(&summary), "1 change waiting to sync");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].detail, "1 change waiting");
        // Accounts are identified only by an opaque hash of their origin.
        assert_eq!(freshness.len(), 1);
        assert!(freshness[0].source_id.starts_with("account-"));
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("collab.example"));
        assert!(!encoded.contains("vault-1"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_states_rank_attention_above_progress_and_pending() {
        let root = test_root();
        write_background_state(
            &root,
            serde_json::json!([
                background_job("job-auth", "https://collab.example", "authentication_required", None),
                background_job("job-run", "https://collab.example", "running", None),
            ]),
            serde_json::json!([]),
            None,
        );
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:00:00Z"),
            &[collab_replica::PendingOpStatus::Pending],
        );

        let (rows, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        // Re-authentication outranks a run in flight and queued local changes.
        assert_eq!(summary.state, WidgetSyncState::AuthenticationRequired);
        assert_eq!(summary.active_jobs, 1);
        assert_eq!(summary.state.label(&summary), "Sign in again to sync");
        // The only launcher affordance for an attention state opens the app.
        let recovery = rows.first().unwrap();
        assert_eq!(recovery.stable_id, "sync-recovery");
        assert_eq!(
            recovery.shortcut.as_ref().unwrap().destination,
            "settings-account",
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_failed_operations_become_an_attention_state_with_a_background_link() {
        let root = test_root();
        write_background_state(&root, serde_json::json!([]), serde_json::json!([]), None);
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:55:00Z"),
            &[
                collab_replica::PendingOpStatus::Failed,
                collab_replica::PendingOpStatus::Pending,
            ],
        );

        let (rows, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::ActionRequired);
        assert_eq!(summary.failed_operations, 1);
        assert_eq!(summary.pending_operations, 2);
        assert_eq!(
            rows[0].shortcut.as_ref().unwrap().destination,
            "settings-background",
        );
        // The vault row leads with what has to be recovered.
        assert_eq!(rows[1].detail, "1 change needs attention");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_pauses_and_reports_offline_only_when_every_replica_is() {
        let root = test_root();
        write_background_state(
            &root,
            serde_json::json!([]),
            serde_json::json!([]),
            Some(serde_json::json!({
                "schemaVersion": 1,
                "runInBackground": true,
                "backgroundSync": true,
                "syncInterval": "system_managed",
                "startAtLogin": false,
                "closeBehavior": "hide_to_tray",
                "paused": true,
            })),
        );
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Offline,
            Some("2026-08-01T06:00:00Z"),
            &[],
        );
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-2",
            "Notes",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T06:00:00Z"),
            &[],
        );

        // One reachable replica keeps the rollup out of the offline state, so a
        // paused profile still reports the reason nothing is running.
        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::Paused);

        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-2",
            "Notes",
            collab_replica::models::SyncStatus::Offline,
            Some("2026-08-01T06:00:00Z"),
            &[],
        );
        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::Offline);
        assert_eq!(summary.state.label(&summary), "Offline · changes sync later");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_accounts_expose_an_app_only_label_beside_the_opaque_identity() {
        let root = test_root();
        write_background_state(
            &root,
            serde_json::json!([]),
            serde_json::json!([{
                "serverUrl": "https://collab.example",
                "allowInvalidCertificates": false,
                "persistAcrossReboots": false,
                "backgroundSyncEnabled": true,
                "profileIds": ["profile-1"],
                "updatedAt": "2026-08-01T07:00:00Z",
            }]),
            None,
        );
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            None,
            &[],
        );
        // A replica whose server registration was dropped stays selectable.
        seed_sync_replica(
            &root,
            "https://other.example",
            "vault-2",
            "Other vault",
            collab_replica::models::SyncStatus::Idle,
            None,
            &[],
        );

        let accounts = list_sync_accounts(&root).unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].label, "https://collab.example");
        assert_eq!(accounts[0].vaults, 1);
        // The identity the configuration stores is the hash, not the label.
        assert_eq!(accounts[0].account_id, account_hash("https://collab.example"));
        assert!(accounts
            .iter()
            .all(|account| account.account_id.starts_with("account-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_selection_filters_by_opaque_account_identity() {
        let root = test_root();
        write_background_state(&root, serde_json::json!([]), serde_json::json!([]), None);
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:50:00Z"),
            &[],
        );
        seed_sync_replica(
            &root,
            "https://other.example",
            "vault-2",
            "Other vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:50:00Z"),
            &[collab_replica::PendingOpStatus::Pending],
        );

        let mut configuration = sync_configuration("sync-1");
        configuration.selected_source_ids = vec![account_hash("https://collab.example")];
        let (rows, freshness, summary) = sync_item_inputs(&root, &configuration, sync_now());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Team vault");
        assert_eq!(freshness.len(), 1);
        // The excluded account contributes neither a row nor a pending change.
        assert_eq!(summary.pending_operations, 0);
        assert_eq!(summary.state, WidgetSyncState::UpToDate);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_progress_stays_indeterminate_when_a_running_job_has_no_total() {
        let root = test_root();
        let mut bounded = background_job("job-1", "https://collab.example", "running", None);
        bounded["progress"] = serde_json::json!({ "completed": 2, "total": 8, "detail": null });
        let unbounded = background_job("job-2", "https://collab.example", "running", None);
        write_background_state(
            &root,
            serde_json::json!([bounded.clone()]),
            serde_json::json!([]),
            None,
        );
        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::Syncing);
        assert_eq!(summary.progress_completed, 2);
        assert_eq!(summary.progress_total, Some(8));

        write_background_state(
            &root,
            serde_json::json!([bounded, unbounded]),
            serde_json::json!([]),
            None,
        );
        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.progress_total, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn several_offline_vaults_each_get_their_own_published_row() {
        // Reproduces a real profile rather than the single-replica happy path:
        // several offline copies across two servers, with the UUID-shaped vault
        // ids the hosted server actually issues.
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        write_background_state(&root, serde_json::json!([]), serde_json::json!([]), None);
        let vaults = [
            ("https://collab.example", "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e", "Team vault"),
            ("https://collab.example", "c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f", "Notes"),
            ("https://other.example", "d5b3e4f6-7a8c-4d9e-0f1a-2b3c4d5e6f70", "Personal"),
        ];
        for (server, id, name) in vaults {
            seed_sync_replica(
                &root,
                server,
                id,
                name,
                collab_replica::models::SyncStatus::Idle,
                Some("2026-08-01T07:30:00Z"),
                &[],
            );
        }
        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        widget_store
            .save_configuration(sync_configuration("sync-1"))
            .unwrap();

        let outcomes = build_and_publish_agenda_profile(
            &root,
            "profile-1",
            &calendar_store,
            sync_now(),
            "test",
        )
        .await
        .unwrap();
        let snapshot = &outcomes[0].snapshot;

        assert_eq!(snapshot.sync.as_ref().unwrap().vaults, 3);
        let titles: Vec<&str> = snapshot.items.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, vec!["Notes", "Personal", "Team vault"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_running_sync_reports_what_it_is_on_and_how_far_along_it_is() {
        let root = test_root();
        let mut behind = background_job("job-1", "https://collab.example", "running", None);
        behind["progress"] =
            serde_json::json!({ "completed": 1, "total": 4, "detail": "Checking offline replicas" });
        let mut ahead = background_job("job-2", "https://collab.example", "running", None);
        // A vault-relative path is what the file executor reports. Only the
        // last segment may be published: the folders above it are not the
        // launcher's business.
        ahead["progress"] = serde_json::json!({
            "completed": 9,
            "total": 12,
            "detail": "Notes/Personal/Finances/plan.md",
        });
        write_background_state(
            &root,
            serde_json::json!([behind, ahead]),
            serde_json::json!([]),
            None,
        );

        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.state, WidgetSyncState::Syncing);
        // The job furthest along is the one actually moving, so it names the line.
        assert_eq!(summary.activity_label.as_deref(), Some("plan.md"));
        assert_eq!(summary.progress_label.as_deref(), Some("10 of 16"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progress_phrasing_is_dropped_once_nothing_is_running() {
        let root = test_root();
        let mut finished =
            background_job("job-1", "https://collab.example", "succeeded", Some("2026-08-01T07:55:00Z"));
        // A finished job keeps the counts it ended on. Publishing them would
        // freeze "9 of 12" on the launcher long after the run was over.
        finished["progress"] =
            serde_json::json!({ "completed": 9, "total": 12, "detail": "plan.md" });
        write_background_state(
            &root,
            serde_json::json!([finished]),
            serde_json::json!([]),
            None,
        );

        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_ne!(summary.state, WidgetSyncState::Syncing);
        assert_eq!(summary.activity_label, None);
        assert_eq!(summary.progress_label, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_running_sync_that_reported_nothing_still_says_it_is_working() {
        let root = test_root();
        let running = background_job("job-1", "https://collab.example", "running", None);
        write_background_state(
            &root,
            serde_json::json!([running]),
            serde_json::json!([]),
            None,
        );

        let (_, _, summary) = sync_item_inputs(&root, &sync_configuration("sync-1"), sync_now());
        assert_eq!(summary.activity_label.as_deref(), Some("Checking for changes"));
        // Nothing stated a total, so no proportion is invented.
        assert_eq!(summary.progress_label, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_progress_detail_that_could_carry_an_origin_is_dropped_not_trimmed() {
        // Trimming a URL to its last segment still publishes part of a URL, so
        // anything origin-shaped contributes nothing at all.
        assert_eq!(sync_activity_detail("https://collab.example/vault"), "");
        assert_eq!(sync_activity_detail("user@host"), "");
        assert_eq!(sync_activity_detail("Notes/plan.md"), "plan.md");
        assert_eq!(sync_activity_detail("Team vault"), "Team vault");
        // A trailing separator must not reduce the whole detail to nothing.
        assert_eq!(sync_activity_detail("Notes/Personal/"), "Personal");
    }

    #[tokio::test]
    async fn sync_profiles_publish_a_rollup_without_reading_the_calendar() {
        let root = test_root();
        let calendar_store = CalendarStore::open(&root, "profile-1").await.unwrap();
        write_background_state(&root, serde_json::json!([]), serde_json::json!([]), None);
        seed_sync_replica(
            &root,
            "https://collab.example",
            "vault-1",
            "Team vault",
            collab_replica::models::SyncStatus::Idle,
            Some("2026-08-01T07:30:00Z"),
            &[],
        );
        let widget_store = WidgetStore::open(&root, "profile-1").unwrap();
        widget_store
            .save_configuration(sync_configuration("sync-1"))
            .unwrap();

        let outcomes = build_and_publish_agenda_profile(
            &root,
            "profile-1",
            &calendar_store,
            sync_now(),
            "test",
        )
        .await
        .unwrap();
        let snapshot = &outcomes[0].snapshot;
        assert_eq!(snapshot.kind, WidgetKind::Sync);
        let summary = snapshot.sync.as_ref().unwrap();
        assert_eq!(summary.state, WidgetSyncState::UpToDate);
        assert_eq!(snapshot.state_label, "Up to date");
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.days.is_empty() && snapshot.months.is_empty());
        assert!(!serde_json::to_string(snapshot)
            .unwrap()
            .contains("collab.example"));

        let action = widget_store
            .prepare_action(WidgetActionRequest {
                configuration_id: "sync-1".into(),
                action: WidgetActionKind::OpenSync,
            })
            .unwrap();
        assert_eq!(action.destination_kind, "settings-background");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_a_sync_widget_may_carry_a_rollup() {
        let profile_hash = profile_hash("profile-1");
        let mut snapshot = build_snapshot(
            "profile-1",
            request(configuration("config-1", WidgetPrivacy::Full), "2026-08-01T10:00:00Z"),
        )
        .unwrap();
        snapshot.sync = Some(WidgetSyncSummary {
            state: WidgetSyncState::UpToDate,
            last_success_at: None,
            last_success_label: None,
            pending_operations: 0,
            failed_operations: 0,
            active_jobs: 0,
            attention_required: 0,
            accounts: 0,
            vaults: 0,
            progress_completed: 4,
            progress_total: Some(1),
            activity_label: None,
            progress_label: None,
            can_sync_now: false,
        });
        assert!(validate_snapshot(&snapshot, &profile_hash).is_err());
        snapshot.kind = WidgetKind::Sync;
        // Progress that has already passed its own total is still rejected.
        assert!(validate_snapshot(&snapshot, &profile_hash).is_err());
        snapshot.sync.as_mut().unwrap().progress_total = Some(8);
        assert!(validate_snapshot(&snapshot, &profile_hash).is_ok());

        // The activity line is the one published string derived from a value
        // that can hold a path, so the boundary refuses to write one that was
        // not reduced rather than trusting its caller.
        for leaked in ["Notes/Personal/plan.md", "https://collab.example", "a@b"] {
            snapshot.sync.as_mut().unwrap().activity_label = Some(leaked.to_string());
            assert!(
                validate_snapshot(&snapshot, &profile_hash).is_err(),
                "{leaked} should not reach launcher-readable state",
            );
        }
        snapshot.sync.as_mut().unwrap().activity_label = Some("plan.md".to_string());
        assert!(validate_snapshot(&snapshot, &profile_hash).is_ok());
    }
}
