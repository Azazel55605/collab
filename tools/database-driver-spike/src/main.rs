//! Disposable-fixture executable. Never accepts a general connection URL or SQL file.
mod microsoft;
mod tiberius_driver;

use anyhow::{ensure, Context, Result};
use collab_database::{DbValue, Limits, ResultEvent, ResultFrame, SessionBinding, StreamWindow};
use serde::Serialize;
use std::{
    env,
    path::PathBuf,
    time::{Duration, Instant},
};

pub const TYPES: &str = "SELECT CAST(9223372036854775807 AS bigint), CAST(123456789012345678901234567890.12345678 AS decimal(38,8)), CAST(NULL AS nvarchar(10)), CAST(N'' AS nvarchar(10)), N'Grüße 世界 👋', CAST(0x0001FF AS varbinary(3)), CAST('2026-11-10T12:34:56.1234567' AS datetime2(7)), CAST('2026-11-10T12:34:56.1234567+05:30' AS datetimeoffset(7));";
pub const LOAD: &str = "SELECT TOP (100000) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS bigint), REPLICATE(N'x',512) FROM sys.all_objects a CROSS JOIN sys.all_objects b;";
pub const TRANSACTION: &str = "CREATE TABLE #phase0 (id int PRIMARY KEY); INSERT #phase0 VALUES (1); BEGIN TRANSACTION; INSERT #phase0 VALUES (2); ROLLBACK; SELECT COUNT(*) FROM #phase0; BEGIN TRANSACTION; INSERT #phase0 VALUES (3); COMMIT; SELECT COUNT(*) FROM #phase0;";
pub const CANCEL: &str = "WAITFOR DELAY '00:00:30'; INSERT dbo.phase0_cancel VALUES (1);";

pub struct Fixture {
    pub port: u16,
    pub password: String,
    pub ca: PathBuf,
    pub tls_mode: String,
}
impl Fixture {
    fn load() -> Result<Self> {
        ensure!(
            env::var("COLLAB_DATABASE_DISPOSABLE_FIXTURE").as_deref() == Ok("yes"),
            "disposable fixture acknowledgement required"
        );
        let password = std::fs::read_to_string(env::var("COLLAB_DB_SPIKE_PASSWORD_FILE")?)?;
        Ok(Self {
            port: env::var("COLLAB_DB_SPIKE_PORT")?.parse()?,
            password: password.trim().into(),
            ca: env::var("COLLAB_DB_SPIKE_CA")?.into(),
            tls_mode: env::var("COLLAB_DB_SPIKE_TLS_MODE").unwrap_or_else(|_| "verified".into()),
        })
    }
    pub fn hostname(&self) -> &str {
        if self.tls_mode == "wrong_hostname" {
            "wrong-name.invalid"
        } else {
            "localhost"
        }
    }
    pub fn negative(&self) -> bool {
        self.tls_mode != "verified"
    }
}

#[derive(Default, Serialize)]
pub struct Report {
    driver: String,
    driver_version: String,
    server_version: String,
    verified_tls: bool,
    connection_burst: usize,
    connect_p95_ms: u128,
    negative_tls_rejected: bool,
    exact_types: bool,
    result_sets: usize,
    messages: usize,
    affected_counts: bool,
    transactions: bool,
    independent_sessions: bool,
    cancel_ms: u128,
    server_work_stopped: bool,
    connection_retired_after_cancel: bool,
    session_reused_after_cancel: bool,
    errors_recover: bool,
    dropped_connection_detected: bool,
    reconnect_is_new_session: bool,
    streamed_rows: usize,
    max_queued_bytes: usize,
    stream_ms: u128,
    resident_kib: Option<usize>,
    lob_streaming: bool,
    lob_prefix_bytes: usize,
    result_limit_reached: bool,
    peak_resident_kib: Option<usize>,
}

pub fn scalar_integer(row: &[DbValue]) -> Result<i64> {
    match row.first() {
        Some(DbValue::Integer { decimal }) => Ok(decimal.parse()?),
        _ => anyhow::bail!("integer fixture type mismatch"),
    }
}

