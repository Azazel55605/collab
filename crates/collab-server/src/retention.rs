//! Retention and compaction maintenance.
//!
//! A periodic best-effort sweep that bounds the growth of operational data:
//! expired auth artifacts and stale presence are always cleared, while
//! audit/activity log retention and document revision-history compaction are
//! opt-in policies. Reclaiming revisions frees their content-addressed blobs,
//! which a final garbage-collection pass removes from the database and disk.
//!
//! Everything here is intentionally non-fatal: a failed step is logged and the
//! run continues, because maintenance must never take the server down.

use crate::storage::BlobStorage;
use collab_protocol::MaintenanceReport;
use sqlx::PgPool;

/// Blobs younger than this grace period are never garbage-collected, so a blob
/// from an in-flight upload (whose revision row may not be committed yet, or
/// which a concurrent identical upload is re-referencing) is never reclaimed.
const BLOB_GC_GRACE: &str = "1 hour";

/// Presence rows not refreshed within this window are considered abandoned.
const PRESENCE_STALE_AFTER: &str = "1 day";
const CALENDAR_OPERATION_RETENTION: &str = "30 days";
const ABANDONED_CALENDAR_UPLOAD_GRACE: &str = "1 day";

#[derive(Debug, Clone, Copy)]
pub struct MaintenancePolicy {
    /// Delete audit and vault-activity events older than this many days. `0`
    /// keeps them forever.
    pub audit_retention_days: u64,
    /// Keep at most this many revisions per non-tombstoned file (the current
    /// revision and any snapshot-pinned revision are always kept). `0` keeps all
    /// history.
    pub revision_history_limit: u32,
    /// When non-zero, deletes oldest unpinned historical revisions until total
    /// retained revision bytes are at or below this target.
    pub revision_storage_target_bytes: u64,
}

impl MaintenancePolicy {
    pub fn from_config(config: &crate::config::ServerConfig) -> Self {
        Self {
            audit_retention_days: config.audit_retention_days,
            revision_history_limit: config.revision_history_limit,
            revision_storage_target_bytes: 0,
        }
    }
}

/// Runs one maintenance pass, returning the counts of records reclaimed. Each
/// step is independent and best-effort.
pub async fn run_maintenance(
    db: &PgPool,
    blobs: &dyn BlobStorage,
    policy: MaintenancePolicy,
) -> MaintenanceReport {
    let mut report = MaintenanceReport::default();

    report.expired_ws_tickets = delete_count(
        db,
        "DELETE FROM ws_tickets WHERE expires_at <= NOW()",
        "ws_tickets",
    )
    .await;
    report.expired_sessions = delete_count(
        db,
        "DELETE FROM sessions WHERE expires_at <= NOW()",
        "sessions",
    )
    .await
        + delete_count(
            db,
            "DELETE FROM native_sessions WHERE refresh_expires_at <= NOW()",
            "native_sessions",
        )
        .await;
    report.stale_presence = delete_count(
        db,
        &format!("DELETE FROM hosted_presence WHERE updated_at < NOW() - INTERVAL '{PRESENCE_STALE_AFTER}'"),
        "hosted_presence",
    )
    .await;
    report.expired_calendar_operations = delete_count(
        db,
        &format!(
            "DELETE FROM calendar_client_operations WHERE applied_at < NOW() - INTERVAL '{CALENDAR_OPERATION_RETENTION}'"
        ),
        "calendar_client_operations",
    )
    .await;
    report.reclaimed_calendar_uploads = delete_count(
        db,
        &format!(
            "DELETE FROM calendar_attachment_uploads upload WHERE upload.created_at < NOW() - INTERVAL '{ABANDONED_CALENDAR_UPLOAD_GRACE}' AND NOT EXISTS (SELECT 1 FROM calendar_attachments attachment WHERE attachment.upload_id=upload.id)"
        ),
        "calendar_attachment_uploads",
    )
    .await;

    if policy.audit_retention_days > 0 {
        let days = policy.audit_retention_days as i64;
        report.pruned_audit_events =
            delete_count_older_than(db, "audit_events", days, "audit_events").await;
        report.pruned_activity_events =
            delete_count_older_than(db, "hosted_vault_activity_events", days, "activity").await;
    }

    report.pruned_revisions = reclaim_revisions(
        db,
        policy.revision_history_limit,
        policy.revision_storage_target_bytes,
    )
    .await;

    let (reclaimed_blobs, reclaimed_blob_bytes) = garbage_collect_blobs(db, blobs).await;
    report.reclaimed_blobs = reclaimed_blobs;
    report.reclaimed_blob_bytes = reclaimed_blob_bytes;

    report
}

