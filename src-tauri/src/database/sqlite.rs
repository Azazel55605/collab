//! A picker-owned SQLite connection per local database tab.
mod edits;
#[cfg(test)]
mod tests;

use super::{
    driver::{MetadataItem, MetadataPage, MetadataRequest},
    query::{self, BrowseRequest, Output, Runtime, TransactionAction},
};
use collab_database::{
    ColumnMetadata, ContractError as E, DbValue, Engine, ExecutionError, FinishReason, Identifier,
    ResultEvent, SessionBinding, SourceRange, TransactionState,
};
use parking_lot::Mutex;
use rusqlite::{
    backup::{Backup, StepResult},
    config::DbConfig,
    fallible_iterator::FallibleIterator,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::{Value, ValueRef},
    Batch, Connection, ErrorCode, OpenFlags,
};
#[cfg(not(unix))]
use same_file::Handle as Identity;
#[cfg(unix)]
type Identity = (u64, u64);
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenMode {
    ReadOnly,
    ReadWrite,
    Create,
}
#[derive(Clone, Serialize)]
pub struct FileView {
    pub binding: SessionBinding,
    pub label: String,
    pub read_only: bool,
}

pub(super) struct Session {
    pub view: FileView,
    pub query: Runtime,
    pub cancel: CancellationToken,
    path: PathBuf,
    identity: Identity,
    connection: Mutex<Option<Connection>>,
    maintenance: AtomicBool,
    edit_unknown: AtomicBool,
    snapshot: Mutex<Option<Arc<edits::Snapshot>>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

pub(super) struct Maintenance(Arc<Session>);
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.0.maintenance.store(false, Ordering::Release);
    }
}

pub(super) fn classify(error: rusqlite::Error) -> E {
    use ErrorCode::*;
    if error
        .sqlite_error()
        .is_some_and(|error| error.extended_code == rusqlite::ffi::SQLITE_READONLY_DBMOVED)
    {
        return E::DatabaseMoved;
    }
    match error.sqlite_error_code() {
        Some(ReadOnly) => E::DatabaseReadOnly,
        Some(DatabaseBusy | DatabaseLocked | FileLockingProtocolFailed) => E::DatabaseLocked,
        Some(NotADatabase | DatabaseCorrupt) => E::InvalidDatabase,
        Some(TooBig | OutOfMemory) => E::LimitReached,
        Some(AuthorizationForStatementDenied | PermissionDenied) => E::PermissionDenied,
        Some(OperationInterrupted) => E::Cancelled,
        Some(SchemaChanged) => E::SchemaConflict,
        Some(SystemIoFailure | CannotOpen) => E::ConnectionFailed,
        _ => E::QueryFailed,
    }
}

pub(super) fn quoted(name: &str) -> Result<String, E> {
    Identifier::new(name)?.quoted(Engine::Sqlite)
}
fn authorize(context: AuthContext<'_>) -> Authorization {
    use AuthAction::*;
    let deny = match context.action {
        Attach { .. }
        | Detach { .. }
        | CreateVtable { .. }
        | DropVtable { .. }
        | Unknown { .. } => true,
        Function { function_name } => [
            "load_extension",
            "readfile",
            "writefile",
            "edit",
            "fts3_tokenizer",
        ]
        .iter()
        .any(|name| function_name.eq_ignore_ascii_case(name)),
        Pragma {
            pragma_name,
            pragma_value,
        } => {
            let pragma = pragma_name.to_ascii_lowercase();
            !matches!(
                pragma.as_str(),
                "table_list"
                    | "table_info"
                    | "table_xinfo"
                    | "index_list"
                    | "index_info"
                    | "index_xinfo"
                    | "foreign_key_list"
            ) && !(pragma_value.is_none()
                && matches!(
                    pragma.as_str(),
                    "schema_version"
                        | "user_version"
                        | "journal_mode"
                        | "page_count"
                        | "page_size"
                        | "integrity_check"
                        | "quick_check"
                ))
        }
        _ => false,
    };
    if deny {
        Authorization::Deny
    } else {
        Authorization::Allow
    }
}