pub struct Collector {
    pub report: Report,
    limits: Limits,
    window: StreamWindow,
    pending: std::collections::VecDeque<ResultFrame>,
    building: Vec<Vec<DbValue>>,
    building_bytes: usize,
    sequence: u64,
    start: Instant,
}
impl Collector {
    pub fn new(report: Report) -> Self {
        let binding = Self::binding();
        let limits = Limits::default();
        Self {
            report,
            window: StreamWindow::new(binding, "fixture-load".into(), limits).unwrap(),
            limits,
            pending: Default::default(),
            building: vec![],
            building_bytes: 0,
            sequence: 0,
            start: Instant::now(),
        }
    }
    fn binding() -> SessionBinding {
        SessionBinding {
            profile_id: "fixture".into(),
            connection_id: "fixture".into(),
            session_id: "fixture".into(),
            tab_id: "fixture".into(),
            database: "collab_phase0".into(),
            generation: 1,
        }
    }
    /// Called before another driver poll, not after creating an unbounded queue.
    pub async fn wait_for_credit(&mut self) -> Result<()> {
        if !self.window.has_credit() {
            self.report.max_queued_bytes = self
                .report
                .max_queued_bytes
                .max(self.window.retained_bytes());
            tokio::time::sleep(Duration::from_millis(20)).await;
            let batch = self
                .pending
                .pop_front()
                .context("credit fixture missing batch")?;
            self.window
                .acknowledge(&batch.binding, &batch.query_id, batch.sequence)?;
        }
        Ok(())
    }
    pub fn row(&mut self, row: Vec<DbValue>) -> Result<bool> {
        for value in &row {
            collab_database::encoded_size(value, self.limits.cell_bytes)?;
        }
        let row_bytes = collab_database::encoded_size(&row, self.limits.batch_bytes)?;
        // Reserve the complete envelope; do not first build an oversized array
        // and only discover its size during IPC serialization.
        if self.building_bytes + row_bytes + 1024 > self.limits.batch_bytes
            && !self.building.is_empty()
            && !self.flush()?
        {
            return Ok(false);
        }
        self.building_bytes += row_bytes + 1;
        self.building.push(row);
        if self.building.len() < self.limits.batch_rows {
            return Ok(true);
        }
        self.flush()
    }
    fn flush(&mut self) -> Result<bool> {
        let batch = ResultFrame {
            binding: Self::binding(),
            query_id: "fixture-load".into(),
            sequence: self.sequence,
            event: ResultEvent::Rows {
                result_set: 0,
                rows: std::mem::take(&mut self.building),
            },
        };
        self.building_bytes = 0;
        match self.window.admit(&batch) {
            Ok(_) => {
                self.sequence += 1;
                self.pending.push_back(batch);
                self.report.max_queued_bytes = self
                    .report
                    .max_queued_bytes
                    .max(self.window.retained_bytes());
                Ok(true)
            }
            Err(collab_database::ContractError::LimitReached) => {
                self.report.result_limit_reached = true;
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }
    pub fn finish(mut self) -> Report {
        self.report.streamed_rows = self.window.total_rows();
        self.report.stream_ms = self.start.elapsed().as_millis();
        self.report.resident_kib =
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|line| line.starts_with("VmRSS:"))
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|s| s.parse().ok())
                });
        self.report.peak_resident_kib =
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|line| line.starts_with("VmHWM:"))
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|s| s.parse().ok())
                });
        self.report
    }
}

#[tokio::main]
async fn main() {
    let result = async {
        let fixture = Fixture::load()?;
        match env::args().nth(1).as_deref() {
            Some("tiberius") => tiberius_driver::run(&fixture).await,
            Some("microsoft") => microsoft::run(&fixture).await,
            _ => anyhow::bail!("choose a comparison driver"),
        }
    }
    .await;
    match result {
        Ok(report) => println!("{}", serde_json::to_string(&report).unwrap()),
        // Never log underlying connection strings, SQL text, values or driver diagnostics.
        Err(error) => {
            eprintln!(
                "database spike failed: {}",
                error
                    .chain()
                    .next()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "fixture error".into())
            );
            std::process::exit(1);
        }
    }
}
