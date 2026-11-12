//! One bounded, explicitly acknowledged result stream per pinned physical session.
use super::driver::{classify, Live};
use collab_database::{
    ContractError as E, DbValue, ExecutionError, FinishReason, Identifier, Limits, ResultEvent,
    ResultFrame, SessionBinding, SourceRange, SqlBatch, StreamWindow, TransactionState,
};
use mssql_tds::{
    connection::tds_client::{CursorColumn, ExecuteOptions, ResultSet, StatementResult, TdsClient},
    core::CancelHandle,
    query::metadata::PlpEncoding,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{collections::VecDeque, sync::Arc, time::Duration};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct Status {
    pub query_id: Option<String>,
    pub phase: String,
    pub transaction: TransactionState,
    pub reason: Option<FinishReason>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            query_id: None,
            phase: "idle".into(),
            transaction: TransactionState::None,
            reason: None,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct HistoryEntry {
    pub sql: String,
    pub executed_at: String,
}
pub struct Runtime {
    inner: Mutex<State>,
}
struct State {
    status: Status,
    pull: Option<Arc<tokio::sync::Mutex<Pull>>>,
    cancel: Arc<CancelHandle>,
    stop: tokio_util::sync::CancellationToken,
    history: VecDeque<HistoryEntry>,
}
struct Pull {
    receiver: mpsc::Receiver<Queued>,
    pending: Option<Queued>,
    last_ack: Option<u64>,
    window: Arc<Mutex<StreamWindow>>,
}
struct Queued {
    frame: ResultFrame,
    _credit: OwnedSemaphorePermit,
}
#[derive(Serialize)]
pub struct Poll {
    pub frame: Option<ResultFrame>,
    pub status: Status,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(State {
                status: Status::default(),
                pull: None,
                cancel: Arc::new(CancelHandle::new()),
                stop: tokio_util::sync::CancellationToken::new(),
                history: VecDeque::new(),
            }),
        }
    }
}
impl Runtime {
    pub fn status(&self) -> Status {
        self.inner.lock().status.clone()
    }
    pub fn clean(&self) -> bool {
        let s = self.status();
        !matches!(
            s.phase.as_str(),
            "running" | "cancelling" | "finishing" | "outcome_unknown"
        ) && s.transaction == TransactionState::None
    }
    pub fn cancel(&self, id: &str) -> Result<(), E> {
        let mut s = self.inner.lock();
        if s.status.query_id.as_deref() != Some(id) {
            return Err(E::StaleQuery);
        }
        if matches!(
            s.status.phase.as_str(),
            "running" | "cancelling" | "finishing"
        ) {
            s.status.phase = "cancelling".into();
            s.cancel.cancel();
            s.stop.cancel();
        }
        Ok(())
    }
    pub fn history(&self) -> Vec<HistoryEntry> {
        self.inner.lock().history.iter().cloned().collect()
    }
    pub fn clear_history(&self) {
        self.inner.lock().history.clear();
    }
    pub async fn poll(&self, id: &str, after: Option<u64>) -> Result<Poll, E> {
        let pull = {
            let s = self.inner.lock();
            if s.status.query_id.as_deref() != Some(id) {
                return Err(E::StaleQuery);
            }
            s.pull.clone().ok_or(E::StaleQuery)?
        };
        let mut pull = pull.lock().await;
        if after != pull.last_ack {
            let pending = pull.pending.as_ref().ok_or(E::InvalidSequence)?;
            if Some(pending.frame.sequence) != after {
                return Err(E::InvalidSequence);
            }
            pull.window
                .lock()
                .acknowledge(&pending.frame.binding, id, pending.frame.sequence)?;
            pull.pending.take();
            pull.last_ack = after;
        }
        if pull.pending.is_none() {
            if let Ok(item) = pull.receiver.try_recv() {
                pull.pending = Some(item);
            }
        }
        let status = self.status();
        if status.query_id.as_deref() != Some(id) {
            return Err(E::StaleQuery);
        }
        // Completion is enqueued before its terminal status is published. If the
        // first receive raced publication, recheck after observing that status.
        if pull.pending.is_none()
            && !matches!(
                status.phase.as_str(),
                "running" | "cancelling" | "finishing"
            )
        {
            if let Ok(item) = pull.receiver.try_recv() {
                pull.pending = Some(item);
            }
        }
        let frame = pull.pending.as_ref().map(|item| item.frame.clone());
        Ok(Poll { frame, status })
    }
}
pub(super) struct Output {
    sender: mpsc::Sender<Queued>,
    credits: Arc<Semaphore>,
    window: Arc<Mutex<StreamWindow>>,
    binding: SessionBinding,
    id: String,
    sequence: u64,
    messages: usize,
    counts: usize,
    sets: usize,
    cancel: Arc<CancelHandle>,
    pub(super) stop: tokio_util::sync::CancellationToken,
    pub(super) limits: Limits,
}
impl Output {
    pub(super) async fn credit(&self) -> Result<OwnedSemaphorePermit, E> {
        tokio::select! {biased;_ = self.stop.cancelled()=>Err(E::Cancelled),result=tokio::time::timeout(Duration::from_secs(5),self.credits.clone().acquire_owned())=>result.map_err(|_|E::Timeout)?.map_err(|_|E::Cancelled)}
    }
    pub(super) async fn emit(&mut self, event: ResultEvent) -> Result<(), E> {
        let credit = self.credit().await?;
        self.emit_with(event, credit)
    }
    pub(super) fn emit_with(
        &mut self,
        event: ResultEvent,
        credit: OwnedSemaphorePermit,
    ) -> Result<(), E> {
        match &event {
            ResultEvent::Message { .. } => {
                if self.messages >= 256 {
                    return Err(E::LimitReached);
                }
                self.messages += 1;
            }
            ResultEvent::AffectedRows { .. } => {
                if self.counts >= 1024 {
                    return Err(E::LimitReached);
                }
                self.counts += 1;
            }
            ResultEvent::Columns { .. } => {
                if self.sets >= 256 {
                    return Err(E::LimitReached);
                }
                self.sets += 1;
            }
            _ => {}
        }
        let frame = ResultFrame {
            binding: self.binding.clone(),
            query_id: self.id.clone(),
            sequence: self.sequence,
            event,
        };
        self.window.lock().admit(&frame)?;
        self.sequence += 1;
        self.sender
            .try_send(Queued {
                frame,
                _credit: credit,
            })
            .map_err(|_| E::Backpressure)?;
        Ok(())
    }
    async fn messages(&mut self, client: &mut TdsClient) -> Result<(), E> {
        if client.take_info_messages_truncated() {
            return Err(E::LimitReached);
        }
        for message in client.take_info_messages() {
            let mut text = message.message;
            truncate(&mut text, 4096);
            self.emit(ResultEvent::Message {
                severity: message.class.clamp(0, 255) as u8,
                safe_text: text,
            })
            .await?;
        }
        Ok(())
    }
}
#[derive(serde::Deserialize)]
pub struct BrowseRequest {
    pub schema: String,
    pub table: String,
    pub filter_column: Option<String>,
    pub filter_text: String,
}
pub fn browse(
    live: Arc<Live>,
    binding: SessionBinding,
    request: BrowseRequest,
) -> Result<String, E> {
    let schema =
        Identifier::new(request.schema.clone())?.quoted(collab_database::Engine::SqlServer)?;
    let table =
        Identifier::new(request.table.clone())?.quoted(collab_database::Engine::SqlServer)?;
    let (filter, parameters) = browse_filter(&request)?;
    let sql = format!("SELECT TOP (500) * FROM {schema}.{table}{filter}");
    start_inner(
        live,
        binding,
        sql,
        None,
        false,
        Some(parameters),
        500,
        false,
    )
}