fn configured_connection(path: &Path, read_only: bool) -> Result<Connection, E> {
    // URI processing and extension loading stay disabled.
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let mut connection = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NOFOLLOW)
        .map_err(classify)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(classify)?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(classify)?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(classify)?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true)
        .map_err(classify)?;
    // Limit SQLite's own allocations before copying dynamic result values.
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, 1 << 20),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 1 << 20),
        (Limit::SQLITE_LIMIT_COLUMN, 256),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_VDBE_OP, 250_000),
    ] {
        connection.set_limit(limit, value).map_err(classify)?;
    }
    connection.authorizer(Some(authorize)).map_err(classify)?;
    connection
        .query_row("PRAGMA main.schema_version", [], |_| Ok(()))
        .map_err(classify)?;
    Ok(connection)
}

// Avoid opening and closing auxiliary descriptors for a live SQLite inode on
// Unix: closing such a descriptor can release SQLite's process-wide locks.
fn file_identity(path: &Path) -> Result<Identity, E> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| E::InvalidDatabase)?;
    if !metadata.is_file() || metadata.len() < 100 {
        return Err(E::InvalidDatabase);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    Identity::from_path(path).map_err(|_| E::InvalidDatabase)
}

pub(crate) fn stage_at(path: &Path) -> Result<tempfile::NamedTempFile, E> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        if !matches!(std::fs::symlink_metadata(sidecar), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(E::DatabaseLocked);
        }
    }
    tempfile::NamedTempFile::new_in(path.parent().ok_or(E::InvalidParameter)?)
        .map_err(|_| E::ConnectionFailed)
}
pub(crate) fn save_stage(stage: tempfile::NamedTempFile, path: &Path) -> Result<(), E> {
    stage
        .as_file()
        .sync_all()
        .map_err(|_| E::ConnectionFailed)?;
    stage
        .persist_noclobber(path)
        .map_err(|_| E::InvalidParameter)?;
    Ok(())
}

impl Session {
    pub(super) fn open(
        binding: SessionBinding,
        path: PathBuf,
        mode: OpenMode,
        cancel: CancellationToken,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Arc<Self>, E> {
        if !collab_documents::sqlite_file::matches_path(&path.to_string_lossy()) {
            return Err(E::InvalidParameter);
        }
        if matches!(mode, OpenMode::Create) {
            let stage = stage_at(&path)?;
            {
                let connection = Connection::open(stage.path()).map_err(classify)?;
                connection
                    .execute_batch("PRAGMA user_version=0")
                    .map_err(classify)?;
            }
            save_stage(stage, &path)?;
        }
        let identity = file_identity(&path)?;
        let path = path.canonicalize().map_err(|_| E::ConnectionFailed)?;
        let read_only = matches!(mode, OpenMode::ReadOnly);
        let connection = configured_connection(&path, read_only)?;
        if file_identity(&path).ok().as_ref() != Some(&identity) {
            return Err(E::DatabaseMoved);
        }
        let label = path
            .file_name()
            .ok_or(E::InvalidParameter)?
            .to_string_lossy()
            .into_owned();
        Ok(Arc::new(Self {
            view: FileView {
                binding,
                label,
                read_only,
            },
            query: Runtime::default(),
            cancel,
            path,
            identity,
            connection: Mutex::new(Some(connection)),
            maintenance: AtomicBool::new(false),
            edit_unknown: AtomicBool::new(false),
            snapshot: Mutex::new(None),
            _permit: permit,
        }))
    }
    pub(super) fn clean(&self) -> bool {
        !self.busy() && self.query.clean() && !self.edit_unknown.load(Ordering::Acquire)
    }
    pub(super) fn busy(&self) -> bool {
        self.maintenance.load(Ordering::Acquire)
    }
    pub(super) fn reserve(self: &Arc<Self>) -> Result<Maintenance, E> {
        if self.query.status().phase != "idle" || self.edit_unknown.load(Ordering::Acquire) {
            return Err(E::UnresolvedSession);
        }
        self.maintenance
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| E::Busy)?;
        Ok(Maintenance(self.clone()))
    }
    fn check_identity(&self) -> Result<(), E> {
        if file_identity(&self.path).ok().as_ref() != Some(&self.identity) {
            return Err(E::DatabaseMoved);
        }
        if self.cancel.is_cancelled() {
            return Err(E::WrongBinding);
        }
        Ok(())
    }
    pub(super) fn backup(&self, destination: &Path) -> Result<(), E> {
        self.check_identity()?;
        if !collab_documents::sqlite_file::matches_path(&destination.to_string_lossy()) {
            return Err(E::InvalidParameter);
        }
        let guard = self.connection.lock();
        let connection = guard.as_ref().ok_or(E::ConnectionFailed)?;
        if !connection.is_autocommit() {
            return Err(E::UnresolvedSession);
        }
        copy_database(connection, destination, || self.check_identity())
    }
}

