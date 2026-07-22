use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;

const CALENDAR_MIGRATION_19_CANONICAL_CHECKSUM: &str =
    "86acae6fa671b9a1e6a0114ac71a95d2ce2c74c3fd4db775a402ccf58b145a81f7c1a168fa55197e1cf5f2066b1a9726";
const CALENDAR_MIGRATION_19_ACCIDENTAL_CHECKSUM: &str =
    "1c84d3736be919a4bf743538836bd2608115cd9e6a529069eaa01a5ab1f32c17dee00eed73036c76471137cb7ce58584";

pub async fn connect_and_migrate(database_url: &str) -> Result<PgPool, DatabaseError> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

pub async fn migrate(pool: &PgPool) -> Result<(), DatabaseError> {
    reconcile_calendar_migration_19(pool).await?;
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

async fn reconcile_calendar_migration_19(pool: &PgPool) -> Result<(), sqlx::Error> {
    let migrations_table_exists =
        sqlx::query_scalar::<_, bool>("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;
    if !migrations_table_exists {
        return Ok(());
    }

    let reconciled = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE _sqlx_migrations
        SET checksum = decode($1, 'hex')
        WHERE version = 19
          AND success = TRUE
          AND checksum = decode($2, 'hex')
        RETURNING version
        "#,
    )
    .bind(CALENDAR_MIGRATION_19_CANONICAL_CHECKSUM)
    .bind(CALENDAR_MIGRATION_19_ACCIDENTAL_CHECKSUM)
    .fetch_optional(pool)
    .await?;

    if reconciled.is_some() {
        tracing::warn!(
            "reconciled the known calendar migration 19 checksum; migration 20 will preserve its schema changes"
        );
    }

    Ok(())
}

pub async fn is_ready(pool: &PgPool) -> bool {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool)
        .await
        .is_ok()
}

/// Serializes live-PostgreSQL integration tests. They share one database and
/// `TRUNCATE` it, so they must not run concurrently. Every test that touches the
/// shared test database holds this guard for its duration.
#[cfg(test)]
pub(crate) fn db_test_guard() -> &'static tokio::sync::Mutex<()> {
    use std::sync::OnceLock;
    static GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
}

#[cfg(test)]
mod tests {
    use super::{is_ready, migrate, CALENDAR_MIGRATION_19_CANONICAL_CHECKSUM};
    use sha2::{Digest, Sha384};
    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn shipped_calendar_migration_checksum_is_stable() {
        let digest = Sha384::digest(include_bytes!("../migrations/0019_user_calendars.sql"));
        assert_eq!(
            format!("{digest:x}"),
            CALENDAR_MIGRATION_19_CANONICAL_CHECKSUM
        );
    }

    #[tokio::test]
    async fn migrations_are_idempotent_when_test_database_is_available() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        migrate(&pool).await.unwrap();
        migrate(&pool).await.unwrap();
        assert!(is_ready(&pool).await);
    }
}