pub(super) fn browse_filter(
    request: &BrowseRequest,
) -> Result<
    (
        String,
        Vec<mssql_tds::message::parameters::rpc_parameters::RpcParameter>,
    ),
    E,
> {
    use mssql_tds::{
        datatypes::{sql_string::SqlString, sqltypes::SqlType},
        message::parameters::rpc_parameters::{RpcParameter, StatusFlags},
    };
    if request.filter_text.len() > 4096 {
        return Err(E::LimitReached);
    }
    if request.filter_text.is_empty() {
        return Ok((String::new(), vec![]));
    }
    let column = request
        .filter_column
        .as_deref()
        .ok_or(E::InvalidParameter)?;
    let column = Identifier::new(column)?.quoted(collab_database::Engine::SqlServer)?;
    let pattern = format!(
        "%{}%",
        request
            .filter_text
            .replace('~', "~~")
            .replace('%', "~%")
            .replace('_', "~_")
            .replace('[', "~[")
    );
    Ok((
        format!(" WHERE TRY_CONVERT(nvarchar(4000), {column}) LIKE @P1 ESCAPE N'~'"),
        vec![RpcParameter::new(
            Some("@P1".into()),
            StatusFlags::NONE,
            SqlType::NVarcharMax(Some(SqlString::from_utf8_string(pattern))),
        )],
    ))
}

