use crate::{Collector, Fixture, Report, CANCEL, LOAD, TRANSACTION, TYPES};
use anyhow::{ensure, Context, Result};
use collab_database::DbValue;
use mssql_tds::{
    connection::{
        client_context::ClientContext,
        tds_client::{CursorColumn, ExecuteOptions, ResultSet, StatementResult, TdsClient},
    },
    connection_provider::tds_connection_provider::TdsConnectionProvider,
    core::{CancelHandle, EncryptionSetting},
    datatypes::column_values::ColumnValues,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

async fn connect(f: &Fixture) -> Result<TdsClient> {
    let mut context = ClientContext::default();
    context.user_name = "sa".into();
    context.password = f.password.clone();
    context.database = "collab_phase0".into();
    context.application_name = "CollabPhase0DisposableFixture".into();
    context.connect_retry_count = 0;
    context.connect_timeout = 10;
    context.encryption_options.mode = EncryptionSetting::Required;
    context.encryption_options.trust_server_certificate = false;
    context.encryption_options.host_name_in_cert = Some(f.hostname().into());
    tokio::time::timeout(
        Duration::from_secs(12),
        TdsConnectionProvider::new().create_client(
            context,
            &format!("tcp:localhost,{}", f.port),
            None,
        ),
    )
    .await
    .context("Microsoft TLS/login timeout")?
    .context("Microsoft TLS/login")
}

struct Results {
    sets: Vec<Vec<Vec<ColumnValues>>>,
    messages: usize,
    counts: Vec<u64>,
}
async fn rows(client: &mut TdsClient, sql: &str) -> Result<Results> {
    let mut result = client
        .execute(sql.into(), ExecuteOptions::new().timeout_secs(10))
        .await
        .context("Microsoft fixture execution")?;
    let mut output = Results {
        sets: vec![],
        messages: 0,
        counts: vec![],
    };
    loop {
        ensure!(output.sets.len() < 32, "fixture result-set bound");
        match result {
            StatementResult::Rows => {
                let mut set = vec![];
                while let Some(row) = client.next_row().await.context("Microsoft fixture row")? {
                    ensure!(set.len() < 128 && row.len() <= 256, "fixture row bound");
                    set.push(row);
                }
                output.sets.push(set);
            }
            StatementResult::NoRows {
                rows_affected: Some(count),
            } => output.counts.push(count),
            StatementResult::NoRows { .. } => {}
            StatementResult::End => break,
        }
        output.messages += client.take_info_messages().len();
        result = client
            .advance()
            .await
            .context("Microsoft fixture next result")?;
    }
    output.messages += client.take_info_messages().len();
    client
        .close_query()
        .await
        .context("Microsoft fixture cleanup")?;
    Ok(output)
}
fn integer(value: &ColumnValues) -> Result<i64> {
    match value {
        ColumnValues::TinyInt(n) => Ok(i64::from(*n)),
        ColumnValues::SmallInt(n) => Ok(i64::from(*n)),
        ColumnValues::Int(n) => Ok(i64::from(*n)),
        ColumnValues::BigInt(n) => Ok(*n),
        _ => anyhow::bail!("Microsoft integer fixture type"),
    }
}
async fn scalar(client: &mut TdsClient, sql: &str) -> Result<i64> {
    integer(&rows(client, sql).await?.sets[0][0][0])
}
async fn no_work(observer: &mut TdsClient, spid: i64) -> Result<()> {
    for _ in 0..30 {
        if scalar(
            observer,
            &format!("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id={spid}"),
        )
        .await?
            == 0
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Microsoft server work still running after cancellation")
}

pub async fn run(f: &Fixture) -> Result<Report> {
    let started = Instant::now();
    let connection = connect(f).await;
    let mut report = Report {
        driver: "mssql-tds".into(),
        driver_version: "0.4.0".into(),
        ..Default::default()
    };
    if f.negative() {
        ensure!(
            connection.is_err(),
            "Microsoft accepted invalid TLS trust/hostname"
        );
        report.negative_tls_rejected = true;
        return Ok(report);
    }
    let mut client = connection?;
    report.verified_tls = true;
    let mut times = vec![started.elapsed().as_millis()];
    let burst = futures_util::future::try_join_all((0..7).map(|_| async {
        let started = Instant::now();
        let connection = connect(f).await?;
        Ok::<_, anyhow::Error>((connection, started.elapsed().as_millis()))
    }))
    .await?;
    times.extend(burst.iter().map(|(_, time)| *time));
    times.sort_unstable();
    report.connection_burst = times.len();
    report.connect_p95_ms = *times.last().unwrap();
    drop(burst);
    if let ColumnValues::String(value) = &rows(
        &mut client,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))",
    )
    .await?
    .sets[0][0][0]
    {
        report.server_version = value.to_string();
    }
    let data = rows(&mut client, TYPES).await?;
    let row = &data.sets[0][0];
    ensure!(integer(&row[0])? == i64::MAX, "Microsoft bigint precision");
    match &row[1] {
        ColumnValues::Decimal(value) | ColumnValues::Numeric(value) => ensure!(
            value.to_string() == "123456789012345678901234567890.12345678" && value.scale == 8,
            "Microsoft decimal precision"
        ),
        _ => anyhow::bail!("Microsoft decimal fixture type"),
    }
    ensure!(row[2] == ColumnValues::Null, "Microsoft SQL NULL");
    ensure!(
        matches!(&row[3], ColumnValues::String(s) if s.to_string().is_empty()),
        "Microsoft empty string"
    );
    ensure!(
        matches!(&row[4], ColumnValues::String(s) if s.to_string() == "Grüße 世界 👋"),
        "Microsoft Unicode"
    );
    ensure!(
        row[5] == ColumnValues::Bytes(vec![0, 1, 255]),
        "Microsoft binary"
    );
    // Despite its public field name, 0.4.0's decoder normalizes this to 100ns
    // ticks (scale_time_value), not nanoseconds. Never treat it as JS Number.
    let days = chrono::NaiveDate::from_ymd_opt(2026, 11, 10)
        .unwrap()
        .signed_duration_since(chrono::NaiveDate::from_ymd_opt(1, 1, 1).unwrap())
        .num_days() as u32;
    let local_ticks = (12 * 3600 + 34 * 60 + 56) * 10_000_000u64 + 1_234_567;
    let utc_ticks = (7 * 3600 + 4 * 60 + 56) * 10_000_000u64 + 1_234_567;
    ensure!(
        matches!(&row[6], ColumnValues::DateTime2(t) if t.days == days && t.time.scale == 7 && t.time.time_nanoseconds == local_ticks),
        "Microsoft datetime2 precision"
    );
    ensure!(
        matches!(&row[7], ColumnValues::DateTimeOffset(t) if t.offset == 330 && t.datetime2.days == days && t.datetime2.time.time_nanoseconds == utc_ticks),
        "Microsoft datetimeoffset precision"
    );
    report.exact_types = true;
    let multi = rows(&mut client, "SELECT 1; PRINT N'phase0-message'; SELECT 2;").await?;
    report.result_sets = multi.sets.len();
    report.messages = multi.messages;
    ensure!(
        report.result_sets == 2 && report.messages >= 1,
        "Microsoft multiple results/messages"
    );
    let tx = rows(&mut client, TRANSACTION).await?;
    ensure!(
        integer(&tx.sets[0][0][0])? == 1 && integer(&tx.sets[1][0][0])? == 2,
        "Microsoft transaction rollback/commit"
    );
    report.transactions = true;
    report.affected_counts = rows(&mut client, "UPDATE #phase0 SET id=id")
        .await?
        .counts
        .contains(&2);
    ensure!(report.affected_counts, "Microsoft affected-row counts");
    let mut observer = connect(f).await?;
    rows(
        &mut observer,
        "CREATE TABLE #phase0 (id int); INSERT #phase0 VALUES (9);",
    )
    .await?;
    ensure!(
        scalar(&mut client, "SELECT COUNT(*) FROM #phase0").await? == 2
            && scalar(&mut observer, "SELECT COUNT(*) FROM #phase0").await? == 1,
        "Microsoft pinned session isolation"
    );
    report.independent_sessions = true;
    ensure!(
        rows(&mut client, "SELECT missing_phase0_column")
            .await
            .is_err(),
        "Microsoft expected server error"
    );
    report.errors_recover = scalar(&mut client, "SELECT 1").await? == 1;
    rows(&mut observer,"IF OBJECT_ID('dbo.phase0_cancel') IS NOT NULL DROP TABLE dbo.phase0_cancel; CREATE TABLE dbo.phase0_cancel (id int);").await?;
    let spid = scalar(&mut client, "SELECT @@SPID").await?;
    let mut handle = CancelHandle::new();
    handle.set_cancel_timeout_secs(3);
    let handle = Arc::new(handle);
    let trigger = handle.clone();
    let cancel_started = Instant::now();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        trigger.cancel();
    });
    let cancelled = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(CANCEL.into(), ExecuteOptions::new().cancel(&handle)),
    )
    .await
    .context("Microsoft cancellation settlement exceeded budget")?;
    ensure!(cancelled.is_err(), "Microsoft expected cancellation result");
    no_work(&mut observer, spid).await?;
    ensure!(
        scalar(&mut observer, "SELECT COUNT(*) FROM dbo.phase0_cancel").await? == 0,
        "Microsoft cancelled write ran"
    );
    report.cancel_ms = cancel_started.elapsed().as_millis();
    report.server_work_stopped = true;
    report.session_reused_after_cancel =
        scalar(&mut client, "SELECT COUNT(*) FROM #phase0").await? == 2;
    ensure!(
        report.session_reused_after_cancel,
        "Microsoft cancellation lost temp/session state"
    );
    // Prove a long PLP value can be stopped before materializing it into a row.
    client
        .execute(
            "SELECT REPLICATE(CAST(N'x' AS nvarchar(max)),1048576)".into(),
            (),
        )
        .await
        .context("Microsoft LOB fixture")?;
    ensure!(
        client
            .next_row_cursor()
            .await
            .context("Microsoft LOB cursor")?,
        "Microsoft LOB row missing"
    );
    ensure!(
        matches!(
            client
                .read_row_column(0)
                .await
                .context("Microsoft LOB header")?,
            CursorColumn::PlpStreaming { .. }
        ),
        "Microsoft LOB did not expose streaming"
    );
    let mut buffer = [0u8; 8192];
    let mut bytes = 0;
    while bytes < 64 << 10 {
        let chunk = client
            .read_active_plp_chunk(&mut buffer)
            .await
            .context("Microsoft LOB chunk")?;
        bytes += chunk.read;
        if chunk.reached_end {
            break;
        }
    }
    ensure!(bytes <= 64 << 10, "Microsoft LOB bound");
    tokio::time::timeout(Duration::from_secs(3), client.cancel_query(3))
        .await
        .context("Microsoft LOB cancellation timeout")?
        .context("Microsoft LOB cancellation")?;
    report.lob_streaming = true;
    report.lob_prefix_bytes = bytes;
    let spid = scalar(&mut client, "SELECT @@SPID").await?;
    rows(&mut observer, &format!("KILL {spid}")).await?;
    report.dropped_connection_detected = scalar(&mut client, "SELECT 1").await.is_err();
    drop(client);
    ensure!(
        report.dropped_connection_detected,
        "Microsoft unexpectedly recovered a killed session"
    );
    let mut client = connect(f).await?;
    report.reconnect_is_new_session = scalar(
        &mut client,
        "SELECT CASE WHEN OBJECT_ID('tempdb..#phase0') IS NULL THEN 1 ELSE 0 END",
    )
    .await?
        == 1;
    let mut collector = Collector::new(report);
    let mut result = client
        .execute(LOAD.into(), ())
        .await
        .context("Microsoft bounded stream")?;
    'results: loop {
        if result == StatementResult::Rows {
            loop {
                collector.wait_for_credit().await?;
                let Some(row) = client.next_row().await.context("Microsoft load row")? else {
                    break;
                };
                let number = integer(&row[0])?;
                let text = match &row[1] {
                    ColumnValues::String(value) => value.to_string(),
                    _ => anyhow::bail!("Microsoft load text"),
                };
                if !collector.row(vec![
                    DbValue::Integer {
                        decimal: number.to_string(),
                    },
                    DbValue::Text { value: text },
                ])? {
                    break 'results;
                }
            }
        }
        result = client
            .advance()
            .await
            .context("Microsoft load next result")?;
        if result == StatementResult::End {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(3), client.cancel_query(3))
        .await
        .context("Microsoft load cancellation timeout")?
        .context("Microsoft load cancellation")?;
    let report = collector.finish();
    ensure!(
        report.streamed_rows > 1000 && report.max_queued_bytes <= 512 << 10,
        "Microsoft bounded stream budget"
    );
    ensure!(
        report.reconnect_is_new_session && report.result_limit_reached,
        "Microsoft recovery/truncation fixture"
    );
    Ok(report)
}