impl Session {
    fn inspect<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, E>) -> Result<T, E> {
        self.check_identity()?;
        let mut guard = self.connection.lock();
        let connection = guard.as_mut().ok_or(E::ConnectionFailed)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let cancel = self.cancel.clone();
        connection
            .progress_handler(
                500,
                Some(move || cancel.is_cancelled() || Instant::now() >= deadline),
            )
            .map_err(classify)?;
        let result = f(connection);
        connection
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(classify)?;
        match result {
            Err(E::Cancelled) if Instant::now() >= deadline => Err(E::Timeout),
            result => result,
        }
    }
    pub(super) fn metadata(&self, request: MetadataRequest) -> Result<MetadataPage, E> {
        use MetadataRequest::*;
        let (sql, parameters) = match request {
            Databases { after } if after.len() <= 512 => ("SELECT 'main','main','database','' WHERE ?1 < 'main'", vec![Value::Text(after)]),
            Schemas { after } => ("SELECT '1','main','schema','' WHERE ?1 < 1", vec![Value::from(after)]),
            Objects { schema_id: 1, after } => ("SELECT CAST(rowid AS TEXT),name,upper(type),'' FROM main.sqlite_schema WHERE rowid>?1 AND type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY rowid LIMIT 101", vec![Value::from(after)]),
            Columns { object_id, after } => ("SELECT CAST(c.cid+1 AS TEXT),c.name,c.type,printf('nullable=%d generated=%d',NOT c.[notnull],c.hidden!=0) FROM main.sqlite_schema s JOIN pragma_table_xinfo(s.name,'main') c WHERE s.rowid=?1 AND s.type IN ('table','view') AND c.cid+1>?2 ORDER BY c.cid LIMIT 101", vec![Value::from(object_id), Value::from(after)]),
            Indexes { object_id, after } => ("SELECT CAST(i.seq+1 AS TEXT),i.name,'INDEX',printf('unique=%d primary=%d partial=%d',i.[unique],i.origin='pk',i.partial) FROM main.sqlite_schema s JOIN pragma_index_list(s.name,'main') i WHERE s.rowid=?1 AND s.type='table' AND i.seq+1>?2 ORDER BY i.seq LIMIT 101", vec![Value::from(object_id), Value::from(after)]),
            Completion { after } => {
                let (object, column) = after.split_once(':').ok_or(E::InvalidParameter)?;
                let cursor = [object, column].into_iter().map(|part| part.parse::<i32>().ok().filter(|&id| id >= 0).map(Value::from).ok_or(E::InvalidParameter)).collect::<Result<Vec<_>, _>>()?;
                ("SELECT printf('%d:%d',s.rowid,c.cid+1),c.name,s.name,'main' FROM main.sqlite_schema s JOIN pragma_table_xinfo(s.name,'main') c WHERE s.type IN ('table','view') AND s.name NOT GLOB 'sqlite_*' AND (s.rowid>?1 OR (s.rowid=?1 AND c.cid+1>?2)) ORDER BY s.rowid,c.cid LIMIT 101", cursor)
            }
            _ => return Err(E::InvalidParameter),
        };
        self.inspect(|connection| {
            let mut statement = connection.prepare(sql).map_err(classify)?;
            let mut items = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok(MetadataItem {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        detail: row.get(3)?,
                    })
                })
                .map_err(classify)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(classify)?;
            if items
                .iter()
                .any(|item| item.name.len() > 2048 || item.kind.len() > 2048)
            {
                return Err(E::LimitReached);
            }
            let next = if items.len() > 100 {
                items.truncate(100);
                items.last().map(|item| item.id.clone())
            } else {
                None
            };
            Ok(MetadataPage { items, next })
        })
    }
}
fn copy_database(
    source: &Connection,
    destination: &Path,
    verify: impl Fn() -> Result<(), E>,
) -> Result<(), E> {
    let stage = stage_at(destination)?;
    {
        let mut copy = Connection::open(stage.path()).map_err(classify)?;
        let backup = Backup::new(source, &mut copy).map_err(classify)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            verify()?;
            if Instant::now() >= deadline {
                return Err(E::Timeout);
            }
            match backup.step(128).map_err(classify)? {
                StepResult::Done => break,
                StepResult::Busy | StepResult::Locked => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {}
            }
            if stage
                .as_file()
                .metadata()
                .map_err(|_| E::ConnectionFailed)?
                .len()
                > 256 << 20
            {
                return Err(E::LimitReached);
            }
        }
        drop(backup);
        copy.pragma_update(None, "journal_mode", "DELETE")
            .map_err(classify)?;
    }
    if stage
        .as_file()
        .metadata()
        .map_err(|_| E::ConnectionFailed)?
        .len()
        > 256 << 20
    {
        return Err(E::LimitReached);
    }
    verify()?;
    save_stage(stage, destination)
}

