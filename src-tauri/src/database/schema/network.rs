use super::{quote, stamp, Draft, Outcome, Pending, Preview, Request};
use crate::database::{driver::Live, edit, maria, Network};
use collab_database::{ContractError as E, DbValue, Engine};
use mssql_tds::message::parameters::rpc_parameters::{RpcParameter, StatusFlags};
use sqlx::{AssertSqlSafe, MySqlConnection, Row as _};
use std::{sync::Arc, time::Duration};

const LIMIT: Duration = Duration::from_secs(20);

pub(super) async fn preview(
    live: Network,
    draft: Arc<Draft>,
    request: Request,
    database: &str,
) -> Result<Preview, edit::Failure> {
    let engine = match live {
        Network::SqlServer(_) => Engine::SqlServer,
        Network::MariaDb(_) => Engine::MariaDb,
    };
    let sql = request.sql(engine, database)?;
    let fingerprint = tokio::time::timeout(LIMIT, async {
        match &live {
            Network::SqlServer(live) => {
                let mut guard = live.client.lock().await;
                sql_server_stamp(guard.as_mut().ok_or(E::ConnectionFailed)?, &request).await
            }
            Network::MariaDb(live) => {
                let mut guard = live.client.lock().await;
                maria_stamp(guard.as_mut().ok_or(E::ConnectionFailed)?, &request).await
            }
        }
    })
    .await
    .map_err(|_| E::Timeout)??;
    if live.cancel().is_cancelled() {
        return Err(E::WrongBinding.into());
    }
    Ok(draft.store(request, sql, fingerprint, engine))
}

pub(super) async fn apply(live: Network, pending: Pending) -> Outcome {
    match live {
        Network::SqlServer(live) => apply_sql_server(live, pending).await,
        Network::MariaDb(live) => apply_maria(live, pending).await,
    }
}