pub fn start(
    live: Arc<Live>,
    binding: SessionBinding,
    sql: String,
    selection: Option<SourceRange>,
    recovery: bool,
) -> Result<String, E> {
    start_inner(
        live, binding, sql, selection, recovery, None, 100_000, false,
    )
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionAction {
    Begin,
    Commit,
    Rollback,
}
pub(super) fn transaction(
    live: Arc<Live>,
    binding: SessionBinding,
    action: TransactionAction,
) -> Result<String, E> {
    let state = live.query.status().transaction;
    let sql = match (&action, state) {
        (TransactionAction::Begin, TransactionState::None) => "BEGIN TRANSACTION;",
        (TransactionAction::Commit, TransactionState::Open) => {
            "IF XACT_STATE()=1 AND @@TRANCOUNT>0 COMMIT TRANSACTION;"
        }
        (TransactionAction::Rollback, TransactionState::Open | TransactionState::Failed) => {
            "IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;"
        }
        _ => return Err(E::UnresolvedSession),
    };
    start_inner(
        live,
        binding,
        sql.into(),
        None,
        true,
        None,
        100_000,
        matches!(action, TransactionAction::Commit),
    )
}
fn start_inner(
    live: Arc<Live>,
    binding: SessionBinding,
    sql: String,
    selection: Option<SourceRange>,
    recovery: bool,
    parameters: Option<Vec<mssql_tds::message::parameters::rpc_parameters::RpcParameter>>,
    row_limit: usize,
    committing: bool,
) -> Result<String, E> {
    let batches = collab_database::sql_batches(&sql, selection)?;
    let (selected, _) = collab_database::selected_sql(&sql, selection)?;
    let (id, output) = start_stream(
        &live.query,
        binding,
        row_limit,
        (parameters.is_none() && !recovery).then_some(selected),
        recovery,
    )?;
    let monitor = live.clone();
    let task = tokio::spawn(async move {
        run(live, batches, output, parameters, committing).await;
    });
    tokio::spawn(async move {
        if task.await.is_err() {
            monitor.cancel.cancel();
            monitor.client.lock().await.take();
            let mut state = monitor.query.inner.lock();
            state.status.phase = "outcome_unknown".into();
            state.status.transaction = TransactionState::Unknown;
        }
    });
    Ok(id)
}
pub(super) fn start_stream(
    runtime: &Runtime,
    binding: SessionBinding,
    row_limit: usize,
    history_sql: Option<&str>,
    recovery: bool,
) -> Result<(String, Output), E> {
    let mut state = runtime.inner.lock();
    if matches!(
        state.status.phase.as_str(),
        "running" | "cancelling" | "finishing"
    ) {
        return Err(E::Busy);
    }
    if matches!(state.status.phase.as_str(), "outcome_unknown" | "retired")
        || (!recovery
            && matches!(
                state.status.transaction,
                TransactionState::Failed | TransactionState::Unknown
            ))
    {
        return Err(E::UnresolvedSession);
    }
    let id = Uuid::new_v4().to_string();
    let limits = Limits {
        result_rows: row_limit,
        ..Limits::default()
    };
    let window = Arc::new(Mutex::new(StreamWindow::new(
        binding.clone(),
        id.clone(),
        limits,
    )?));
    let (sender, receiver) = mpsc::channel(2);
    let mut handle = CancelHandle::new();
    handle.set_cancel_timeout_secs(3);
    let cancel = Arc::new(handle);
    let stop = tokio_util::sync::CancellationToken::new();
    state.status = Status {
        query_id: Some(id.clone()),
        phase: "running".into(),
        transaction: state.status.transaction,
        reason: None,
    };
    state.cancel = cancel.clone();
    state.stop = stop.clone();
    state.pull = Some(Arc::new(tokio::sync::Mutex::new(Pull {
        receiver,
        pending: None,
        last_ack: None,
        window: window.clone(),
    })));
    if let Some(selected) = history_sql {
        state.history.push_front(HistoryEntry {
            sql: selected.into(),
            executed_at: chrono::Utc::now().to_rfc3339(),
        });
    }
    while state.history.len() > limits.history_entries
        || state
            .history
            .iter()
            .map(|h| h.sql.len() + h.executed_at.len())
            .sum::<usize>()
            > limits.history_bytes
    {
        state.history.pop_back();
    }
    drop(state);
    let output = Output {
        sender,
        credits: Arc::new(Semaphore::new(2)),
        window,
        binding,
        id: id.clone(),
        sequence: 0,
        messages: 0,
        counts: 0,
        sets: 0,
        cancel,
        stop,
        limits,
    };
    Ok((id, output))
}

impl Runtime {
    pub(super) fn retire(&self, unknown: bool) {
        let mut state = self.inner.lock();
        state.status.phase = if unknown {
            "outcome_unknown"
        } else {
            "retired"
        }
        .into();
        state.status.transaction = if unknown {
            TransactionState::Unknown
        } else {
            TransactionState::None
        };
    }
}

async fn run(
    live: Arc<Live>,
    batches: Vec<SqlBatch>,
    mut output: Output,
    parameters: Option<Vec<mssql_tds::message::parameters::rpc_parameters::RpcParameter>>,
    committing: bool,
) {
    let mut guard = live.client.lock().await;
    let mut error = None;
    let mut reason = FinishReason::Complete;
    let mut result = if let Some(client) = guard.as_mut() {
        tokio::select! {biased;_ = live.cancel.cancelled()=>Err(failure(E::Cancelled,None,true)),result=tokio::time::timeout(Duration::from_secs(300),execute(client,&batches,&mut output,parameters))=>result.unwrap_or_else(|_|Err(failure(E::Timeout,None,true)))}
    } else {
        Err(failure(E::ConnectionFailed, None, true))
    };
    if guard
        .as_mut()
        .is_some_and(|client| client.take_info_messages_truncated())
    {
        result = Err(failure(E::LimitReached, None, false));
    }
    match result {
        Ok(r) => reason = r,
        Err(e) => {
            if e.code == E::Cancelled {
                reason = FinishReason::Cancelled;
            } else {
                error = Some(e);
            }
        }
    }
    let interrupted = reason != FinishReason::Complete || error.is_some();
    let mut transaction = TransactionState::Unknown;
    let mut reusable = false;
    if let Some(client) = guard.as_mut() {
        let drained = if interrupted {
            tokio::time::timeout(Duration::from_secs(3), client.cancel_query(3))
                .await
                .is_ok_and(|r| r.is_ok())
        } else {
            true
        };
        if drained && !live.cancel.is_cancelled() && !(committing && interrupted) {
            if let Ok(Ok(observed)) = tokio::time::timeout(
                Duration::from_secs(3),
                observe(client, &output.binding.database),
            )
            .await
            {
                transaction = observed;
                reusable = true;
            }
        }
    }
    if !reusable {
        guard.take();
        if error.is_none() {
            error = Some(failure(E::ConnectionFailed, None, true));
        }
    }
    drop(guard);
    if let Some(e) = error.as_mut() {
        if !reusable {
            e.outcome_unknown = true;
        }
    }
    if !finish_stream(
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
    }
}

pub(super) async fn finish_stream(
    runtime: &Runtime,
    cancel: &tokio_util::sync::CancellationToken,
    mut output: Output,
    transaction: TransactionState,
    reusable: bool,
    error: Option<ExecutionError>,
    reason: FinishReason,
) -> bool {
    // Publish completion before trying to enqueue it: a stalled renderer must never
    // hold a running server request open merely by withholding acknowledgements.
    {
        let mut state = runtime.inner.lock();
        state.status.phase = "finishing".into();
        state.status.transaction = transaction;
        state.status.reason = Some(reason);
    }
    if cancel.is_cancelled() {
        return false;
    }
    // Completion has an independent bounded wait even after user cancellation.
    output.cancel = Arc::new(CancelHandle::new());
    output.stop = tokio_util::sync::CancellationToken::new();
    let event = match error {
        Some(error) => ResultEvent::Failed { error },
        None => ResultEvent::Finished { reason },
    };
    let credit = output.credit().await;
    let delivered = {
        let mut state = runtime.inner.lock();
        let delivered = credit
            .and_then(|credit| output.emit_with(event, credit))
            .is_ok();
        state.status.phase = if !reusable && transaction == TransactionState::Unknown {
            "outcome_unknown"
        } else if delivered && reusable {
            "idle"
        } else {
            "retired"
        }
        .into();
        delivered
    };
    delivered
}
pub(super) fn failure(
    code: E,
    source: Option<SourceRange>,
    outcome_unknown: bool,
) -> ExecutionError {
    ExecutionError {
        code,
        source,
        server_code: None,
        outcome_unknown,
    }
}
fn sql_error(error: mssql_tds::error::Error, batch: &SqlBatch) -> ExecutionError {
    let mut result = failure(E::QueryFailed, Some(batch.source), false);
    if let mssql_tds::error::Error::SqlServerError { diagnostics } = &error {
        if let Some(first) = diagnostics.errors.first() {
            result.server_code = i32::try_from(first.number).ok();
            if let Some(line) = first.line_number {
                let start = batch
                    .sql
                    .split_inclusive('\n')
                    .take(line.max(1) as usize - 1)
                    .map(|l| l.encode_utf16().count() as u32)
                    .sum::<u32>();
                let count = batch
                    .sql
                    .split_inclusive('\n')
                    .nth(line.max(1) as usize - 1)
                    .unwrap_or("")
                    .encode_utf16()
                    .count() as u32;
                result.source = Some(SourceRange {
                    start_utf16: batch.source.start_utf16 + start,
                    end_utf16: (batch.source.start_utf16 + start + count)
                        .min(batch.source.end_utf16),
                });
            }
        }
    }
    result.code = classify(error);
    result.outcome_unknown = matches!(result.code, E::ConnectionFailed | E::Timeout);
    result
}
async fn execute(
    client: &mut TdsClient,
    batches: &[SqlBatch],
    out: &mut Output,
    mut parameters: Option<Vec<mssql_tds::message::parameters::rpc_parameters::RpcParameter>>,
) -> Result<FinishReason, ExecutionError> {
    let mut set = 0u32;
    for batch in batches {
        let options = ExecuteOptions::new().timeout_secs(120).cancel(&out.cancel);
        let mut result = if let Some(parameters) = parameters.take() {
            client
                .execute_sp_executesql(batch.sql.clone(), parameters, options)
                .await
        } else {
            client.execute(batch.sql.clone(), options).await
        }
        .map_err(|e| sql_error(e, batch))?;
        loop {
            match result {
                StatementResult::Rows => {
                    let metadata = client.get_metadata().clone();
                    if metadata.len() > out.limits.columns {
                        return Ok(FinishReason::CellLimit);
                    }
                    if metadata.iter().any(|c| {
                        matches!(
                            c.data_type,
                            mssql_tds::datatypes::sqldatatypes::TdsDataType::Text
                                | mssql_tds::datatypes::sqldatatypes::TdsDataType::NText
                                | mssql_tds::datatypes::sqldatatypes::TdsDataType::Image
                        )
                    }) {
                        return Ok(FinishReason::CellLimit);
                    }
                    let columns = metadata
                        .iter()
                        .enumerate()
                        .map(|(index, c)| collab_database::ColumnMetadata {
                            name: Identifier::new(if c.column_name.is_empty() {
                                format!("Column {}", index + 1)
                            } else {
                                c.column_name.clone()
                            })
                            .unwrap_or_else(|_| {
                                Identifier::new(format!("Column {}", index + 1)).unwrap()
                            }),
                            engine_type: format!("{:?}", c.data_type),
                            nullable: c.is_nullable(),
                            generated: c.is_computed() || c.is_identity(),
                            version_token: false,
                            precision: c.get_precision().map(u16::from),
                            scale: c.get_scale().map(i16::from),
                        })
                        .collect();
                    out.emit(ResultEvent::Columns {
                        result_set: set,
                        columns,
                    })
                    .await
                    .map_err(|e| failure(e, Some(batch.source), false))?;
                    loop {
                        // Reserve delivery capacity BEFORE reading another native row/large cell.
                        let credit = out
                            .credit()
                            .await
                            .map_err(|e| failure(e, Some(batch.source), false))?;
                        let mut rows = Vec::new();
                        let mut bytes = 1024usize;
                        let mut truncated = false;
                        while rows.len() < out.limits.batch_rows
                            && bytes < 128 << 10
                            && out.window.lock().total_rows() + rows.len() < out.limits.result_rows
                        {
                            if out.stop.is_cancelled() {
                                return Err(failure(E::Cancelled, Some(batch.source), false));
                            }
                            if !client
                                .next_row_cursor()
                                .await
                                .map_err(|e| sql_error(e, batch))?
                            {
                                break;
                            }
                            let mut row = Vec::new();
                            let mut row_bytes = 0;
                            for (index, column) in metadata.iter().enumerate() {
                                let (mut value, cut) = read_cell(client, index, column)
                                    .await
                                    .map_err(|e| failure(e, Some(batch.source), false))?;
                                truncated |= cut;
                                if collab_database::encoded_size(&value, out.limits.cell_bytes)
                                    .is_err()
                                {
                                    value = DbValue::Truncated {
                                        engine_type: format!("{:?}", column.data_type),
                                        preview: "Value exceeds the cell limit".into(),
                                        original_bytes: None,
                                    };
                                    truncated = true;
                                }
                                row_bytes +=
                                    collab_database::encoded_size(&value, out.limits.cell_bytes)
                                        .unwrap_or(out.limits.cell_bytes)
                                        + 1;
                                if row_bytes > 64 << 10 {
                                    return Ok(FinishReason::CellLimit);
                                }
                                row.push(value);
                                if truncated {
                                    for remaining in metadata.iter().skip(index + 1) {
                                        row.push(DbValue::Opaque {
                                            engine_type: format!("{:?}", remaining.data_type),
                                            display: "Not fetched after cell limit".into(),
                                        });
                                    }
                                    break;
                                }
                            }
                            bytes += row_bytes;
                            rows.push(row);
                            if truncated {
                                break;
                            }
                        }
                        if rows.is_empty() {
                            drop(credit);
                            break;
                        }
                        // A row is <=64 KiB, so the last row cannot overflow a 256 KiB frame.
                        match out.emit_with(
                            ResultEvent::Rows {
                                result_set: set,
                                rows,
                            },
                            credit,
                        ) {
                            Ok(()) => {}
                            Err(E::LimitReached) => return Ok(FinishReason::ByteLimit),
                            Err(e) => return Err(failure(e, Some(batch.source), false)),
                        }
                        if truncated {
                            return Ok(FinishReason::CellLimit);
                        }
                        if out.window.lock().total_rows() >= out.limits.result_rows {
                            return Ok(FinishReason::RowLimit);
                        }
                    }
                    set += 1;
                }
                StatementResult::NoRows {
                    rows_affected: Some(count),
                } => out
                    .emit(ResultEvent::AffectedRows {
                        result_set: set,
                        exact_count: count.to_string(),
                    })
                    .await
                    .map_err(|e| failure(e, Some(batch.source), false))?,
                StatementResult::End => break,
                _ => {}
            }
            out.messages(client)
                .await
                .map_err(|e| failure(e, Some(batch.source), false))?;
            result = client.advance().await.map_err(|e| sql_error(e, batch))?;
        }
        out.messages(client)
            .await
            .map_err(|e| failure(e, Some(batch.source), false))?;
        client
            .close_query()
            .await
            .map_err(|e| sql_error(e, batch))?;
    }
    Ok(FinishReason::Complete)
}
async fn observe(client: &mut TdsClient, database: &str) -> Result<TransactionState, E> {
    let mut result = client
        .execute(
            "SELECT CAST(DB_NAME() AS nvarchar(128)), CAST(XACT_STATE() AS int), CAST(@@TRANCOUNT AS int)".into(),
            ExecuteOptions::new().timeout_secs(2),
        )
        .await
        .map_err(classify)?;
    let mut observed = None;
    loop {
        match result {
            StatementResult::Rows => {
                while let Some(row) = client.next_row().await.map_err(classify)? {
                    use mssql_tds::datatypes::column_values::ColumnValues as C;
                    if let [C::String(name), C::Int(state), C::Int(count)] = row.as_slice() {
                        if name.to_string() != database {
                            return Err(E::WrongBinding);
                        }
                        // XACT_STATE can see the probe's own autocommit read
                        // transaction while @@TRANCOUNT is zero. Only a retained
                        // user transaction must block session disposal.
                        observed = Some(if *count == 0 {
                            TransactionState::None
                        } else {
                            match state {
                                1 => TransactionState::Open,
                                -1 => TransactionState::Failed,
                                _ => TransactionState::Unknown,
                            }
                        });
                    }
                }
            }
            StatementResult::End => break,
            _ => {}
        }
        result = client.advance().await.map_err(classify)?;
    }
    client.close_query().await.map_err(classify)?;
    observed.ok_or(E::ConnectionFailed)
}
fn truncate(text: &mut String, limit: usize) {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
}
pub(super) async fn read_cell(
    client: &mut TdsClient,
    index: usize,
    column: &mssql_tds::query::metadata::ColumnMetadata,
) -> Result<(DbValue, bool), E> {
    match client.read_row_column(index).await.map_err(classify)? {
        CursorColumn::Value {
            value: column_value,
            ..
        } => Ok((value(column_value)?, false)),
        CursorColumn::PlpStreaming { collation } => {
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let mut total = None;
            let mut ended = false;
            while bytes.len() < 16 << 10 {
                let chunk = client
                    .read_active_plp_chunk(&mut buffer)
                    .await
                    .map_err(classify)?;
                bytes.extend_from_slice(&buffer[..chunk.read]);
                total = chunk.known_total;
                if chunk.reached_end {
                    ended = true;
                    break;
                }
            }
            let encoding = column.plp_encoding();
            let text = match encoding {
                Some(PlpEncoding::Utf16Text) => String::from_utf16_lossy(
                    &bytes
                        .chunks_exact(2)
                        .map(|b| u16::from_le_bytes([b[0], b[1]]))
                        .collect::<Vec<_>>(),
                ),
                Some(PlpEncoding::Utf8Text) => String::from_utf8_lossy(&bytes).into_owned(),
                Some(PlpEncoding::SingleByteText) => {
                    use mssql_tds::datatypes::sql_string::{EncodingType, SqlString};
                    if let Some(collation) = collation {
                        SqlString::new(bytes.clone(), EncodingType::LcidBased(collation))
                            .to_string()
                    } else {
                        String::from_utf8_lossy(&bytes).into_owned()
                    }
                }
                _ => {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                }
            };
            if !ended {
                let mut preview = text;
                truncate(&mut preview, 4096);
                return Ok((
                    DbValue::Truncated {
                        engine_type: format!("{:?}", column.data_type),
                        preview,
                        original_bytes: total,
                    },
                    true,
                ));
            }
            if matches!(encoding, Some(PlpEncoding::Binary) | None) {
                Ok((DbValue::Binary { base64: text }, false))
            } else {
                Ok((DbValue::Text { value: text }, false))
            }
        }
        _ => Err(E::DataConversion),
    }
}
fn date(year: i32, days: i64) -> Result<chrono::NaiveDate, E> {
    chrono::NaiveDate::from_ymd_opt(year, 1, 1)
        .and_then(|d| d.checked_add_signed(chrono::Duration::days(days)))
        .ok_or(E::DataConversion)
}
fn time(ticks: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:07}",
        ticks / 10_000_000 / 3600,
        ticks / 10_000_000 / 60 % 60,
        ticks / 10_000_000 % 60,
        ticks % 10_000_000
    )
}
fn decimal_money(raw: i64, precision: u16) -> DbValue {
    let abs = raw.unsigned_abs();
    DbValue::Decimal {
        decimal: format!(
            "{}{}.{:04}",
            if raw < 0 { "-" } else { "" },
            abs / 10000,
            abs % 10000
        ),
        precision,
        scale: 4,
    }
}
fn value(column: mssql_tds::datatypes::column_values::ColumnValues) -> Result<DbValue, E> {
    use mssql_tds::datatypes::column_values::ColumnValues as C;
    Ok(match column {
        C::Null => DbValue::Null,
        C::Bit(value) => DbValue::Boolean { value },
        C::TinyInt(v) => DbValue::Integer {
            decimal: v.to_string(),
        },
        C::SmallInt(v) => DbValue::Integer {
            decimal: v.to_string(),
        },
        C::Int(v) => DbValue::Integer {
            decimal: v.to_string(),
        },
        C::BigInt(v) => DbValue::Integer {
            decimal: v.to_string(),
        },
        C::Decimal(v) | C::Numeric(v) => DbValue::Decimal {
            decimal: v.to_string(),
            precision: u16::from(v.precision),
            scale: u16::from(v.scale),
        },
        C::Real(v) => DbValue::Float {
            round_trip_decimal: v.to_string(),
            bits: 32,
        },
        C::Float(v) => DbValue::Float {
            round_trip_decimal: v.to_string(),
            bits: 64,
        },
        C::String(v) => DbValue::Text {
            value: v.to_string(),
        },
        C::Bytes(v) => {
            use base64::Engine;
            DbValue::Binary {
                base64: base64::engine::general_purpose::STANDARD.encode(v),
            }
        }
        C::Uuid(v) => DbValue::Uuid {
            value: v.to_string(),
        },
        C::Date(v) => DbValue::Date {
            iso8601: date(1, i64::from(v.get_days()))?.to_string(),
        },
        C::Time(v) => DbValue::Time {
            iso8601: time(v.time_nanoseconds),
            fractional_digits: v.scale,
        },
        C::DateTime2(v) => DbValue::DateTime {
            iso8601: format!(
                "{}T{}",
                date(1, i64::from(v.days))?,
                time(v.time.time_nanoseconds)
            ),
            fractional_digits: v.time.scale,
            offset_minutes: None,
        },
        C::DateTimeOffset(v) => {
            let date = date(1, i64::from(v.datetime2.days))?;
            let ticks = v.datetime2.time.time_nanoseconds;
            let seconds = (ticks / 10_000_000) as i64;
            let local = date.and_hms_nano_opt(0, 0, 0, 0).ok_or(E::DataConversion)?
                + chrono::Duration::seconds(seconds)
                + chrono::Duration::nanoseconds(((ticks % 10_000_000) * 100) as i64)
                + chrono::Duration::minutes(i64::from(v.offset));
            DbValue::DateTime {
                iso8601: format!(
                    "{}{}{:02}:{:02}",
                    format!(
                        "{}.{:07}",
                        local.format("%Y-%m-%dT%H:%M:%S"),
                        local.and_utc().timestamp_subsec_nanos() / 100
                    ),
                    if v.offset < 0 { "-" } else { "+" },
                    v.offset.unsigned_abs() / 60,
                    v.offset.unsigned_abs() % 60
                ),
                fractional_digits: v.datetime2.time.scale,
                offset_minutes: Some(v.offset),
            }
        }
        C::SmallDateTime(v) => DbValue::DateTime {
            iso8601: format!(
                "{}T{:02}:{:02}:00",
                date(1900, i64::from(v.days))?,
                v.time / 60,
                v.time % 60
            ),
            fractional_digits: 0,
            offset_minutes: None,
        },
        C::DateTime(v) => {
            let d = date(1900, i64::from(v.days))?;
            let millis = (u64::from(v.time) * 1000 + 150) / 300;
            DbValue::DateTime {
                iso8601: format!(
                    "{}T{:02}:{:02}:{:02}.{:03}",
                    d,
                    millis / 3600000,
                    millis / 60000 % 60,
                    millis / 1000 % 60,
                    millis % 1000
                ),
                fractional_digits: 3,
                offset_minutes: None,
            }
        }
        C::SmallMoney(v) => decimal_money(i64::from(v.int_val), 10),
        C::Money(v) => decimal_money(
            (i64::from(v.msb_part) << 32) | (i64::from(v.lsb_part) & 0xffff_ffff),
            19,
        ),
        other => DbValue::Opaque {
            engine_type: match other {
                C::Date(_) => "date",
                C::Xml(_) => "xml",
                C::Json(_) => "json",
                C::Vector(_) => "vector",
                _ => "unsupported",
            }
            .into(),
            display: "Unsupported value; read-only".into(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_types_do_not_round_trip_through_float_or_drop_offset() {
        use mssql_tds::datatypes::column_values::{
            ColumnValues as C, SqlDateTime2, SqlDateTimeOffset, SqlTime,
        };
        assert!(
            matches!(value(C::BigInt(i64::MAX)).unwrap(),DbValue::Integer{decimal} if decimal=="9223372036854775807")
        );
        assert!(
            matches!(decimal_money(i64::MIN,19),DbValue::Decimal{decimal,..} if decimal=="-922337203685477.5808")
        );
        let days = chrono::NaiveDate::from_ymd_opt(2026, 11, 10)
            .unwrap()
            .signed_duration_since(chrono::NaiveDate::from_ymd_opt(1, 1, 1).unwrap())
            .num_days() as u32;
        let result = value(C::DateTimeOffset(SqlDateTimeOffset {
            offset: 330,
            datetime2: SqlDateTime2 {
                days,
                time: SqlTime {
                    time_nanoseconds: (7 * 3600 + 4 * 60 + 56) * 10_000_000 + 1234567,
                    scale: 7,
                },
            },
        }))
        .unwrap();
        assert!(
            matches!(result,DbValue::DateTime{iso8601,..} if iso8601=="2026-11-10T12:34:56.1234567+05:30")
        );
    }
    #[tokio::test]
    async fn pull_replays_without_credit_and_rejects_forged_or_out_of_order_ack() {
        let binding = SessionBinding {
            profile_id: "p".into(),
            connection_id: "c".into(),
            session_id: "s".into(),
            tab_id: "t".into(),
            database: "db".into(),
            generation: 1,
        };
        let runtime = Runtime::default();
        let limits = Limits::default();
        let window = Arc::new(Mutex::new(
            StreamWindow::new(binding.clone(), "q".into(), limits).unwrap(),
        ));
        let (sender, receiver) = mpsc::channel(2);
        {
            let mut state = runtime.inner.lock();
            state.status.query_id = Some("q".into());
            state.pull = Some(Arc::new(tokio::sync::Mutex::new(Pull {
                receiver,
                pending: None,
                last_ack: None,
                window: window.clone(),
            })));
        }
        let credits = Arc::new(Semaphore::new(2));
        let mut out = Output {
            sender,
            credits: credits.clone(),
            window: window.clone(),
            binding,
            id: "q".into(),
            sequence: 0,
            messages: 0,
            counts: 0,
            sets: 0,
            cancel: Arc::new(CancelHandle::new()),
            stop: tokio_util::sync::CancellationToken::new(),
            limits,
        };
        out.emit(ResultEvent::Message {
            severity: 0,
            safe_text: "fixture".into(),
        })
        .await
        .unwrap();
        out.emit(ResultEvent::Finished {
            reason: FinishReason::Complete,
        })
        .await
        .unwrap();
        assert_eq!(credits.available_permits(), 0);
        assert_eq!(
            runtime
                .poll("q", None)
                .await
                .unwrap()
                .frame
                .unwrap()
                .sequence,
            0
        );
        assert_eq!(
            runtime
                .poll("q", None)
                .await
                .unwrap()
                .frame
                .unwrap()
                .sequence,
            0
        );
        assert_eq!(credits.available_permits(), 0);
        assert!(matches!(
            runtime.poll("other", Some(0)).await,
            Err(E::StaleQuery)
        ));
        assert!(matches!(
            runtime.poll("q", Some(1)).await,
            Err(E::InvalidSequence)
        ));
        assert_eq!(
            runtime
                .poll("q", Some(0))
                .await
                .unwrap()
                .frame
                .unwrap()
                .sequence,
            1
        );
        assert_eq!(credits.available_permits(), 1);
        runtime.poll("q", Some(1)).await.unwrap();
        assert_eq!(credits.available_permits(), 2);
        assert_eq!(window.lock().retained_bytes(), 0);
    }
}
