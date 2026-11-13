use super::*;
use crate::database::edit::{ApplyRequest, ApplyResult, Change, Field, Input, Runtime};

#[test]
fn version_and_identifier_contract() {
    assert!(validate_version("5.5.5-10.11.16-MariaDB").is_ok());
    assert!(validate_version("11.4.12-MariaDB").is_ok());
    assert_eq!(validate_version("10.6.25-MariaDB"), Err(E::Unsupported));
    assert_eq!(validate_version("8.4.8-MySQL"), Err(E::Unsupported));
    assert_eq!(quote("a`b").unwrap(), "`a``b`");
}

fn config(port: u16, host: &str, username: &str) -> SavedConnection {
    SavedConnection {
        engine: Engine::MariaDb,
        id: uuid::Uuid::new_v4().to_string(),
        label: "Fixture".into(),
        environment: "Test".into(),
        host: host.into(),
        port,
        database: "collab_phase5".into(),
        username: username.into(),
        certificate_hostname: None,
        remember_password: false,
        credential_id: None,
        retired_credentials: vec![],
    }
}
fn binding() -> SessionBinding {
    SessionBinding {
        profile_id: "fixture".into(),
        connection_id: "fixture".into(),
        session_id: "fixture".into(),
        tab_id: "fixture".into(),
        database: "collab_phase5".into(),
        generation: 1,
    }
}
fn request(table: &str) -> BrowseRequest {
    BrowseRequest {
        schema: binding().database,
        table: table.into(),
        filter_column: None,
        filter_text: String::new(),
    }
}
fn permit() -> OwnedSemaphorePermit {
    Arc::new(tokio::sync::Semaphore::new(1))
        .try_acquire_owned()
        .unwrap()
}
async fn connect(config: &SavedConnection, password: &str) -> Result<Arc<Live>, E> {
    Live::connect(
        config,
        &config.database,
        password,
        CancellationToken::new(),
        permit(),
    )
    .await
}