async fn sql_server_stamp(
    client: &mut mssql_tds::connection::tds_client::TdsClient,
    request: &Request,
) -> Result<[u8; 32], edit::Failure> {
    // The JSON contains definitions, rather than row contents or approximate
    // timestamps. Bounded PLP decoding in edit::read enforces the size cap.
    let sql = r#"
        DECLARE @id int = OBJECT_ID(QUOTENAME(@P1) + N'.' + QUOTENAME(@P2));
        SELECT CAST(SCHEMA_ID(@P1) AS nvarchar(20)),
          CAST(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS nvarchar(1)),
          (SELECT CAST(type AS nvarchar(4)) FROM sys.objects WHERE object_id=@id),
          (SELECT object_id, CONVERT(nvarchar(40),create_date,126) AS created,
             CONVERT(nvarchar(40),modify_date,126) AS modified, temporal_type, is_memory_optimized,
             JSON_QUERY((SELECT column_id, name, user_type_id, max_length, precision, scale,
                is_nullable, collation_name, is_identity, is_computed, default_object_id
                FROM sys.columns WHERE object_id=@id ORDER BY column_id FOR JSON PATH)) AS columns,
             JSON_QUERY((SELECT i.index_id, i.name, i.type, i.is_unique, i.is_primary_key,
                i.is_disabled, i.filter_definition,
                JSON_QUERY((SELECT column_id,key_ordinal,index_column_id,is_descending_key,is_included_column
                    FROM sys.index_columns WHERE object_id=@id AND index_id=i.index_id
                    ORDER BY index_column_id FOR JSON PATH)) AS columns
                FROM sys.indexes i WHERE i.object_id=@id ORDER BY i.index_id FOR JSON PATH)) AS indexes,
             JSON_QUERY((SELECT object_id, referenced_object_id, parent_object_id, is_disabled, is_not_trusted
                FROM sys.foreign_keys WHERE parent_object_id=@id OR referenced_object_id=@id
                ORDER BY object_id FOR JSON PATH)) AS foreign_keys,
             JSON_QUERY((SELECT object_id, type, name, CONVERT(nvarchar(40),modify_date,126) AS modified
                FROM sys.objects WHERE parent_object_id=@id ORDER BY object_id FOR JSON PATH)) AS dependents
             FROM sys.tables WHERE object_id=@id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
          CAST((SELECT COUNT(*) FROM sys.tables WHERE object_id=@id AND (temporal_type<>0 OR is_memory_optimized=1)) AS nvarchar(20));"#;
    let values = [&request.schema, &request.table]
        .into_iter()
        .enumerate()
        .map(|(i, name)| {
            RpcParameter::new(
                Some(format!("@P{}", i + 1)),
                StatusFlags::NONE,
                edit::unicode(name),
            )
        })
        .collect();
    let sets = edit::read(client, sql.into(), values, 1, 1).await?;
    let row = sets
        .first()
        .and_then(|rows| rows.first())
        .ok_or(E::DataConversion)?;
    if row.len() != 5 {
        return Err(E::DataConversion.into());
    }
    if matches!(row[0], DbValue::Null) {
        return Err(E::SchemaConflict.into());
    }
    if !matches!(&row[1], DbValue::Text { value } if value == "1") {
        return Err(E::PermissionDenied.into());
    }
    if request.create() {
        if !matches!(row[2], DbValue::Null) {
            return Err(E::SchemaConflict.into());
        }
    } else if !matches!(&row[2], DbValue::Text { value } if value.trim() == "U")
        || !matches!(&row[4], DbValue::Text { value } if value == "0")
    {
        return Err(E::SchemaDependency.into());
    }
    Ok(stamp(
        serde_json::to_vec(row).map_err(|_| E::DataConversion)?,
    ))
}

async fn apply_sql_server(live: Arc<Live>, pending: Pending) -> Outcome {
    let mut guard = live.client.lock().await;
    let Some(client) = guard.as_mut() else {
        return Outcome::rejected(E::ConnectionFailed);
    };
    let stage = tokio::time::timeout(LIMIT, async {
        edit::command(
            client,
            "SET LOCK_TIMEOUT 5000; SET XACT_ABORT ON; BEGIN TRANSACTION;".into(),
        )
        .await?;
        // Hold a table lock from validation through DDL. CREATE has no existing
        // table to lock and relies on the engine's atomic name check.
        if !pending.request.create() {
            let schema = quote(&pending.request.schema, Engine::SqlServer)?;
            let table = quote(&pending.request.table, Engine::SqlServer)?;
            edit::read(
                client,
                format!("SELECT TOP (1) 1 FROM {schema}.{table} WITH (TABLOCKX,HOLDLOCK);"),
                vec![],
                1,
                1,
            )
            .await?;
        }
        if sql_server_stamp(client, &pending.request).await? != pending.stamp {
            return Err(E::SchemaConflict.into());
        }
        edit::command(client, pending.preview.sql).await
    })
    .await;
    if let Err(failure) = stage.unwrap_or_else(|_| Err(E::Timeout.into())) {
        // Dropping the dedicated connection rolls back its uncommitted transaction.
        guard.take();
        return Outcome::rejected(failure);
    }
    match tokio::time::timeout(
        Duration::from_secs(8),
        edit::command(client, "COMMIT TRANSACTION".into()),
    )
    .await
    {
        Ok(Ok(())) => Outcome::Applied,
        Ok(Err(failure)) => Outcome::unknown(failure),
        Err(_) => Outcome::unknown(E::Timeout),
    }
}

async fn maria_stamp(
    client: &mut MySqlConnection,
    request: &Request,
) -> Result<[u8; 32], edit::Failure> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?"
    ).bind(&request.schema).bind(&request.table).fetch_optional(&mut *client).await?;
    if request.create() {
        if row.is_some() {
            return Err(E::SchemaConflict.into());
        }
        return Ok(stamp(b"absent"));
    }
    if !row
        .is_some_and(|(kind, engine)| kind == "BASE TABLE" && engine.as_deref() == Some("InnoDB"))
    {
        return Err(E::SchemaDependency.into());
    }
    let schema = quote(&request.schema, Engine::MariaDb)?;
    let table = quote(&request.table, Engine::MariaDb)?;
    let row = sqlx::query(AssertSqlSafe(format!("SHOW CREATE TABLE {schema}.{table}")))
        .fetch_one(client)
        .await?;
    let definition: &str = row.try_get(1)?;
    if definition.len() > 64 << 10 {
        return Err(E::LimitReached.into());
    }
    // SHOW CREATE emits the mutable AUTO_INCREMENT counter in the table
    // options line. Strip that exact token while preserving column definitions.
    let mut lines = definition.lines().collect::<Vec<_>>();
    if let Some(index) = lines.iter().rposition(|line| line.starts_with(") ENGINE=")) {
        let options = lines[index]
            .split(' ')
            .filter(|part| {
                !part.strip_prefix("AUTO_INCREMENT=").is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                })
            })
            .collect::<Vec<_>>()
            .join(" ");
        lines[index] = &options;
        return Ok(stamp(lines.join("\n")));
    }
    Ok(stamp(definition))
}