/// Capture a consistent standalone snapshot for an explicit binary attachment.
pub(crate) fn snapshot_for_upload(path: &Path) -> Result<tempfile::TempDir, E> {
    let identity = file_identity(path)?;
    let source = configured_connection(path, true)?;
    if file_identity(path).ok().as_ref() != Some(&identity) {
        return Err(E::DatabaseMoved);
    }
    let directory = tempfile::tempdir().map_err(|_| E::ConnectionFailed)?;
    copy_database(&source, &directory.path().join("snapshot.sqlite"), || {
        if file_identity(path).ok().as_ref() != Some(&identity) {
            return Err(E::DatabaseMoved);
        }
        Ok(())
    })?;
    Ok(directory)
}

fn value(value: ValueRef<'_>) -> Result<DbValue, E> {
    Ok(match value {
        ValueRef::Null => DbValue::Null,
        ValueRef::Integer(value) => DbValue::Integer {
            decimal: value.to_string(),
        },
        ValueRef::Real(value) if value.is_finite() => DbValue::Float {
            round_trip_decimal: value.to_string(),
            bits: 64,
        },
        ValueRef::Real(_) => DbValue::Opaque {
            engine_type: "REAL".into(),
            display: "Non-finite REAL".into(),
        },
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(value) => DbValue::Text {
                value: value.into(),
            },
            Err(_) => DbValue::Opaque {
                engine_type: "TEXT".into(),
                display: "Invalid UTF-8".into(),
            },
        },
        ValueRef::Blob(bytes) => {
            use base64::Engine as _;
            DbValue::Binary {
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        }
    })
}
fn result_cell(cell: ValueRef<'_>) -> Result<(DbValue, bool), E> {
    let (bytes, kind) = match cell {
        ValueRef::Blob(bytes) => (bytes, "BLOB"),
        ValueRef::Text(bytes) => (bytes, "TEXT"),
        _ => return Ok((value(cell)?, false)),
    };
    if bytes.len() <= 16 << 10 {
        return Ok((value(cell)?, false));
    }
    let preview = if kind == "TEXT" {
        String::from_utf8_lossy(&bytes[..4096]).into_owned()
    } else {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&bytes[..3072])
    };
    Ok((
        DbValue::Truncated {
            engine_type: kind.into(),
            preview,
            original_bytes: Some(bytes.len() as u64),
        },
        true,
    ))
}

pub(super) fn filter(request: &BrowseRequest) -> Result<(String, Vec<Value>), E> {
    if request.schema != "main" || request.filter_text.len() > 4096 {
        return Err(E::InvalidParameter);
    }
    if request.filter_text.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let column = quoted(
        request
            .filter_column
            .as_deref()
            .ok_or(E::InvalidParameter)?,
    )?;
    Ok((
        format!(" WHERE instr(CAST({column} AS TEXT),?1)>0"),
        vec![Value::Text(request.filter_text.clone())],
    ))
}

