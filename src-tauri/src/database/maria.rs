//! MariaDB SQL login, verified transport, and one prepared statement per run.
pub(super) mod edit;
#[cfg(test)]
mod tests;

use super::{
    driver::{MetadataItem, MetadataPage, MetadataRequest},
    query::{self, BrowseRequest, Output, TransactionAction},
    SavedConnection,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use collab_database::{
    ColumnMetadata, ContractError as E, DbValue, Engine, ExecutionError, FinishReason, Identifier,
    ResultEvent, SessionBinding, SourceRange, TransactionState,
};
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::{
    mysql::{
        types::MySqlTime, MySqlColumn, MySqlConnectOptions, MySqlDatabaseError, MySqlRow,
        MySqlSslMode,
    },
    AssertSqlSafe, Column as _, ConnectOptions as _, Decode, Either, Executor as _, MySql,
    MySqlConnection, Row as _, SqlSafeStr as _, Statement as _, TypeInfo as _, ValueRef as _,
};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
pub struct Capabilities {
    pub version: String,
    pub sql_mode: String,
    pub collation: String,
    pub innodb: bool,
}

pub(super) struct Live {
    pub(super) client: Mutex<Option<MySqlConnection>>,
    pub(super) query: query::Runtime,
    pub(super) cancel: CancellationToken,
    pub(super) capabilities: Capabilities,
    database: String,
    _permit: OwnedSemaphorePermit,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const METADATA_TIMEOUT: Duration = Duration::from_secs(12);

fn server_code(error: &sqlx::Error) -> Option<i32> {
    error
        .as_database_error()
        .and_then(|e| e.try_downcast_ref::<MySqlDatabaseError>())
        .map(|e| i32::from(e.number()))
}
fn classify(error: &sqlx::Error) -> E {
    match server_code(error) {
        Some(1045 | 1698) => E::AuthenticationFailed,
        Some(1044 | 1049 | 1142 | 1143 | 1227 | 1370) => E::PermissionDenied,
        Some(1205 | 1213) => E::DatabaseLocked,
        Some(1969 | 3024) => E::Timeout,
        Some(1153) => E::LimitReached,
        Some(_) => E::QueryFailed,
        None => match error {
            sqlx::Error::Tls(_) => E::TlsRejected,
            // SQLx forwards Rustls handshake I/O errors as Error::Io.
            sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                E::TlsRejected
            }
            sqlx::Error::Decode(_) | sqlx::Error::ColumnDecode { .. } => E::DataConversion,
            _ => E::ConnectionFailed,
        },
    }
}
impl From<sqlx::Error> for super::edit::Failure {
    fn from(error: sqlx::Error) -> Self {
        Self {
            code: classify(&error),
            server_code: server_code(&error),
            change_index: None,
        }
    }
}

pub(super) fn quote(name: &str) -> Result<String, E> {
    Identifier::new(name)?.quoted(Engine::MariaDb)
}

fn validate_version(version: &str) -> Result<(), E> {
    let numeric = version.strip_prefix("5.5.5-").unwrap_or(version);
    let mut parts = numeric.split(['.', '-']);
    let major: u16 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or(E::Unsupported)?;
    let minor: u16 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or(E::Unsupported)?;
    if !version.contains("MariaDB") || (major, minor) < (10, 11) || version.len() > 192 {
        return Err(E::Unsupported);
    }
    Ok(())
}

impl Live {
    pub(super) async fn connect(
        config: &SavedConnection,
        database: &str,
        password: &str,
        cancel: CancellationToken,
        permit: OwnedSemaphorePermit,
    ) -> Result<Arc<Self>, E> {
        quote(database)?;
        let options = MySqlConnectOptions::new()
            .host(&config.host)
            .port(config.port)
            .database(database)
            .username(&config.username)
            .password(password)
            .ssl_mode(MySqlSslMode::VerifyIdentity)
            .charset("utf8mb4")
            .pipes_as_concat(false)
            .no_engine_substitution(false)
            .statement_cache_capacity(0)
            .disable_statement_logging();
        let (client, capabilities) = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(E::WrongBinding),
            result = timeout(CONNECT_TIMEOUT, async {
                let mut client = options.connect().await.map_err(|e| classify(&e))?;
                let version: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(&mut client).await.map_err(|e| classify(&e))?;
                validate_version(&version)?;
                // This also neutralizes connection defaults that change placeholder
                // syntax or allow silent value/engine substitution.
                sqlx::query("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO', autocommit=1, foreign_key_checks=1, check_constraint_checks=1, time_zone='+00:00', max_statement_time=120, innodb_lock_wait_timeout=5, lock_wait_timeout=5")
                    .execute(&mut client).await.map_err(|e| classify(&e))?;
                let (pinned, sql_mode, collation, innodb): (String, String, String, i32) = sqlx::query_as(
                    "SELECT DATABASE(), @@SESSION.sql_mode, @@SESSION.collation_connection, EXISTS(SELECT 1 FROM information_schema.ENGINES WHERE ENGINE='InnoDB' AND SUPPORT IN ('YES','DEFAULT') AND TRANSACTIONS='YES')"
                ).fetch_one(&mut client).await.map_err(|e| classify(&e))?;
                if pinned != database { return Err(E::WrongBinding); }
                Ok((client, Capabilities { version, sql_mode, collation, innodb: innodb != 0 }))
            }) => result.map_err(|_| E::Timeout)??,
        };
        Ok(Arc::new(Self {
            client: Mutex::new(Some(client)),
            query: Default::default(),
            cancel,
            capabilities,
            database: database.into(),
            _permit: permit,
        }))
    }

    pub(super) async fn metadata(&self, request: &MetadataRequest) -> Result<MetadataPage, E> {
        let (sql, parameters) = metadata_query(&self.database, request)?;
        let mut guard = self.client.lock().await;
        let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(E::WrongBinding),
            result = timeout(METADATA_TIMEOUT, async {
                let mut query = sqlx::query(sql);
                for parameter in parameters { query = query.bind(parameter); }
                let rows = query.fetch_all(client).await.map_err(|e| classify(&e))?;
                let mut items = Vec::new();
                for row in rows {
                    let text = |i| row.try_get::<String, _>(i).map_err(|_| E::DataConversion);
                    let mut id = text(0usize)?;
                    let name = text(1usize)?;
                    let kind = text(2usize)?;
                    let detail = text(3usize)?;
                    if matches!(request, MetadataRequest::Completion { .. }) {
                        id = serde_json::to_string(&(&kind, id.parse::<u32>().map_err(|_| E::DataConversion)?)).map_err(|_| E::DataConversion)?;
                    }
                    items.push(MetadataItem { id, name, kind, detail });
                }
                let next = if items.len() > 100 {
                    items.truncate(100);
                    items.last().map(|item| item.id.clone())
                } else { None };
                collab_database::encoded_size(&items, 256 << 10)?;
                Ok(MetadataPage { items, next })
            }) => result.unwrap_or(Err(E::Timeout)),
        };
        if result.is_err() {
            guard.take();
        }
        result
    }
}

