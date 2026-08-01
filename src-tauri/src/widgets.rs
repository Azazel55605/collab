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
const MAX_STORE_BYTES: u64 = 64 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 16_384;

static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn store_lock() -> &'static Mutex<()> {
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WidgetKind {
    Agenda,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetDisplayOptions {
    #[serde(default = "default_horizon_days")]
    pub horizon_days: u8,
    #[serde(default = "default_max_items")]
    pub max_items: u8,
    #[serde(default)]
    pub show_completed: bool,
}

fn default_horizon_days() -> u8 {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetConfiguration {
    #[serde(default = "widget_schema_version")]
    pub schema_version: u32,
    pub configuration_id: String,
    pub kind: WidgetKind,
    #[serde(default)]
    pub selected_source_ids: Vec<String>,
    pub privacy: WidgetPrivacy,
    #[serde(default)]
    pub display: WidgetDisplayOptions,
    #[serde(default)]
    pub actions: WidgetActionOptions,
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
}

fn default_private_item_title() -> String {
    "Private item".into()
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
    #[serde(default = "default_widget_theme")]
    pub theme: String,
    #[serde(default = "default_widget_accent")]
    pub accent: String,
    #[serde(default = "default_widget_font_scale")]
    pub font_scale: f32,
    pub freshness: Vec<WidgetSourceFreshness>,
    pub items: Vec<WidgetSnapshotItem>,
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
        "Nothing upcoming"
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
        theme: appearance.theme,
        accent: appearance.accent,
        font_scale: appearance.font_scale,
        freshness,
        items,
    };
    validate_snapshot(&snapshot, &snapshot.profile_id_hash)?;
    encode_bounded(&snapshot, MAX_SNAPSHOT_BYTES)?;
    Ok(snapshot)
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
        .map(|configuration| configuration.display.horizon_days)
        .max()
        .unwrap_or(default_horizon_days());
    let last_day = today + Duration::days(i64::from(max_horizon));
    let query_from = local_midnight_utc(time_zone, oldest)?;
    let query_to = local_midnight_utc(time_zone, last_day + Duration::days(1))?;

    let calendars = calendar_store
        .list_calendars()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|calendar| !calendar.archived && calendar.deleted_at.is_none())
        .collect::<Vec<_>>();
    let active_calendar_ids = calendars
        .iter()
        .map(|calendar| calendar.id.as_str())
        .collect::<HashSet<_>>();
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
    let projected = query_calendar_items(
        &candidates,
        CalendarQueryRange {
            from: query_from,
            to: query_to,
            limit: MAX_RANGE_QUERY_ITEMS as usize,
            include_deleted: false,
            include_unscheduled_tasks: false,
        },
    )
    .map_err(|error| error.to_string())?;
    let subscriptions = calendar_store
        .list_subscriptions()
        .await
        .map_err(|error| error.to_string())?;
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
    for configuration in configurations {
        let generation_started = Instant::now();
        let configuration_id = configuration.configuration_id.clone();
        let max_items = usize::from(configuration.display.max_items);
        let horizon_end = today + Duration::days(i64::from(configuration.display.horizon_days));
        let mut items = Vec::new();
        for item in &projected {
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
        let snapshot = build_snapshot(
            profile_id,
            WidgetBuildRequest {
                configuration,
                generated_at: now.to_rfc3339(),
                date_label: today.format("%Y-%m-%d").to_string(),
                appearance: Some(appearance.clone()),
                freshness: freshness.clone(),
                items,
            },
        )?;
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
    }))
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
    );
    let (title, detail) = match privacy {
        WidgetPrivacy::Full => (item.title, item.detail),
        WidgetPrivacy::TitleOnly => (item.title, item.title_only_detail),
        WidgetPrivacy::Private => (item.private_title, item.title_only_detail),
    };
    let (section, item_kind, calendar_id, item_id, day_key, start_at, all_day, source_color) =
        metadata;
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
    if !(1..=31).contains(&configuration.display.horizon_days) {
        return Err("Widget horizon must be between 1 and 31 days.".into());
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
        && left.theme == right.theme
        && left.accent == right.accent
        && left.font_scale == right.font_scale
        && left.freshness == right.freshness
        && left.items == right.items
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
        privacy: WidgetPrivacy::Full,
        display: WidgetDisplayOptions {
            max_items: 6,
            ..WidgetDisplayOptions::default()
        },
        actions: WidgetActionOptions::default(),
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
            privacy,
            display: WidgetDisplayOptions::default(),
            actions: WidgetActionOptions::default(),
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
}