pub(super) fn browse(
    session: Arc<Session>,
    binding: SessionBinding,
    request: BrowseRequest,
) -> Result<String, E> {
    let table = quoted(&request.table)?;
    let (filter, values) = filter(&request)?;
    launch(
        session,
        binding,
        format!("SELECT * FROM main.{table}{filter} LIMIT 500"),
        values,
        None,
        500,
        false,
    )
}
pub(super) fn start(
    session: Arc<Session>,
    binding: SessionBinding,
    sql: String,
    selection: Option<SourceRange>,
) -> Result<String, E> {
    let (selected, offset) = collab_database::selected_sql(&sql, selection)?;
    if selected.trim().is_empty() {
        return Err(E::InvalidParameter);
    }
    let source = SourceRange {
        start_utf16: offset,
        end_utf16: offset + selected.encode_utf16().count() as u32,
    };
    launch(
        session,
        binding,
        selected.into(),
        vec![],
        Some(source),
        100_000,
        false,
    )
}
pub(super) fn transaction(
    session: Arc<Session>,
    binding: SessionBinding,
    action: TransactionAction,
) -> Result<String, E> {
    let state = session.query.status().transaction;
    let sql = match (&action, state) {
        (TransactionAction::Begin, TransactionState::None) => "BEGIN",
        (TransactionAction::Commit, TransactionState::Open) => "COMMIT",
        (TransactionAction::Rollback, TransactionState::Open | TransactionState::Failed) => {
            "ROLLBACK"
        }
        _ => return Err(E::UnresolvedSession),
    };
    launch(session, binding, sql.into(), vec![], None, 1, true)
}

fn launch(
    session: Arc<Session>,
    binding: SessionBinding,
    sql: String,
    values: Vec<Value>,
    source: Option<SourceRange>,
    row_limit: usize,
    recovery: bool,
) -> Result<String, E> {
    if session.busy() {
        return Err(E::Busy);
    }
    if session.edit_unknown.load(Ordering::Acquire) {
        return Err(E::UnresolvedSession);
    }
    let history = source.as_ref().map(|_| sql.as_str());
    let (id, mut output) =
        query::start_stream(&session.query, binding, row_limit, history, recovery)?;
    let worker = session.clone();
    let runtime = tokio::runtime::Handle::current();
    let task = tokio::task::spawn_blocking(move || {
        let (result, state) = run(&worker, &runtime, &mut output, &sql, &values);
        (output, result, state)
    });
    tokio::spawn(async move {
        let Ok((output, result, transaction)) = task.await else {
            session.connection.lock().take();
            session.query.retire(true);
            return;
        };
        let (error, reason, reusable) = match result {
            Ok(reason) => (None, reason, true),
            Err((E::Cancelled, _)) => (None, FinishReason::Cancelled, true),
            Err((code, server_code)) => {
                let unknown = code == E::ConnectionFailed;
                let error = ExecutionError {
                    code,
                    source,
                    server_code,
                    outcome_unknown: unknown,
                };
                (
                    Some(error),
                    FinishReason::Complete,
                    !unknown && code != E::DatabaseMoved,
                )
            }
        };
        if !reusable {
            session.connection.lock().take();
        }
        let transaction = if error.as_ref().is_some_and(|error| error.outcome_unknown) {
            TransactionState::Unknown
        } else {
            transaction
        };
        if !query::finish_stream(
            &session.query,
            &session.cancel,
            output,
            transaction,
            reusable,
            error,
            reason,
        )
        .await
        {
            session.connection.lock().take();
            session.cancel.cancel();
            session
                .query
                .retire(!reusable && transaction == TransactionState::Unknown);
        }
    });
    Ok(id)
}

type QueryError = (E, Option<i32>);
fn sql_error(error: rusqlite::Error) -> QueryError {
    let code = match &error {
        rusqlite::Error::SqliteFailure(error, _) => Some(error.extended_code),
        _ => None,
    };
    (classify(error), code)
}