fn metadata_query(
    database: &str,
    request: &MetadataRequest,
) -> Result<(&'static str, Vec<String>), E> {
    let cursor = |text: &str| {
        if text.len() > 512 || text.contains('\0') {
            Err(E::InvalidParameter)
        } else {
            Ok(text.to_owned())
        }
    };
    use MetadataRequest::*;
    Ok(match request {
        Databases { after } => (
            "SELECT SCHEMA_NAME, SCHEMA_NAME, 'database', '' FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME > BINARY ? ORDER BY BINARY SCHEMA_NAME LIMIT 101",
            vec![cursor(after)?],
        ),
        MariaTables { after } => (
            "SELECT TABLE_NAME,TABLE_NAME,TABLE_TYPE,COALESCE(ENGINE,'') FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME > BINARY ? ORDER BY BINARY TABLE_NAME LIMIT 101",
            vec![database.into(), cursor(after)?],
        ),
        MariaColumns { table, after } if *after >= 0 => (
            "SELECT CAST(ORDINAL_POSITION AS CHAR),COLUMN_NAME,COLUMN_TYPE,CONCAT('nullable=',IS_NULLABLE,' ',EXTRA) FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ? AND ORDINAL_POSITION > CAST(? AS UNSIGNED) ORDER BY ORDINAL_POSITION LIMIT 101",
            vec![database.into(), cursor(table)?, after.to_string()],
        ),
        MariaIndexes { table, after } => (
            "SELECT INDEX_NAME,INDEX_NAME,MAX(INDEX_TYPE),CONCAT('unique=',IF(MAX(NON_UNIQUE)=0,'yes','no'),', columns=',COUNT(*)) FROM information_schema.STATISTICS WHERE BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ? AND BINARY INDEX_NAME > BINARY ? GROUP BY INDEX_NAME,BINARY INDEX_NAME ORDER BY BINARY INDEX_NAME LIMIT 101",
            vec![database.into(), cursor(table)?, cursor(after)?],
        ),
        Completion { after } => {
            let (table, ordinal): (String, u32) = if after == "0:0" { (String::new(), 0) } else {
                serde_json::from_str(&cursor(after)?).map_err(|_| E::InvalidParameter)?
            };
            (
                "SELECT CAST(ORDINAL_POSITION AS CHAR),COLUMN_NAME,TABLE_NAME,TABLE_SCHEMA FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? AND (BINARY TABLE_NAME>BINARY ? OR (BINARY TABLE_NAME=BINARY ? AND ORDINAL_POSITION>CAST(? AS UNSIGNED))) ORDER BY BINARY TABLE_NAME,ORDINAL_POSITION LIMIT 101",
                vec![database.into(), table.clone(), table, ordinal.to_string()],
            )
        }
        _ => return Err(E::InvalidParameter),
    })
}