async fn drain(live: &Live, query_id: &str) -> Vec<ResultEvent> {
    timeout(Duration::from_secs(12), async {
        let mut cursor = None;
        let mut events = Vec::new();
        loop {
            let poll = live.query.poll(query_id, cursor).await.unwrap();
            if let Some(frame) = poll.frame {
                cursor = Some(frame.sequence);
                let done = matches!(
                    frame.event,
                    ResultEvent::Finished { .. } | ResultEvent::Failed { .. }
                );
                events.push(frame.event);
                if done {
                    live.query.poll(query_id, cursor).await.unwrap();
                    return events;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    })
    .await
    .unwrap()
}

fn update(row_id: String, text: &str) -> Change {
    Change::Update {
        row_id,
        values: vec![Field {
            column: 2,
            value: Input::Value { text: text.into() },
        }],
    }
}

#[tokio::test]
#[ignore = "requires the disposable TLS MariaDB fixture described in the database guide"]
async fn disposable_mariadb_verified_queries_metadata_and_atomic_edits() {
    assert_eq!(
        std::env::var("COLLAB_MARIA_DISPOSABLE").as_deref(),
        Ok("yes")
    );
    let port = std::env::var("COLLAB_MARIA_FIXTURE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let password = zeroize::Zeroizing::new(std::env::var("COLLAB_MARIA_FIXTURE_PASSWORD").unwrap());
    let account = config(port, "localhost", "editor");
    assert_eq!(
        connect(&config(port, "127.0.0.1", "editor"), &password)
            .await
            .err(),
        Some(E::TlsRejected)
    );
    assert_eq!(
        connect(&account, "invalid-fixture-password").await.err(),
        Some(E::AuthenticationFailed)
    );
    let live = connect(&account, &password).await.unwrap();
    assert!(live.capabilities.innodb);
    assert!(live.capabilities.sql_mode.contains("STRICT_ALL_TABLES"));
    let tables = live
        .metadata(&MetadataRequest::MariaTables {
            after: String::new(),
        })
        .await
        .unwrap();
    assert!(tables
        .items
        .iter()
        .any(|item| item.name == "items" && item.detail == "InnoDB"));
    let columns = live
        .metadata(&MetadataRequest::MariaColumns {
            table: "items".into(),
            after: 0,
        })
        .await
        .unwrap();
    assert!(columns
        .items
        .iter()
        .any(|item| item.name == "quantity" && item.kind.starts_with("decimal")));
    let indexes = live
        .metadata(&MetadataRequest::MariaIndexes {
            table: "items".into(),
            after: String::new(),
        })
        .await
        .unwrap();
    assert!(indexes.items.iter().any(|item| item.name == "PRIMARY"));
    let completion = live
        .metadata(&MetadataRequest::Completion {
            after: "0:0".into(),
        })
        .await
        .unwrap();
    assert!(completion
        .items
        .iter()
        .any(|item| item.kind == "items" && item.name == "value"));

    let id = start(
        live.clone(),
        binding(),
        "SELECT id, quantity, payload, elapsed FROM items ORDER BY id".into(),
        None,
    )
    .unwrap();
    let events = drain(&live, &id).await;
    assert!(events.iter().any(|event| matches!(event, ResultEvent::Rows {rows,..} if rows.iter().any(|row|
        matches!(&row[0], DbValue::Integer {decimal} if decimal == "18446744073709551615")
        && matches!(&row[1], DbValue::Decimal {decimal,..} if decimal == "1234567890123456789012345.1234567890")
        && matches!(&row[2], DbValue::Binary {base64} if base64 == "AAE=")
        && matches!(&row[3], DbValue::Time {iso8601,..} if iso8601 == "-100:00:01.123456")
    ))), "exact typed values were not returned");

    let id = start(live.clone(), binding(), "SELECT 1; SELECT 2".into(), None).unwrap();
    let events = drain(&live, &id).await;
    assert!(
        matches!(events.last(), Some(ResultEvent::Failed {error}) if error.code == E::QueryFailed && !error.outcome_unknown)
    );
    let id = transaction(live.clone(), binding(), TransactionAction::Begin).unwrap();
    drain(&live, &id).await;
    assert_eq!(live.query.status().transaction, TransactionState::Open);
    let id = start(
        live.clone(),
        binding(),
        "CREATE TABLE implicit_commit (id int) ENGINE=InnoDB".into(),
        None,
    )
    .unwrap();
    drain(&live, &id).await;
    assert_eq!(live.query.status().transaction, TransactionState::None);

    crate::database::schema::network::fixture(Engine::MariaDb, "collab_phase5", async || {
        crate::database::Network::MariaDb(connect(&account, &password).await.unwrap())
    })
    .await;
    let edit_runtime = Arc::new(Runtime::default());
    for table in ["nontransactional", "with_trigger", "without_key"] {
        let edit_session = connect(&account, &password).await.unwrap();
        assert_eq!(
            edit::load(
                edit_runtime.reserve().unwrap(),
                edit_session,
                request(table)
            )
            .await
            .err()
            .unwrap()
            .code,
            E::ReadOnlyResult
        );
    }
    let limited = connect(&config(port, "localhost", "limited"), &password)
        .await
        .unwrap();
    assert_eq!(
        edit::load(edit_runtime.reserve().unwrap(), limited, request("items"))
            .await
            .err()
            .unwrap()
            .code,
        E::ReadOnlyResult
    );

    let edit_session = connect(&account, &password).await.unwrap();
    let page = edit::load(
        edit_runtime.reserve().unwrap(),
        edit_session,
        request("items"),
    )
    .await
    .unwrap();
    assert_eq!(page.rows.len(), 2);
    let id = start(
        live.clone(),
        binding(),
        "UPDATE items SET value='second' WHERE id=18446744073709551615".into(),
        None,
    )
    .unwrap();
    drain(&live, &id).await;
    let edit_session = connect(&account, &password).await.unwrap();
    let result = edit::apply(
        edit_runtime.reserve().unwrap(),
        edit_session,
        ApplyRequest {
            snapshot_id: page.id,
            changes: vec![
                update(page.rows[0].id.clone(), "changed"),
                update(page.rows[1].id.clone(), "changed"),
            ],
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(result, ApplyResult::Rejected {failure} if failure.code == E::RowConflict && failure.change_index == Some(1))
    );
    let edit_session = connect(&account, &password).await.unwrap();
    let page = edit::load(
        edit_runtime.reserve().unwrap(),
        edit_session,
        request("items"),
    )
    .await
    .unwrap();
    assert!(matches!(&page.rows[0].values[2], DbValue::Text {value} if value == "First"));
    let edit_session = connect(&account, &password).await.unwrap();
    let result = edit::apply(
        edit_runtime.reserve().unwrap(),
        edit_session,
        ApplyRequest {
            snapshot_id: page.id,
            changes: vec![
                update(page.rows[0].id.clone(), "First"),
                Change::Delete {
                    row_id: page.rows[1].id.clone(),
                },
                Change::Insert {
                    values: vec![
                        Field {
                            column: 0,
                            value: Input::Value { text: "2".into() },
                        },
                        Field {
                            column: 2,
                            value: Input::Value {
                                text: "added".into(),
                            },
                        },
                    ],
                },
            ],
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(result, ApplyResult::Committed {rows} if rows.len() == 3 && rows[1].is_none() &&
        matches!(&rows[2].as_ref().unwrap()[6], DbValue::Text {value} if value == "ADDED"))
    );

    let lost = connect(&account, &password).await.unwrap();
    let session_id: u64 = {
        let mut client = lost.client.lock().await;
        sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(client.as_mut().unwrap())
            .await
            .unwrap()
    };
    let id = start(lost.clone(), binding(), "SELECT SLEEP(10)".into(), None).unwrap();
    let observer = connect(&account, &password).await.unwrap();
    let mut client = observer.client.lock().await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID=? AND COMMAND<>'Sleep' AND INFO LIKE '%SLEEP(10)%'",
            )
            .bind(session_id)
            .fetch_one(client.as_mut().unwrap()).await.unwrap();
            if active == 1 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("fixture query never reached the server");
    // The numeric ID came from this fixture's own disposable session.
    sqlx::query(sqlx::AssertSqlSafe(format!("KILL CONNECTION {session_id}")))
        .execute(client.as_mut().unwrap())
        .await
        .unwrap();
    drop(client);
    let events = drain(&lost, &id).await;
    assert!(matches!(events.last(), Some(ResultEvent::Failed { error }) if error.outcome_unknown));
    assert_eq!(lost.query.status().phase, "outcome_unknown");
    assert_eq!(
        start(lost, binding(), "SELECT 1".into(), None),
        Err(E::UnresolvedSession)
    );

    let id = start(live.clone(), binding(), "SELECT SLEEP(10)".into(), None).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    live.query.cancel(&id).unwrap();
    let events = drain(&live, &id).await;
    assert!(
        matches!(events.last(), Some(ResultEvent::Failed {error}) if error.code == E::Cancelled && error.outcome_unknown)
    );
    assert_eq!(live.query.status().phase, "outcome_unknown");
}
