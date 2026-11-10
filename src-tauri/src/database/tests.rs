use super::*;
use driver::MetadataRequest;
fn config() -> SavedConnection {
    SavedConnection {
        id: String::new(),
        label: "Fixture".into(),
        environment: "Test".into(),
        host: "localhost".into(),
        port: 1433,
        database: "master".into(),
        username: "sa".into(),
        certificate_hostname: None,
        remember_password: false,
        credential_id: None,
        retired_credentials: vec![],
    }
}
#[test]
fn profiles_reject_connection_string_injection_and_do_not_store_secrets() {
    let mut c = config();
    c.id = Uuid::new_v4().to_string();
    assert!(c.validate().is_ok());
    for bad in [
        "localhost;TrustServerCertificate=true",
        "localhost,1433",
        "host\\instance",
        "host\n",
    ] {
        c.host = bad.into();
        assert!(c.validate().is_err());
    }
    let root = tempfile::tempdir().unwrap();
    c = config();
    c.id = Uuid::new_v4().to_string();
    persist(root.path(), "../../profile", &[c]).unwrap();
    let profiles = load(root.path(), "../../profile").unwrap();
    assert_eq!(profiles.len(), 1);
    assert!(!std::fs::read_to_string(path(root.path(), "../../profile"))
        .unwrap()
        .contains("password\":\""));
}
#[tokio::test]
async fn registry_tokens_expire_on_profile_switch_and_saved_fields_are_native_owned() {
    let root = tempfile::tempdir().unwrap();
    let first = activate(root.path(), "test-profile-a".into())
        .await
        .unwrap();
    let saved = save(root.path(), &first.token, config(), None)
        .await
        .unwrap();
    assert!(Uuid::parse_str(&saved.id).is_ok());
    let mut forged = config();
    forged.id = Uuid::new_v4().to_string();
    assert!(matches!(
        save(root.path(), &first.token, forged, None).await,
        Err(E::WrongBinding)
    ));
    profile_changed("test-profile-a", "test-profile-b")
        .await
        .unwrap();
    let second = activate(root.path(), "test-profile-b".into())
        .await
        .unwrap();
    assert!(second.profiles.is_empty());
    assert!(matches!(
        disconnect(&first.token, "missing").await,
        Err(E::WrongBinding)
    ));
    profile_changed("test-profile-b", "test-profile-a")
        .await
        .unwrap();
    let restored = activate(root.path(), "test-profile-a".into())
        .await
        .unwrap();
    assert_eq!(restored.profiles.len(), 1);
    assert_ne!(first.token, restored.token);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut pending_config = restored.profiles[0].clone();
    pending_config.port = listener.local_addr().unwrap().port();
    let saved = save(root.path(), &restored.token, pending_config, None)
        .await
        .unwrap();
    let token = restored.token.clone();
    let id = saved.id.clone();
    let pending = tokio::spawn(async move {
        connect(
            &token,
            &id,
            Some("disposable-no-login-handshake".into()),
            false,
        )
        .await
    });
    let (_socket, _) = tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    profile_changed("test-profile-a", "test-profile-c")
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap(),
        Err(E::WrongBinding)
    ));
    assert_eq!(slots().available_permits(), 8);
    assert!(matches!(
        activate(root.path(), "test-profile-a".into()).await,
        Err(E::WrongBinding)
    ));
    assert!(matches!(
        deactivate(&restored.token).await,
        Err(E::WrongBinding)
    ));
}
/// Run only from scripts/database-driver-spike.py --native-adapter. Never accepts
/// an arbitrary database URL; the harness owns this loopback Developer instance.
#[tokio::test]
#[ignore]
async fn real_disposable_registry_connections_and_metadata() {
    assert_eq!(
        std::env::var("COLLAB_DATABASE_DISPOSABLE_FIXTURE").as_deref(),
        Ok("yes")
    );
    let password =
        std::fs::read_to_string(std::env::var("COLLAB_DB_SPIKE_PASSWORD_FILE").unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let w = activate(root.path(), "fixture-profile".into())
        .await
        .unwrap();
    let mut c = config();
    c.port = std::env::var("COLLAB_DB_SPIKE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    c.database = "collab_phase0".into();
    let saved = save(root.path(), &w.token, c, None).await.unwrap();
    connect(&w.token, &saved.id, Some(password.clone()), true)
        .await
        .unwrap();
    assert!(activate(root.path(), "fixture-profile".into())
        .await
        .unwrap()
        .connections
        .is_empty());
    assert!(matches!(
        connect(
            &w.token,
            &saved.id,
            Some("wrong-disposable-password".into()),
            false
        )
        .await,
        Err(E::AuthenticationFailed)
    ));
    let mut invalid = config();
    invalid.port = saved.port;
    invalid.database = saved.database.clone();
    invalid.certificate_hostname = Some("wrong-name.invalid".into());
    let invalid = save(root.path(), &w.token, invalid, None).await.unwrap();
    assert!(matches!(
        connect(&w.token, &invalid.id, Some(password.clone()), false).await,
        Err(E::TlsRejected)
    ));
    let a = connect(&w.token, &saved.id, Some(password.clone()), false)
        .await
        .unwrap();
    let b = connect(&w.token, &saved.id, Some(password.clone()), false)
        .await
        .unwrap();
    assert_ne!(a.id, b.id);
    let page = metadata(
        &w.token,
        &a.id,
        None,
        MetadataRequest::Databases {
            after: String::new(),
        },
    )
    .await
    .unwrap();
    assert!(page.items.iter().any(|i| i.name == "collab_phase0"));
    let ta = open_tab(&w.token, &a.id, "collab_phase0".into())
        .await
        .unwrap();
    let tb = open_tab(&w.token, &b.id, "master".into()).await.unwrap();
    let mut forged = ta.clone();
    forged.database = "master".into();
    assert!(matches!(
        close_tab(&w.token, &forged, false).await,
        Err(E::WrongBinding)
    ));
    assert!(matches!(
        metadata(
            &w.token,
            &b.id,
            Some(ta.clone()),
            MetadataRequest::Schemas { after: 0 }
        )
        .await,
        Err(E::WrongBinding)
    ));
    let schemas = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Schemas { after: 0 },
    )
    .await
    .unwrap();
    assert!(schemas.items.iter().any(|i| i.name == "dbo"));
    let dbo = schemas
        .items
        .iter()
        .find(|i| i.name == "dbo")
        .unwrap()
        .id
        .parse()
        .unwrap();
    let objects = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Objects {
            schema_id: dbo,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(objects.items.len(), 100);
    assert!(objects.next.is_some());
    let second = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Objects {
            schema_id: dbo,
            after: objects.next.unwrap().parse().unwrap(),
        },
    )
    .await
    .unwrap();
    assert!(second.items.len() >= 6);
    assert!(second
        .items
        .iter()
        .all(|i| !objects.items.iter().any(|old| old.id == i.id)));
    let table = objects
        .items
        .iter()
        .chain(second.items.iter())
        .find(|i| i.name == "phase1_metadata")
        .unwrap()
        .id
        .parse()
        .unwrap();
    let columns = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Columns {
            object_id: table,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert!(columns.items.iter().any(|i| i.name == "label"));
    let indexes = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Indexes {
            object_id: table,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert!(indexes.items.iter().any(|i| i.name == "phase1_label"));
    let injected = metadata(
        &w.token,
        &a.id,
        None,
        MetadataRequest::Databases {
            after: "zz'; DROP DATABASE collab_phase0;--".into(),
        },
    )
    .await
    .unwrap();
    assert!(injected.items.is_empty());
    disconnect(&w.token, &a.id).await.unwrap();
    let w2 = activate(root.path(), "fixture-profile".into())
        .await
        .unwrap();
    assert_eq!(w2.tabs.len(), 1);
    assert_eq!(w2.tabs[0], tb);
    assert!(matches!(
        close_tab(&w.token, &ta, false).await,
        Err(E::WrongBinding)
    ));
    close_tab(&w.token, &tb, false).await.unwrap();
    phase2_fixture(&w.token, &b.id).await;
    let mut held = vec![];
    for _ in 0..7 {
        held.push(
            connect(&w.token, &saved.id, Some(password.clone()), false)
                .await
                .unwrap(),
        );
    }
    assert!(matches!(
        connect(&w.token, &saved.id, Some(password), false).await,
        Err(E::LimitReached)
    ));
    {
        profile_changed("fixture-profile", "other-fixture-profile")
            .await
            .unwrap();
        activate(root.path(), "other-fixture-profile".into())
            .await
            .unwrap()
    };
    activate(root.path(), "other-fixture-profile".into())
        .await
        .unwrap();
    assert_eq!(slots().available_permits(), 8);
    assert!(matches!(
        metadata(&w.token, &b.id, None, MetadataRequest::Schemas { after: 0 }).await,
        Err(E::WrongBinding)
    ));
}

async fn collect_query(
    token: &str,
    binding: &SessionBinding,
    id: &str,
) -> (Vec<collab_database::ResultFrame>, query::Status) {
    let start = std::time::Instant::now();
    let mut frames = vec![];
    let mut after = None;
    loop {
        assert!(
            start.elapsed() < std::time::Duration::from_secs(30),
            "query fixture exceeded deadline"
        );
        let live = query_live(token, binding).await.unwrap();
        let poll = live.query.poll(id, after).await.unwrap();
        if let Some(frame) = poll.frame {
            assert_eq!(frame.sequence, after.map_or(0, |n| n + 1));
            after = Some(frame.sequence);
            let done = matches!(
                frame.event,
                collab_database::ResultEvent::Finished { .. }
                    | collab_database::ResultEvent::Failed { .. }
            );
            frames.push(frame);
            if done {
                let status = live.query.poll(id, after).await.unwrap().status;
                return (frames, status);
            }
        } else {
            assert!(
                !matches!(poll.status.phase.as_str(), "retired" | "outcome_unknown"),
                "fixture session retired before delivering completion"
            );
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    }
}
async fn fixture_scalar(live: &Arc<Live>, sql: String) -> i64 {
    use mssql_tds::connection::tds_client::{ExecuteOptions, ResultSet, StatementResult};
    use mssql_tds::datatypes::column_values::ColumnValues as C;
    let mut guard = live.client.lock().await;
    let client = guard.as_mut().unwrap();
    let probe = if sql.contains("@@SPID") {
        "session-id"
    } else if sql.contains("dm_exec_requests") {
        "server-request"
    } else {
        "side-effect"
    };
    let mut result = client
        .execute(sql, ExecuteOptions::new().timeout_secs(3))
        .await
        .unwrap_or_else(|_| panic!("fixture scalar {probe}"));
    let mut value = None;
    loop {
        match result {
            StatementResult::Rows => {
                while let Some(row) = client.next_row().await.unwrap() {
                    value = match row.first() {
                        Some(C::Int(v)) => Some(i64::from(*v)),
                        Some(C::SmallInt(v)) => Some(i64::from(*v)),
                        Some(C::BigInt(v)) => Some(*v),
                        _ => None,
                    };
                }
            }
            StatementResult::End => break,
            _ => {}
        }
        result = client.advance().await.unwrap();
    }
    client.close_query().await.unwrap();
    value.unwrap()
}
async fn phase2_fixture(token: &str, connection: &str) {
    use collab_database::{
        DbValue as V, FinishReason as F, ResultEvent as R, TransactionState as T,
    };
    let began = std::time::Instant::now();
    let observer = {
        let r = registry().lock().await;
        r.connections.get(connection).unwrap().live.clone()
    };
    let tab = open_tab(token, connection, "collab_phase0".into())
        .await
        .unwrap();
    let sql=format!("CREATE TABLE #phase2(id int); INSERT #phase2 VALUES(1); SELECT CAST(9223372036854775807 AS bigint),CAST(123456789012345678901234567890.12345678 AS decimal(38,8)),CAST(NULL AS nvarchar(10)),N'',N'Grüße 世界 👋',CAST('2026-11-10T12:34:56.1234567+05:30' AS datetimeoffset(7)); PRINT N'phase2-message';\nGO\nSELECT COUNT(*) FROM #phase2; SELECT @@SPID;");
    let id = start_query(token, tab.clone(), sql, None, false)
        .await
        .unwrap();
    let (frames, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.phase, "idle");
    assert_eq!(status.transaction, T::None);
    let row = frames
        .iter()
        .find_map(|f| match &f.event {
            R::Rows {
                result_set: 0,
                rows,
            } => Some(&rows[0]),
            _ => None,
        })
        .unwrap();
    assert!(matches!(&row[0],V::Integer{decimal} if decimal=="9223372036854775807"));
    assert!(
        matches!(&row[1],V::Decimal{decimal,..} if decimal=="123456789012345678901234567890.12345678")
    );
    assert_eq!(row[2], V::Null);
    assert!(matches!(&row[3],V::Text{value} if value.is_empty()));
    assert!(matches!(&row[4],V::Text{value} if value=="Grüße 世界 👋"));
    assert!(
        matches!(&row[5],V::DateTime{iso8601,..} if iso8601=="2026-11-10T12:34:56.1234567+05:30")
    );
    assert!(frames
        .iter()
        .any(|f| matches!(&f.event,R::Message{safe_text,..} if safe_text=="phase2-message")));
    let spid = frames
        .iter()
        .find_map(|f| match &f.event {
            R::Rows {
                result_set: 2,
                rows,
            } => match &rows[0][0] {
                V::Integer { decimal } => Some(decimal.clone()),
                _ => None,
            },
            _ => None,
        })
        .unwrap();
    let sql = "-- 👋\nSELECT missing_phase2_column";
    let id = start_query(
        token,
        tab.clone(),
        sql.into(),
        Some(collab_database::SourceRange {
            start_utf16: 6,
            end_utf16: sql.encode_utf16().count() as u32,
        }),
        false,
    )
    .await
    .unwrap();
    let (frames, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.phase, "idle");
    assert!(frames.iter().any(|f|matches!(&f.event,R::Failed{error} if error.server_code==Some(207)&&error.source.unwrap().start_utf16==6)));
    let id = start_query(
        token,
        tab.clone(),
        "BEGIN TRANSACTION; INSERT #phase2 VALUES(2);".into(),
        None,
        false,
    )
    .await
    .unwrap();
    let (_, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.transaction, T::Open);
    assert!(!can_quit().await);
    assert!(matches!(
        close_tab(token, &tab, false).await,
        Err(E::UnresolvedSession)
    ));
    assert!(matches!(
        disconnect(token, connection).await,
        Err(E::UnresolvedSession)
    ));
    assert!(matches!(
        profile_changed("fixture-profile", "blocked-profile").await,
        Err(E::UnresolvedSession)
    ));
    let id = start_query(
        token,
        tab.clone(),
        "IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;".into(),
        None,
        true,
    )
    .await
    .unwrap();
    let (_, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.transaction, T::None);
    let id = start_query(
        token,
        tab.clone(),
        "WAITFOR DELAY '00:00:30'; INSERT dbo.phase0_cancel VALUES(42);".into(),
        None,
        false,
    )
    .await
    .unwrap();
    let live = query_live(token, &tab).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(matches!(
        live.query.cancel("wrong-query"),
        Err(E::StaleQuery)
    ));
    let cancel_started = std::time::Instant::now();
    live.query.cancel(&id).unwrap();
    let (frames, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.phase, "idle");
    assert!(frames.iter().any(|f| matches!(
        f.event,
        R::Finished {
            reason: F::Cancelled
        }
    )));
    let cancel_ms = cancel_started.elapsed().as_millis();
    assert_eq!(
        fixture_scalar(
            &observer,
            format!("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id={spid}")
        )
        .await,
        0
    );
    assert_eq!(
        fixture_scalar(
            &observer,
            "SELECT COUNT(*) FROM collab_phase0.dbo.phase0_cancel WHERE id=42".into()
        )
        .await,
        0
    );
    let id = start_query(
        token,
        tab.clone(),
        "SELECT REPLICATE(CAST(N'x' AS nvarchar(max)),1048576)".into(),
        None,
        false,
    )
    .await
    .unwrap();
    let (frames, _) = collect_query(token, &tab, &id).await;
    assert!(frames
        .iter()
        .any(|f| matches!(&f.event,R::Rows{rows,..} if matches!(rows[0][0],V::Truncated{..}))));
    assert!(frames.iter().any(|f| matches!(
        f.event,
        R::Finished {
            reason: F::CellLimit
        }
    )));
    let id=start_query(token,tab.clone(),"SELECT TOP(100000) REPLICATE(N'x',512) FROM sys.all_objects a CROSS JOIN sys.all_objects b".into(),None,false).await.unwrap();
    let (frames, _) = collect_query(token, &tab, &id).await;
    assert!(frames.iter().any(|f| matches!(
        f.event,
        R::Finished {
            reason: F::ByteLimit
        }
    )));
    assert!(
        frames
            .iter()
            .map(|f| serde_json::to_vec(f).unwrap().len())
            .sum::<usize>()
            <= 8 << 20
    );
    let result_wire_bytes = frames
        .iter()
        .map(|f| serde_json::to_vec(f).unwrap().len())
        .sum::<usize>();
    let streamed_rows = frames
        .iter()
        .map(|f| match &f.event {
            R::Rows { rows, .. } => rows.len(),
            _ => 0,
        })
        .sum::<usize>();

    let id = browse_query(
        token,
        tab.clone(),
        query::BrowseRequest {
            schema: "dbo".into(),
            table: "phase1_metadata".into(),
            filter_column: Some("label".into()),
            filter_text: "'; DROP TABLE dbo.phase1_metadata;--".into(),
        },
    )
    .await
    .unwrap();
    let (frames, _) = collect_query(token, &tab, &id).await;
    assert!(!frames.iter().any(|f| matches!(f.event, R::Failed { .. })));
    let id = start_query(
        token,
        tab.clone(),
        "DECLARE @i int=0; WHILE @i<1000 BEGIN PRINT REPLICATE(N'x',4000); SET @i+=1; END;".into(),
        None,
        false,
    )
    .await
    .unwrap();
    let (frames, _) = collect_query(token, &tab, &id).await;
    assert!(frames
        .iter()
        .any(|f| matches!(&f.event,R::Failed{error} if error.code==E::LimitReached)));
    close_tab(token, &tab, true).await.unwrap();
    let tab = open_tab(token, connection, "collab_phase0".into())
        .await
        .unwrap();
    let owned = query_live(token, &tab).await.unwrap();
    let spid = fixture_scalar(&owned, "SELECT CAST(@@SPID AS int)".into()).await;
    // Kill only this new fixture session, independently of any retirement at a limit.
    {
        let mut guard = observer.client.lock().await;
        let client = guard.as_mut().unwrap();
        client.execute(format!("KILL {spid}"), ()).await.unwrap();
        client.close_query().await.unwrap();
    }
    let id = start_query(
        token,
        tab.clone(),
        "INSERT dbo.phase0_cancel VALUES(99);".into(),
        None,
        false,
    )
    .await
    .unwrap();
    let (frames, status) = collect_query(token, &tab, &id).await;
    assert_eq!(status.phase, "outcome_unknown");
    assert!(frames
        .iter()
        .any(|f| matches!(&f.event,R::Failed{error} if error.outcome_unknown)));
    assert!(matches!(
        start_query(token, tab.clone(), "SELECT 1".into(), None, false).await,
        Err(E::UnresolvedSession)
    ));
    close_tab(token, &tab, true).await.unwrap();
    assert_eq!(
        fixture_scalar(
            &observer,
            "SELECT COUNT(*) FROM collab_phase0.dbo.phase0_cancel WHERE id=99".into()
        )
        .await,
        0
    );
    let diagnostic = open_tab(token, connection, "collab_phase0".into())
        .await
        .unwrap();
    let id=start_query(token,diagnostic.clone(),"DECLARE @i int=0,@msg nvarchar(4000)=REPLICATE(N'x',4000); WHILE @i<1000 BEGIN RAISERROR(@msg,16,1); SET @i+=1; END;".into(),None,false).await.unwrap();
    let (diagnostics, status) = collect_query(token, &diagnostic, &id).await;
    assert!(diagnostics
        .iter()
        .any(|frame| matches!(&frame.event,R::Failed{error} if error.code==E::LimitReached)));
    assert_eq!(status.phase, "outcome_unknown");
    close_tab(token, &diagnostic, true).await.unwrap();
    // A renderer withholding acknowledgement cannot keep a server request alive.
    let stalled = open_tab(token, connection, "collab_phase0".into())
        .await
        .unwrap();
    let stalled_live = query_live(token, &stalled).await.unwrap();
    let stalled_spid = fixture_scalar(&stalled_live, "SELECT CAST(@@SPID AS int)".into()).await;
    let id=start_query(token,stalled.clone(),"SELECT TOP(100000) REPLICATE(N'x',512) FROM sys.all_objects a CROSS JOIN sys.all_objects b".into(),None,false).await.unwrap();
    let live = query_live(token, &stalled).await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !matches!(
        live.query.status().phase.as_str(),
        "retired" | "outcome_unknown"
    ) && std::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(matches!(
        live.query.status().phase.as_str(),
        "retired" | "outcome_unknown"
    ));
    assert!(live.query.poll(&id, Some(999)).await.is_err());
    close_tab(token, &stalled, true).await.unwrap();
    assert_eq!(
        fixture_scalar(
            &observer,
            format!("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id={stalled_spid}")
        )
        .await,
        0
    );
    let peak_resident_kib = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse::<usize>().ok())
        });
    println!(
        "COLLAB_DATABASE_PHASE2 {}",
        serde_json::json!({"query_checks":true,"cancel_ms":cancel_ms,"streamed_rows":streamed_rows,"result_wire_bytes":result_wire_bytes,"peak_resident_kib":peak_resident_kib,"total_query_ms":began.elapsed().as_millis(),"server_work_stopped":true,"stalled_consumer_retired":true,"no_replay":true,"bounded_diagnostics":true})
    );
}
