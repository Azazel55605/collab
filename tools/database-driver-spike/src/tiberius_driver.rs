use crate::{Collector, Fixture, Report, CANCEL, LOAD, TRANSACTION, TYPES};
use anyhow::{ensure, Context, Result};
use collab_database::DbValue;
use futures_util::TryStreamExt;
use std::time::{Duration, Instant};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type Connection = Client<Compat<TcpStream>>;
async fn connect(f: &Fixture) -> Result<Connection> {
    let mut config = Config::new();
    config.host(f.hostname());
    config.port(f.port);
    config.database("collab_phase0");
    config.authentication(AuthMethod::sql_server("sa", &f.password));
    config.encryption(EncryptionLevel::Required);
    config.trust_cert_ca(f.ca.to_string_lossy());
    let tcp = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(("127.0.0.1", f.port)),
    )
    .await
    .context("Tiberius TCP timeout")?
    .context("Tiberius TCP connection")?;
    tcp.set_nodelay(true)?;
    tokio::time::timeout(
        Duration::from_secs(10),
        Client::connect(config, tcp.compat_write()),
    )
    .await
    .context("Tiberius TLS/login timeout")?
    .context("Tiberius TLS/login")
}
async fn rows(client: &mut Connection, sql: &str) -> Result<Vec<Vec<tiberius::Row>>> {
    client
        .simple_query(sql)
        .await
        .context("Tiberius fixture execution")?
        .into_results()
        .await
        .context("Tiberius fixture rows")
}
async fn scalar(client: &mut Connection, sql: &str) -> Result<i32> {
    Ok(rows(client, sql).await?[0][0]
        .get::<i32, _>(0)
        .context("Tiberius fixture scalar")?)
}
async fn no_work(observer: &mut Connection, spid: i32) -> Result<()> {
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
    anyhow::bail!("Tiberius server work still running after cancellation")
}