/// Executes a parameterless `DELETE` and returns the affected row count, logging
/// and swallowing errors so one failing step cannot abort the run.
async fn delete_count(db: &PgPool, sql: &str, label: &str) -> u64 {
    match sqlx::query(sql).execute(db).await {
        Ok(result) => result.rows_affected(),
        Err(error) => {
            tracing::warn!(?error, label, "maintenance step failed");
            0
        }
    }
}

async fn delete_count_older_than(db: &PgPool, table: &str, days: i64, label: &str) -> u64 {
    // `table` is a fixed internal identifier, never user input.
    let sql = format!("DELETE FROM {table} WHERE created_at < NOW() - make_interval(days => $1)");
    match sqlx::query(&sql).bind(days as i32).execute(db).await {
        Ok(result) => result.rows_affected(),
        Err(error) => {
            tracing::warn!(?error, label, "maintenance retention step failed");
            0
        }
    }
}

/// Reclaims document history: deletes every revision of tombstoned (purged)
/// files, and—when a history limit is set—every revision of a live file beyond
/// the newest `limit`, always preserving the file's current revision and any
/// snapshot-pinned revision.
async fn reclaim_revisions(db: &PgPool, history_limit: u32, storage_target_bytes: u64) -> u64 {
    let mut pruned = 0;

    // Tombstoned files are purged: detach the current-revision pointer, then drop
    // all of their revisions (cascading away any of their snapshots).
    if let Err(error) = sqlx::query(
        "UPDATE hosted_file_entries SET current_revision_id = NULL \
         WHERE state = 'tombstoned' AND current_revision_id IS NOT NULL",
    )
    .execute(db)
    .await
    {
        tracing::warn!(
            ?error,
            "clearing tombstoned current-revision pointers failed"
        );
    }
    pruned += delete_count(
        db,
        "DELETE FROM hosted_file_revisions r \
         USING hosted_file_entries e \
         WHERE e.id = r.file_id AND e.state = 'tombstoned'",
        "tombstoned_revisions",
    )
    .await;

    if history_limit > 0 {
        let sql = "
            WITH ranked AS (
                SELECT r.id,
                       ROW_NUMBER() OVER (PARTITION BY r.file_id ORDER BY r.sequence DESC) AS rn
                FROM hosted_file_revisions r
                JOIN hosted_file_entries e ON e.id = r.file_id
                WHERE e.state <> 'tombstoned'
            )
            DELETE FROM hosted_file_revisions r
            USING ranked
            WHERE r.id = ranked.id
              AND ranked.rn > $1
              AND r.id NOT IN (
                  SELECT current_revision_id FROM hosted_file_entries
                  WHERE current_revision_id IS NOT NULL
              )
              AND NOT EXISTS (SELECT 1 FROM hosted_snapshots s WHERE s.revision_id = r.id)
        ";
        match sqlx::query(sql)
            .bind(history_limit as i64)
            .execute(db)
            .await
        {
            Ok(result) => pruned += result.rows_affected(),
            Err(error) => tracing::warn!(?error, "revision history compaction failed"),
        }
    }

    if storage_target_bytes > 0 {
        let sql = "
            WITH total AS (
                SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes
                FROM hosted_file_revisions
            ),
            candidates AS (
                SELECT r.id,
                       r.size_bytes,
                       SUM(r.size_bytes) OVER (ORDER BY r.created_at ASC, r.sequence ASC, r.id ASC) AS cumulative_bytes,
                       total.bytes AS total_bytes
                FROM hosted_file_revisions r
                CROSS JOIN total
                WHERE r.id NOT IN (
                    SELECT current_revision_id FROM hosted_file_entries
                    WHERE current_revision_id IS NOT NULL
                )
                  AND NOT EXISTS (SELECT 1 FROM hosted_snapshots s WHERE s.revision_id = r.id)
            ),
            doomed AS (
                SELECT id
                FROM candidates
                WHERE total_bytes > $1
                  AND cumulative_bytes <= (total_bytes - $1)
            )
            DELETE FROM hosted_file_revisions r
            USING doomed
            WHERE r.id = doomed.id
        ";
        match sqlx::query(sql)
            .bind(storage_target_bytes as i64)
            .execute(db)
            .await
        {
            Ok(result) => pruned += result.rows_affected(),
            Err(error) => tracing::warn!(?error, "revision storage target compaction failed"),
        }
    }

    pruned
}

