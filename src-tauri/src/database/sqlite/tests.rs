use super::*;
use crate::database::edit::{ApplyRequest, ApplyResult, Change, Field, Input, SqliteStorage};
use rusqlite::params;

fn request(table: &str) -> BrowseRequest {
    BrowseRequest {
        schema: "main".into(),
        table: table.into(),
        filter_column: None,
        filter_text: String::new(),
    }
}

fn binding() -> SessionBinding {
    SessionBinding {
        profile_id: "test".into(),
        session_id: "session".into(),
        connection_id: "local".into(),
        tab_id: "tab".into(),
        database: "main".into(),
        generation: 1,
    }
}

pub(super) fn open(path: &Path, mode: OpenMode) -> Result<Arc<Session>, E> {
    Session::open(
        binding(),
        path.to_owned(),
        mode,
        CancellationToken::new(),
        Arc::new(tokio::sync::Semaphore::new(1))
            .try_acquire_owned()
            .unwrap(),
    )
}

fn text(column: usize, text: &str) -> Field {
    Field {
        column,
        value: Input::SqliteValue {
            storage: SqliteStorage::Text,
            text: text.into(),
        },
    }
}

#[test]
fn picker_owned_file_is_read_only_when_requested_and_detects_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite3");
    let file = open(&path, OpenMode::Create).unwrap();
    assert_eq!(
        open(&path, OpenMode::Create).err(),
        Some(E::InvalidParameter)
    );
    file.inspect(|connection| {
        connection.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY, value); INSERT INTO items VALUES (1,'a')").map_err(classify)
    }).unwrap();
    let ro = open(&path, OpenMode::ReadOnly).unwrap();
    assert_eq!(
        ro.inspect(|connection| connection
            .execute("DELETE FROM items", [])
            .map_err(classify)),
        Err(E::DatabaseReadOnly)
    );
    assert_eq!(
        ro.edit_load(request("items")).err().unwrap().code,
        E::DatabaseReadOnly
    );
    assert!(ro
        .inspect(|connection| connection
            .execute("ATTACH ':memory:' AS extra", [])
            .map_err(classify))
        .is_err());
    assert!(ro
        .inspect(|connection| connection
            .execute(
                "VACUUM INTO ?1",
                [dir.path().join("new.db").to_str().unwrap()]
            )
            .map_err(classify))
        .is_err());
    #[cfg(unix)]
    {
        std::fs::rename(&path, dir.path().join("moved.db")).unwrap();
        let replacement = open(&path, OpenMode::Create).unwrap();
        assert!(replacement.check_identity().is_ok());
        assert_eq!(file.check_identity(), Err(E::DatabaseMoved));
    }
    let invalid = dir.path().join("invalid.db");
    std::fs::write(&invalid, [0u8; 4096]).unwrap();
    assert_eq!(
        open(&invalid, OpenMode::ReadOnly).err(),
        Some(E::InvalidDatabase)
    );
}