async fn apply_maria(live: Arc<maria::Live>, pending: Pending) -> Outcome {
    let mut guard = live.client.lock().await;
    let Some(client) = guard.as_mut() else {
        return Outcome::rejected(E::ConnectionFailed);
    };
    let validated = tokio::time::timeout(LIMIT, async {
        if !pending.request.create() {
            let schema = quote(&pending.request.schema, Engine::MariaDb)?;
            let table = quote(&pending.request.table, Engine::MariaDb)?;
            sqlx::query("SET autocommit=0")
                .execute(&mut *client)
                .await?;
            // Explicit WRITE lock spans revalidation and the implicit DDL commit.
            sqlx::query(AssertSqlSafe(format!("LOCK TABLES {schema}.{table} WRITE")))
                .execute(&mut *client)
                .await?;
        }
        if maria_stamp(client, &pending.request).await? != pending.stamp {
            return Err(edit::Failure::from(E::SchemaConflict));
        }
        Ok(())
    })
    .await;
    if let Err(failure) = validated.unwrap_or_else(|_| Err(E::Timeout.into())) {
        guard.take();
        return Outcome::rejected(failure);
    }
    let result = tokio::time::timeout(
        LIMIT,
        sqlx::query(AssertSqlSafe(pending.preview.sql)).execute(client),
    )
    .await;
    // Dropping this connection releases its explicit locks, including on errors.
    guard.take();
    match result {
        Ok(Ok(_)) => Outcome::Applied,
        Ok(Err(error)) if error.as_database_error().is_some() => Outcome::rejected(error),
        Ok(Err(error)) => Outcome::unknown(error),
        Err(_) => Outcome::unknown(E::Timeout),
    }
}

#[cfg(test)]
pub(in crate::database) async fn fixture(
    engine: Engine,
    database: &str,
    mut connect: impl AsyncFnMut() -> Network,
) {
    let schema = if engine == Engine::SqlServer {
        "dbo"
    } else {
        database
    };
    let draft = Arc::new(Draft::default());
    let request = |change: &str| {
        serde_json::from_str::<Request>(&format!(
            r#"{{"schema":"{schema}","table":"phase6_fixture","change":{change}}}"#
        ))
        .unwrap()
    };
    let create = r#"{"kind":"create_table","columns":[{"name":"id","data_type":"integer","nullable":false,"primary_key":false}]}"#;
    let add = r#"{"kind":"add_column","column":{"name":"payload","data_type":"short_text","nullable":true,"primary_key":false}}"#;
    let key = r#"{"kind":"add_primary_key","columns":["id"]}"#;
    let index =
        r#"{"kind":"create_index","name":"phase6_payload","columns":["payload"],"unique":false}"#;
    for change in [create, add, key, index] {
        if change == add {
            let changed = preview(connect().await, draft.clone(), request(
                r#"{"kind":"add_column","column":{"name":"revision","data_type":"integer","nullable":true,"primary_key":false}}"#,
            ), database).await.unwrap();
            // Keep a copy of the first native preview in a separate tab.
            let other = Arc::new(Draft::default());
            let stale = preview(connect().await, other.clone(), request(add), database)
                .await
                .unwrap();
            assert!(matches!(
                apply(connect().await, draft.take(&changed.id, false).unwrap()).await,
                Outcome::Applied
            ));
            assert!(
                matches!(apply(connect().await, other.take(&stale.id, false).unwrap()).await,
                Outcome::Rejected { failure } if failure.code == E::SchemaConflict)
            );
        }
        let plan = preview(connect().await, draft.clone(), request(change), database)
            .await
            .unwrap();
        let result = apply(connect().await, draft.take(&plan.id, false).unwrap()).await;
        match result {
            Outcome::Applied => {}
            Outcome::Rejected { failure } | Outcome::Unknown { failure } => panic!("{failure:?}"),
        }
    }
}