fn target(database: &str, request: &BrowseRequest) -> Result<(String, String, Option<String>), E> {
    if request.schema != database || request.filter_text.len() > 4096 {
        return Err(E::InvalidParameter);
    }
    let table = format!("{}.{}", quote(database)?, quote(&request.table)?);
    if request.filter_text.is_empty() {
        return Ok((table, String::new(), None));
    }
    let column = quote(
        request
            .filter_column
            .as_deref()
            .ok_or(E::InvalidParameter)?,
    )?;
    Ok((
        table,
        format!(" WHERE LOCATE(CAST(? AS BINARY),CAST({column} AS BINARY))>0"),
        Some(request.filter_text.clone()),
    ))
}

pub(super) fn start(
    live: Arc<Live>,
    binding: SessionBinding,
    sql: String,
    selection: Option<SourceRange>,
) -> Result<String, E> {
    let (selected, offset) = collab_database::selected_sql(&sql, selection)?;
    if selected.trim().is_empty() || selected.contains('\0') {
        return Err(E::InvalidParameter);
    }
    let source = SourceRange {
        start_utf16: offset,
        end_utf16: offset + selected.encode_utf16().count() as u32,
    };
    launch(live, binding, selected.into(), None, Some(source), 100_000)
}

pub(super) fn browse(
    live: Arc<Live>,
    binding: SessionBinding,
    request: BrowseRequest,
) -> Result<String, E> {
    let (table, filter, value) = target(&binding.database, &request)?;
    launch(
        live,
        binding,
        format!("SELECT * FROM {table}{filter} LIMIT 500"),
        value,
        None,
        500,
    )
}

pub(super) fn transaction(
    live: Arc<Live>,
    binding: SessionBinding,
    action: TransactionAction,
) -> Result<String, E> {
    let sql = match (action, live.query.status().transaction) {
        (TransactionAction::Begin, TransactionState::None) => "START TRANSACTION",
        (TransactionAction::Commit, TransactionState::Open) => "COMMIT",
        (TransactionAction::Rollback, TransactionState::Open | TransactionState::Failed) => {
            "ROLLBACK"
        }
        _ => return Err(E::UnresolvedSession),
    };
    launch(live, binding, sql.into(), None, None, 1)
}