#[test]
fn metadata_and_grid_edits_support_without_rowid_and_reject_keyless() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    let file = open(&path, OpenMode::Create).unwrap();
    let external = Connection::open(&path).unwrap();
    external.execute_batch("
        PRAGMA journal_mode=WAL;
        CREATE TABLE keyed(a TEXT, b INTEGER, value, g TEXT GENERATED ALWAYS AS (value || '!'), PRIMARY KEY(a,b)) WITHOUT ROWID;
        CREATE TABLE keyless(value);
        CREATE TABLE nullable(id TEXT PRIMARY KEY, value);
        CREATE TABLE fallback(id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, value);
        CREATE TABLE auto(id INTEGER PRIMARY KEY, value DEFAULT 'default');
        CREATE TRIGGER keyed_au AFTER UPDATE OF value ON keyed
          WHEN new.value = 'new' BEGIN UPDATE keyed SET value = 'trigger' WHERE a = new.a AND b = new.b; END;
        INSERT INTO keyed(a,b,value) VALUES ('one',9223372036854775807,'first'),('two',2,x'0102');
    ").unwrap();
    let objects = file
        .metadata(MetadataRequest::Objects {
            schema_id: 1,
            after: 0,
        })
        .unwrap();
    let object_id = objects
        .items
        .iter()
        .find(|item| item.name == "keyed")
        .unwrap()
        .id
        .parse()
        .unwrap();
    assert_eq!(
        file.metadata(MetadataRequest::Columns {
            object_id,
            after: 0
        })
        .unwrap()
        .items
        .len(),
        4
    );
    assert_eq!(
        file.metadata(MetadataRequest::Indexes {
            object_id,
            after: 0
        })
        .unwrap()
        .items
        .len(),
        1
    );
    assert!(file
        .metadata(MetadataRequest::Completion {
            after: "0:0".into()
        })
        .unwrap()
        .items
        .iter()
        .any(|item| item.name == "value" && item.kind == "keyed"));
    for table in ["keyless", "nullable"] {
        assert_eq!(
            file.edit_load(request(table)).err().unwrap().code,
            E::ReadOnlyResult
        );
    }
    assert!(file.edit_load(request("fallback")).is_ok());

    let page = file.edit_load(request("keyed")).unwrap();
    assert!(
        matches!(&page.rows[0].values[1], DbValue::Integer { decimal } if decimal == "9223372036854775807")
    );
    assert!(matches!(&page.rows[1].values[2], DbValue::Binary { base64 } if base64 == "AQI="));
    external
        .execute(
            "UPDATE keyed SET value = 'externally changed' WHERE a='two'",
            [],
        )
        .unwrap();
    let result = file
        .edit_apply(ApplyRequest {
            snapshot_id: page.id,
            changes: vec![
                Change::Update {
                    row_id: page.rows[0].id.clone(),
                    values: vec![text(2, "new")],
                },
                Change::Delete {
                    row_id: page.rows[1].id.clone(),
                },
            ],
        })
        .unwrap();
    assert!(
        matches!(result, ApplyResult::Rejected { failure } if failure.code == E::RowConflict && failure.change_index == Some(1))
    );
    assert_eq!(
        external
            .query_row("SELECT value FROM keyed WHERE a='one'", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "first"
    );

    let page = file.edit_load(request("keyed")).unwrap();
    let result = file
        .edit_apply(ApplyRequest {
            snapshot_id: page.id,
            changes: vec![
                Change::Update {
                    row_id: page.rows[0].id.clone(),
                    values: vec![text(2, "new")],
                },
                Change::Delete {
                    row_id: page.rows[1].id.clone(),
                },
            ],
        })
        .unwrap();
    let ApplyResult::Committed { rows } = result else {
        panic!("edit should commit");
    };
    assert!(
        matches!(&rows[0].as_ref().unwrap()[3], DbValue::Text { value } if value == "trigger!")
    );
    assert!(rows[1].is_none());

    let page = file.edit_load(request("auto")).unwrap();
    let result = file
        .edit_apply(ApplyRequest {
            snapshot_id: page.id,
            changes: vec![Change::Insert { values: vec![] }],
        })
        .unwrap();
    assert!(
        matches!(result, ApplyResult::Committed { rows } if matches!(&rows[0].as_ref().unwrap()[0], DbValue::Integer { decimal } if decimal == "1"))
    );
}

#[test]
fn wal_snapshot_contains_committed_rows_and_writer_lock_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite");
    let external = Connection::open(&path).unwrap();
    external.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY, value); INSERT INTO items VALUES (1,'committed'); BEGIN IMMEDIATE; INSERT INTO items VALUES (2,'pending')").unwrap();
    assert!(dir.path().join("test.sqlite-wal").metadata().unwrap().len() > 32);
    let copy = snapshot_for_upload(&path).unwrap();
    let snapshot = configured_connection(&copy.path().join("snapshot.sqlite"), true).unwrap();
    assert_eq!(
        snapshot
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        snapshot
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );

    let file = open(&path, OpenMode::ReadWrite).unwrap();
    let page = file.edit_load(request("items")).unwrap();
    let start = Instant::now();
    let result = file
        .edit_apply(ApplyRequest {
            snapshot_id: page.id,
            changes: vec![Change::Update {
                row_id: page.rows[0].id.clone(),
                values: vec![text(1, "changed")],
            }],
        })
        .unwrap();
    assert!(
        matches!(result, ApplyResult::Rejected { failure } if failure.code == E::DatabaseLocked)
    );
    assert!(
        start.elapsed() >= Duration::from_millis(1500) && start.elapsed() < Duration::from_secs(8)
    );
    external.execute_batch("ROLLBACK").unwrap();
    assert!(file.edit_load(request("items")).is_ok());
}