/// Deletes blobs no longer referenced by any revision (and older than the grace
/// period) from the database, then removes their on-disk content. Returns the
/// number of blobs and the total bytes reclaimed.
async fn garbage_collect_blobs(db: &PgPool, blobs: &dyn BlobStorage) -> (u64, u64) {
    let sql = format!(
        "DELETE FROM hosted_blobs b \
         WHERE b.created_at < NOW() - INTERVAL '{BLOB_GC_GRACE}' \
           AND NOT EXISTS (SELECT 1 FROM hosted_file_revisions r WHERE r.blob_digest = b.digest) \
         RETURNING b.digest, b.size_bytes"
    );
    let rows = match sqlx::query_as::<_, (String, i64)>(&sql).fetch_all(db).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(?error, "blob garbage collection query failed");
            return (0, 0);
        }
    };
    let mut count = 0;
    let mut bytes = 0;
    for (digest, size) in rows {
        // The database row is already gone; removing the file is best-effort. A
        // failure leaves a harmless orphan that a later run cannot re-select.
        match blobs.delete(&digest).await {
            Ok(()) => {
                count += 1;
                bytes += size.max(0) as u64;
            }
            Err(error) => tracing::warn!(?error, digest, "removing orphaned blob from disk failed"),
        }
    }
    (count, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::FileSystemBlobStorage;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::Row;
    use std::sync::Arc;
    use uuid::Uuid;

    async fn seed_blob(pool: &PgPool, blobs: &FileSystemBlobStorage, content: &[u8]) -> String {
        let digest = blobs.put(content).await.unwrap();
        // Backdate past the GC grace period so the blob is collectable once orphaned.
        sqlx::query(
            "INSERT INTO hosted_blobs (digest, size_bytes, media_type, storage_key, created_at) \
             VALUES ($1, $2, 'text/plain', $1, NOW() - INTERVAL '2 hours') ON CONFLICT (digest) DO NOTHING",
        )
        .bind(&digest)
        .bind(content.len() as i64)
        .execute(pool)
        .await
        .unwrap();
        digest
    }

    async fn insert_revision(
        pool: &PgPool,
        vault: Uuid,
        file: Uuid,
        sequence: i64,
        digest: &str,
        size: usize,
    ) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes) \
             VALUES ($1, $2, $3, $4, $5, $5, $6)",
        )
        .bind(id)
        .bind(vault)
        .bind(file)
        .bind(sequence)
        .bind(digest)
        .bind(size as i64)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn run_maintenance_reclaims_expired_audit_revisions_and_blobs() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            eprintln!("skipping: COLLAB_TEST_DATABASE_URL not set");
            return;
        };
        let _guard = crate::database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        crate::database::migrate(&pool).await.unwrap();
        sqlx::query(
            "TRUNCATE audit_events, invitations, native_sessions, sessions, credentials, users, hosted_blobs RESTART IDENTITY CASCADE",
        )
        .execute(&pool)
        .await
        .unwrap();
        let dir = tempfile::tempdir().unwrap().keep();
        let blobs = Arc::new(FileSystemBlobStorage::new(dir).await.unwrap());

        // --- identities and vault ---
        let user = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, normalized_username, display_name) VALUES ($1, 'u', 'u', 'User')",
        )
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
        let vault = Uuid::now_v7();
        sqlx::query("INSERT INTO hosted_vaults (id, name, owner_user_id) VALUES ($1, 'V', $2)")
            .bind(vault)
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();

        // --- active file with four revisions; rev1 is snapshot-pinned, rev4 current ---
        let file_a = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_entries (id, vault_id, name, normalized_name, kind, document_type, state) \
             VALUES ($1, $2, 'a.md', 'a.md', 'document', 'note', 'active')",
        )
        .bind(file_a)
        .bind(vault)
        .execute(&pool)
        .await
        .unwrap();
        let mut a_revs = Vec::new();
        for sequence in 1..=4 {
            let content = format!("a-content-{sequence}").into_bytes();
            let digest = seed_blob(&pool, &blobs, &content).await;
            let rev = insert_revision(&pool, vault, file_a, sequence, &digest, content.len()).await;
            a_revs.push((rev, digest));
        }
        let (rev1, blob1) = a_revs[0].clone();
        let (rev2, blob2) = a_revs[1].clone();
        let (rev4, _) = a_revs[3].clone();
        sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
            .bind(rev4)
            .bind(file_a)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO hosted_snapshots (id, vault_id, file_id, revision_id, label) \
             VALUES ($1, $2, $3, $4, 'pin')",
        )
        .bind(Uuid::now_v7())
        .bind(vault)
        .bind(file_a)
        .bind(rev1)
        .execute(&pool)
        .await
        .unwrap();

        // --- tombstoned (purged) file with one revision; everything is reclaimable ---
        let file_b = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_entries (id, vault_id, name, normalized_name, kind, document_type, state) \
             VALUES ($1, $2, 'b.md', 'b.md', 'document', 'note', 'tombstoned')",
        )
        .bind(file_b)
        .bind(vault)
        .execute(&pool)
        .await
        .unwrap();
        let b_content = b"b-content".to_vec();
        let blob_b = seed_blob(&pool, &blobs, &b_content).await;
        let rev_b = insert_revision(&pool, vault, file_b, 1, &blob_b, b_content.len()).await;
        sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
            .bind(rev_b)
            .bind(file_b)
            .execute(&pool)
            .await
            .unwrap();

        // --- expired vs valid ephemeral data ---
        sqlx::query(
            "INSERT INTO ws_tickets (id, ticket_hash, user_id, vault_id, expires_at) \
             VALUES ($1, 'expired', $2, $3, NOW() - INTERVAL '1 minute'), \
                    ($4, 'valid', $2, $3, NOW() + INTERVAL '1 hour')",
        )
        .bind(Uuid::now_v7())
        .bind(user)
        .bind(vault)
        .bind(Uuid::now_v7())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) \
             VALUES ($1, $2, 'expired', 'c', NOW() - INTERVAL '1 hour'), \
                    ($3, $2, 'valid', 'c', NOW() + INTERVAL '1 hour')",
        )
        .bind(Uuid::now_v7())
        .bind(user)
        .bind(Uuid::now_v7())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosted_presence (vault_id, user_id, updated_at) VALUES ($1, $2, NOW() - INTERVAL '2 days')",
        )
        .bind(vault)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

        // --- old vs recent audit / activity events ---
        sqlx::query(
            "INSERT INTO audit_events (id, action, result, request_id, created_at) \
             VALUES ($1, 'x', 'success', 'r', NOW() - INTERVAL '40 days'), \
                    ($2, 'x', 'success', 'r', NOW())",
        )
        .bind(Uuid::now_v7())
        .bind(Uuid::now_v7())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosted_vault_activity_events (id, vault_id, event_type, created_at) \
             VALUES ($1, $2, 'e', NOW() - INTERVAL '40 days'), ($3, $2, 'e', NOW())",
        )
        .bind(Uuid::now_v7())
        .bind(vault)
        .bind(Uuid::now_v7())
        .execute(&pool)
        .await
        .unwrap();

        let report = run_maintenance(
            &pool,
            blobs.as_ref(),
            MaintenancePolicy {
                audit_retention_days: 30,
                revision_history_limit: 2,
                revision_storage_target_bytes: 0,
            },
        )
        .await;

        assert_eq!(report.expired_ws_tickets, 1);
        assert_eq!(report.expired_sessions, 1);
        assert_eq!(report.stale_presence, 1);
        assert_eq!(report.pruned_audit_events, 1);
        assert_eq!(report.pruned_activity_events, 1);
        // rev2 (beyond the newest 2, not current, not snapshot-pinned) + tombstoned rev_b.
        assert_eq!(report.pruned_revisions, 2);
        assert_eq!(report.reclaimed_blobs, 2);
        assert!(report.reclaimed_blob_bytes > 0);

        // Surviving revisions: rev1 (snapshot), rev3/rev4 (within limit). rev2 + rev_b gone.
        let live: Vec<Uuid> = sqlx::query("SELECT id FROM hosted_file_revisions")
            .fetch_all(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<Uuid, _>("id"))
            .collect();
        assert!(live.contains(&rev1) && live.contains(&rev4));
        assert!(!live.contains(&rev2) && !live.contains(&rev_b));

        // The pinning snapshot survived (its revision was preserved).
        let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(snapshots, 1);

        // The tombstoned file's current pointer was detached.
        let current_b: Option<Uuid> =
            sqlx::query_scalar("SELECT current_revision_id FROM hosted_file_entries WHERE id = $1")
                .bind(file_b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(current_b.is_none());

        // Orphaned blobs were deleted from disk; referenced ones remain.
        assert!(!blobs.exists(&blob2).await.unwrap());
        assert!(!blobs.exists(&blob_b).await.unwrap());
        assert!(blobs.exists(&blob1).await.unwrap());

        // The valid ticket/session survived.
        let tickets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ws_tickets")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tickets, 1);
    }
}
