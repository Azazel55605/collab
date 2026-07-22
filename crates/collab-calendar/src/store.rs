use crate::models::{
    CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarItemKind, CalendarMutation,
    CalendarOperation, CalendarSyncState, CalendarTimeValue, CALENDAR_SCHEMA_VERSION,
};
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_RANGE_QUERY_ITEMS: u32 = 5_000;
pub const MAX_SEARCH_QUERY_ITEMS: u32 = 500;
pub const LOCAL_STORE_SCHEMA_VERSION: i64 = 2;

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
                 kind = 'birthday'
                 OR recurrence_rule IS NOT NULL
                 OR (start_sort < ? AND end_sort > ?)
               )
             ORDER BY COALESCE(start_sort, 0), id
             LIMIT ?
            "#,
        )
        .bind(include_deleted)
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
                revision, deleted_at, created_at, updated_at, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                calendar_id = excluded.calendar_id,
                uid = excluded.uid,
                kind = excluded.kind,
                start_sort = excluded.start_sort,
                end_sort = excluded.end_sort,
                recurrence_rule = excluded.recurrence_rule,
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
    use crate::models::{CalendarLocation, CalendarTimeValue};

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
            source_binding: None,
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
}