async fn drain(file: &Session, id: &str) -> Vec<ResultEvent> {
    let mut after = None;
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(
            Instant::now() < deadline,
            "query did not reach a terminal event"
        );
        let poll = file.query.poll(id, after).await.unwrap();
        if let Some(frame) = poll.frame {
            after = Some(frame.sequence);
            let terminal = matches!(
                frame.event,
                ResultEvent::Finished { .. } | ResultEvent::Failed { .. }
            );
            events.push(frame.event);
            if terminal {
                file.query.poll(id, after).await.unwrap();
                return events;
            }
        } else {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[tokio::test]
async fn query_stream_preserves_precision_and_cancels_in_flight_sql() {
    let dir = tempfile::tempdir().unwrap();
    let file = open(&dir.path().join("test.db"), OpenMode::Create).unwrap();
    let id = start(
        file.clone(),
        binding(),
        "SELECT 9223372036854775807, x'0102'; SELECT 'next';".into(),
        None,
    )
    .unwrap();
    let events = drain(&file, &id).await;
    assert!(events.iter().any(|event| matches!(event, ResultEvent::Rows { rows, .. } if matches!(&rows[0][0], DbValue::Integer { decimal } if decimal == "9223372036854775807"))));
    assert!(events
        .iter()
        .any(|event| matches!(event, ResultEvent::Rows { result_set: 1, .. })));
    let id = start(file.clone(), binding(), "WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<1000000000) SELECT sum(n) FROM t".into(), None).unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(frame) = file.query.poll(&id, None).await.unwrap().frame {
                break frame;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(first.event, ResultEvent::Columns { .. }));
    file.query.cancel(&id).unwrap();
    let events = drain(&file, &id).await;
    assert!(matches!(
        events.last(),
        Some(ResultEvent::Finished {
            reason: FinishReason::Cancelled
        })
    ));
    assert!(file.clean());
}

#[test]
fn wal_recovers_after_process_exit_with_an_uncommitted_writer() {
    const CHILD: &str = "COLLAB_TEST_SQLITE_CRASH_PATH";
    if let Some(path) = std::env::var_os(CHILD) {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY, value); INSERT INTO items VALUES (1,'committed'); BEGIN IMMEDIATE").unwrap();
        connection
            .execute("INSERT INTO items VALUES (2,?1)", params!["pending"])
            .unwrap();
        std::process::exit(42);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("crash.sqlite");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "database::sqlite::tests::wal_recovers_after_process_exit_with_an_uncommitted_writer",
        ])
        .env(CHILD, &path)
        .output()
        .unwrap()
        .status;
    assert_eq!(status.code(), Some(42));
    assert!(dir.path().join("crash.sqlite-wal").is_file());
    let file = open(&path, OpenMode::ReadWrite).unwrap();
    assert_eq!(
        file.inspect(|connection| connection
            .query_row("SELECT value FROM items", [], |row| row.get::<_, String>(0))
            .map_err(classify))
            .unwrap(),
        "committed"
    );
    assert_eq!(
        file.inspect(|connection| connection
            .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
            .map_err(classify))
            .unwrap(),
        1
    );
    assert_eq!(
        file.inspect(|connection| connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .map_err(classify))
            .unwrap(),
        "ok"
    );
}

#[test]
fn deferred_constraint_failure_is_a_confirmed_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let file = open(&dir.path().join("foreign.db"), OpenMode::Create).unwrap();
    file.inspect(|connection| {
        connection
            .execute_batch(
                "
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER
            REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);
    ",
            )
            .map_err(classify)
    })
    .unwrap();
    let page = file.edit_load(request("children")).unwrap();
    let result = file
        .edit_apply(ApplyRequest {
            snapshot_id: page.id,
            changes: vec![Change::Insert {
                values: vec![Field {
                    column: 1,
                    value: Input::SqliteValue {
                        storage: SqliteStorage::Integer,
                        text: "42".into(),
                    },
                }],
            }],
        })
        .unwrap();
    assert!(matches!(result, ApplyResult::Rejected { failure } if failure.code == E::QueryFailed));
    assert!(file.clean());
    assert!(file.edit_load(request("children")).unwrap().rows.is_empty());
}

#[tokio::test]
async fn closing_a_backpressured_session_releases_the_file_and_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("closing.sqlite");
    let file = open(&path, OpenMode::Create).unwrap();
    file.inspect(|client| {
        client
            .execute_batch("CREATE TABLE items(id INTEGER)")
            .map_err(classify)
    })
    .unwrap();
    let id = start(
        file.clone(),
        binding(),
        "BEGIN IMMEDIATE; INSERT INTO items VALUES (1); SELECT id FROM items".into(),
        None,
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            // Acknowledge the BEGIN frame to let the worker produce the
            // INSERT count and column frame, then stop consuming altogether.
            if let Some(frame) = file.query.poll(&id, None).await.unwrap().frame {
                assert!(matches!(frame.event, ResultEvent::AffectedRows { .. }));
                file.query.poll(&id, Some(frame.sequence)).await.unwrap();
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(75)).await;
    file.cancel.cancel();
    let weak = Arc::downgrade(&file);
    drop(file);
    tokio::time::timeout(Duration::from_secs(2), async {
        while weak.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the result worker kept the closed file alive");
    let client = Connection::open(path).unwrap();
    let count: i64 = client
        .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