type Failure = (E, Option<i32>);
fn query_error(error: sqlx::Error) -> Failure {
    (classify(&error), server_code(&error))
}

fn launch(
    live: Arc<Live>,
    binding: SessionBinding,
    sql: String,
    parameter: Option<String>,
    source: Option<SourceRange>,
    row_limit: usize,
) -> Result<String, E> {
    let (id, output) = query::start_stream(
        &live.query,
        binding,
        row_limit,
        source.map(|_| sql.as_str()),
        sql == "ROLLBACK",
        &live.cancel,
    )?;
    let monitor = live.clone();
    let worker = tokio::spawn(run(live, output, sql, parameter, source));
    tokio::spawn(async move {
        if worker.await.is_err() {
            monitor.client.lock().await.take();
            monitor.query.retire(true);
        }
    });
    Ok(id)
}

async fn observe(client: &mut MySqlConnection, database: &str) -> Result<TransactionState, E> {
    let (current, in_transaction, autocommit): (Option<String>, i32, i32) = sqlx::query_as(
        "SELECT DATABASE(), CAST(@@in_transaction AS SIGNED), CAST(@@autocommit AS SIGNED)",
    )
    .fetch_one(client)
    .await
    .map_err(|e| classify(&e))?;
    if current.as_deref() != Some(database) || autocommit != 1 {
        return Err(E::WrongBinding);
    }
    Ok(if in_transaction == 0 {
        TransactionState::None
    } else {
        TransactionState::Open
    })
}

async fn run(
    live: Arc<Live>,
    mut output: Output,
    sql: String,
    parameter: Option<String>,
    source: Option<SourceRange>,
) {
    let mut guard = live.client.lock().await;
    let mut reusable = false;
    let mut transaction = TransactionState::Unknown;
    let mut result = Err((E::ConnectionFailed, None));
    if let Some(client) = guard.as_mut() {
        let stop = output.stop.clone();
        result = tokio::select! {
            biased;
            _ = live.cancel.cancelled() => Err((E::WrongBinding, None)),
            _ = stop.cancelled() => Err((E::Cancelled, None)),
            result = timeout(QUERY_TIMEOUT, execute(client, &mut output, &sql, parameter)) => result.unwrap_or(Err((E::Timeout,None))),
        };
        // A server error packet settles the statement. A client timeout,
        // cancellation, or protocol error does not establish its outcome.
        if result.is_ok() || matches!(result, Err((_, Some(_)))) {
            match timeout(Duration::from_secs(3), observe(client, &live.database)).await {
                Ok(Ok(state)) => {
                    transaction = state;
                    reusable = true;
                }
                Ok(Err(code)) if result.is_ok() => result = Err((code, None)),
                _ => {}
            }
        }
    }
    if !reusable {
        guard.take();
    }
    drop(guard);
    let (reason, error) = match result {
        Ok(reason) if reusable => (reason, None),
        Ok(_) => (
            FinishReason::Complete,
            Some(ExecutionError {
                code: E::ConnectionFailed,
                source,
                server_code: None,
                outcome_unknown: true,
            }),
        ),
        Err((code, server_code)) => (
            FinishReason::Complete,
            Some(ExecutionError {
                code,
                source,
                server_code,
                outcome_unknown: !reusable,
            }),
        ),
    };
    if !query::finish_stream(
        &live.query,
        &live.cancel,
        output,
        transaction,
        reusable,
        error,
        reason,
    )
    .await
    {
        live.client.lock().await.take();
        live.cancel.cancel();
        live.query.retire(!reusable);
    }
}

fn columns(columns: &[MySqlColumn]) -> Vec<ColumnMetadata> {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| ColumnMetadata {
            name: Identifier::new(column.name())
                .unwrap_or_else(|_| Identifier::new(format!("Column {}", index + 1)).unwrap()),
            engine_type: column.type_info().name().into(),
            nullable: true,
            generated: false,
            version_token: false,
            precision: None,
            scale: None,
        })
        .collect()
}

