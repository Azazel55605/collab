use crate::models::{
    CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarItemKind, CalendarLocation,
    CalendarMirrorAnchor, CalendarMirrorConflict, CalendarMirrorGroup, CalendarMutation,
    CalendarOperation, CalendarOperationFailure, CalendarRemoteChange, CalendarSubscription,
    CalendarSyncState, CalendarTimeValue, CALENDAR_SCHEMA_VERSION,
};
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_RANGE_QUERY_ITEMS: u32 = 5_000;
pub const MAX_SEARCH_QUERY_ITEMS: u32 = 500;
pub const LOCAL_STORE_SCHEMA_VERSION: i64 = 6;
pub const MAX_MIRROR_GROUP_MEMBERS: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum CalendarStoreError {
    #[error("Invalid calendar data: {0}")]
    Validation(String),
    #[error("Calendar not found")]
    CalendarNotFound,
    #[error("Calendar is read-only")]
    ReadOnly,
    #[error("Calendar item revision conflict: expected {expected}, actual {actual}")]
    Conflict { expected: i64, actual: i64 },
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub struct CalendarStore {
    pool: SqlitePool,
    path: PathBuf,
}

impl CalendarStore {
    pub async fn open(config_root: &Path, profile_id: &str) -> Result<Self, CalendarStoreError> {
        validate_segment(profile_id, "profile ID")?;
        let profile_dir = config_root.join("profiles").join(profile_id);
        std::fs::create_dir_all(&profile_dir)?;
        let path = profile_dir.join("calendar.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5))
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let store = Self { pool, path };
        store.migrate(profile_id).await?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn migrate(&self, profile_id: &str) -> Result<(), CalendarStoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendars (
                id TEXT PRIMARY KEY NOT NULL,
                global_id TEXT NOT NULL,
                location_json TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                default_time_zone TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                read_only INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        let calendar_columns = sqlx::query("PRAGMA table_info(calendars)")
            .fetch_all(&mut *tx)
            .await?;
        if !calendar_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "deleted_at")
        {
            sqlx::query("ALTER TABLE calendars ADD COLUMN deleted_at TEXT")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendar_items (
                id TEXT PRIMARY KEY NOT NULL,
                calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
                uid TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_sort INTEGER,
                end_sort INTEGER,
                recurrence_rule TEXT,
                recurrence_id TEXT,
                recurrence_sort INTEGER,
                recurrence_series_id TEXT,
                revision INTEGER NOT NULL,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                UNIQUE(calendar_id, uid, id)
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        let item_columns = sqlx::query("PRAGMA table_info(calendar_items)")
            .fetch_all(&mut *tx)
            .await?;
        if !item_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "recurrence_id")
        {
            sqlx::query("ALTER TABLE calendar_items ADD COLUMN recurrence_id TEXT")
                .execute(&mut *tx)
                .await?;
        }
        if !item_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "recurrence_series_id")
        {
            sqlx::query("ALTER TABLE calendar_items ADD COLUMN recurrence_series_id TEXT")
                .execute(&mut *tx)
                .await?;
        }
        if !item_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "recurrence_sort")
        {
            sqlx::query("ALTER TABLE calendar_items ADD COLUMN recurrence_sort INTEGER")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS calendar_items_uid_recurrence_idx ON calendar_items(calendar_id, uid, COALESCE(recurrence_id, ''))",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS calendar_items_recurrence_range_idx ON calendar_items(recurrence_sort)",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS calendar_items_range_idx ON calendar_items(calendar_id, start_sort, end_sort)",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS calendar_items_updated_idx ON calendar_items(updated_at, id)",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS pending_operations (
                client_operation_id TEXT PRIMARY KEY NOT NULL,
                device_id TEXT NOT NULL,
                calendar_id TEXT,
                item_id TEXT,
                expected_revision INTEGER,
                source_change_id TEXT,
                propagation_lineage_json TEXT NOT NULL,
                mutation_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        let pending_columns = sqlx::query("PRAGMA table_info(pending_operations)")
            .fetch_all(&mut *tx)
            .await?;
        if !pending_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "attempt_count")
        {
            sqlx::query(
                "ALTER TABLE pending_operations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
            )
            .execute(&mut *tx)
            .await?;
        }
        if !pending_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "last_error")
        {
            sqlx::query("ALTER TABLE pending_operations ADD COLUMN last_error TEXT")
                .execute(&mut *tx)
                .await?;
        }
        if !pending_columns
            .iter()
            .any(|row| row.get::<String, _>("name") == "last_attempt_at")
        {
            sqlx::query("ALTER TABLE pending_operations ADD COLUMN last_attempt_at TEXT")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS sync_state (
                origin_key TEXT PRIMARY KEY NOT NULL,
                cursor TEXT,
                last_synced_at TEXT,
                last_error TEXT
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendar_subscriptions (
                id TEXT PRIMARY KEY NOT NULL,
                calendar_id TEXT NOT NULL UNIQUE REFERENCES calendars(id) ON DELETE CASCADE,
                feed_url TEXT NOT NULL UNIQUE,
                last_refreshed_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendar_mirror_groups (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendar_mirror_anchors (
                group_id TEXT NOT NULL REFERENCES calendar_mirror_groups(id) ON DELETE CASCADE,
                logical_item_key TEXT NOT NULL,
                member_id TEXT NOT NULL,
                item_id TEXT,
                revision INTEGER,
                fingerprint TEXT NOT NULL,
                deleted_at TEXT,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (group_id, logical_item_key, member_id)
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS calendar_mirror_anchors_item_idx ON calendar_mirror_anchors(group_id, item_id)",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS calendar_mirror_conflicts (
                id TEXT PRIMARY KEY NOT NULL,
                group_id TEXT NOT NULL REFERENCES calendar_mirror_groups(id) ON DELETE CASCADE,
                logical_item_key TEXT NOT NULL,
                status TEXT NOT NULL,
                detected_at TEXT NOT NULL,
                resolved_at TEXT,
                data_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS calendar_mirror_conflicts_open_idx ON calendar_mirror_conflicts(group_id, logical_item_key) WHERE status='unresolved'",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS profile_metadata (
                profile_id TEXT PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            )"#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO profile_metadata (profile_id, created_at, schema_version)
               VALUES (?, ?, ?)
               ON CONFLICT(profile_id) DO UPDATE SET schema_version = excluded.schema_version"#,
        )
        .bind(profile_id)
        .bind(Utc::now().to_rfc3339())
        .bind(LOCAL_STORE_SCHEMA_VERSION)
        .execute(&mut *tx)
        .await?;
        sqlx::query(&format!(
            "PRAGMA user_version = {LOCAL_STORE_SCHEMA_VERSION}"
        ))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_calendars(&self) -> Result<Vec<CalendarDefinition>, CalendarStoreError> {
        let rows = sqlx::query(
            "SELECT data_json FROM calendars WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id",
        )
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn list_subscriptions(
        &self,
    ) -> Result<Vec<CalendarSubscription>, CalendarStoreError> {
        let rows =
            sqlx::query("SELECT data_json FROM calendar_subscriptions ORDER BY created_at, id")
                .fetch_all(&self.pool)
                .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn upsert_subscription(
        &self,
        subscription: &CalendarSubscription,
    ) -> Result<(), CalendarStoreError> {
        validate_subscription(subscription)?;
        let location_json = sqlx::query_scalar::<_, String>(
            "SELECT location_json FROM calendars WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&subscription.calendar_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(CalendarStoreError::CalendarNotFound)?;
        let location: CalendarLocation = serde_json::from_str(&location_json)?;
        if !matches!(
            location,
            CalendarLocation::Subscription {
                ref subscription_id,
                ..
            } if subscription_id == &subscription.id
        ) {
            return Err(CalendarStoreError::Validation(
                "subscription metadata must match its read-only calendar location".into(),
            ));
        }
        sqlx::query(
            r#"INSERT INTO calendar_subscriptions (
                 id,calendar_id,feed_url,last_refreshed_at,last_error,created_at,updated_at,data_json
               ) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,
                 feed_url=excluded.feed_url,last_refreshed_at=excluded.last_refreshed_at,
                 last_error=excluded.last_error,updated_at=excluded.updated_at,
                 data_json=excluded.data_json"#,
        )
        .bind(&subscription.id)
        .bind(&subscription.calendar_id)
        .bind(&subscription.feed_url)
        .bind(subscription.last_refreshed_at.as_deref())
        .bind(subscription.last_error.as_deref())
        .bind(&subscription.created_at)
        .bind(&subscription.updated_at)
        .bind(serde_json::to_string(subscription)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_subscription(
        &self,
        subscription_id: &str,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(subscription_id, "subscription ID")?;
        let mut tx = self.pool.begin().await?;
        let calendar_id = sqlx::query_scalar::<_, String>(
            "SELECT calendar_id FROM calendar_subscriptions WHERE id = ?",
        )
        .bind(subscription_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(calendar_id) = calendar_id {
            sqlx::query("DELETE FROM calendars WHERE id = ?")
                .bind(calendar_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_calendar(
        &self,
        calendar: &CalendarDefinition,
    ) -> Result<(), CalendarStoreError> {
        validate_calendar(calendar)?;
        let mut normalized = calendar.clone();
        normalized.schema_version = CALENDAR_SCHEMA_VERSION;
        normalized.read_only =
            normalized.read_only || normalized.location.is_inherently_read_only();
        let data_json = serde_json::to_string(&normalized)?;
        let location_json = serde_json::to_string(&normalized.location)?;
        sqlx::query(
            r#"
            INSERT INTO calendars (
                id, global_id, location_json, name, color, default_time_zone,
                archived, read_only, revision, deleted_at, created_at, updated_at, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                global_id = excluded.global_id,
                location_json = excluded.location_json,
                name = excluded.name,
                color = excluded.color,
                default_time_zone = excluded.default_time_zone,
                archived = excluded.archived,
                read_only = excluded.read_only,
                revision = excluded.revision,
                deleted_at = excluded.deleted_at,
                updated_at = excluded.updated_at,
                data_json = excluded.data_json
            "#,
        )
        .bind(&normalized.id)
        .bind(&normalized.global_id)
        .bind(location_json)
        .bind(&normalized.name)
        .bind(&normalized.color)
        .bind(&normalized.default_time_zone)
        .bind(normalized.archived)
        .bind(normalized.read_only)
        .bind(normalized.revision)
        .bind(normalized.deleted_at.as_deref())
        .bind(&normalized.created_at)
        .bind(&normalized.updated_at)
        .bind(data_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn replace_generated_kanban_calendar(
        &self,
        calendar: &CalendarDefinition,
        items: &[CalendarItem],
    ) -> Result<(), CalendarStoreError> {
        if !matches!(calendar.location, CalendarLocation::Kanban { .. }) || !calendar.read_only {
            return Err(CalendarStoreError::Validation(
                "generated Kanban calendars must use a read-only Kanban location".into(),
            ));
        }
        if items.iter().any(|item| {
            !matches!(
                item.source_binding.as_ref(),
                Some(crate::models::CalendarSourceBinding::Kanban { .. })
            )
        }) {
            return Err(CalendarStoreError::Validation(
                "generated Kanban items require a Kanban source binding".into(),
            ));
        }
        self.replace_read_only_calendar(calendar, items, None).await
    }

    pub async fn replace_subscription_calendar(
        &self,
        calendar: &CalendarDefinition,
        items: &[CalendarItem],
        subscription: &CalendarSubscription,
    ) -> Result<(), CalendarStoreError> {
        let subscription_id = match &calendar.location {
            CalendarLocation::Subscription {
                subscription_id, ..
            } if calendar.read_only => subscription_id,
            _ => {
                return Err(CalendarStoreError::Validation(
                    "subscription calendars must use a read-only subscription location".into(),
                ));
            }
        };
        if items.iter().any(|item| {
            !matches!(
                item.source_binding.as_ref(),
                Some(crate::models::CalendarSourceBinding::External {
                    subscription_id: item_subscription_id,
                    ..
                }) if item_subscription_id == subscription_id
            )
        }) {
            return Err(CalendarStoreError::Validation(
                "subscription items require a matching external source binding".into(),
            ));
        }
        validate_subscription(subscription)?;
        if subscription.id != *subscription_id || subscription.calendar_id != calendar.id {
            return Err(CalendarStoreError::Validation(
                "subscription metadata must match the subscription calendar".into(),
            ));
        }
        self.replace_read_only_calendar(calendar, items, Some(subscription))
            .await
    }

    async fn replace_read_only_calendar(
        &self,
        calendar: &CalendarDefinition,
        items: &[CalendarItem],
        subscription: Option<&CalendarSubscription>,
    ) -> Result<(), CalendarStoreError> {
        validate_calendar(calendar)?;
        if items.len() > MAX_RANGE_QUERY_ITEMS as usize {
            return Err(CalendarStoreError::Validation(format!(
                "read-only calendars cannot exceed {MAX_RANGE_QUERY_ITEMS} items"
            )));
        }
        let mut ids = HashSet::with_capacity(items.len());
        for item in items {
            validate_item(item)?;
            if item.calendar_id != calendar.id || !ids.insert(item.id.clone()) {
                return Err(CalendarStoreError::Validation(
                    "read-only calendar items must have unique IDs and target the calendar".into(),
                ));
            }
        }

        let mut normalized = calendar.clone();
        normalized.schema_version = CALENDAR_SCHEMA_VERSION;
        normalized.read_only = true;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO calendars (
                 id,global_id,location_json,name,color,default_time_zone,archived,
                 read_only,revision,deleted_at,created_at,updated_at,data_json
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET global_id=excluded.global_id,
                 location_json=excluded.location_json,name=excluded.name,color=excluded.color,
                 default_time_zone=excluded.default_time_zone,archived=excluded.archived,
                 read_only=1,revision=excluded.revision,deleted_at=NULL,
                 updated_at=excluded.updated_at,data_json=excluded.data_json"#,
        )
        .bind(&normalized.id)
        .bind(&normalized.global_id)
        .bind(serde_json::to_string(&normalized.location)?)
        .bind(&normalized.name)
        .bind(&normalized.color)
        .bind(&normalized.default_time_zone)
        .bind(normalized.archived)
        .bind(true)
        .bind(normalized.revision)
        .bind(normalized.deleted_at.as_deref())
        .bind(&normalized.created_at)
        .bind(&normalized.updated_at)
        .bind(serde_json::to_string(&normalized)?)
        .execute(&mut *tx)
        .await?;

        let existing_ids =
            sqlx::query_scalar::<_, String>("SELECT id FROM calendar_items WHERE calendar_id=?")
                .bind(&normalized.id)
                .fetch_all(&mut *tx)
                .await?;
        for existing_id in existing_ids {
            if !ids.contains(&existing_id) {
                sqlx::query("DELETE FROM calendar_items WHERE id=?")
                    .bind(existing_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        for item in items {
            let (start_sort, end_sort) = item_sort_range(item)?;
            sqlx::query(
                r#"INSERT INTO calendar_items (
                     id,calendar_id,uid,kind,start_sort,end_sort,recurrence_rule,
                     recurrence_id,recurrence_sort,recurrence_series_id,revision,
                     deleted_at,created_at,updated_at,data_json
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,
                     uid=excluded.uid,kind=excluded.kind,start_sort=excluded.start_sort,
                     end_sort=excluded.end_sort,recurrence_rule=excluded.recurrence_rule,
                     recurrence_id=excluded.recurrence_id,recurrence_sort=excluded.recurrence_sort,
                     recurrence_series_id=excluded.recurrence_series_id,
                     revision=excluded.revision,deleted_at=excluded.deleted_at,
                     updated_at=excluded.updated_at,data_json=excluded.data_json"#,
            )
            .bind(&item.id)
            .bind(&item.calendar_id)
            .bind(&item.uid)
            .bind(item.kind.as_str())
            .bind(start_sort)
            .bind(end_sort)
            .bind(item.recurrence.as_ref().map(|value| value.rrule.as_str()))
            .bind(
                item.recurrence_id
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            )
            .bind(
                item.recurrence_id
                    .as_ref()
                    .map(|value| time_sort_value(value, false))
                    .transpose()?,
            )
            .bind(item.recurrence_series_id.as_deref())
            .bind(item.revision)
            .bind(item.deleted_at.as_deref())
            .bind(&item.created_at)
            .bind(&item.updated_at)
            .bind(serde_json::to_string(item)?)
            .execute(&mut *tx)
            .await?;
        }
        if let Some(subscription) = subscription {
            sqlx::query(
                r#"INSERT INTO calendar_subscriptions (
                     id,calendar_id,feed_url,last_refreshed_at,last_error,created_at,updated_at,data_json
                   ) VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,
                     feed_url=excluded.feed_url,last_refreshed_at=excluded.last_refreshed_at,
                     last_error=excluded.last_error,updated_at=excluded.updated_at,
                     data_json=excluded.data_json"#,
            )
            .bind(&subscription.id)
            .bind(&subscription.calendar_id)
            .bind(&subscription.feed_url)
            .bind(subscription.last_refreshed_at.as_deref())
            .bind(subscription.last_error.as_deref())
            .bind(&subscription.created_at)
            .bind(&subscription.updated_at)
            .bind(serde_json::to_string(subscription)?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_calendar_with_operation(
        &self,
        calendar: &CalendarDefinition,
        operation: &CalendarOperation,
    ) -> Result<(), CalendarStoreError> {
        validate_calendar(calendar)?;
        validate_non_empty(&operation.client_operation_id, "client operation ID")?;
        validate_non_empty(&operation.device_id, "device ID")?;
        match &operation.mutation {
            CalendarMutation::CreateCalendar {
                calendar: operation_calendar,
            }
            | CalendarMutation::UpdateCalendar {
                calendar: operation_calendar,
            } if operation_calendar == calendar => {}
            CalendarMutation::CreateCalendar { .. } | CalendarMutation::UpdateCalendar { .. } => {
                return Err(CalendarStoreError::Validation(
                    "queued operation calendar does not match the persisted calendar".into(),
                ));
            }
            _ => {
                return Err(CalendarStoreError::Validation(
                    "calendar writes require a createCalendar or updateCalendar operation".into(),
                ));
            }
        }

        let mut normalized = calendar.clone();
        normalized.schema_version = CALENDAR_SCHEMA_VERSION;
        normalized.read_only =
            normalized.read_only || normalized.location.is_inherently_read_only();
        let data_json = serde_json::to_string(&normalized)?;
        let location_json = serde_json::to_string(&normalized.location)?;
        let mutation_json = serde_json::to_string(&operation.mutation)?;
        let lineage_json = serde_json::to_string(&operation.propagation_lineage)?;
        let mut tx = self.pool.begin().await?;
        let operation_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE client_operation_id = ?)",
        )
        .bind(&operation.client_operation_id)
        .fetch_one(&mut *tx)
        .await?;
        if operation_exists {
            tx.commit().await?;
            return Ok(());
        }
        let existing = sqlx::query("SELECT revision, read_only FROM calendars WHERE id = ?")
            .bind(&calendar.id)
            .fetch_optional(&mut *tx)
            .await?;
        if existing
            .as_ref()
            .is_some_and(|row| row.get::<bool, _>("read_only"))
        {
            return Err(CalendarStoreError::ReadOnly);
        }
        if let Some(expected) = operation.expected_revision {
            let actual = existing
                .as_ref()
                .map(|row| row.get::<i64, _>("revision"))
                .unwrap_or(0);
            if actual != expected {
                return Err(CalendarStoreError::Conflict { expected, actual });
            }
        }
        sqlx::query(
            r#"
            INSERT INTO calendars (
                id, global_id, location_json, name, color, default_time_zone,
                archived, read_only, revision, deleted_at, created_at, updated_at, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                global_id = excluded.global_id,
                location_json = excluded.location_json,
                name = excluded.name,
                color = excluded.color,
                default_time_zone = excluded.default_time_zone,
                archived = excluded.archived,
                read_only = excluded.read_only,
                revision = excluded.revision,
                deleted_at = excluded.deleted_at,
                updated_at = excluded.updated_at,
                data_json = excluded.data_json
            "#,
        )
        .bind(&normalized.id)
        .bind(&normalized.global_id)
        .bind(location_json)
        .bind(&normalized.name)
        .bind(&normalized.color)
        .bind(&normalized.default_time_zone)
        .bind(normalized.archived)
        .bind(normalized.read_only)
        .bind(normalized.revision)
        .bind(normalized.deleted_at.as_deref())
        .bind(&normalized.created_at)
        .bind(&normalized.updated_at)
        .bind(data_json)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO pending_operations (
                client_operation_id, device_id, calendar_id, item_id,
                expected_revision, source_change_id, propagation_lineage_json,
                mutation_json, status, created_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(client_operation_id) DO NOTHING
            "#,
        )
        .bind(&operation.client_operation_id)
        .bind(&operation.device_id)
        .bind(&calendar.id)
        .bind(operation.expected_revision)
        .bind(operation.source_change_id.as_deref())
        .bind(lineage_json)
        .bind(mutation_json)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_calendar_with_operation(
        &self,
        calendar_id: &str,
        deleted_at: &str,
        operation: &CalendarOperation,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(calendar_id, "calendar ID")?;
        validate_timestamp(deleted_at, "calendar deletedAt")?;
        validate_non_empty(&operation.client_operation_id, "client operation ID")?;
        validate_non_empty(&operation.device_id, "device ID")?;
        match &operation.mutation {
            CalendarMutation::DeleteCalendar {
                calendar_id: queued_id,
            } if queued_id == calendar_id => {}
            _ => {
                return Err(CalendarStoreError::Validation(
                    "calendar deletes require a matching deleteCalendar operation".into(),
                ));
            }
        }

        let mut tx = self.pool.begin().await?;
        let operation_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE client_operation_id = ?)",
        )
        .bind(&operation.client_operation_id)
        .fetch_one(&mut *tx)
        .await?;
        if operation_exists {
            tx.commit().await?;
            return Ok(());
        }
        let row = sqlx::query(
            "SELECT revision, data_json FROM calendars WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(calendar_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(CalendarStoreError::CalendarNotFound)?;
        let actual = row.get::<i64, _>("revision");
        if let Some(expected) = operation.expected_revision {
            if expected != actual {
                return Err(CalendarStoreError::Conflict { expected, actual });
            }
        }
        let mut calendar: CalendarDefinition = serde_json::from_str(row.get("data_json"))?;
        calendar.revision = actual + 1;
        calendar.updated_at = deleted_at.to_owned();
        calendar.deleted_at = Some(deleted_at.to_owned());
        sqlx::query(
            "UPDATE calendars SET revision = ?, deleted_at = ?, updated_at = ?, data_json = ? WHERE id = ?",
        )
        .bind(calendar.revision)
        .bind(deleted_at)
        .bind(deleted_at)
        .bind(serde_json::to_string(&calendar)?)
        .bind(calendar_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO pending_operations (
                client_operation_id, device_id, calendar_id, item_id,
                expected_revision, source_change_id, propagation_lineage_json,
                mutation_json, status, created_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?)"#,
        )
        .bind(&operation.client_operation_id)
        .bind(&operation.device_id)
        .bind(calendar_id)
        .bind(operation.expected_revision)
        .bind(operation.source_change_id.as_deref())
        .bind(serde_json::to_string(&operation.propagation_lineage)?)
        .bind(serde_json::to_string(&operation.mutation)?)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn cleanup_tombstones(
        &self,
        older_than: &str,
    ) -> Result<CalendarCleanupResult, CalendarStoreError> {
        validate_timestamp(older_than, "tombstone cutoff")?;
        let mut tx = self.pool.begin().await?;
        let items_removed = sqlx::query(
            r#"DELETE FROM calendar_items
               WHERE deleted_at IS NOT NULL AND deleted_at < ?
                 AND NOT EXISTS (
                   SELECT 1 FROM pending_operations pending
                   WHERE pending.item_id = calendar_items.id
                 )"#,
        )
        .bind(older_than)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let calendars_removed = sqlx::query(
            r#"DELETE FROM calendars
               WHERE deleted_at IS NOT NULL AND deleted_at < ?
                 AND NOT EXISTS (
                   SELECT 1 FROM pending_operations pending
                   WHERE pending.calendar_id = calendars.id
                 )"#,
        )
        .bind(older_than)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok(CalendarCleanupResult {
            calendars_removed,
            items_removed,
        })
    }

    pub async fn list_items_in_range(
        &self,
        from: &str,
        to: &str,
        limit: u32,
        include_deleted: bool,
    ) -> Result<Vec<CalendarItem>, CalendarStoreError> {
        if limit == 0 || limit > MAX_RANGE_QUERY_ITEMS {
            return Err(CalendarStoreError::Validation(format!(
                "query limit must be between 1 and {MAX_RANGE_QUERY_ITEMS}"
            )));
        }
        let from_sort = parse_query_bound(from)?;
        let to_sort = parse_query_bound(to)?;
        if to_sort <= from_sort {
            return Err(CalendarStoreError::Validation(
                "query end must be after its start".into(),
            ));
        }
        let rows = sqlx::query(
            r#"
            SELECT data_json
              FROM calendar_items
             WHERE (? OR deleted_at IS NULL)
               AND (
                 recurrence_series_id IS NULL
                 OR EXISTS (
                   SELECT 1 FROM calendar_items master
                   WHERE master.id = calendar_items.recurrence_series_id
                     AND (? OR master.deleted_at IS NULL)
                 )
               )
               AND (
                 kind = 'birthday'
                 OR (kind = 'task' AND start_sort IS NULL AND recurrence_rule IS NULL)
                 OR recurrence_rule IS NOT NULL
                 OR (recurrence_sort >= ? AND recurrence_sort < ?)
                 OR (start_sort < ? AND end_sort > ?)
               )
             ORDER BY COALESCE(start_sort, 0), id
             LIMIT ?
            "#,
        )
        .bind(include_deleted)
        .bind(include_deleted)
        .bind(from_sort)
        .bind(to_sort)
        .bind(to_sort)
        .bind(from_sort)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn upsert_item_with_operation(
        &self,
        item: &CalendarItem,
        operation: &CalendarOperation,
    ) -> Result<(), CalendarStoreError> {
        validate_item(item)?;
        validate_non_empty(&operation.client_operation_id, "client operation ID")?;
        validate_non_empty(&operation.device_id, "device ID")?;
        let (start_sort, end_sort) = item_sort_range(item)?;
        let item_json = serde_json::to_string(item)?;
        let mutation_json = serde_json::to_string(&operation.mutation)?;
        let lineage_json = serde_json::to_string(&operation.propagation_lineage)?;
        let mut tx = self.pool.begin().await?;
        let operation_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE client_operation_id = ?)",
        )
        .bind(&operation.client_operation_id)
        .fetch_one(&mut *tx)
        .await?;
        if operation_exists {
            tx.commit().await?;
            return Ok(());
        }
        match &operation.mutation {
            CalendarMutation::UpsertItem {
                item: operation_item,
            } if operation_item == item => {}
            CalendarMutation::UpsertItem { .. } => {
                return Err(CalendarStoreError::Validation(
                    "queued operation item does not match the persisted item".into(),
                ));
            }
            _ => {
                return Err(CalendarStoreError::Validation(
                    "item writes require an upsertItem operation".into(),
                ));
            }
        }
        let calendar = sqlx::query("SELECT read_only FROM calendars WHERE id = ?")
            .bind(&item.calendar_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(CalendarStoreError::CalendarNotFound)?;
        if calendar.get::<bool, _>("read_only") {
            return Err(CalendarStoreError::ReadOnly);
        }
        if let Some(expected) = operation.expected_revision {
            let actual =
                sqlx::query_scalar::<_, i64>("SELECT revision FROM calendar_items WHERE id = ?")
                    .bind(&item.id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .unwrap_or(0);
            if actual != expected {
                return Err(CalendarStoreError::Conflict { expected, actual });
            }
        }
        sqlx::query(
            r#"
            INSERT INTO calendar_items (
                id, calendar_id, uid, kind, start_sort, end_sort, recurrence_rule,
                recurrence_id, recurrence_sort, recurrence_series_id, revision, deleted_at, created_at, updated_at, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                calendar_id = excluded.calendar_id,
                uid = excluded.uid,
                kind = excluded.kind,
                start_sort = excluded.start_sort,
                end_sort = excluded.end_sort,
                recurrence_rule = excluded.recurrence_rule,
                recurrence_id = excluded.recurrence_id,
                recurrence_sort = excluded.recurrence_sort,
                recurrence_series_id = excluded.recurrence_series_id,
                revision = excluded.revision,
                deleted_at = excluded.deleted_at,
                updated_at = excluded.updated_at,
                data_json = excluded.data_json
            "#,
        )
        .bind(&item.id)
        .bind(&item.calendar_id)
        .bind(&item.uid)
        .bind(item.kind.as_str())
        .bind(start_sort)
        .bind(end_sort)
        .bind(item.recurrence.as_ref().map(|value| value.rrule.as_str()))
        .bind(
            item.recurrence_id
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .bind(
            item.recurrence_id
                .as_ref()
                .map(|value| time_sort_value(value, false))
                .transpose()?,
        )
        .bind(item.recurrence_series_id.as_deref())
        .bind(item.revision)
        .bind(item.deleted_at.as_deref())
        .bind(&item.created_at)
        .bind(&item.updated_at)
        .bind(item_json)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO pending_operations (
                client_operation_id, device_id, calendar_id, item_id,
                expected_revision, source_change_id, propagation_lineage_json,
                mutation_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(client_operation_id) DO NOTHING
            "#,
        )
        .bind(&operation.client_operation_id)
        .bind(&operation.device_id)
        .bind(&item.calendar_id)
        .bind(&item.id)
        .bind(operation.expected_revision)
        .bind(operation.source_change_id.as_deref())
        .bind(lineage_json)
        .bind(mutation_json)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_items_with_operations(
        &self,
        entries: &[(CalendarItem, CalendarOperation)],
    ) -> Result<(), CalendarStoreError> {
        if entries.is_empty() || entries.len() > MAX_RANGE_QUERY_ITEMS as usize {
            return Err(CalendarStoreError::Validation(format!(
                "item batches must contain between 1 and {MAX_RANGE_QUERY_ITEMS} entries"
            )));
        }
        let mut prepared = Vec::with_capacity(entries.len());
        for (item, operation) in entries {
            validate_item(item)?;
            validate_non_empty(&operation.client_operation_id, "client operation ID")?;
            validate_non_empty(&operation.device_id, "device ID")?;
            match &operation.mutation {
                CalendarMutation::UpsertItem {
                    item: operation_item,
                } if operation_item == item => {}
                CalendarMutation::UpsertItem { .. } => {
                    return Err(CalendarStoreError::Validation(
                        "queued operation item does not match the persisted item".into(),
                    ));
                }
                _ => {
                    return Err(CalendarStoreError::Validation(
                        "item writes require an upsertItem operation".into(),
                    ));
                }
            }
            let (start_sort, end_sort) = item_sort_range(item)?;
            prepared.push((
                start_sort,
                end_sort,
                serde_json::to_string(item)?,
                serde_json::to_string(&operation.mutation)?,
                serde_json::to_string(&operation.propagation_lineage)?,
            ));
        }

        let mut tx = self.pool.begin().await?;
        for ((item, operation), (start_sort, end_sort, item_json, mutation_json, lineage_json)) in
            entries.iter().zip(prepared)
        {
            let operation_exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE client_operation_id = ?)",
            )
            .bind(&operation.client_operation_id)
            .fetch_one(&mut *tx)
            .await?;
            if operation_exists {
                continue;
            }
            let calendar = sqlx::query("SELECT read_only FROM calendars WHERE id = ?")
                .bind(&item.calendar_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(CalendarStoreError::CalendarNotFound)?;
            if calendar.get::<bool, _>("read_only") {
                return Err(CalendarStoreError::ReadOnly);
            }
            if let Some(expected) = operation.expected_revision {
                let actual = sqlx::query_scalar::<_, i64>(
                    "SELECT revision FROM calendar_items WHERE id = ?",
                )
                .bind(&item.id)
                .fetch_optional(&mut *tx)
                .await?
                .unwrap_or(0);
                if actual != expected {
                    return Err(CalendarStoreError::Conflict { expected, actual });
                }
            }
            sqlx::query(
                r#"
                INSERT INTO calendar_items (
                    id, calendar_id, uid, kind, start_sort, end_sort, recurrence_rule,
                    recurrence_id, recurrence_sort, recurrence_series_id, revision, deleted_at, created_at, updated_at, data_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    calendar_id = excluded.calendar_id,
                    uid = excluded.uid,
                    kind = excluded.kind,
                    start_sort = excluded.start_sort,
                    end_sort = excluded.end_sort,
                    recurrence_rule = excluded.recurrence_rule,
                    recurrence_id = excluded.recurrence_id,
                    recurrence_sort = excluded.recurrence_sort,
                    recurrence_series_id = excluded.recurrence_series_id,
                    revision = excluded.revision,
                    deleted_at = excluded.deleted_at,
                    updated_at = excluded.updated_at,
                    data_json = excluded.data_json
                "#,
            )
            .bind(&item.id)
            .bind(&item.calendar_id)
            .bind(&item.uid)
            .bind(item.kind.as_str())
            .bind(start_sort)
            .bind(end_sort)
            .bind(item.recurrence.as_ref().map(|value| value.rrule.as_str()))
            .bind(
                item.recurrence_id
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            )
            .bind(
                item.recurrence_id
                    .as_ref()
                    .map(|value| time_sort_value(value, false))
                    .transpose()?,
            )
            .bind(item.recurrence_series_id.as_deref())
            .bind(item.revision)
            .bind(item.deleted_at.as_deref())
            .bind(&item.created_at)
            .bind(&item.updated_at)
            .bind(item_json)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO pending_operations (
                    client_operation_id, device_id, calendar_id, item_id,
                    expected_revision, source_change_id, propagation_lineage_json,
                    mutation_json, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                ON CONFLICT(client_operation_id) DO NOTHING
                "#,
            )
            .bind(&operation.client_operation_id)
            .bind(&operation.device_id)
            .bind(&item.calendar_id)
            .bind(&item.id)
            .bind(operation.expected_revision)
            .bind(operation.source_change_id.as_deref())
            .bind(lineage_json)
            .bind(mutation_json)
            .bind(Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_item_with_operation(
        &self,
        calendar_id: &str,
        item_id: &str,
        deleted_at: &str,
        operation: &CalendarOperation,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(calendar_id, "calendar ID")?;
        validate_non_empty(item_id, "calendar item ID")?;
        validate_timestamp(deleted_at, "calendar item deletedAt")?;
        validate_non_empty(&operation.client_operation_id, "client operation ID")?;
        validate_non_empty(&operation.device_id, "device ID")?;
        match &operation.mutation {
            CalendarMutation::DeleteItem {
                calendar_id: queued_calendar_id,
                item_id: queued_item_id,
                deleted_at: queued_deleted_at,
            } if queued_calendar_id == calendar_id
                && queued_item_id == item_id
                && queued_deleted_at == deleted_at => {}
            _ => {
                return Err(CalendarStoreError::Validation(
                    "item deletes require a matching deleteItem operation".into(),
                ));
            }
        }

        let mut tx = self.pool.begin().await?;
        let operation_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE client_operation_id = ?)",
        )
        .bind(&operation.client_operation_id)
        .fetch_one(&mut *tx)
        .await?;
        if operation_exists {
            tx.commit().await?;
            return Ok(());
        }
        let calendar = sqlx::query("SELECT read_only FROM calendars WHERE id = ?")
            .bind(calendar_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(CalendarStoreError::CalendarNotFound)?;
        if calendar.get::<bool, _>("read_only") {
            return Err(CalendarStoreError::ReadOnly);
        }
        let row = sqlx::query(
            "SELECT revision, data_json FROM calendar_items WHERE id = ? AND calendar_id = ?",
        )
        .bind(item_id)
        .bind(calendar_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| CalendarStoreError::Validation("calendar item not found".into()))?;
        let actual = row.get::<i64, _>("revision");
        if let Some(expected) = operation.expected_revision {
            if actual != expected {
                return Err(CalendarStoreError::Conflict { expected, actual });
            }
        }
        let mut item: CalendarItem = serde_json::from_str(row.get("data_json"))?;
        item.deleted_at = Some(deleted_at.to_owned());
        item.updated_at = deleted_at.to_owned();
        item.revision = actual + 1;
        let mutation_json = serde_json::to_string(&operation.mutation)?;
        let lineage_json = serde_json::to_string(&operation.propagation_lineage)?;
        sqlx::query(
            "UPDATE calendar_items SET revision = ?, deleted_at = ?, updated_at = ?, data_json = ? WHERE id = ?",
        )
        .bind(item.revision)
        .bind(deleted_at)
        .bind(deleted_at)
        .bind(serde_json::to_string(&item)?)
        .bind(item_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO pending_operations (
                client_operation_id, device_id, calendar_id, item_id,
                expected_revision, source_change_id, propagation_lineage_json,
                mutation_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"#,
        )
        .bind(&operation.client_operation_id)
        .bind(&operation.device_id)
        .bind(calendar_id)
        .bind(item_id)
        .bind(operation.expected_revision)
        .bind(operation.source_change_id.as_deref())
        .bind(lineage_json)
        .bind(mutation_json)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn search_items(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CalendarItem>, CalendarStoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if limit == 0 || limit > MAX_SEARCH_QUERY_ITEMS {
            return Err(CalendarStoreError::Validation(format!(
                "search limit must be between 1 and {MAX_SEARCH_QUERY_ITEMS}"
            )));
        }
        let escaped = query
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let rows = sqlx::query(
            r#"SELECT data_json FROM calendar_items
               WHERE deleted_at IS NULL AND lower(data_json) LIKE ? ESCAPE '\'
               ORDER BY updated_at DESC, id LIMIT ?"#,
        )
        .bind(format!("%{escaped}%"))
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn acknowledge_operations(
        &self,
        client_operation_ids: &[String],
    ) -> Result<(), CalendarStoreError> {
        let mut tx = self.pool.begin().await?;
        for operation_id in client_operation_ids {
            validate_non_empty(operation_id, "client operation ID")?;
            sqlx::query("DELETE FROM pending_operations WHERE client_operation_id = ?")
                .bind(operation_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn remove_hosted_origin_cache(
        &self,
        server_url: &str,
        user_id: &str,
    ) -> Result<CalendarCleanupResult, CalendarStoreError> {
        validate_non_empty(server_url, "hosted calendar server URL")?;
        validate_non_empty(user_id, "hosted calendar user ID")?;
        let normalized_server_url = server_url.trim_end_matches('/');
        let origin_key = format!("{normalized_server_url}::{user_id}");
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query("SELECT id, location_json FROM calendars")
            .fetch_all(&mut *tx)
            .await?;
        let mut calendar_ids = Vec::new();
        for row in rows {
            let location: crate::models::CalendarLocation =
                serde_json::from_str(row.get::<&str, _>("location_json"))?;
            if matches!(
                location,
                crate::models::CalendarLocation::Hosted { server_url, user_id: owner }
                    if server_url.trim_end_matches('/') == normalized_server_url && owner == user_id
            ) {
                calendar_ids.push(row.get::<String, _>("id"));
            }
        }

        for calendar_id in &calendar_ids {
            let unresolved = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM pending_operations WHERE calendar_id=? AND status IN ('pending', 'failed'))",
            )
            .bind(calendar_id)
            .fetch_one(&mut *tx)
            .await?;
            if unresolved {
                return Err(CalendarStoreError::Validation(
                    "hosted calendar cache has unresolved changes".into(),
                ));
            }
        }

        let mut items_removed = 0_u64;
        for calendar_id in &calendar_ids {
            items_removed += sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM calendar_items WHERE calendar_id=?",
            )
            .bind(calendar_id)
            .fetch_one(&mut *tx)
            .await? as u64;
            sqlx::query("DELETE FROM calendars WHERE id=?")
                .bind(calendar_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("DELETE FROM sync_state WHERE origin_key=?")
            .bind(origin_key)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(CalendarCleanupResult {
            calendars_removed: calendar_ids.len() as u64,
            items_removed,
        })
    }

    pub async fn read_sync_state(
        &self,
        origin_key: &str,
    ) -> Result<Option<CalendarSyncState>, CalendarStoreError> {
        validate_non_empty(origin_key, "sync origin key")?;
        let row = sqlx::query(
            "SELECT origin_key, cursor, last_synced_at, last_error FROM sync_state WHERE origin_key = ?",
        )
        .bind(origin_key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| CalendarSyncState {
            origin_key: row.get("origin_key"),
            cursor: row.get("cursor"),
            last_synced_at: row.get("last_synced_at"),
            last_error: row.get("last_error"),
        }))
    }

    pub async fn write_sync_state(
        &self,
        state: &CalendarSyncState,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(&state.origin_key, "sync origin key")?;
        if let Some(value) = &state.last_synced_at {
            validate_timestamp(value, "sync lastSyncedAt")?;
        }
        sqlx::query(
            r#"INSERT INTO sync_state (origin_key, cursor, last_synced_at, last_error)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(origin_key) DO UPDATE SET
                 cursor = excluded.cursor,
                 last_synced_at = excluded.last_synced_at,
                 last_error = excluded.last_error"#,
        )
        .bind(&state.origin_key)
        .bind(state.cursor.as_deref())
        .bind(state.last_synced_at.as_deref())
        .bind(state.last_error.as_deref())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Applies one server change page and advances its cursor in the same
    /// transaction. A failed page is therefore safe to retry after restart.
    pub async fn apply_remote_changes(
        &self,
        changes: &[CalendarRemoteChange],
        state: &CalendarSyncState,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(&state.origin_key, "sync origin key")?;
        if let Some(value) = &state.last_synced_at {
            validate_timestamp(value, "sync lastSyncedAt")?;
        }
        let mut tx = self.pool.begin().await?;
        for change in changes {
            if change.sequence < 1 {
                return Err(CalendarStoreError::Validation(
                    "remote change sequence must be positive".into(),
                ));
            }
            validate_non_empty(&change.entity_id, "remote entity ID")?;
            validate_timestamp(&change.changed_at, "remote changedAt")?;
            match (change.entity_type.as_str(), change.operation.as_str()) {
                ("calendar", "upsert") => {
                    let mut calendar: CalendarDefinition =
                        serde_json::from_value(change.payload.clone().ok_or_else(|| {
                            CalendarStoreError::Validation(
                                "remote calendar upserts require a payload".into(),
                            )
                        })?)?;
                    if calendar.id != change.entity_id {
                        return Err(CalendarStoreError::Validation(
                            "remote calendar payload ID does not match its change".into(),
                        ));
                    }
                    validate_calendar(&calendar)?;
                    calendar.schema_version = CALENDAR_SCHEMA_VERSION;
                    calendar.read_only =
                        calendar.read_only || calendar.location.is_inherently_read_only();
                    sqlx::query(
                        r#"INSERT INTO calendars (
                            id, global_id, location_json, name, color, default_time_zone,
                            archived, read_only, revision, deleted_at, created_at, updated_at, data_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            global_id=excluded.global_id, location_json=excluded.location_json,
                            name=excluded.name, color=excluded.color,
                            default_time_zone=excluded.default_time_zone,
                            archived=excluded.archived, read_only=excluded.read_only,
                            revision=excluded.revision, deleted_at=excluded.deleted_at,
                            created_at=excluded.created_at, updated_at=excluded.updated_at,
                            data_json=excluded.data_json"#,
                    )
                    .bind(&calendar.id)
                    .bind(&calendar.global_id)
                    .bind(serde_json::to_string(&calendar.location)?)
                    .bind(&calendar.name)
                    .bind(&calendar.color)
                    .bind(&calendar.default_time_zone)
                    .bind(calendar.archived)
                    .bind(calendar.read_only)
                    .bind(calendar.revision)
                    .bind(calendar.deleted_at.as_deref())
                    .bind(&calendar.created_at)
                    .bind(&calendar.updated_at)
                    .bind(serde_json::to_string(&calendar)?)
                    .execute(&mut *tx)
                    .await?;
                }
                ("calendar", "delete") => {
                    reject_delete_payload(change)?;
                    if let Some(row) = sqlx::query("SELECT data_json FROM calendars WHERE id=?")
                        .bind(&change.entity_id)
                        .fetch_optional(&mut *tx)
                        .await?
                    {
                        let mut calendar: CalendarDefinition =
                            serde_json::from_str(row.get("data_json"))?;
                        calendar.deleted_at = Some(change.changed_at.clone());
                        calendar.updated_at = change.changed_at.clone();
                        sqlx::query(
                            "UPDATE calendars SET deleted_at=?, updated_at=?, data_json=? WHERE id=?",
                        )
                        .bind(&change.changed_at)
                        .bind(&change.changed_at)
                        .bind(serde_json::to_string(&calendar)?)
                        .bind(&change.entity_id)
                        .execute(&mut *tx)
                        .await?;
                    }
                }
                ("item", "upsert") => {
                    let item: CalendarItem =
                        serde_json::from_value(change.payload.clone().ok_or_else(|| {
                            CalendarStoreError::Validation(
                                "remote item upserts require a payload".into(),
                            )
                        })?)?;
                    if item.id != change.entity_id {
                        return Err(CalendarStoreError::Validation(
                            "remote item payload ID does not match its change".into(),
                        ));
                    }
                    validate_item(&item)?;
                    let calendar_exists = sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM calendars WHERE id=?)",
                    )
                    .bind(&item.calendar_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !calendar_exists {
                        return Err(CalendarStoreError::CalendarNotFound);
                    }
                    let (start_sort, end_sort) = item_sort_range(&item)?;
                    let recurrence_id = item
                        .recurrence_id
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?;
                    let recurrence_sort = item
                        .recurrence_id
                        .as_ref()
                        .map(|value| time_sort_value(value, false))
                        .transpose()?;
                    sqlx::query(
                        r#"INSERT INTO calendar_items (
                            id, calendar_id, uid, kind, start_sort, end_sort, recurrence_rule,
                            recurrence_id, recurrence_sort, recurrence_series_id, revision,
                            deleted_at, created_at, updated_at, data_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            calendar_id=excluded.calendar_id, uid=excluded.uid, kind=excluded.kind,
                            start_sort=excluded.start_sort, end_sort=excluded.end_sort,
                            recurrence_rule=excluded.recurrence_rule,
                            recurrence_id=excluded.recurrence_id,
                            recurrence_sort=excluded.recurrence_sort,
                            recurrence_series_id=excluded.recurrence_series_id,
                            revision=excluded.revision, deleted_at=excluded.deleted_at,
                            created_at=excluded.created_at, updated_at=excluded.updated_at,
                            data_json=excluded.data_json"#,
                    )
                    .bind(&item.id)
                    .bind(&item.calendar_id)
                    .bind(&item.uid)
                    .bind(item.kind.as_str())
                    .bind(start_sort)
                    .bind(end_sort)
                    .bind(item.recurrence.as_ref().map(|value| value.rrule.as_str()))
                    .bind(recurrence_id)
                    .bind(recurrence_sort)
                    .bind(item.recurrence_series_id.as_deref())
                    .bind(item.revision)
                    .bind(item.deleted_at.as_deref())
                    .bind(&item.created_at)
                    .bind(&item.updated_at)
                    .bind(serde_json::to_string(&item)?)
                    .execute(&mut *tx)
                    .await?;
                }
                ("item", "delete") => {
                    reject_delete_payload(change)?;
                    if let Some(row) =
                        sqlx::query("SELECT data_json FROM calendar_items WHERE id=?")
                            .bind(&change.entity_id)
                            .fetch_optional(&mut *tx)
                            .await?
                    {
                        let mut item: CalendarItem = serde_json::from_str(row.get("data_json"))?;
                        item.deleted_at = Some(change.changed_at.clone());
                        item.updated_at = change.changed_at.clone();
                        sqlx::query(
                            "UPDATE calendar_items SET deleted_at=?, updated_at=?, data_json=? WHERE id=?",
                        )
                        .bind(&change.changed_at)
                        .bind(&change.changed_at)
                        .bind(serde_json::to_string(&item)?)
                        .bind(&change.entity_id)
                        .execute(&mut *tx)
                        .await?;
                    }
                }
                _ => {
                    return Err(CalendarStoreError::Validation(
                        "remote calendar change type is invalid".into(),
                    ));
                }
            }
        }
        sqlx::query(
            r#"INSERT INTO sync_state (origin_key, cursor, last_synced_at, last_error)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(origin_key) DO UPDATE SET
                 cursor=excluded.cursor, last_synced_at=excluded.last_synced_at,
                 last_error=excluded.last_error"#,
        )
        .bind(&state.origin_key)
        .bind(state.cursor.as_deref())
        .bind(state.last_synced_at.as_deref())
        .bind(state.last_error.as_deref())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_pending_operations(
        &self,
    ) -> Result<Vec<CalendarOperation>, CalendarStoreError> {
        let rows = sqlx::query(
            r#"
            SELECT client_operation_id, device_id, expected_revision,
                   source_change_id, propagation_lineage_json, mutation_json
              FROM pending_operations
             WHERE status = 'pending'
             ORDER BY created_at, client_operation_id
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CalendarOperation {
                    client_operation_id: row.get("client_operation_id"),
                    device_id: row.get("device_id"),
                    expected_revision: row.get("expected_revision"),
                    source_change_id: row.get("source_change_id"),
                    propagation_lineage: serde_json::from_str(
                        row.get::<&str, _>("propagation_lineage_json"),
                    )?,
                    mutation: serde_json::from_str(row.get::<&str, _>("mutation_json"))?,
                })
            })
            .collect()
    }

    pub async fn list_failed_operations(
        &self,
    ) -> Result<Vec<CalendarOperationFailure>, CalendarStoreError> {
        let rows = sqlx::query(
            r#"SELECT client_operation_id, device_id, expected_revision,
                      source_change_id, propagation_lineage_json, mutation_json,
                      attempt_count, last_error, last_attempt_at
                 FROM pending_operations
                WHERE status = 'failed'
                ORDER BY last_attempt_at DESC, created_at, client_operation_id"#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CalendarOperationFailure {
                    operation: CalendarOperation {
                        client_operation_id: row.get("client_operation_id"),
                        device_id: row.get("device_id"),
                        expected_revision: row.get("expected_revision"),
                        source_change_id: row.get("source_change_id"),
                        propagation_lineage: serde_json::from_str(
                            row.get::<&str, _>("propagation_lineage_json"),
                        )?,
                        mutation: serde_json::from_str(row.get::<&str, _>("mutation_json"))?,
                    },
                    attempt_count: row.get("attempt_count"),
                    last_error: row.get("last_error"),
                    last_attempt_at: row.get("last_attempt_at"),
                })
            })
            .collect()
    }

    pub async fn mark_operation_failed(
        &self,
        client_operation_id: &str,
        error: &str,
        attempted_at: &str,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(client_operation_id, "client operation ID")?;
        validate_non_empty(error, "calendar sync error")?;
        validate_timestamp(attempted_at, "calendar operation attemptedAt")?;
        let result = sqlx::query(
            r#"UPDATE pending_operations
                  SET status='failed', attempt_count=attempt_count+1,
                      last_error=?, last_attempt_at=?
                WHERE client_operation_id=?"#,
        )
        .bind(error)
        .bind(attempted_at)
        .bind(client_operation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(CalendarStoreError::Validation(
                "calendar operation not found".into(),
            ));
        }
        Ok(())
    }

    pub async fn retry_operation(
        &self,
        client_operation_id: &str,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(client_operation_id, "client operation ID")?;
        let result = sqlx::query(
            r#"UPDATE pending_operations
                  SET status='pending', last_error=NULL, last_attempt_at=NULL
                WHERE client_operation_id=? AND status='failed'"#,
        )
        .bind(client_operation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(CalendarStoreError::Validation(
                "failed calendar operation not found".into(),
            ));
        }
        Ok(())
    }

    pub async fn discard_operation(
        &self,
        client_operation_id: &str,
    ) -> Result<(), CalendarStoreError> {
        validate_non_empty(client_operation_id, "client operation ID")?;
        let result = sqlx::query(
            "DELETE FROM pending_operations WHERE client_operation_id=? AND status='failed'",
        )
        .bind(client_operation_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(CalendarStoreError::Validation(
                "failed calendar operation not found".into(),
            ));
        }
        Ok(())
    }

    pub async fn list_mirror_groups(&self) -> Result<Vec<CalendarMirrorGroup>, CalendarStoreError> {
        let rows = sqlx::query(
            "SELECT data_json FROM calendar_mirror_groups ORDER BY name COLLATE NOCASE, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn upsert_mirror_group(
        &self,
        group: &CalendarMirrorGroup,
    ) -> Result<(), CalendarStoreError> {
        validate_mirror_group(group)?;
        let mut tx = self.pool.begin().await?;
        for member in &group.members {
            let calendar = sqlx::query(
                "SELECT location_json, read_only, deleted_at FROM calendars WHERE id=?",
            )
            .bind(&member.calendar_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(CalendarStoreError::CalendarNotFound)?;
            let location: crate::models::CalendarLocation =
                serde_json::from_str(calendar.get::<&str, _>("location_json"))?;
            if location != member.location {
                return Err(CalendarStoreError::Validation(
                    "mirror member location does not match its calendar".into(),
                ));
            }
            if calendar.get::<bool, _>("read_only")
                || calendar.get::<Option<String>, _>("deleted_at").is_some()
            {
                return Err(CalendarStoreError::ReadOnly);
            }
        }
        sqlx::query(
            r#"INSERT INTO calendar_mirror_groups
               (id,name,enabled,created_at,updated_at,data_json)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,
                 updated_at=excluded.updated_at,data_json=excluded.data_json"#,
        )
        .bind(&group.id)
        .bind(&group.name)
        .bind(group.enabled)
        .bind(&group.created_at)
        .bind(&group.updated_at)
        .bind(serde_json::to_string(group)?)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_mirror_group(&self, group_id: &str) -> Result<(), CalendarStoreError> {
        validate_non_empty(group_id, "mirror group ID")?;
        sqlx::query("DELETE FROM calendar_mirror_groups WHERE id=?")
            .bind(group_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_mirror_anchors(
        &self,
        group_id: &str,
    ) -> Result<Vec<CalendarMirrorAnchor>, CalendarStoreError> {
        validate_non_empty(group_id, "mirror group ID")?;
        let rows = sqlx::query(
            "SELECT data_json FROM calendar_mirror_anchors WHERE group_id=? ORDER BY logical_item_key, member_id",
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn upsert_mirror_anchors(
        &self,
        anchors: &[CalendarMirrorAnchor],
    ) -> Result<(), CalendarStoreError> {
        let mut tx = self.pool.begin().await?;
        for anchor in anchors {
            validate_mirror_anchor(anchor)?;
            sqlx::query(
                r#"INSERT INTO calendar_mirror_anchors
                   (group_id,logical_item_key,member_id,item_id,revision,fingerprint,deleted_at,updated_at,data_json)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(group_id,logical_item_key,member_id) DO UPDATE SET
                     item_id=excluded.item_id,revision=excluded.revision,
                     fingerprint=excluded.fingerprint,deleted_at=excluded.deleted_at,
                     updated_at=excluded.updated_at,data_json=excluded.data_json"#,
            )
            .bind(&anchor.group_id)
            .bind(&anchor.logical_item_key)
            .bind(&anchor.member_id)
            .bind(anchor.item_id.as_deref())
            .bind(anchor.revision)
            .bind(&anchor.fingerprint)
            .bind(anchor.deleted_at.as_deref())
            .bind(&anchor.updated_at)
            .bind(serde_json::to_string(anchor)?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_mirror_conflicts(
        &self,
        group_id: Option<&str>,
        include_resolved: bool,
    ) -> Result<Vec<CalendarMirrorConflict>, CalendarStoreError> {
        let rows = match (group_id, include_resolved) {
            (Some(group_id), true) => {
                validate_non_empty(group_id, "mirror group ID")?;
                sqlx::query("SELECT data_json FROM calendar_mirror_conflicts WHERE group_id=? ORDER BY detected_at DESC")
                    .bind(group_id)
                    .fetch_all(&self.pool)
                    .await?
            }
            (Some(group_id), false) => {
                validate_non_empty(group_id, "mirror group ID")?;
                sqlx::query("SELECT data_json FROM calendar_mirror_conflicts WHERE group_id=? AND status='unresolved' ORDER BY detected_at DESC")
                    .bind(group_id)
                    .fetch_all(&self.pool)
                    .await?
            }
            (None, true) => sqlx::query("SELECT data_json FROM calendar_mirror_conflicts ORDER BY detected_at DESC")
                .fetch_all(&self.pool)
                .await?,
            (None, false) => sqlx::query("SELECT data_json FROM calendar_mirror_conflicts WHERE status='unresolved' ORDER BY detected_at DESC")
                .fetch_all(&self.pool)
                .await?,
        };
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn upsert_mirror_conflict(
        &self,
        conflict: &CalendarMirrorConflict,
    ) -> Result<(), CalendarStoreError> {
        validate_mirror_conflict(conflict)?;
        sqlx::query(
            r#"INSERT INTO calendar_mirror_conflicts
               (id,group_id,logical_item_key,status,detected_at,resolved_at,data_json)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET status=excluded.status,
                 resolved_at=excluded.resolved_at,data_json=excluded.data_json"#,
        )
        .bind(&conflict.id)
        .bind(&conflict.group_id)
        .bind(&conflict.logical_item_key)
        .bind(&conflict.status)
        .bind(&conflict.detected_at)
        .bind(conflict.resolved_at.as_deref())
        .bind(serde_json::to_string(conflict)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_items_for_mirror(
        &self,
        calendar_ids: &[String],
        limit: u32,
    ) -> Result<Vec<CalendarItem>, CalendarStoreError> {
        if calendar_ids.len() < 2 || calendar_ids.len() > MAX_MIRROR_GROUP_MEMBERS {
            return Err(CalendarStoreError::Validation(
                "mirror item queries require between 2 and 8 calendars".into(),
            ));
        }
        if limit == 0 || limit > MAX_RANGE_QUERY_ITEMS {
            return Err(CalendarStoreError::Validation(format!(
                "query limit must be between 1 and {MAX_RANGE_QUERY_ITEMS}"
            )));
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT data_json FROM calendar_items WHERE calendar_id IN (",
        );
        let mut separated = query.separated(", ");
        for id in calendar_ids {
            validate_non_empty(id, "calendar ID")?;
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY updated_at, id LIMIT ");
        query.push_bind(limit + 1);
        let rows = query.build().fetch_all(&self.pool).await?;
        if rows.len() > limit as usize {
            return Err(CalendarStoreError::Validation(format!(
                "mirror group exceeds the bounded {limit}-item pass limit"
            )));
        }
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }

    pub async fn list_items_for_calendar(
        &self,
        calendar_id: &str,
        limit: u32,
    ) -> Result<Vec<CalendarItem>, CalendarStoreError> {
        validate_non_empty(calendar_id, "calendar ID")?;
        if limit == 0 || limit > MAX_RANGE_QUERY_ITEMS {
            return Err(CalendarStoreError::Validation(format!(
                "query limit must be between 1 and {MAX_RANGE_QUERY_ITEMS}"
            )));
        }
        let rows = sqlx::query(
            "SELECT data_json FROM calendar_items WHERE calendar_id = ? ORDER BY updated_at, id LIMIT ?",
        )
        .bind(calendar_id)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        if rows.len() > limit as usize {
            return Err(CalendarStoreError::Validation(format!(
                "calendar exceeds the bounded {limit}-item limit"
            )));
        }
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get::<&str, _>("data_json")).map_err(Into::into))
            .collect()
    }
}

fn reject_delete_payload(change: &CalendarRemoteChange) -> Result<(), CalendarStoreError> {
    if change.payload.is_some() {
        return Err(CalendarStoreError::Validation(
            "remote deletes must not include a payload".into(),
        ));
    }
    Ok(())
}

fn validate_segment(value: &str, label: &str) -> Result<(), CalendarStoreError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(CalendarStoreError::Validation(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_non_empty(value: &str, label: &str) -> Result<(), CalendarStoreError> {
    if value.trim().is_empty() {
        return Err(CalendarStoreError::Validation(format!(
            "{label} is required"
        )));
    }
    Ok(())
}

fn validate_timestamp(value: &str, label: &str) -> Result<(), CalendarStoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| CalendarStoreError::Validation(format!("{label} must be RFC 3339")))
}

fn validate_calendar(calendar: &CalendarDefinition) -> Result<(), CalendarStoreError> {
    validate_non_empty(&calendar.id, "calendar ID")?;
    validate_non_empty(&calendar.global_id, "calendar global ID")?;
    validate_non_empty(&calendar.name, "calendar name")?;
    if calendar.revision < 0 {
        return Err(CalendarStoreError::Validation(
            "calendar revision cannot be negative".into(),
        ));
    }
    validate_timestamp(&calendar.created_at, "calendar createdAt")?;
    validate_timestamp(&calendar.updated_at, "calendar updatedAt")?;
    if let Some(deleted_at) = &calendar.deleted_at {
        validate_timestamp(deleted_at, "calendar deletedAt")?;
    }
    Ok(())
}

fn validate_item(item: &CalendarItem) -> Result<(), CalendarStoreError> {
    for (value, label) in [
        (&item.id, "calendar item ID"),
        (&item.uid, "calendar item UID"),
        (&item.calendar_id, "calendar ID"),
        (&item.title, "calendar item title"),
    ] {
        validate_non_empty(value, label)?;
    }
    if item.revision < 0 {
        return Err(CalendarStoreError::Validation(
            "calendar item revision cannot be negative".into(),
        ));
    }
    if item.icalendar_properties.len() > crate::MAX_ICALENDAR_PROPERTIES
        || item.icalendar_properties.iter().any(|line| {
            line.len() > crate::MAX_ICALENDAR_PROPERTY_LENGTH
                || line.contains(['\r', '\n'])
                || !line.split_once(':').is_some_and(|(head, _)| {
                    let head = head.to_ascii_uppercase();
                    head.starts_with("X-") && !head.starts_with("X-COLLAB-")
                })
        })
    {
        return Err(CalendarStoreError::Validation(
            "invalid preserved iCalendar properties".into(),
        ));
    }
    validate_timestamp(&item.created_at, "calendar item createdAt")?;
    validate_timestamp(&item.updated_at, "calendar item updatedAt")?;
    match item.kind {
        CalendarItemKind::Event if item.start.is_none() || item.end.is_none() => Err(
            CalendarStoreError::Validation("events require start and end values".into()),
        ),
        CalendarItemKind::Birthday if item.date.is_none() => Err(CalendarStoreError::Validation(
            "birthdays require a date".into(),
        )),
        _ => Ok(()),
    }
}

fn validate_subscription(subscription: &CalendarSubscription) -> Result<(), CalendarStoreError> {
    validate_non_empty(&subscription.id, "subscription ID")?;
    validate_non_empty(&subscription.calendar_id, "subscription calendar ID")?;
    validate_non_empty(&subscription.feed_url, "subscription feed URL")?;
    validate_timestamp(&subscription.created_at, "subscription createdAt")?;
    validate_timestamp(&subscription.updated_at, "subscription updatedAt")?;
    if let Some(last_refreshed_at) = &subscription.last_refreshed_at {
        validate_timestamp(last_refreshed_at, "subscription lastRefreshedAt")?;
    }
    Ok(())
}

fn validate_mirror_group(group: &CalendarMirrorGroup) -> Result<(), CalendarStoreError> {
    validate_non_empty(&group.id, "mirror group ID")?;
    validate_non_empty(&group.name, "mirror group name")?;
    validate_timestamp(&group.created_at, "mirror group createdAt")?;
    validate_timestamp(&group.updated_at, "mirror group updatedAt")?;
    if group.schema_version != 1 {
        return Err(CalendarStoreError::Validation(
            "unsupported mirror group schema version".into(),
        ));
    }
    if group.members.len() < 2 || group.members.len() > MAX_MIRROR_GROUP_MEMBERS {
        return Err(CalendarStoreError::Validation(
            "mirror groups require between 2 and 8 members".into(),
        ));
    }
    let mut member_ids = std::collections::HashSet::new();
    let mut calendar_ids = std::collections::HashSet::new();
    let mut location_keys = std::collections::HashSet::new();
    for member in &group.members {
        validate_non_empty(&member.id, "mirror member ID")?;
        validate_non_empty(&member.calendar_id, "mirror member calendar ID")?;
        validate_timestamp(&member.added_at, "mirror member addedAt")?;
        if member.location.is_inherently_read_only() {
            return Err(CalendarStoreError::ReadOnly);
        }
        let location_key = serde_json::to_string(&member.location)?;
        if !member_ids.insert(&member.id)
            || !calendar_ids.insert(&member.calendar_id)
            || !location_keys.insert(location_key)
        {
            return Err(CalendarStoreError::Validation(
                "mirror group members must have unique IDs, calendars, and locations".into(),
            ));
        }
    }
    Ok(())
}

fn validate_mirror_anchor(anchor: &CalendarMirrorAnchor) -> Result<(), CalendarStoreError> {
    validate_non_empty(&anchor.group_id, "mirror group ID")?;
    validate_non_empty(&anchor.logical_item_key, "mirror logical item key")?;
    validate_non_empty(&anchor.member_id, "mirror member ID")?;
    validate_non_empty(&anchor.fingerprint, "mirror fingerprint")?;
    validate_timestamp(&anchor.updated_at, "mirror anchor updatedAt")?;
    if let Some(revision) = anchor.revision {
        if revision < 0 {
            return Err(CalendarStoreError::Validation(
                "mirror anchor revision cannot be negative".into(),
            ));
        }
    }
    if let Some(deleted_at) = &anchor.deleted_at {
        validate_timestamp(deleted_at, "mirror anchor deletedAt")?;
    }
    Ok(())
}

fn validate_mirror_conflict(conflict: &CalendarMirrorConflict) -> Result<(), CalendarStoreError> {
    validate_non_empty(&conflict.id, "mirror conflict ID")?;
    validate_non_empty(&conflict.group_id, "mirror group ID")?;
    validate_non_empty(&conflict.logical_item_key, "mirror logical item key")?;
    validate_timestamp(&conflict.detected_at, "mirror conflict detectedAt")?;
    if conflict.status != "unresolved" && conflict.status != "resolved" {
        return Err(CalendarStoreError::Validation(
            "mirror conflict status is invalid".into(),
        ));
    }
    if conflict.versions.len() < 2 {
        return Err(CalendarStoreError::Validation(
            "mirror conflicts require at least two versions".into(),
        ));
    }
    if let Some(resolved_at) = &conflict.resolved_at {
        validate_timestamp(resolved_at, "mirror conflict resolvedAt")?;
    }
    Ok(())
}

fn parse_date(value: &str) -> Result<i64, CalendarStoreError> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| CalendarStoreError::Validation("invalid calendar date".into()))?;
    Ok(date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_utc()
        .timestamp_millis())
}

fn time_sort_value(value: &CalendarTimeValue, end_of_day: bool) -> Result<i64, CalendarStoreError> {
    match value {
        CalendarTimeValue::Date { date } => {
            let start = parse_date(date)?;
            Ok(if end_of_day {
                start + 86_400_000
            } else {
                start
            })
        }
        CalendarTimeValue::DateTime { date_time, .. } => DateTime::parse_from_rfc3339(date_time)
            .map(|date| date.timestamp_millis())
            .map_err(|_| CalendarStoreError::Validation("invalid calendar timestamp".into())),
    }
}

fn item_sort_range(item: &CalendarItem) -> Result<(Option<i64>, Option<i64>), CalendarStoreError> {
    match item.kind {
        CalendarItemKind::Event => {
            let start = item
                .start
                .as_ref()
                .ok_or_else(|| CalendarStoreError::Validation("event start is required".into()))?;
            let end = item
                .end
                .as_ref()
                .ok_or_else(|| CalendarStoreError::Validation("event end is required".into()))?;
            let start_sort = time_sort_value(start, false)?;
            let end_sort = time_sort_value(end, false)?;
            if end_sort <= start_sort {
                return Err(CalendarStoreError::Validation(
                    "event end must be after start".into(),
                ));
            }
            Ok((Some(start_sort), Some(end_sort)))
        }
        CalendarItemKind::Task => {
            let start = item.start.as_ref().or(item.due.as_ref());
            let end = item.due.as_ref().or(item.start.as_ref());
            match (start, end) {
                (Some(start), Some(end)) => Ok((
                    Some(time_sort_value(start, false)?),
                    Some(time_sort_value(end, true)?),
                )),
                _ => Ok((None, None)),
            }
        }
        CalendarItemKind::Birthday => Ok((None, None)),
    }
}

fn parse_query_bound(value: &str) -> Result<i64, CalendarStoreError> {
    parse_date(value).or_else(|_| {
        DateTime::parse_from_rfc3339(value)
            .map(|date| date.timestamp_millis())
            .map_err(|_| CalendarStoreError::Validation("invalid query bound".into()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CalendarLocation, CalendarMirrorConflictVersion, CalendarMirrorMember, CalendarTimeValue,
    };

    fn calendar(read_only: bool) -> CalendarDefinition {
        CalendarDefinition {
            schema_version: CALENDAR_SCHEMA_VERSION,
            id: "calendar-1".into(),
            global_id: "global-1".into(),
            location: CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
            name: "Personal".into(),
            color: "#a855f7".into(),
            default_time_zone: "Europe/Berlin".into(),
            archived: false,
            read_only,
            revision: 0,
            created_at: "2026-07-22T08:00:00Z".into(),
            updated_at: "2026-07-22T08:00:00Z".into(),
            deleted_at: None,
        }
    }

    fn event() -> CalendarItem {
        CalendarItem {
            id: "event-1".into(),
            uid: "event-1@collab.local".into(),
            calendar_id: "calendar-1".into(),
            kind: CalendarItemKind::Event,
            title: "Planning".into(),
            description: None,
            url: None,
            reminders: Vec::new(),
            attendees: Vec::new(),
            attachments: Vec::new(),
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: Vec::new(),
            start: Some(CalendarTimeValue::DateTime {
                date_time: "2026-07-22T10:00:00Z".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            end: Some(CalendarTimeValue::DateTime {
                date_time: "2026-07-22T11:00:00Z".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: Some("busy".into()),
            priority: None,
            status: None,
            completed_at: None,
            revision: 0,
            created_at: "2026-07-22T08:00:00Z".into(),
            updated_at: "2026-07-22T08:00:00Z".into(),
            deleted_at: None,
        }
    }

    fn operation() -> CalendarOperation {
        CalendarOperation {
            client_operation_id: "operation-1".into(),
            device_id: "device-1".into(),
            expected_revision: Some(0),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::UpsertItem { item: event() },
        }
    }

    #[tokio::test]
    async fn imports_item_batches_atomically_and_lists_one_calendar() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();

        let first = event();
        let first_operation = operation();
        let mut second = event();
        second.id = "event-2".into();
        second.uid = "event-2@collab.local".into();
        second.title = "Follow-up".into();
        let mut stale_operation = CalendarOperation {
            client_operation_id: "operation-2".into(),
            mutation: CalendarMutation::UpsertItem {
                item: second.clone(),
            },
            ..operation()
        };
        stale_operation.expected_revision = Some(9);

        assert!(matches!(
            store
                .upsert_items_with_operations(&[
                    (first.clone(), first_operation.clone()),
                    (second.clone(), stale_operation),
                ])
                .await,
            Err(CalendarStoreError::Conflict {
                expected: 9,
                actual: 0
            })
        ));
        assert!(store
            .list_items_for_calendar("calendar-1", 10)
            .await
            .unwrap()
            .is_empty());

        let second_operation = CalendarOperation {
            client_operation_id: "operation-2".into(),
            mutation: CalendarMutation::UpsertItem {
                item: second.clone(),
            },
            ..operation()
        };
        store
            .upsert_items_with_operations(&[
                (first.clone(), first_operation),
                (second.clone(), second_operation),
            ])
            .await
            .unwrap();
        assert_eq!(
            store
                .list_items_for_calendar("calendar-1", 10)
                .await
                .unwrap(),
            vec![first, second]
        );
        assert_eq!(store.list_pending_operations().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn creates_a_profile_database_and_round_trips_calendars() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        assert_eq!(
            store.path(),
            root.path().join("profiles/profile-1/calendar.sqlite")
        );
        store.upsert_calendar(&calendar(false)).await.unwrap();
        assert_eq!(store.list_calendars().await.unwrap(), vec![calendar(false)]);
        let schema_version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(schema_version, LOCAL_STORE_SCHEMA_VERSION);
        let profile_id = sqlx::query_scalar::<_, String>("SELECT profile_id FROM profile_metadata")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(profile_id, "profile-1");
    }

    #[tokio::test]
    async fn replaces_generated_kanban_items_without_pending_operations() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let mut generated_calendar = calendar(true);
        generated_calendar.location = CalendarLocation::Kanban {
            origin_key: "local-vault:/vault".into(),
        };
        generated_calendar.name = "Assigned tasks · Project".into();
        let mut task = event();
        task.id = "task-1".into();
        task.uid = "kanban:/vault:board:card-1".into();
        task.kind = CalendarItemKind::Task;
        task.start = None;
        task.end = None;
        task.due = None;
        task.availability = None;
        task.status = Some("needs-action".into());
        task.source_binding = Some(crate::models::CalendarSourceBinding::Kanban {
            server_url: None,
            vault_id: None,
            file_id: "Board.kanban".into(),
            card_id: "card-1".into(),
            path: Some("Board.kanban".into()),
            source_revision: Some(1),
        });

        store
            .replace_generated_kanban_calendar(&generated_calendar, &[task.clone()])
            .await
            .unwrap();
        assert_eq!(
            store
                .list_items_in_range("2026-07-01", "2026-08-01", 100, false)
                .await
                .unwrap(),
            vec![task]
        );
        assert!(store.list_pending_operations().await.unwrap().is_empty());

        store
            .replace_generated_kanban_calendar(&generated_calendar, &[])
            .await
            .unwrap();
        assert!(store
            .list_items_in_range("2026-07-01", "2026-08-01", 100, false)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn persists_and_atomically_replaces_subscription_calendars() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let mut subscription_calendar = calendar(true);
        subscription_calendar.id = "subscription-calendar".into();
        subscription_calendar.global_id = "subscription-calendar".into();
        subscription_calendar.location = CalendarLocation::Subscription {
            subscription_id: "subscription-1".into(),
            server_url: None,
            user_id: None,
        };
        subscription_calendar.name = "External".into();
        let mut subscribed_event = event();
        subscribed_event.id = "subscription-event".into();
        subscribed_event.calendar_id = subscription_calendar.id.clone();
        subscribed_event.source_binding = Some(crate::models::CalendarSourceBinding::External {
            subscription_id: "subscription-1".into(),
            external_uid: subscribed_event.uid.clone(),
        });
        let subscription = CalendarSubscription {
            id: "subscription-1".into(),
            calendar_id: subscription_calendar.id.clone(),
            feed_url: "https://example.com/calendar.ics".into(),
            etag: Some("\"revision-1\"".into()),
            last_modified: None,
            last_refreshed_at: Some("2026-07-26T12:00:00Z".into()),
            last_error: None,
            created_at: "2026-07-26T12:00:00Z".into(),
            updated_at: "2026-07-26T12:00:00Z".into(),
            server_url: None,
            user_id: None,
        };
        store
            .replace_subscription_calendar(
                &subscription_calendar,
                &[subscribed_event.clone()],
                &subscription,
            )
            .await
            .unwrap();
        assert_eq!(
            store.list_subscriptions().await.unwrap(),
            vec![subscription.clone()]
        );
        assert_eq!(
            store
                .list_items_for_calendar(&subscription_calendar.id, 10)
                .await
                .unwrap(),
            vec![subscribed_event.clone()]
        );

        let mut invalid = subscribed_event.clone();
        invalid.source_binding = Some(crate::models::CalendarSourceBinding::External {
            subscription_id: "another-subscription".into(),
            external_uid: invalid.uid.clone(),
        });
        assert!(store
            .replace_subscription_calendar(&subscription_calendar, &[invalid], &subscription)
            .await
            .is_err());
        assert_eq!(
            store
                .list_items_for_calendar(&subscription_calendar.id, 10)
                .await
                .unwrap(),
            vec![subscribed_event]
        );

        store.delete_subscription("subscription-1").await.unwrap();
        assert!(store.list_subscriptions().await.unwrap().is_empty());
        assert!(store.list_calendars().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn atomically_updates_a_calendar_and_queues_its_operation() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let original = calendar(false);
        store.upsert_calendar(&original).await.unwrap();
        let mut updated = original.clone();
        updated.name = "Private".into();
        updated.archived = true;
        updated.revision = 1;
        updated.updated_at = "2026-07-22T09:00:00Z".into();
        let operation = CalendarOperation {
            client_operation_id: "calendar-operation-1".into(),
            device_id: "device-1".into(),
            expected_revision: Some(0),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::UpdateCalendar {
                calendar: updated.clone(),
            },
        };

        store
            .upsert_calendar_with_operation(&updated, &operation)
            .await
            .unwrap();

        assert_eq!(store.list_calendars().await.unwrap(), vec![updated]);
        assert_eq!(
            store.list_pending_operations().await.unwrap(),
            vec![operation]
        );
    }

    #[tokio::test]
    async fn migrates_v1_profiles_without_losing_calendars() {
        let root = tempfile::tempdir().unwrap();
        let profile_dir = root.path().join("profiles/profile-1");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let path = profile_dir.join("calendar.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE calendars (
                id TEXT PRIMARY KEY NOT NULL, global_id TEXT NOT NULL,
                location_json TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
                default_time_zone TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
                read_only INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_json TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let original = calendar(false);
        sqlx::query(
            r#"INSERT INTO calendars
               (id,global_id,location_json,name,color,default_time_zone,archived,read_only,
                revision,created_at,updated_at,data_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"#,
        )
        .bind(&original.id)
        .bind(&original.global_id)
        .bind(serde_json::to_string(&original.location).unwrap())
        .bind(&original.name)
        .bind(&original.color)
        .bind(&original.default_time_zone)
        .bind(original.archived)
        .bind(original.read_only)
        .bind(original.revision)
        .bind(&original.created_at)
        .bind(&original.updated_at)
        .bind(serde_json::to_string(&original).unwrap())
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        assert_eq!(store.list_calendars().await.unwrap(), vec![original]);
        let has_deleted_at = sqlx::query("PRAGMA table_info(calendars)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .iter()
            .any(|row| row.get::<String, _>("name") == "deleted_at");
        assert!(has_deleted_at);
    }

    #[tokio::test]
    async fn tombstones_calendars_and_cleans_only_acknowledged_deletes() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();
        let deleted_at = "2026-07-22T12:00:00Z";
        let operation = CalendarOperation {
            client_operation_id: "delete-calendar-1".into(),
            device_id: "device-1".into(),
            expected_revision: Some(0),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::DeleteCalendar {
                calendar_id: "calendar-1".into(),
            },
        };
        store
            .delete_calendar_with_operation("calendar-1", deleted_at, &operation)
            .await
            .unwrap();
        assert!(store.list_calendars().await.unwrap().is_empty());
        let blocked = store
            .cleanup_tombstones("2026-07-23T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(blocked.calendars_removed, 0);
        store
            .acknowledge_operations(&[operation.client_operation_id])
            .await
            .unwrap();
        let cleaned = store
            .cleanup_tombstones("2026-07-23T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(cleaned.calendars_removed, 1);
    }

    #[tokio::test]
    async fn commits_an_item_and_pending_operation_together() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();
        store
            .upsert_item_with_operation(&event(), &operation())
            .await
            .unwrap();

        let items = store
            .list_items_in_range("2026-07-22", "2026-07-23", 100, false)
            .await
            .unwrap();
        assert_eq!(items, vec![event()]);
        assert_eq!(
            store.list_pending_operations().await.unwrap(),
            vec![operation()]
        );
    }

    #[tokio::test]
    async fn stores_recurrence_exceptions_with_the_master_uid_and_queries_the_original_slot() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();

        let mut master = event();
        master.recurrence = Some(crate::models::CalendarRecurrence {
            rrule: "FREQ=DAILY;COUNT=3".into(),
            rdates: Vec::new(),
            exdates: Vec::new(),
        });
        let master_operation = CalendarOperation {
            client_operation_id: "master-operation".into(),
            mutation: CalendarMutation::UpsertItem {
                item: master.clone(),
            },
            ..operation()
        };
        store
            .upsert_item_with_operation(&master, &master_operation)
            .await
            .unwrap();

        let mut exception = event();
        exception.id = "exception-1".into();
        exception.start = Some(CalendarTimeValue::DateTime {
            date_time: "2026-07-24T10:00:00Z".into(),
            time_zone: "Europe/Berlin".into(),
        });
        exception.end = Some(CalendarTimeValue::DateTime {
            date_time: "2026-07-24T11:00:00Z".into(),
            time_zone: "Europe/Berlin".into(),
        });
        exception.recurrence_id = Some(CalendarTimeValue::DateTime {
            date_time: "2026-07-22T10:00:00Z".into(),
            time_zone: "Europe/Berlin".into(),
        });
        exception.recurrence_series_id = Some(master.id.clone());
        let exception_operation = CalendarOperation {
            client_operation_id: "exception-operation".into(),
            mutation: CalendarMutation::UpsertItem {
                item: exception.clone(),
            },
            ..operation()
        };
        store
            .upsert_item_with_operation(&exception, &exception_operation)
            .await
            .unwrap();

        let queried = store
            .list_items_in_range("2026-07-22", "2026-07-23", 100, false)
            .await
            .unwrap();
        assert_eq!(queried.len(), 2);
        assert!(queried.iter().any(|item| item.id == exception.id));
    }

    #[tokio::test]
    async fn rejects_writes_to_read_only_calendars_without_queuing_operations() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(true)).await.unwrap();
        assert!(matches!(
            store
                .upsert_item_with_operation(&event(), &operation())
                .await,
            Err(CalendarStoreError::ReadOnly)
        ));
        assert!(store.list_pending_operations().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn operation_retries_are_noops_and_stale_revisions_do_not_write() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();
        store
            .upsert_item_with_operation(&event(), &operation())
            .await
            .unwrap();

        let mut changed = event();
        changed.title = "Must not replace the original".into();
        store
            .upsert_item_with_operation(&changed, &operation())
            .await
            .unwrap();
        assert_eq!(
            store
                .list_items_in_range("2026-07-22", "2026-07-23", 100, false)
                .await
                .unwrap()[0]
                .title,
            "Planning"
        );

        let mut stale_operation = operation();
        stale_operation.client_operation_id = "operation-2".into();
        stale_operation.expected_revision = Some(9);
        stale_operation.mutation = CalendarMutation::UpsertItem {
            item: changed.clone(),
        };
        assert!(matches!(
            store
                .upsert_item_with_operation(&changed, &stale_operation)
                .await,
            Err(CalendarStoreError::Conflict {
                expected: 9,
                actual: 0
            })
        ));
        assert_eq!(store.list_pending_operations().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn retains_failed_operations_until_retry_or_discard() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();
        store
            .upsert_item_with_operation(&event(), &operation())
            .await
            .unwrap();

        store
            .mark_operation_failed("operation-1", "revision conflict", "2026-07-22T12:00:00Z")
            .await
            .unwrap();
        assert!(store.list_pending_operations().await.unwrap().is_empty());
        let failures = store.list_failed_operations().await.unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].attempt_count, 1);
        assert_eq!(failures[0].last_error, "revision conflict");

        store.retry_operation("operation-1").await.unwrap();
        assert_eq!(store.list_pending_operations().await.unwrap().len(), 1);
        assert!(store.list_failed_operations().await.unwrap().is_empty());

        store
            .mark_operation_failed("operation-1", "still conflicting", "2026-07-22T12:05:00Z")
            .await
            .unwrap();
        assert_eq!(
            store.list_failed_operations().await.unwrap()[0].attempt_count,
            2
        );
        store.discard_operation("operation-1").await.unwrap();
        assert!(store.list_pending_operations().await.unwrap().is_empty());
        assert!(store.list_failed_operations().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn removes_only_resolved_hosted_origin_caches() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let mut hosted = calendar(false);
        hosted.location = CalendarLocation::Hosted {
            server_url: "https://server.test".into(),
            user_id: "user-1".into(),
        };
        store.upsert_calendar(&hosted).await.unwrap();
        store
            .upsert_item_with_operation(&event(), &operation())
            .await
            .unwrap();

        assert!(matches!(
            store
                .remove_hosted_origin_cache("https://server.test/", "user-1")
                .await,
            Err(CalendarStoreError::Validation(_))
        ));
        store
            .acknowledge_operations(&["operation-1".into()])
            .await
            .unwrap();
        let result = store
            .remove_hosted_origin_cache("https://server.test/", "user-1")
            .await
            .unwrap();
        assert_eq!(result.calendars_removed, 1);
        assert_eq!(result.items_removed, 1);
        assert!(store.list_calendars().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn tombstones_items_and_persists_sync_bookkeeping() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        store.upsert_calendar(&calendar(false)).await.unwrap();
        store
            .upsert_item_with_operation(&event(), &operation())
            .await
            .unwrap();
        assert_eq!(
            store.search_items("planning", 10).await.unwrap(),
            vec![event()]
        );

        let deleted_at = "2026-07-22T12:00:00Z";
        let delete_operation = CalendarOperation {
            client_operation_id: "operation-2".into(),
            device_id: "device-1".into(),
            expected_revision: Some(0),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::DeleteItem {
                calendar_id: "calendar-1".into(),
                item_id: "event-1".into(),
                deleted_at: deleted_at.into(),
            },
        };
        store
            .delete_item_with_operation("calendar-1", "event-1", deleted_at, &delete_operation)
            .await
            .unwrap();
        assert!(store.search_items("planning", 10).await.unwrap().is_empty());
        let deleted = store
            .list_items_in_range("2026-07-22", "2026-07-23", 10, true)
            .await
            .unwrap();
        assert_eq!(deleted[0].deleted_at.as_deref(), Some(deleted_at));
        assert_eq!(deleted[0].revision, 1);

        let state = CalendarSyncState {
            origin_key: "https://server.test:user-1".into(),
            cursor: Some("cursor-2".into()),
            last_synced_at: Some(deleted_at.into()),
            last_error: None,
        };
        store.write_sync_state(&state).await.unwrap();
        assert_eq!(
            store.read_sync_state(&state.origin_key).await.unwrap(),
            Some(state)
        );

        store
            .acknowledge_operations(&["operation-1".into(), "operation-2".into()])
            .await
            .unwrap();
        assert!(store.list_pending_operations().await.unwrap().is_empty());
        let cleanup = store
            .cleanup_tombstones("2026-07-23T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(cleanup.items_removed, 1);
    }

    #[tokio::test]
    async fn applies_remote_pages_and_cursor_atomically() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let changed_at = "2026-07-22T12:00:00Z";
        let state = CalendarSyncState {
            origin_key: "https://server.test::user-1".into(),
            cursor: Some("2".into()),
            last_synced_at: Some(changed_at.into()),
            last_error: None,
        };
        let changes = vec![
            CalendarRemoteChange {
                sequence: 1,
                entity_type: "calendar".into(),
                entity_id: "calendar-1".into(),
                operation: "upsert".into(),
                payload: Some(serde_json::to_value(calendar(false)).unwrap()),
                changed_at: changed_at.into(),
            },
            CalendarRemoteChange {
                sequence: 2,
                entity_type: "item".into(),
                entity_id: "event-1".into(),
                operation: "upsert".into(),
                payload: Some(serde_json::to_value(event()).unwrap()),
                changed_at: changed_at.into(),
            },
        ];
        store.apply_remote_changes(&changes, &state).await.unwrap();
        assert_eq!(store.list_calendars().await.unwrap(), vec![calendar(false)]);
        assert_eq!(
            store
                .list_items_in_range("2026-07-22", "2026-07-23", 10, false)
                .await
                .unwrap(),
            vec![event()]
        );
        assert_eq!(
            store.read_sync_state(&state.origin_key).await.unwrap(),
            Some(state)
        );

        let failed_state = CalendarSyncState {
            origin_key: "https://other.test::user-2".into(),
            cursor: Some("4".into()),
            last_synced_at: Some(changed_at.into()),
            last_error: None,
        };
        let invalid = vec![
            CalendarRemoteChange {
                sequence: 3,
                entity_type: "calendar".into(),
                entity_id: "calendar-2".into(),
                operation: "upsert".into(),
                payload: Some(
                    serde_json::to_value(CalendarDefinition {
                        id: "calendar-2".into(),
                        global_id: "global-2".into(),
                        ..calendar(false)
                    })
                    .unwrap(),
                ),
                changed_at: changed_at.into(),
            },
            CalendarRemoteChange {
                sequence: 4,
                entity_type: "unknown".into(),
                entity_id: "broken".into(),
                operation: "upsert".into(),
                payload: None,
                changed_at: changed_at.into(),
            },
        ];
        assert!(store
            .apply_remote_changes(&invalid, &failed_state)
            .await
            .is_err());
        assert!(store
            .list_calendars()
            .await
            .unwrap()
            .iter()
            .all(|calendar| calendar.id != "calendar-2"));
        assert!(store
            .read_sync_state(&failed_state.origin_key)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rejects_profile_path_traversal_and_unbounded_queries() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            CalendarStore::open(root.path(), "../escape").await,
            Err(CalendarStoreError::Validation(_))
        ));
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        assert!(matches!(
            store
                .list_items_in_range("2026-07-22", "2026-07-23", 5_001, false)
                .await,
            Err(CalendarStoreError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn persists_mirror_groups_anchors_conflicts_and_bounded_items() {
        let root = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(root.path(), "profile-1").await.unwrap();
        let local = calendar(false);
        let hosted = CalendarDefinition {
            id: "calendar-2".into(),
            global_id: "global-2".into(),
            location: CalendarLocation::Hosted {
                server_url: "https://calendar.example".into(),
                user_id: "user-1".into(),
            },
            name: "Hosted".into(),
            ..local.clone()
        };
        store.upsert_calendar(&local).await.unwrap();
        store.upsert_calendar(&hosted).await.unwrap();
        let group = CalendarMirrorGroup {
            schema_version: 1,
            id: "mirror-1".into(),
            name: "Personal mirror".into(),
            enabled: true,
            members: vec![
                CalendarMirrorMember {
                    id: "local-member".into(),
                    calendar_id: local.id.clone(),
                    location: local.location.clone(),
                    added_at: "2026-07-24T08:00:00Z".into(),
                },
                CalendarMirrorMember {
                    id: "hosted-member".into(),
                    calendar_id: hosted.id.clone(),
                    location: hosted.location.clone(),
                    added_at: "2026-07-24T08:00:00Z".into(),
                },
            ],
            created_at: "2026-07-24T08:00:00Z".into(),
            updated_at: "2026-07-24T08:00:00Z".into(),
        };
        store.upsert_mirror_group(&group).await.unwrap();
        assert_eq!(
            store.list_mirror_groups().await.unwrap(),
            vec![group.clone()]
        );

        let anchor = CalendarMirrorAnchor {
            group_id: group.id.clone(),
            logical_item_key: "uid-1\0master".into(),
            member_id: "local-member".into(),
            item_id: Some("event-1".into()),
            revision: Some(0),
            fingerprint: "v1:abc".into(),
            deleted_at: None,
            updated_at: "2026-07-24T08:00:00Z".into(),
        };
        store
            .upsert_mirror_anchors(std::slice::from_ref(&anchor))
            .await
            .unwrap();
        assert_eq!(
            store.list_mirror_anchors(&group.id).await.unwrap(),
            vec![anchor]
        );

        let conflict = CalendarMirrorConflict {
            id: "conflict-1".into(),
            group_id: group.id.clone(),
            logical_item_key: "uid-1\0master".into(),
            status: "unresolved".into(),
            versions: vec![
                CalendarMirrorConflictVersion {
                    member_id: "local-member".into(),
                    fingerprint: "v1:a".into(),
                    item: Some(event()),
                },
                CalendarMirrorConflictVersion {
                    member_id: "hosted-member".into(),
                    fingerprint: "v1:b".into(),
                    item: None,
                },
            ],
            detected_at: "2026-07-24T08:00:00Z".into(),
            resolved_at: None,
        };
        store.upsert_mirror_conflict(&conflict).await.unwrap();
        assert_eq!(
            store
                .list_mirror_conflicts(Some(&group.id), false)
                .await
                .unwrap(),
            vec![conflict]
        );

        let local_event = event();
        store
            .upsert_item_with_operation(&local_event, &operation())
            .await
            .unwrap();
        assert_eq!(
            store
                .list_items_for_mirror(&[local.id.clone(), hosted.id.clone()], 100)
                .await
                .unwrap(),
            vec![local_event]
        );
        store.delete_mirror_group(&group.id).await.unwrap();
        assert!(store.list_mirror_groups().await.unwrap().is_empty());
        assert!(store
            .list_mirror_anchors(&group.id)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .list_mirror_conflicts(Some(&group.id), true)
            .await
            .unwrap()
            .is_empty());
    }
}
