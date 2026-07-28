use chrono::{DateTime, Duration, LocalResult, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration as StdDuration;
use uuid::Uuid;

const MAX_RECONCILE_ENTRIES: usize = 20_000;
const MAX_INBOX_LIMIT: u32 = 500;
const ACTION_TOKEN_TTL_MINUTES: i64 = 15;
const NOTIFICATION_CATEGORIES: [&str; 6] = [
    "calendar.reminder",
    "calendar.invitation",
    "collaboration.message",
    "collaboration.mention",
    "sync.action-required",
    "transfer.complete",
];

fn default_true() -> bool {
    true
}

fn default_category_preferences() -> BTreeMap<String, bool> {
    NOTIFICATION_CATEGORIES
        .into_iter()
        .map(|category| (category.to_string(), true))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationQuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
    pub time_zone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_lock_screen_privacy")]
    pub lock_screen_privacy: String,
    #[serde(default = "default_category_preferences")]
    pub category_enabled: BTreeMap<String, bool>,
    #[serde(default)]
    pub scope_enabled: BTreeMap<String, bool>,
    #[serde(default)]
    pub quiet_hours: Option<NotificationQuietHours>,
    #[serde(default = "default_true")]
    pub allow_time_sensitive_during_quiet_hours: bool,
    #[serde(default = "default_true")]
    pub batch_notifications: bool,
}

fn default_lock_screen_privacy() -> String {
    "title-only".to_string()
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            lock_screen_privacy: default_lock_screen_privacy(),
            category_enabled: default_category_preferences(),
            scope_enabled: BTreeMap::new(),
            quiet_hours: None,
            allow_time_sensitive_during_quiet_hours: true,
            batch_notifications: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEnvelope {
    pub schema_version: u32,
    pub id: String,
    pub category: String,
    pub kind: String,
    pub channel: String,
    pub account_key: String,
    #[serde(default)]
    pub server_url: Option<String>,
    pub source_id: String,
    pub occurrence_key: Option<String>,
    pub delivery_key: String,
    pub created_at: String,
    pub scheduled_at: Option<String>,
    pub expires_at: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub privacy: String,
    pub priority: String,
    pub destination: Value,
    pub actions: Vec<Value>,
    pub requires_inbox: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotificationState {
    Scheduled,
    Ready,
    Delivered,
    Read,
    Dismissed,
    Cancelled,
    Failed,
}

impl NotificationState {
    fn parse(value: &str) -> Result<Self, NotificationStoreError> {
        match value {
            "scheduled" => Ok(Self::Scheduled),
            "ready" => Ok(Self::Ready),
            "delivered" => Ok(Self::Delivered),
            "read" => Ok(Self::Read),
            "dismissed" => Ok(Self::Dismissed),
            "cancelled" => Ok(Self::Cancelled),
            "failed" => Ok(Self::Failed),
            _ => Err(NotificationStoreError::Validation(
                "notification state is invalid".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub envelope: NotificationEnvelope,
    pub state: NotificationState,
    pub updated_at: String,
    pub delivered_at: Option<String>,
    pub delivery_surface: Option<String>,
    pub read_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub snoozed_from_id: Option<String>,
    pub failure_message: Option<String>,
    pub attempt_count: u32,
    pub next_retry_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationReconcileResult {
    pub inserted: u64,
    pub updated: u64,
    pub cancelled: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActionToken {
    pub token: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedNotificationAction {
    pub notification_id: String,
    pub action: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationReconciliationRequest {
    pub profile_id: String,
    pub category: String,
    pub requested_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum NotificationStoreError {
    #[error("Invalid notification data: {0}")]
    Validation(String),
    #[error("Notification not found")]
    NotFound,
    #[error("Notification action token is invalid or expired")]
    InvalidActionToken,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub struct NotificationStore {
    pool: SqlitePool,
}

impl NotificationStore {
    pub async fn open(
        config_root: &Path,
        profile_id: &str,
    ) -> Result<Self, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        let profile_dir = config_root.join("profiles").join(profile_id);
        std::fs::create_dir_all(&profile_dir)?;
        let path = profile_dir.join("notifications.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(StdDuration::from_secs(5))
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<(), NotificationStoreError> {
        for statement in [
            r#"
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY NOT NULL,
                profile_id TEXT NOT NULL,
                category TEXT NOT NULL,
                source_id TEXT NOT NULL,
                scheduled_at TEXT,
                expires_at TEXT,
                envelope_json TEXT NOT NULL,
                requires_inbox INTEGER NOT NULL DEFAULT 1,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                delivered_at TEXT,
                delivery_surface TEXT,
                read_at TEXT,
                dismissed_at TEXT,
                snoozed_from_id TEXT,
                failure_message TEXT,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT
            )"#,
            r#"CREATE INDEX IF NOT EXISTS notifications_due_idx
                ON notifications(profile_id, state, scheduled_at)"#,
            r#"CREATE INDEX IF NOT EXISTS notifications_source_idx
                ON notifications(profile_id, category, source_id)"#,
            r#"CREATE TABLE IF NOT EXISTS notification_action_tokens (
                token_hash TEXT PRIMARY KEY NOT NULL,
                notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
                action_json TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                consumed_at TEXT
            )"#,
            r#"CREATE INDEX IF NOT EXISTS notification_action_tokens_expiry_idx
                ON notification_action_tokens(expires_at)"#,
            r#"CREATE TABLE IF NOT EXISTS notification_reconciliation_requests (
                profile_id TEXT NOT NULL,
                category TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                PRIMARY KEY(profile_id, category)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS notification_remote_cursors (
                profile_id TEXT NOT NULL,
                server_url TEXT NOT NULL,
                cursor TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(profile_id, server_url)
            )"#,
            r#"CREATE TABLE IF NOT EXISTS notification_preferences (
                profile_id TEXT PRIMARY KEY NOT NULL,
                preferences_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"#,
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        let columns = sqlx::query("PRAGMA table_info(notifications)")
            .fetch_all(&self.pool)
            .await?;
        if !columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "requires_inbox")
        {
            sqlx::query(
                "ALTER TABLE notifications ADD COLUMN requires_inbox INTEGER NOT NULL DEFAULT 1",
            )
            .execute(&self.pool)
            .await?;
        }
        if !columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "delivery_surface")
        {
            sqlx::query("ALTER TABLE notifications ADD COLUMN delivery_surface TEXT")
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn preferences(
        &self,
        profile_id: &str,
    ) -> Result<NotificationPreferences, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        let row =
            sqlx::query("SELECT preferences_json FROM notification_preferences WHERE profile_id=?")
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        let mut preferences = match row {
            Some(row) => serde_json::from_str(row.get::<&str, _>("preferences_json"))?,
            None => NotificationPreferences::default(),
        };
        for category in NOTIFICATION_CATEGORIES {
            preferences
                .category_enabled
                .entry(category.to_string())
                .or_insert(true);
        }
        validate_preferences(&preferences)?;
        Ok(preferences)
    }

    pub async fn save_preferences(
        &self,
        profile_id: &str,
        mut preferences: NotificationPreferences,
    ) -> Result<NotificationPreferences, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        for category in NOTIFICATION_CATEGORIES {
            preferences
                .category_enabled
                .entry(category.to_string())
                .or_insert(true);
        }
        validate_preferences(&preferences)?;
        sqlx::query(
            r#"INSERT INTO notification_preferences(profile_id,preferences_json,updated_at)
               VALUES (?,?,?)
               ON CONFLICT(profile_id) DO UPDATE SET
                 preferences_json=excluded.preferences_json,
                 updated_at=excluded.updated_at"#,
        )
        .bind(profile_id)
        .bind(serde_json::to_string(&preferences)?)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(preferences)
    }

    pub async fn reconcile(
        &self,
        profile_id: &str,
        category: &str,
        entries: &[NotificationEnvelope],
    ) -> Result<NotificationReconcileResult, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        if entries.len() > MAX_RECONCILE_ENTRIES {
            return Err(NotificationStoreError::Validation(format!(
                "notification reconciliation is limited to {MAX_RECONCILE_ENTRIES} entries"
            )));
        }
        if category.trim().is_empty() || category.len() > 160 {
            return Err(NotificationStoreError::Validation(
                "notification category is invalid".into(),
            ));
        }
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "CREATE TEMP TABLE IF NOT EXISTS incoming_notification_ids (id TEXT PRIMARY KEY NOT NULL)",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM incoming_notification_ids")
            .execute(&mut *tx)
            .await?;
        let mut inserted = 0;
        let mut updated = 0;
        for entry in entries {
            validate_envelope(entry, category)?;
            let scheduled_at = entry.scheduled_at.as_deref().unwrap_or(&entry.created_at);
            let scheduled = parse_instant(scheduled_at, "schedule time")?;
            let state = if scheduled <= now {
                "ready"
            } else {
                "scheduled"
            };
            let envelope_json = serde_json::to_string(entry)?;
            let existing =
                sqlx::query("SELECT state, scheduled_at FROM notifications WHERE id = ?")
                    .bind(&entry.id)
                    .fetch_optional(&mut *tx)
                    .await?;
            sqlx::query("INSERT OR IGNORE INTO incoming_notification_ids(id) VALUES (?)")
                .bind(&entry.id)
                .execute(&mut *tx)
                .await?;
            match existing {
                None => {
                    sqlx::query(
                        r#"INSERT INTO notifications
                           (id,profile_id,category,source_id,scheduled_at,expires_at,envelope_json,
                            requires_inbox,state,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)"#,
                    )
                    .bind(&entry.id)
                    .bind(profile_id)
                    .bind(&entry.category)
                    .bind(&entry.source_id)
                    .bind(scheduled_at)
                    .bind(entry.expires_at.as_deref())
                    .bind(envelope_json)
                    .bind(entry.requires_inbox)
                    .bind(state)
                    .bind(&entry.created_at)
                    .bind(&now_text)
                    .execute(&mut *tx)
                    .await?;
                    inserted += 1;
                }
                Some(row) => {
                    let old_state: String = row.get("state");
                    let old_schedule: Option<String> = row.get("scheduled_at");
                    let next_state =
                        if matches!(old_state.as_str(), "delivered" | "read" | "dismissed")
                            && old_schedule.as_deref() == Some(scheduled_at)
                        {
                            old_state.as_str()
                        } else {
                            state
                        };
                    sqlx::query(
                        r#"UPDATE notifications
                              SET profile_id=?, category=?, source_id=?, scheduled_at=?, expires_at=?,
                                  envelope_json=?, requires_inbox=?, state=?, updated_at=?,
                                  failure_message=NULL, next_retry_at=NULL
                            WHERE id=?"#,
                    )
                    .bind(profile_id)
                    .bind(&entry.category)
                    .bind(&entry.source_id)
                    .bind(scheduled_at)
                    .bind(entry.expires_at.as_deref())
                    .bind(envelope_json)
                    .bind(entry.requires_inbox)
                    .bind(next_state)
                    .bind(&now_text)
                    .bind(&entry.id)
                    .execute(&mut *tx)
                    .await?;
                    updated += 1;
                }
            }
        }
        let cancelled = sqlx::query(
            r#"UPDATE notifications
                  SET state='cancelled', updated_at=?
                WHERE profile_id=? AND category=?
                  AND state IN ('scheduled','ready','failed')
                  AND snoozed_from_id IS NULL
                  AND id NOT IN (SELECT id FROM incoming_notification_ids)"#,
        )
        .bind(&now_text)
        .bind(profile_id)
        .bind(category)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        sqlx::query(
            "DELETE FROM notification_reconciliation_requests WHERE profile_id=? AND category=?",
        )
        .bind(profile_id)
        .bind(category)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(NotificationReconcileResult {
            inserted,
            updated,
            cancelled,
        })
    }

    pub async fn ingest(
        &self,
        profile_id: &str,
        entries: &[NotificationEnvelope],
    ) -> Result<NotificationReconcileResult, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        if entries.len() > MAX_RECONCILE_ENTRIES {
            return Err(NotificationStoreError::Validation(format!(
                "notification ingestion is limited to {MAX_RECONCILE_ENTRIES} entries"
            )));
        }
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let mut inserted = 0;
        let mut updated = 0;
        let mut tx = self.pool.begin().await?;
        for entry in entries {
            validate_envelope(entry, &entry.category)?;
            let scheduled_at = entry.scheduled_at.as_deref().unwrap_or(&entry.created_at);
            let state = if parse_instant(scheduled_at, "schedule time")? <= now {
                "ready"
            } else {
                "scheduled"
            };
            let envelope_json = serde_json::to_string(entry)?;
            let existing = sqlx::query("SELECT state,scheduled_at FROM notifications WHERE id=?")
                .bind(&entry.id)
                .fetch_optional(&mut *tx)
                .await?;
            match existing {
                None => {
                    sqlx::query(
                        r#"INSERT INTO notifications
                           (id,profile_id,category,source_id,scheduled_at,expires_at,envelope_json,
                            requires_inbox,state,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)"#,
                    )
                    .bind(&entry.id)
                    .bind(profile_id)
                    .bind(&entry.category)
                    .bind(&entry.source_id)
                    .bind(scheduled_at)
                    .bind(entry.expires_at.as_deref())
                    .bind(envelope_json)
                    .bind(entry.requires_inbox)
                    .bind(state)
                    .bind(&entry.created_at)
                    .bind(&now_text)
                    .execute(&mut *tx)
                    .await?;
                    inserted += 1;
                }
                Some(row) => {
                    let old_state: String = row.get("state");
                    let old_schedule: Option<String> = row.get("scheduled_at");
                    let next_state =
                        if matches!(old_state.as_str(), "delivered" | "read" | "dismissed")
                            && old_schedule.as_deref() == Some(scheduled_at)
                        {
                            old_state.as_str()
                        } else {
                            state
                        };
                    sqlx::query(
                        r#"UPDATE notifications
                           SET profile_id=?,category=?,source_id=?,scheduled_at=?,expires_at=?,
                               envelope_json=?,requires_inbox=?,state=?,updated_at=?,
                               failure_message=NULL,next_retry_at=NULL
                           WHERE id=?"#,
                    )
                    .bind(profile_id)
                    .bind(&entry.category)
                    .bind(&entry.source_id)
                    .bind(scheduled_at)
                    .bind(entry.expires_at.as_deref())
                    .bind(envelope_json)
                    .bind(entry.requires_inbox)
                    .bind(next_state)
                    .bind(&now_text)
                    .bind(&entry.id)
                    .execute(&mut *tx)
                    .await?;
                    updated += 1;
                }
            }
        }
        tx.commit().await?;
        Ok(NotificationReconcileResult {
            inserted,
            updated,
            cancelled: 0,
        })
    }

    pub async fn remote_cursor(
        &self,
        profile_id: &str,
        server_url: &str,
    ) -> Result<Option<String>, NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        if server_url.trim().is_empty() || server_url.len() > 2_048 {
            return Err(NotificationStoreError::Validation(
                "notification server URL is invalid".into(),
            ));
        }
        sqlx::query_scalar(
            "SELECT cursor FROM notification_remote_cursors WHERE profile_id=? AND server_url=?",
        )
        .bind(profile_id)
        .bind(server_url)
        .fetch_optional(&self.pool)
        .await
        .map_err(NotificationStoreError::from)
    }

    pub async fn save_remote_cursor(
        &self,
        profile_id: &str,
        server_url: &str,
        cursor: &str,
    ) -> Result<(), NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        if server_url.trim().is_empty()
            || server_url.len() > 2_048
            || cursor.trim().is_empty()
            || cursor.len() > 256
        {
            return Err(NotificationStoreError::Validation(
                "notification remote cursor is invalid".into(),
            ));
        }
        sqlx::query(
            r#"INSERT INTO notification_remote_cursors(profile_id,server_url,cursor,updated_at)
               VALUES (?,?,?,?)
               ON CONFLICT(profile_id,server_url) DO UPDATE SET
                 cursor=excluded.cursor,updated_at=excluded.updated_at"#,
        )
        .bind(profile_id)
        .bind(server_url)
        .bind(cursor)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn request_reconciliation(
        &self,
        profile_id: &str,
        category: &str,
    ) -> Result<(), NotificationStoreError> {
        validate_segment(profile_id, "profile ID")?;
        if category.trim().is_empty() || category.len() > 160 {
            return Err(NotificationStoreError::Validation(
                "notification category is invalid".into(),
            ));
        }
        sqlx::query(
            r#"INSERT INTO notification_reconciliation_requests(profile_id,category,requested_at)
               VALUES (?,?,?)
               ON CONFLICT(profile_id,category) DO UPDATE SET requested_at=excluded.requested_at"#,
        )
        .bind(profile_id)
        .bind(category)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_reconciliation_requests(
        &self,
        profile_id: &str,
    ) -> Result<Vec<NotificationReconciliationRequest>, NotificationStoreError> {
        let rows = sqlx::query(
            r#"SELECT profile_id,category,requested_at
               FROM notification_reconciliation_requests
               WHERE profile_id=? ORDER BY requested_at"#,
        )
        .bind(profile_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| NotificationReconciliationRequest {
                profile_id: row.get("profile_id"),
                category: row.get("category"),
                requested_at: row.get("requested_at"),
            })
            .collect())
    }

    pub async fn cancel_category(
        &self,
        profile_id: &str,
        category: &str,
    ) -> Result<u64, NotificationStoreError> {
        let now = Utc::now().to_rfc3339();
        Ok(sqlx::query(
            r#"UPDATE notifications SET state='cancelled', updated_at=?
               WHERE profile_id=? AND category=? AND state IN ('scheduled','ready','failed')"#,
        )
        .bind(now)
        .bind(profile_id)
        .bind(category)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    pub async fn list_inbox(
        &self,
        profile_id: &str,
        include_dismissed: bool,
        limit: u32,
    ) -> Result<Vec<NotificationRecord>, NotificationStoreError> {
        if limit == 0 || limit > MAX_INBOX_LIMIT {
            return Err(NotificationStoreError::Validation(format!(
                "inbox limit must be between 1 and {MAX_INBOX_LIMIT}"
            )));
        }
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE notifications SET state='ready', updated_at=?
               WHERE profile_id=? AND state='scheduled' AND scheduled_at<=?"#,
        )
        .bind(&now)
        .bind(profile_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let rows = sqlx::query(
            r#"SELECT * FROM notifications
               WHERE profile_id=?
                 AND state NOT IN ('scheduled','cancelled')
                 AND requires_inbox=1
                 AND (? OR state != 'dismissed')
                 AND (expires_at IS NULL OR expires_at>?)
               ORDER BY COALESCE(scheduled_at, created_at) DESC, id
               LIMIT ?"#,
        )
        .bind(profile_id)
        .bind(include_dismissed)
        .bind(&now)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(record_from_row).collect()
    }

    pub async fn list_due(
        &self,
        profile_id: &str,
        limit: u32,
    ) -> Result<Vec<NotificationRecord>, NotificationStoreError> {
        if limit == 0 || limit > 100 {
            return Err(NotificationStoreError::Validation(
                "due notification limit must be between 1 and 100".into(),
            ));
        }
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE notifications SET state='ready', updated_at=?
               WHERE profile_id=? AND state='scheduled' AND scheduled_at<=?"#,
        )
        .bind(&now)
        .bind(profile_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"UPDATE notifications
               SET state='ready', failure_message=NULL, next_retry_at=NULL, updated_at=?
               WHERE profile_id=? AND state='failed' AND next_retry_at<=?"#,
        )
        .bind(&now)
        .bind(profile_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        let rows = sqlx::query(
            r#"SELECT * FROM notifications
               WHERE profile_id=? AND state='ready'
                 AND (expires_at IS NULL OR expires_at>?)
               ORDER BY COALESCE(scheduled_at, created_at), id
               LIMIT 20000"#,
        )
        .bind(profile_id)
        .bind(&now)
        .fetch_all(&self.pool)
        .await?;
        let preferences = self.preferences(profile_id).await?;
        let now = Utc::now();
        let mut due = Vec::new();
        for row in &rows {
            let record = record_from_row(row)?;
            if delivery_time(&record.envelope, &preferences, now).is_some_and(|value| value <= now)
            {
                due.push(record);
                if due.len() == limit as usize {
                    break;
                }
            }
        }
        Ok(due)
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub async fn next_delivery_at(
        &self,
        profile_id: &str,
    ) -> Result<Option<DateTime<Utc>>, NotificationStoreError> {
        let rows = sqlx::query(
            r#"SELECT state, scheduled_at, next_retry_at, envelope_json FROM notifications
               WHERE profile_id=?
                 AND state IN ('scheduled','ready','failed')
                 AND (expires_at IS NULL OR expires_at>?)
               LIMIT 20000"#,
        )
        .bind(profile_id)
        .bind(Utc::now().to_rfc3339())
        .fetch_all(&self.pool)
        .await?;
        let now = Utc::now();
        let preferences = self.preferences(profile_id).await?;
        let mut next: Option<DateTime<Utc>> = None;
        for row in rows {
            let state: &str = row.get("state");
            let value = match state {
                "ready" => Some(now),
                "scheduled" => row
                    .get::<Option<String>, _>("scheduled_at")
                    .map(|value| parse_instant(&value, "schedule time"))
                    .transpose()?,
                "failed" => row
                    .get::<Option<String>, _>("next_retry_at")
                    .map(|value| parse_instant(&value, "retry time"))
                    .transpose()?,
                _ => None,
            };
            if let Some(value) = value {
                let envelope: NotificationEnvelope =
                    serde_json::from_str(row.get::<&str, _>("envelope_json"))?;
                if let Some(value) = delivery_time(&envelope, &preferences, value.max(now)) {
                    next = Some(next.map_or(value, |current| current.min(value)));
                }
            }
        }
        Ok(next)
    }

    pub async fn mark_delivered(
        &self,
        notification_id: &str,
        surface: &str,
    ) -> Result<(), NotificationStoreError> {
        if !matches!(surface, "native" | "in-app") {
            return Err(NotificationStoreError::Validation(
                "notification delivery surface is invalid".into(),
            ));
        }
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"UPDATE notifications
               SET state='delivered', delivered_at=?, delivery_surface=?,
                   failure_message=NULL, next_retry_at=NULL, updated_at=?
               WHERE id=? AND state='ready'"#,
        )
        .bind(&now)
        .bind(surface)
        .bind(&now)
        .bind(notification_id)
        .execute(&self.pool)
        .await?;
        ensure_changed(result.rows_affected())
    }

    pub async fn mark_read(
        &self,
        notification_id: &str,
        read: bool,
    ) -> Result<(), NotificationStoreError> {
        let now = Utc::now().to_rfc3339();
        let result = if read {
            sqlx::query(
                r#"UPDATE notifications
                   SET state='read', read_at=?, updated_at=?
                   WHERE id=? AND state NOT IN ('scheduled','cancelled','dismissed')"#,
            )
            .bind(&now)
            .bind(&now)
            .bind(notification_id)
            .execute(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"UPDATE notifications
                   SET state='ready', read_at=NULL, updated_at=?
                   WHERE id=? AND state='read'"#,
            )
            .bind(&now)
            .bind(notification_id)
            .execute(&self.pool)
            .await?
        };
        ensure_changed(result.rows_affected())
    }

    pub async fn dismiss(&self, notification_id: &str) -> Result<(), NotificationStoreError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"UPDATE notifications
               SET state='dismissed', dismissed_at=?, updated_at=?
               WHERE id=? AND state != 'cancelled'"#,
        )
        .bind(&now)
        .bind(&now)
        .bind(notification_id)
        .execute(&self.pool)
        .await?;
        ensure_changed(result.rows_affected())
    }

    pub async fn snooze(
        &self,
        notification_id: &str,
        minutes: u32,
    ) -> Result<NotificationRecord, NotificationStoreError> {
        if !(1..=10_080).contains(&minutes) {
            return Err(NotificationStoreError::Validation(
                "snooze duration must be between 1 minute and 7 days".into(),
            ));
        }
        let original = self.record(notification_id).await?;
        let profile_id: String =
            sqlx::query_scalar("SELECT profile_id FROM notifications WHERE id=?")
                .bind(notification_id)
                .fetch_one(&self.pool)
                .await?;
        let now = Utc::now();
        let scheduled_at = (now + Duration::minutes(i64::from(minutes))).to_rfc3339();
        let mut envelope = original.envelope;
        envelope.delivery_key = format!("{}:snooze:{}", envelope.delivery_key, Uuid::new_v4());
        let child_id = notification_id_for(&envelope);
        envelope.id = child_id.clone();
        envelope.created_at = now.to_rfc3339();
        envelope.scheduled_at = Some(scheduled_at.clone());
        let envelope_json = serde_json::to_string(&envelope)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE notifications SET state='dismissed', dismissed_at=?, updated_at=? WHERE id=?",
        )
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .bind(notification_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO notifications
               (id,profile_id,category,source_id,scheduled_at,expires_at,envelope_json,
                requires_inbox,state,created_at,updated_at,snoozed_from_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"#,
        )
        .bind(&child_id)
        .bind(profile_id)
        .bind(&envelope.category)
        .bind(&envelope.source_id)
        .bind(&scheduled_at)
        .bind(envelope.expires_at.as_deref())
        .bind(envelope_json)
        .bind(envelope.requires_inbox)
        .bind("scheduled")
        .bind(&envelope.created_at)
        .bind(&envelope.created_at)
        .bind(notification_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.record(&child_id).await
    }

    pub async fn mark_failed(
        &self,
        notification_id: &str,
        message: &str,
    ) -> Result<(), NotificationStoreError> {
        if message.trim().is_empty() || message.len() > 1_000 {
            return Err(NotificationStoreError::Validation(
                "failure message is invalid".into(),
            ));
        }
        let now = Utc::now();
        let current = self.record(notification_id).await?;
        let attempt_count = current.attempt_count.saturating_add(1);
        let delay_minutes = 2_i64.pow(attempt_count.min(8));
        let retry_at = (now + Duration::minutes(delay_minutes)).to_rfc3339();
        sqlx::query(
            r#"UPDATE notifications
               SET state='failed', failure_message=?, attempt_count=?,
                   next_retry_at=?, updated_at=? WHERE id=?"#,
        )
        .bind(message)
        .bind(attempt_count)
        .bind(retry_at)
        .bind(now.to_rfc3339())
        .bind(notification_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn retry(&self, notification_id: &str) -> Result<(), NotificationStoreError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"UPDATE notifications
               SET state='ready', failure_message=NULL, next_retry_at=NULL, updated_at=?
               WHERE id=? AND state='failed'"#,
        )
        .bind(now)
        .bind(notification_id)
        .execute(&self.pool)
        .await?;
        ensure_changed(result.rows_affected())
    }

    pub async fn create_action_token(
        &self,
        notification_id: &str,
        action: &Value,
    ) -> Result<NotificationActionToken, NotificationStoreError> {
        let record = self.record(notification_id).await?;
        if !record
            .envelope
            .actions
            .iter()
            .any(|allowed| allowed == action)
        {
            return Err(NotificationStoreError::Validation(
                "notification action is not allowed".into(),
            ));
        }
        let token = Uuid::new_v4().to_string();
        let expires_at = (Utc::now() + Duration::minutes(ACTION_TOKEN_TTL_MINUTES)).to_rfc3339();
        sqlx::query(
            r#"INSERT INTO notification_action_tokens
               (token_hash,notification_id,action_json,expires_at)
               VALUES (?,?,?,?)"#,
        )
        .bind(hash_token(&token))
        .bind(notification_id)
        .bind(serde_json::to_string(action)?)
        .bind(&expires_at)
        .execute(&self.pool)
        .await?;
        Ok(NotificationActionToken { token, expires_at })
    }

    pub async fn consume_action_token(
        &self,
        token: &str,
    ) -> Result<ConsumedNotificationAction, NotificationStoreError> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT notification_id, action_json FROM notification_action_tokens
               WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?"#,
        )
        .bind(hash_token(token))
        .bind(&now)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(NotificationStoreError::InvalidActionToken)?;
        let notification_id: String = row.get("notification_id");
        let action_json: String = row.get("action_json");
        sqlx::query(
            "UPDATE notification_action_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL",
        )
        .bind(&now)
        .bind(hash_token(token))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(ConsumedNotificationAction {
            notification_id,
            action: serde_json::from_str(&action_json)?,
        })
    }

    pub async fn cleanup(&self, retention_days: u32) -> Result<u64, NotificationStoreError> {
        if !(7..=3_650).contains(&retention_days) {
            return Err(NotificationStoreError::Validation(
                "notification retention must be between 7 and 3650 days".into(),
            ));
        }
        let cutoff = (Utc::now() - Duration::days(i64::from(retention_days))).to_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM notification_action_tokens WHERE expires_at<? OR consumed_at IS NOT NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        let removed = sqlx::query(
            r#"DELETE FROM notifications
               WHERE updated_at<? AND state IN ('read','dismissed','cancelled')"#,
        )
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok(removed)
    }

    pub async fn record(
        &self,
        notification_id: &str,
    ) -> Result<NotificationRecord, NotificationStoreError> {
        let row = sqlx::query("SELECT * FROM notifications WHERE id=?")
            .bind(notification_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(NotificationStoreError::NotFound)?;
        record_from_row(&row)
    }
}

fn record_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<NotificationRecord, NotificationStoreError> {
    let envelope_json: String = row.get("envelope_json");
    Ok(NotificationRecord {
        envelope: serde_json::from_str(&envelope_json)?,
        state: NotificationState::parse(row.get::<&str, _>("state"))?,
        updated_at: row.get("updated_at"),
        delivered_at: row.get("delivered_at"),
        delivery_surface: row.get("delivery_surface"),
        read_at: row.get("read_at"),
        dismissed_at: row.get("dismissed_at"),
        snoozed_from_id: row.get("snoozed_from_id"),
        failure_message: row.get("failure_message"),
        attempt_count: row.get::<i64, _>("attempt_count").max(0) as u32,
        next_retry_at: row.get("next_retry_at"),
    })
}

fn validate_preferences(
    preferences: &NotificationPreferences,
) -> Result<(), NotificationStoreError> {
    if !matches!(
        preferences.lock_screen_privacy.as_str(),
        "full" | "title-only" | "hidden"
    ) {
        return Err(NotificationStoreError::Validation(
            "notification lock-screen privacy is invalid".into(),
        ));
    }
    if preferences
        .category_enabled
        .keys()
        .any(|category| !NOTIFICATION_CATEGORIES.contains(&category.as_str()))
    {
        return Err(NotificationStoreError::Validation(
            "notification category preference is invalid".into(),
        ));
    }
    if preferences.scope_enabled.len() > 2_000
        || preferences.scope_enabled.keys().any(|scope| {
            let has_value = scope
                .split_once(':')
                .is_some_and(|(_, value)| !value.trim().is_empty());
            scope.len() > 320
                || !has_value
                || !(scope.starts_with("server:")
                    || scope.starts_with("vault:")
                    || scope.starts_with("calendar:"))
        })
    {
        return Err(NotificationStoreError::Validation(
            "notification scope preference is invalid".into(),
        ));
    }
    if let Some(quiet_hours) = &preferences.quiet_hours {
        if quiet_hours.start_minute >= 1_440
            || quiet_hours.end_minute >= 1_440
            || quiet_hours.start_minute == quiet_hours.end_minute
            || quiet_hours.time_zone.len() > 80
            || quiet_hours.time_zone.parse::<Tz>().is_err()
        {
            return Err(NotificationStoreError::Validation(
                "notification quiet hours are invalid".into(),
            ));
        }
    }
    Ok(())
}

fn scope_is_enabled(
    envelope: &NotificationEnvelope,
    preferences: &NotificationPreferences,
) -> bool {
    [("vault", "vaultId"), ("calendar", "calendarId")]
        .into_iter()
        .filter_map(|(prefix, field)| {
            envelope
                .destination
                .get(field)
                .and_then(Value::as_str)
                .map(|value| format!("{prefix}:{value}"))
        })
        .all(|scope| {
            preferences
                .scope_enabled
                .get(&scope)
                .copied()
                .unwrap_or(true)
        })
        && envelope.server_url.as_ref().is_none_or(|server_url| {
            preferences
                .scope_enabled
                .get(&format!("server:{server_url}"))
                .copied()
                .unwrap_or(true)
        })
}

fn quiet_hours_end(
    quiet_hours: &NotificationQuietHours,
    instant: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let time_zone = quiet_hours.time_zone.parse::<Tz>().ok()?;
    let local = instant.with_timezone(&time_zone);
    let minute = (local.hour() * 60 + local.minute()) as u16;
    let inside = if quiet_hours.start_minute < quiet_hours.end_minute {
        minute >= quiet_hours.start_minute && minute < quiet_hours.end_minute
    } else {
        minute >= quiet_hours.start_minute || minute < quiet_hours.end_minute
    };
    if !inside {
        return None;
    }
    let end_date = if quiet_hours.start_minute > quiet_hours.end_minute
        && minute >= quiet_hours.start_minute
    {
        local.date_naive().succ_opt()?
    } else {
        local.date_naive()
    };
    let hour = u32::from(quiet_hours.end_minute / 60);
    let minute = u32::from(quiet_hours.end_minute % 60);
    let mut candidate = end_date.and_hms_opt(hour, minute, 0)?;
    for _ in 0..=180 {
        match time_zone.from_local_datetime(&candidate) {
            LocalResult::Single(value) => return Some(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(first, second) => {
                return Some(first.min(second).with_timezone(&Utc))
            }
            LocalResult::None => candidate += Duration::minutes(1),
        }
    }
    None
}

fn delivery_time(
    envelope: &NotificationEnvelope,
    preferences: &NotificationPreferences,
    instant: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    if !preferences.enabled
        || !preferences
            .category_enabled
            .get(&envelope.category)
            .copied()
            .unwrap_or(true)
        || !scope_is_enabled(envelope, preferences)
    {
        return None;
    }
    if envelope.priority == "time-sensitive" && preferences.allow_time_sensitive_during_quiet_hours
    {
        return Some(instant);
    }
    preferences
        .quiet_hours
        .as_ref()
        .and_then(|quiet_hours| quiet_hours_end(quiet_hours, instant))
        .or(Some(instant))
}

pub fn effective_privacy(envelope_privacy: &str, preference_privacy: &str) -> &'static str {
    let rank = |value: &str| match value {
        "hidden" => 2,
        "title-only" => 1,
        _ => 0,
    };
    match rank(envelope_privacy).max(rank(preference_privacy)) {
        2 => "hidden",
        1 => "title-only",
        _ => "full",
    }
}

fn validate_envelope(
    envelope: &NotificationEnvelope,
    category: &str,
) -> Result<(), NotificationStoreError> {
    let (expected_category, expected_channel, allowed_actions): (&str, &str, &[&str]) =
        match envelope.kind.as_str() {
            "calendar.event-reminder" | "calendar.birthday-reminder" => (
                "calendar.reminder",
                "calendar",
                &["open", "dismiss", "snooze"],
            ),
            "calendar.task-reminder" => (
                "calendar.reminder",
                "calendar",
                &["open", "dismiss", "snooze", "calendar.task.complete"],
            ),
            "calendar.invitation" => (
                "calendar.invitation",
                "calendar",
                &["open", "dismiss", "calendar.invitation.respond"],
            ),
            "calendar.invitation-update" => {
                ("calendar.invitation", "calendar", &["open", "dismiss"])
            }
            "collaboration.message" => (
                "collaboration.message",
                "collaboration",
                &["open", "dismiss"],
            ),
            "collaboration.mention" => (
                "collaboration.mention",
                "collaboration",
                &["open", "dismiss"],
            ),
            "sync.conflict" => (
                "sync.action-required",
                "sync",
                &["open", "dismiss", "sync.retry"],
            ),
            "sync.authentication-required" => (
                "sync.action-required",
                "sync",
                &["open", "dismiss", "server.reauthenticate"],
            ),
            "sync.permission-denied" => ("sync.action-required", "sync", &["open", "dismiss"]),
            "transfer.complete" => ("transfer.complete", "transfers", &["open", "dismiss"]),
            _ => {
                return Err(NotificationStoreError::Validation(
                    "notification kind is unsupported".into(),
                ))
            }
        };
    let mut action_kinds = std::collections::HashSet::new();
    for action in &envelope.actions {
        let action_kind = action.get("kind").and_then(Value::as_str).ok_or_else(|| {
            NotificationStoreError::Validation("notification action is invalid".into())
        })?;
        if !allowed_actions.contains(&action_kind) || !action_kinds.insert(action_kind) {
            return Err(NotificationStoreError::Validation(
                "notification action is not allowed".into(),
            ));
        }
        if action_kind == "snooze"
            && !action
                .get("minutes")
                .and_then(Value::as_u64)
                .is_some_and(|minutes| (1..=10_080).contains(&minutes))
        {
            return Err(NotificationStoreError::Validation(
                "notification snooze action is invalid".into(),
            ));
        }
    }
    let destination_kind = envelope
        .destination
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            NotificationStoreError::Validation("notification destination is invalid".into())
        })?;
    if !matches!(
        destination_kind,
        "calendar-item"
            | "calendar-invitations"
            | "vault-chat"
            | "vault-file"
            | "sync-recovery"
            | "settings"
            | "notification-center"
    ) {
        return Err(NotificationStoreError::Validation(
            "notification destination is unsupported".into(),
        ));
    }
    if envelope.schema_version != 1
        || envelope.id.trim().is_empty()
        || envelope.id.len() > 2_048
        || envelope.category != category
        || envelope.category != expected_category
        || envelope.channel != expected_channel
        || envelope.account_key.trim().is_empty()
        || envelope.account_key.len() > 160
        || envelope.server_url.as_ref().is_some_and(|server_url| {
            let Ok(url) = url::Url::parse(server_url) else {
                return true;
            };
            !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
        })
        || envelope.source_id.trim().is_empty()
        || envelope.source_id.len() > 512
        || envelope.delivery_key.trim().is_empty()
        || envelope.delivery_key.len() > 512
        || envelope.title.trim().is_empty()
        || envelope.title.chars().count() > 500
        || envelope
            .body
            .as_ref()
            .is_some_and(|body| body.len() > 4_096)
        || envelope.actions.len() > 4
        || !matches!(envelope.privacy.as_str(), "full" | "title-only" | "hidden")
        || !matches!(envelope.priority.as_str(), "normal" | "time-sensitive")
        || envelope.id != notification_id_for(envelope)
    {
        return Err(NotificationStoreError::Validation(
            "notification envelope is invalid".into(),
        ));
    }
    parse_instant(&envelope.created_at, "creation time")?;
    if let Some(value) = &envelope.scheduled_at {
        parse_instant(value, "schedule time")?;
    }
    if let Some(value) = &envelope.expires_at {
        parse_instant(value, "expiry time")?;
    }
    Ok(())
}

fn parse_instant(value: &str, label: &str) -> Result<DateTime<Utc>, NotificationStoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| NotificationStoreError::Validation(format!("{label} must be RFC 3339")))
}

fn validate_segment(value: &str, label: &str) -> Result<(), NotificationStoreError> {
    if value.is_empty()
        || value.len() > 160
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', '\0'])
    {
        return Err(NotificationStoreError::Validation(format!(
            "invalid {label}"
        )));
    }
    Ok(())
}

fn notification_id_for(envelope: &NotificationEnvelope) -> String {
    let parts = [
        envelope.category.as_str(),
        envelope.account_key.as_str(),
        envelope.source_id.as_str(),
        envelope.occurrence_key.as_deref().unwrap_or("-"),
        envelope.delivery_key.as_str(),
    ];
    format!(
        "notification:v1:{}",
        parts.map(encode_uri_component).join(":")
    )
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn ensure_changed(rows: u64) -> Result<(), NotificationStoreError> {
    if rows == 0 {
        Err(NotificationStoreError::NotFound)
    } else {
        Ok(())
    }
}

pub fn profile_ids(config_root: &Path) -> Result<Vec<String>, NotificationStoreError> {
    let profiles = config_root.join("profiles");
    let entries = match std::fs::read_dir(profiles) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_segment(&id, "profile ID").is_ok() {
            ids.push(id);
        }
    }
    ids.sort();
    ids.truncate(100);
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(_id: &str, scheduled_at: &str) -> NotificationEnvelope {
        let mut envelope = NotificationEnvelope {
            schema_version: 1,
            id: String::new(),
            category: "calendar.reminder".into(),
            kind: "calendar.event-reminder".into(),
            channel: "calendar".into(),
            account_key: "profile-1".into(),
            server_url: None,
            source_id: "item-1".into(),
            occurrence_key: None,
            delivery_key: "reminder-1".into(),
            created_at: "2026-07-28T10:00:00Z".into(),
            scheduled_at: Some(scheduled_at.into()),
            expires_at: None,
            title: "Planning".into(),
            body: None,
            privacy: "title-only".into(),
            priority: "time-sensitive".into(),
            destination: json!({"kind":"calendar-item","profileId":"profile-1","calendarId":"calendar-1","itemId":"item-1"}),
            actions: vec![json!({"kind":"open"}), json!({"kind":"dismiss"})],
            requires_inbox: true,
        };
        envelope.id = notification_id_for(&envelope);
        envelope
    }

    #[tokio::test]
    async fn reconciliation_replaces_and_cancels_stale_rows() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let first = envelope("notification-1", "2099-01-01T09:00:00Z");
        let result = store
            .reconcile("profile-1", "calendar.reminder", &[first.clone()])
            .await
            .unwrap();
        assert_eq!(result.inserted, 1);
        let mut changed = first;
        changed.title = "Updated planning".into();
        let result = store
            .reconcile("profile-1", "calendar.reminder", &[changed])
            .await
            .unwrap();
        assert_eq!(result.updated, 1);
        let result = store
            .reconcile("profile-1", "calendar.reminder", &[])
            .await
            .unwrap();
        assert_eq!(result.cancelled, 1);
    }

    #[tokio::test]
    async fn action_tokens_are_allowlisted_and_one_time() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        let notification_id = notice.id.clone();
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        let token = store
            .create_action_token(&notification_id, &json!({"kind":"open"}))
            .await
            .unwrap();
        let consumed = store.consume_action_token(&token.token).await.unwrap();
        assert_eq!(consumed.notification_id, notification_id);
        assert!(matches!(
            store.consume_action_token(&token.token).await,
            Err(NotificationStoreError::InvalidActionToken)
        ));
    }

    #[tokio::test]
    async fn inbox_lifecycle_and_reconciliation_requests_are_durable() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        store
            .request_reconciliation("profile-1", "calendar.reminder")
            .await
            .unwrap();
        assert_eq!(
            store
                .list_reconciliation_requests("profile-1")
                .await
                .unwrap()
                .len(),
            1
        );
        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        let notification_id = notice.id.clone();
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        assert!(store
            .list_reconciliation_requests("profile-1")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store.list_inbox("profile-1", false, 20).await.unwrap()[0].state,
            NotificationState::Ready
        );
        store.mark_read(&notification_id, true).await.unwrap();
        assert_eq!(
            store.list_inbox("profile-1", false, 20).await.unwrap()[0].state,
            NotificationState::Read
        );
        let snoozed = store.snooze(&notification_id, 10).await.unwrap();
        assert_eq!(snoozed.state, NotificationState::Scheduled);
        assert_eq!(
            snoozed.snoozed_from_id.as_deref(),
            Some(notification_id.as_str())
        );
    }

    #[tokio::test]
    async fn records_without_inbox_policy_are_not_listed() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let mut notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        notice.requires_inbox = false;
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        assert!(store
            .list_inbox("profile-1", false, 20)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn due_records_transition_to_delivered_once() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        let notification_id = notice.id.clone();
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        assert_eq!(store.list_due("profile-1", 20).await.unwrap().len(), 1);
        store
            .mark_delivered(&notification_id, "native")
            .await
            .unwrap();
        assert!(store.list_due("profile-1", 20).await.unwrap().is_empty());
        let inbox = store.list_inbox("profile-1", false, 20).await.unwrap();
        assert_eq!(inbox[0].state, NotificationState::Delivered);
        assert_eq!(inbox[0].delivery_surface.as_deref(), Some("native"));
    }

    #[tokio::test]
    async fn next_delivery_uses_the_earliest_active_schedule() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let later = envelope("notification-later", "2099-01-01T10:00:00Z");
        let earlier = envelope("notification-earlier", "2099-01-01T09:00:00Z");
        store
            .reconcile("profile-1", "calendar.reminder", &[later, earlier])
            .await
            .unwrap();

        assert_eq!(
            store.next_delivery_at("profile-1").await.unwrap(),
            Some(
                DateTime::parse_from_rfc3339("2099-01-01T09:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );
    }

    #[tokio::test]
    async fn due_listing_retries_failed_delivery_after_backoff() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        let notification_id = notice.id.clone();
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        store
            .mark_failed(&notification_id, "native delivery failed")
            .await
            .unwrap();
        sqlx::query("UPDATE notifications SET next_retry_at=? WHERE id=?")
            .bind("2026-01-01T09:01:00Z")
            .bind(&notification_id)
            .execute(&store.pool)
            .await
            .unwrap();

        let due = store.list_due("profile-1", 20).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].envelope.id, notification_id);
        assert_eq!(due[0].state, NotificationState::Ready);
        assert_eq!(due[0].attempt_count, 1);
        assert!(due[0].failure_message.is_none());
        assert!(due[0].next_retry_at.is_none());
    }

    #[tokio::test]
    async fn remote_ingestion_is_idempotent_and_preserves_unseen_records() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let first = envelope("notification-1", "2026-01-01T09:00:00Z");
        let mut second = envelope("notification-2", "2026-01-01T10:00:00Z");
        second.delivery_key = "reminder-2".to_string();
        second.id = notification_id_for(&second);
        let result = store
            .ingest("profile-1", &[first.clone(), second.clone()])
            .await
            .unwrap();
        assert_eq!(result.inserted, 2);
        assert_eq!(result.cancelled, 0);
        let result = store.ingest("profile-1", &[second]).await.unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(result.cancelled, 0);
        assert_eq!(store.list_due("profile-1", 20).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn remote_cursors_are_scoped_by_profile_and_server() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        assert!(store
            .remote_cursor("profile-1", "https://one.example")
            .await
            .unwrap()
            .is_none());
        store
            .save_remote_cursor("profile-1", "https://one.example", "42")
            .await
            .unwrap();
        assert_eq!(
            store
                .remote_cursor("profile-1", "https://one.example")
                .await
                .unwrap()
                .as_deref(),
            Some("42")
        );
        assert!(store
            .remote_cursor("profile-1", "https://two.example")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn notification_preferences_round_trip_and_filter_categories() {
        let root = tempfile::tempdir().unwrap();
        let store = NotificationStore::open(root.path(), "profile-1")
            .await
            .unwrap();
        let mut preferences = NotificationPreferences::default();
        preferences
            .category_enabled
            .insert("calendar.reminder".into(), false);
        preferences.lock_screen_privacy = "hidden".into();
        let saved = store
            .save_preferences("profile-1", preferences.clone())
            .await
            .unwrap();
        assert_eq!(saved, preferences);
        assert_eq!(store.preferences("profile-1").await.unwrap(), preferences);

        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        store
            .reconcile("profile-1", "calendar.reminder", &[notice])
            .await
            .unwrap();
        assert!(store.list_due("profile-1", 20).await.unwrap().is_empty());
        assert!(store.next_delivery_at("profile-1").await.unwrap().is_none());
    }

    #[test]
    fn quiet_hours_defer_across_midnight_and_dst_gaps() {
        let mut preferences = NotificationPreferences::default();
        preferences.allow_time_sensitive_during_quiet_hours = false;
        preferences.quiet_hours = Some(NotificationQuietHours {
            start_minute: 22 * 60,
            end_minute: 7 * 60,
            time_zone: "Europe/Berlin".into(),
        });
        let notice = envelope("notification-1", "2026-01-01T09:00:00Z");
        let instant = DateTime::parse_from_rfc3339("2026-07-28T21:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            delivery_time(&notice, &preferences, instant),
            Some(
                DateTime::parse_from_rfc3339("2026-07-29T05:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );

        preferences.quiet_hours = Some(NotificationQuietHours {
            start_minute: 60,
            end_minute: 2 * 60 + 30,
            time_zone: "Europe/Berlin".into(),
        });
        let spring_forward = DateTime::parse_from_rfc3339("2026-03-29T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            delivery_time(&notice, &preferences, spring_forward),
            Some(
                DateTime::parse_from_rfc3339("2026-03-29T01:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );
    }

    #[test]
    fn privacy_preference_can_only_redact_more_content() {
        assert_eq!(effective_privacy("full", "title-only"), "title-only");
        assert_eq!(effective_privacy("title-only", "full"), "title-only");
        assert_eq!(effective_privacy("hidden", "full"), "hidden");
    }

    #[test]
    fn source_scope_overrides_filter_server_vault_and_calendar_destinations() {
        let instant = Utc::now();
        let mut notice = envelope("notification-1", &instant.to_rfc3339());
        notice.priority = "normal".into();
        notice.server_url = Some("https://collab.example.test".into());
        notice
            .destination
            .as_object_mut()
            .unwrap()
            .insert("vaultId".into(), Value::String("vault-1".into()));
        for scope in [
            "server:https://collab.example.test",
            "vault:vault-1",
            "calendar:calendar-1",
        ] {
            let mut preferences = NotificationPreferences::default();
            preferences.scope_enabled.insert(scope.into(), false);
            assert_eq!(delivery_time(&notice, &preferences, instant), None);
        }
        let preferences = NotificationPreferences::default();
        assert_eq!(delivery_time(&notice, &preferences, instant), Some(instant));
    }
}