#[allow(deprecated)] // The SQLx MySQL stream exposes result boundaries through fetch_many.
async fn execute(
    client: &mut MySqlConnection,
    output: &mut Output,
    sql: &str,
    parameter: Option<String>,
) -> Result<FinishReason, Failure> {
    // COM_STMT_PREPARE accepts one statement using the server's own SQL mode.
    let statement = client
        .prepare(AssertSqlSafe(sql).into_sql_str())
        .await
        .map_err(query_error)?;
    let initial = statement.columns();
    let mut query = statement.query().persistent(false);
    if let Some(value) = parameter {
        query = query.bind(value);
    }
    let mut stream = query.fetch_many(client);
    let mut set = 0u32;
    let mut seen_columns = false;
    let mut page = Vec::new();
    let mut page_bytes = 0;
    let mut total = 0;
    let mut reason = FinishReason::Complete;
    while let Some(item) = stream.try_next().await.map_err(query_error)? {
        match item {
            Either::Right(row) if reason == FinishReason::Complete => {
                if !seen_columns {
                    output
                        .emit(ResultEvent::Columns {
                            result_set: set,
                            columns: columns(row.columns()),
                        })
                        .await
                        .map_err(|e| (e, None))?;
                    seen_columns = true;
                }
                if total == output.limits.result_rows {
                    reason = FinishReason::RowLimit;
                    continue;
                }
                let mut values = Vec::with_capacity(row.len());
                for index in 0..row.len() {
                    values.push(read_cell(&row, index).map_err(|e| (e, None))?);
                }
                let size = match collab_database::encoded_size(&values, 128 << 10) {
                    Ok(size) => size,
                    Err(_) => {
                        reason = FinishReason::ByteLimit;
                        continue;
                    }
                };
                let truncated = values
                    .iter()
                    .any(|v| matches!(v, DbValue::Truncated { .. }));
                page_bytes += size;
                page.push(values);
                total += 1;
                if page_bytes >= 96 << 10 || page.len() >= 128 || truncated {
                    if !emit_rows(output, set, &mut page).await? {
                        reason = FinishReason::ByteLimit;
                    } else if truncated {
                        reason = FinishReason::CellLimit;
                    }
                    page_bytes = 0;
                }
            }
            Either::Left(result) => {
                if reason == FinishReason::Complete {
                    if !seen_columns && set == 0 && !initial.is_empty() {
                        output
                            .emit(ResultEvent::Columns {
                                result_set: set,
                                columns: columns(initial),
                            })
                            .await
                            .map_err(|e| (e, None))?;
                        seen_columns = true;
                    }
                    if !seen_columns {
                        output
                            .emit(ResultEvent::AffectedRows {
                                result_set: set,
                                exact_count: result.rows_affected().to_string(),
                            })
                            .await
                            .map_err(|e| (e, None))?;
                    }
                }
                if !page.is_empty() && !emit_rows(output, set, &mut page).await? {
                    reason = FinishReason::ByteLimit;
                }
                set += 1;
                seen_columns = false;
                page_bytes = 0;
            }
            _ => {}
        }
    }
    if !page.is_empty() && !emit_rows(output, set, &mut page).await? {
        reason = FinishReason::ByteLimit;
    }
    Ok(reason)
}

async fn emit_rows(
    output: &mut Output,
    set: u32,
    page: &mut Vec<Vec<DbValue>>,
) -> Result<bool, Failure> {
    match output
        .emit(ResultEvent::Rows {
            result_set: set,
            rows: std::mem::take(page),
        })
        .await
    {
        Ok(()) => Ok(true),
        Err(E::LimitReached) => Ok(false),
        Err(error) => Err((error, None)),
    }
}

fn fractional(text: &str) -> u8 {
    text.split_once('.').map_or(0, |(_, tail)| tail.len() as u8)
}