pub async fn run(f: &Fixture) -> Result<Report> {
    let started = Instant::now();
    let connection = connect(f).await;
    let mut report = Report {
        driver: "tiberius".into(),
        driver_version: "0.13.0".into(),
        ..Default::default()
    };
    if f.negative() {
        ensure!(
            connection.is_err(),
            "Tiberius accepted invalid TLS trust/hostname"
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
    report.server_version = rows(
        &mut client,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))",
    )
    .await?[0][0]
        .get::<&str, _>(0)
        .unwrap_or("")
        .into();
    let data = rows(&mut client, TYPES).await?;
    let row = &data[0][0];
    ensure!(
        row.get::<i64, _>(0) == Some(i64::MAX),
        "Tiberius bigint precision"
    );
    let decimal = row
        .get::<tiberius::numeric::Numeric, _>(1)
        .context("Tiberius decimal type")?;
    ensure!(
        decimal.to_string() == "123456789012345678901234567890.12345678",
        "Tiberius decimal precision"
    );
    ensure!(
        row.get::<&str, _>(2).is_none() && row.get::<&str, _>(3) == Some(""),
        "Tiberius null/empty distinction"
    );
    ensure!(
        row.get::<&str, _>(4) == Some("Grüße 世界 👋"),
        "Tiberius Unicode"
    );
    ensure!(
        row.get::<&[u8], _>(5) == Some(&[0, 1, 255]),
        "Tiberius binary"
    );
    ensure!(
        row.get::<chrono::NaiveDateTime, _>(6)
            .context("Tiberius datetime2")?
            .and_utc()
            .timestamp_subsec_nanos()
            == 123456700,
        "Tiberius temporal precision"
    );
    let offset = row
        .get::<chrono::DateTime<chrono::FixedOffset>, _>(7)
        .context("Tiberius datetimeoffset")?;
    ensure!(
        offset.offset().local_minus_utc() == 19800 && offset.timestamp_subsec_nanos() == 123456700,
        "Tiberius timezone precision"
    );
    ensure!(
        offset.to_rfc3339_opts(chrono::SecondsFormat::Nanos, false)
            == "2026-11-10T12:34:56.123456700+05:30",
        "Tiberius timezone value"
    );
    report.exact_types = true;
    report.result_sets = rows(&mut client, "SELECT 1; PRINT N'phase0-message'; SELECT 2;")
        .await?
        .len();
    ensure!(report.result_sets == 2, "Tiberius multi-result sets");
    // The released public QueryItem stream exposes Metadata/Row, not INFO messages.
    report.messages = 0;
    let tx = rows(&mut client, TRANSACTION).await?;
    ensure!(
        tx[0][0].get::<i32, _>(0) == Some(1) && tx[1][0].get::<i32, _>(0) == Some(2),
        "Tiberius transaction rollback/commit"
    );
    report.transactions = true;
    let affected = client
        .execute("UPDATE #phase0 SET id=id", &[])
        .await
        .context("Tiberius affected rows")?;
    report.affected_counts = affected.total() == 2;
    ensure!(report.affected_counts, "Tiberius affected-row count");
    let mut observer = connect(f).await?;
    rows(
        &mut observer,
        "CREATE TABLE #phase0 (id int); INSERT #phase0 VALUES (9);",
    )
    .await?;
    ensure!(
        scalar(&mut client, "SELECT COUNT(*) FROM #phase0").await? == 2
            && scalar(&mut observer, "SELECT COUNT(*) FROM #phase0").await? == 1,
        "Tiberius session isolation"
    );
    report.independent_sessions = true;
    ensure!(
        client
            .simple_query("SELECT missing_phase0_column")
            .await
            .is_err(),
        "Tiberius expected server error"
    );
    // Fully consume the error path before checking reuse; never replay the failed statement.
    let recovered = scalar(&mut client, "SELECT 1").await;
    report.errors_recover = recovered.is_ok();
    if !report.errors_recover {
        client = connect(f).await?;
    }
    let spid = scalar(&mut client, "SELECT @@SPID").await?;
    rows(&mut observer,"IF OBJECT_ID('dbo.phase0_cancel') IS NOT NULL DROP TABLE dbo.phase0_cancel; CREATE TABLE dbo.phase0_cancel (id int);").await?;
    let cancel_started = Instant::now();
    let pending =
        tokio::time::timeout(Duration::from_millis(300), client.simple_query(CANCEL)).await;
    ensure!(pending.is_err(), "Tiberius WAITFOR unexpectedly finished");
    drop(pending);
    let _ = tokio::time::timeout(Duration::from_secs(3), client.cancel_query()).await;
    // A dropped mid-response stream is not generally recoverable per the driver
    // contract. Always retire it, even if Attention acknowledgement was observed.
    drop(client);
    report.connection_retired_after_cancel = true;
    no_work(&mut observer, spid).await?;
    ensure!(
        scalar(&mut observer, "SELECT COUNT(*) FROM dbo.phase0_cancel").await? == 0,
        "Tiberius cancelled write ran"
    );
    report.cancel_ms = cancel_started.elapsed().as_millis();
    report.server_work_stopped = true;
    let mut client = connect(f).await?;
    report.reconnect_is_new_session = scalar(
        &mut client,
        "SELECT CASE WHEN OBJECT_ID('tempdb..#phase0') IS NULL THEN 1 ELSE 0 END",
    )
    .await?
        == 1;
    let spid = scalar(&mut client, "SELECT @@SPID").await?;
    rows(&mut observer, &format!("KILL {spid}")).await?;
    report.dropped_connection_detected = scalar(&mut client, "SELECT 1").await.is_err();
    drop(client);
    let mut client = connect(f).await?;
    let mut collector = Collector::new(report);
    let mut stream = client
        .simple_query(LOAD)
        .await
        .context("Tiberius bounded stream")?;
    loop {
        collector.wait_for_credit().await?;
        let Some(item) = stream.try_next().await.context("Tiberius stream row")? else {
            break;
        };
        if let QueryItem::Row(row) = item {
            let number = row.get::<i64, _>(0).context("Tiberius load integer")?;
            let text = row.get::<&str, _>(1).context("Tiberius load text")?;
            if !collector.row(vec![
                DbValue::Integer {
                    decimal: number.to_string(),
                },
                DbValue::Text { value: text.into() },
            ])? {
                break;
            }
        }
    }
    drop(stream);
    let _ = tokio::time::timeout(Duration::from_secs(3), client.cancel_query()).await;
    drop(client);
    let report = collector.finish();
    ensure!(
        report.streamed_rows > 1000 && report.max_queued_bytes <= 512 << 10,
        "Tiberius bounded stream budget"
    );
    ensure!(
        report.dropped_connection_detected
            && report.reconnect_is_new_session
            && report.result_limit_reached,
        "Tiberius recovery/truncation fixture"
    );
    Ok(report)
}