fn run(
    session: &Session,
    runtime: &tokio::runtime::Handle,
    output: &mut Output,
    sql: &str,
    values: &[Value],
) -> (Result<FinishReason, QueryError>, TransactionState) {
    if let Err(error) = session.check_identity() {
        return (Err((error, None)), TransactionState::None);
    }
    let mut guard = session.connection.lock();
    let Some(connection) = guard.as_mut() else {
        return (Err((E::ConnectionFailed, None)), TransactionState::Unknown);
    };
    let stop = output.stop.clone();
    let cancel = session.cancel.clone();
    let deadline = Instant::now() + Duration::from_secs(120);
    if let Err(error) = connection.progress_handler(
        500,
        Some(move || stop.is_cancelled() || cancel.is_cancelled() || Instant::now() >= deadline),
    ) {
        return (Err(sql_error(error)), TransactionState::Unknown);
    }
    let result = match execute(connection, session, runtime, output, sql, values, deadline) {
        Err((E::Cancelled, code)) if Instant::now() >= deadline => Err((E::Timeout, code)),
        result => result,
    };
    let reset = connection
        .progress_handler(0, None::<fn() -> bool>)
        .map_err(sql_error);
    let state = if connection.is_autocommit() {
        TransactionState::None
    } else {
        TransactionState::Open
    };
    (result.and_then(|result| reset.map(|_| result)), state)
}

fn execute(
    connection: &Connection,
    session: &Session,
    runtime: &tokio::runtime::Handle,
    output: &mut Output,
    sql: &str,
    values: &[Value],
    deadline: Instant,
) -> Result<FinishReason, QueryError> {
    let mut batch = Batch::new(connection, sql);
    let mut set = 0u32;
    let mut total = 0usize;
    for index in 0..128 {
        session.check_identity().map_err(|e| (e, None))?;
        if output.stop.is_cancelled() {
            return Err((E::Cancelled, None));
        }
        if Instant::now() >= deadline {
            return Err((E::Timeout, None));
        }
        let Some(mut statement) = batch.next().map_err(sql_error)? else {
            return Ok(FinishReason::Complete);
        };
        let count = statement.column_count();
        if count == 0 {
            let before = connection.total_changes();
            statement
                .execute(rusqlite::params_from_iter(values))
                .map_err(sql_error)?;
            let changes = if connection.total_changes() != before {
                connection.changes()
            } else {
                0
            };
            runtime
                .block_on(output.emit(ResultEvent::AffectedRows {
                    result_set: set,
                    exact_count: changes.to_string(),
                }))
                .map_err(|e| (e, None))?;
            continue;
        }
        let columns = statement
            .column_names()
            .enumerate()
            .map(|(i, name)| ColumnMetadata {
                name: Identifier::new(name)
                    .unwrap_or_else(|_| Identifier::new(format!("Column {}", i + 1)).unwrap()),
                engine_type: "SQLite".into(),
                nullable: true,
                generated: false,
                version_token: false,
                precision: None,
                scale: None,
            })
            .collect();
        runtime
            .block_on(output.emit(ResultEvent::Columns {
                result_set: set,
                columns,
            }))
            .map_err(|e| (e, None))?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(if index == 0 {
                values
            } else {
                &[]
            }))
            .map_err(sql_error)?;
        loop {
            let credit = runtime.block_on(output.credit()).map_err(|e| (e, None))?;
            let mut page = Vec::new();
            let mut size = 0usize;
            let mut cut = false;
            while page.len() < 128 && size < 128 << 10 && total < output.limits.result_rows {
                let Some(row) = rows.next().map_err(sql_error)? else {
                    break;
                };
                let mut cells = Vec::with_capacity(count);
                for i in 0..count {
                    let (value, truncated) =
                        result_cell(row.get_ref(i).map_err(sql_error)?).map_err(|e| (e, None))?;
                    cut |= truncated;
                    cells.push(value);
                }
                let row_size =
                    collab_database::encoded_size(&cells, 64 << 10).map_err(|e| (e, None))?;
                size += row_size;
                page.push(cells);
                total += 1;
                if cut {
                    break;
                }
            }
            if page.is_empty() {
                break;
            }
            match output.emit_with(
                ResultEvent::Rows {
                    result_set: set,
                    rows: page,
                },
                credit,
            ) {
                Ok(()) => {}
                Err(E::LimitReached) => return Ok(FinishReason::ByteLimit),
                Err(error) => return Err((error, None)),
            }
            if cut {
                return Ok(FinishReason::CellLimit);
            }
            if total == output.limits.result_rows {
                return Ok(FinishReason::RowLimit);
            }
        }
        set += 1;
    }
    if batch.next().map_err(sql_error)?.is_some() {
        Err((E::LimitReached, None))
    } else {
        Ok(FinishReason::Complete)
    }
}