fn read_cell(row: &MySqlRow, index: usize) -> Result<DbValue, E> {
    let kind = row.columns()[index].type_info().name();
    let raw = row.try_get_raw(index).map_err(|_| E::DataConversion)?;
    if raw.is_null() {
        return Ok(DbValue::Null);
    }
    let opaque = || DbValue::Opaque {
        engine_type: kind.into(),
        display: format!("Unsupported or unrepresentable {kind} value"),
    };
    macro_rules! decoded {
        ($type:ty) => {
            <$type as Decode<'_, MySql>>::decode(raw).ok()
        };
    }
    Ok(match kind {
        "BOOLEAN" if row.try_get::<u8, _>(index).is_ok() => DbValue::Integer {
            decimal: row
                .try_get::<u8, _>(index)
                .map_err(|_| E::DataConversion)?
                .to_string(),
        },
        "BIT" => decoded!(&[u8])
            .filter(|bytes| !bytes.is_empty() && bytes.len() <= 8)
            .map(|bytes| DbValue::Integer {
                decimal: bytes
                    .iter()
                    .fold(0u64, |value, &byte| (value << 8) | u64::from(byte))
                    .to_string(),
            })
            .unwrap_or_else(opaque),
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => {
            decoded!(i64)
                .map(|n| DbValue::Integer {
                    decimal: n.to_string(),
                })
                .unwrap_or_else(opaque)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => decoded!(u64)
            .map(|n| DbValue::Integer {
                decimal: n.to_string(),
            })
            .unwrap_or_else(opaque),
        "DECIMAL" => decoded!(&str)
            .map(|decimal| {
                let scale = u16::from(fractional(decimal));
                let precision = decimal
                    .trim_start_matches('-')
                    .replace('.', "")
                    .trim_start_matches('0')
                    .len() as u16;
                DbValue::Decimal {
                    decimal: decimal.into(),
                    precision: precision.max(scale).max(1),
                    scale,
                }
            })
            .unwrap_or_else(opaque),
        "FLOAT" => decoded!(f32)
            .filter(|v| v.is_finite())
            .map(|v| DbValue::Float {
                round_trip_decimal: v.to_string(),
                bits: 32,
            })
            .unwrap_or_else(opaque),
        "DOUBLE" => decoded!(f64)
            .filter(|v| v.is_finite())
            .map(|v| DbValue::Float {
                round_trip_decimal: v.to_string(),
                bits: 64,
            })
            .unwrap_or_else(opaque),
        "DATE" => decoded!(chrono::NaiveDate)
            .map(|v| DbValue::Date {
                iso8601: v.to_string(),
            })
            .unwrap_or_else(opaque),
        "DATETIME" | "TIMESTAMP" => decoded!(chrono::NaiveDateTime)
            .map(|v| {
                let iso8601 = v.format("%Y-%m-%dT%H:%M:%S%.f").to_string();
                DbValue::DateTime {
                    fractional_digits: fractional(&iso8601),
                    iso8601,
                    offset_minutes: None,
                }
            })
            .unwrap_or_else(opaque),
        "TIME" => decoded!(MySqlTime)
            .map(|v| {
                let iso8601 = v.to_string();
                DbValue::Time {
                    fractional_digits: fractional(&iso8601),
                    iso8601,
                }
            })
            .unwrap_or_else(opaque),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            let bytes = decoded!(&[u8]).ok_or(E::DataConversion)?;
            if bytes.len() > 16 << 10 {
                DbValue::Truncated {
                    engine_type: kind.into(),
                    preview: STANDARD.encode(&bytes[..3072]),
                    original_bytes: Some(bytes.len() as u64),
                }
            } else {
                DbValue::Binary {
                    base64: STANDARD.encode(bytes),
                }
            }
        }
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET"
        | "JSON" => {
            let Some(text) = decoded!(&str) else {
                return Ok(opaque());
            };
            if text.len() > 16 << 10 {
                DbValue::Truncated {
                    engine_type: kind.into(),
                    preview: text.chars().take(1024).collect(),
                    original_bytes: Some(text.len() as u64),
                }
            } else {
                DbValue::Text { value: text.into() }
            }
        }
        _ => opaque(),
    })
}
