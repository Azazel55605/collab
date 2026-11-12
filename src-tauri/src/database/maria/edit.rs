//! Grid writes are limited to ordinary, trigger-free InnoDB tables with a
//! usable unique key. Metadata locks and row locks protect validation through
//! commit, while all renderer-supplied cell values are bound parameters.
use super::{quote, read_cell, target, Live};
use crate::database::{
    edit::{
        ApplyRequest, ApplyResult, Change, Column, EditRow, Failure, Field, Input, InputKind,
        Operation, Page,
    },
    query::BrowseRequest,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use collab_database::{ContractError as E, DbValue, Identifier};
use sqlx::{
    mysql::{MySqlArguments, MySqlRow},
    query::Query,
    AssertSqlSafe, MySql, MySqlConnection, Row as _,
};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::time::timeout;

const PAGE_ROWS: usize = 100;
const MAX_COLUMNS: usize = 32;
const MAX_BYTES: usize = 1 << 20;
const APPLY_TIMEOUT: Duration = Duration::from_secs(20);

type Rows = Vec<Option<Vec<DbValue>>>;
type Params<'a> = Query<'a, MySql, MySqlArguments>;

#[derive(Clone, PartialEq, Eq, sqlx::FromRow)]
struct FieldInfo {
    name: String,
    declared: String,
    base: String,
    nullable: i64,
    default_value: Option<String>,
    extra: String,
    generation: Option<String>,
    collation: Option<String>,
    precision: Option<u64>,
    scale: Option<u64>,
    length: Option<u64>,
    date_scale: Option<u64>,
}

impl FieldInfo {
    fn auto(&self) -> bool {
        self.extra.contains("auto_increment")
    }
    fn generated(&self) -> bool {
        self.generation
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    }
    fn input(&self) -> Result<InputKind, E> {
        Ok(match self.base.as_str() {
            "tinyint" | "smallint" | "mediumint" | "int" | "bigint" => InputKind::Integer,
            "decimal" => InputKind::Decimal,
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext"
                if self
                    .collation
                    .as_deref()
                    .is_some_and(|c| c.starts_with("utf8mb4_")) =>
            {
                InputKind::Text
            }
            "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
                InputKind::Binary
            }
            "date" => InputKind::Date,
            "time" => InputKind::Time,
            "datetime" | "timestamp" => InputKind::DateTime,
            _ => return Err(E::ReadOnlyResult),
        })
    }
}

#[derive(PartialEq, Eq)]
struct Table {
    name: String,
    target: String,
    fields: Vec<FieldInfo>,
    columns: Vec<String>,
    key: Vec<usize>,
    key_name: String,
}

pub(in crate::database) struct Snapshot {
    table: Table,
    page: Page,
}

impl Table {
    async fn read(
        client: &mut MySqlConnection,
        database: &str,
        name: &str,
    ) -> Result<Self, Failure> {
        let target = format!("{}.{}", quote(database)?, quote(name)?);
        // Access in the current transaction keeps the table's metadata locked
        // until COMMIT/ROLLBACK, including when the table is empty.
        sqlx::query(AssertSqlSafe(format!("SELECT * FROM {target} LIMIT 0")))
            .execute(&mut *client)
            .await?;
        let eligible: i64 = sqlx::query_scalar(
            "SELECT CAST(EXISTS(SELECT 1 FROM information_schema.TABLES
               WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?
               AND ENGINE='InnoDB' AND TABLE_TYPE='BASE TABLE') AS SIGNED)",
        )
        .bind(database)
        .bind(name)
        .fetch_one(&mut *client)
        .await?;
        if eligible == 0 {
            return Err(E::ReadOnlyResult.into());
        }

        // INFORMATION_SCHEMA hides triggers from accounts without TRIGGER.
        // A direct global/schema/table grant proves visibility; a role-only
        // grant may be conservatively rejected. Any trigger could write a
        // nontransactional table, so the grid requires a trigger-free target.
        let safe: i64 = sqlx::query_scalar(
            "WITH account AS (
                 SELECT CONCAT(QUOTE(LEFT(CURRENT_USER(), CHAR_LENGTH(CURRENT_USER())-CHAR_LENGTH(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))-1)),
                   '@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))) AS grantee
             )
             SELECT CAST((
                 EXISTS(SELECT 1 FROM information_schema.USER_PRIVILEGES p JOIN account a ON BINARY p.GRANTEE=BINARY a.grantee WHERE p.PRIVILEGE_TYPE='TRIGGER')
                 OR EXISTS(SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES p JOIN account a ON BINARY p.GRANTEE=BINARY a.grantee WHERE p.PRIVILEGE_TYPE='TRIGGER' AND BINARY p.TABLE_SCHEMA=BINARY ?)
                 OR EXISTS(SELECT 1 FROM information_schema.TABLE_PRIVILEGES p JOIN account a ON BINARY p.GRANTEE=BINARY a.grantee WHERE p.PRIVILEGE_TYPE='TRIGGER' AND BINARY p.TABLE_SCHEMA=BINARY ? AND BINARY p.TABLE_NAME=BINARY ?)
             ) AND NOT EXISTS(
                 SELECT 1 FROM information_schema.TRIGGERS WHERE BINARY EVENT_OBJECT_SCHEMA=BINARY ? AND BINARY EVENT_OBJECT_TABLE=BINARY ?
             ) AS SIGNED)"
        ).bind(database).bind(database).bind(name).bind(database).bind(name).fetch_one(&mut *client).await?;
        if safe == 0 {
            return Err(E::ReadOnlyResult.into());
        }

        let fields: Vec<FieldInfo> = sqlx::query_as(
            "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS declared, DATA_TYPE AS base,
             CAST(IS_NULLABLE='YES' AS SIGNED) AS nullable, COLUMN_DEFAULT AS default_value,
             EXTRA AS extra, GENERATION_EXPRESSION AS generation, COLLATION_NAME AS collation,
             CAST(NUMERIC_PRECISION AS UNSIGNED) AS `precision`, CAST(NUMERIC_SCALE AS UNSIGNED) AS scale,
             CAST(CHARACTER_MAXIMUM_LENGTH AS UNSIGNED) AS length, CAST(DATETIME_PRECISION AS UNSIGNED) AS date_scale
             FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?
             ORDER BY ORDINAL_POSITION LIMIT 33"
        ).bind(database).bind(name).fetch_all(&mut *client).await?;
        if fields.is_empty() || fields.len() > MAX_COLUMNS {
            return Err(E::ReadOnlyResult.into());
        }
        for field in &fields {
            field.input()?;
        }
        let keys: Vec<(String, Option<String>, i64)> = sqlx::query_as(
            "SELECT INDEX_NAME, COLUMN_NAME, CAST((SUB_PART IS NULL AND INDEX_TYPE='BTREE') AS SIGNED)
             FROM information_schema.STATISTICS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?
             AND NON_UNIQUE=0 ORDER BY BINARY INDEX_NAME,SEQ_IN_INDEX LIMIT 1025"
        ).bind(database).bind(name).fetch_all(client).await?;
        if keys.len() > 1024 {
            return Err(E::ReadOnlyResult.into());
        }
        let mut groups = BTreeMap::<(bool, String), Vec<Option<usize>>>::new();
        for (index, column, full) in keys {
            let field = fields.iter().position(|field| {
                full != 0
                    && column.as_deref() == Some(&field.name)
                    && field.nullable == 0
                    && !field.generated()
            });
            groups
                .entry((index != "PRIMARY", index))
                .or_default()
                .push(field);
        }
        let (key_name, key) = groups
            .into_iter()
            .find_map(|((_, name), fields)| {
                fields
                    .into_iter()
                    .collect::<Option<Vec<_>>>()
                    .map(|key| (name, key))
            })
            .ok_or(E::ReadOnlyResult)?;
        let columns = fields
            .iter()
            .map(|field| quote(&field.name))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            name: name.into(),
            target,
            fields,
            columns,
            key,
            key_name,
        })
    }

    fn edit_columns(&self) -> Result<Vec<Column>, E> {
        self.fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                Ok(Column::maria(
                    Identifier::new(&field.name)?,
                    field.declared.clone(),
                    field.input()?,
                    field.nullable != 0,
                    field.generated() || field.auto(),
                    field.default_value.is_some(),
                    self.key.contains(&index),
                ))
            })
            .collect()
    }

    fn key_columns(&self) -> impl Iterator<Item = &str> {
        self.key.iter().map(|&index| self.columns[index].as_str())
    }

    fn key_predicate(&self) -> String {
        self.key
            .iter()
            .map(|&index| {
                let name = &self.columns[index];
                let field = &self.fields[index];
                if field.base == "decimal" {
                    // Comparing a DECIMAL column with a string parameter can fall
                    // back to approximate comparison. Use the verified column type.
                    let precision = field.precision.unwrap_or(65).clamp(1, 65);
                    let scale = field.scale.unwrap_or(0).min(38).min(precision);
                    format!("{name}=CAST(? AS DECIMAL({precision},{scale}))")
                } else {
                    format!("{name}=?")
                }
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}

enum Value {
    Null,
    Text(String),
    Binary(Vec<u8>),
    Signed(i64),
    Unsigned(u64),
}

impl Value {
    fn bind(self, query: Params<'_>) -> Params<'_> {
        match self {
            Self::Null => query.bind(Option::<String>::None),
            Self::Text(value) => query.bind(value),
            Self::Binary(value) => query.bind(value),
            Self::Signed(value) => query.bind(value),
            Self::Unsigned(value) => query.bind(value),
        }
    }

    fn original(field: &FieldInfo, value: &DbValue) -> Result<Self, E> {
        match value {
            DbValue::Binary { base64 } => Ok(Self::Binary(
                STANDARD.decode(base64).map_err(|_| E::DataConversion)?,
            )),
            DbValue::Integer { decimal } => Self::input(field, decimal.clone()),
            DbValue::Decimal { decimal, .. } => Ok(Self::Text(decimal.clone())),
            DbValue::Text { value } => Ok(Self::Text(value.clone())),
            DbValue::Date { iso8601 }
            | DbValue::Time { iso8601, .. }
            | DbValue::DateTime { iso8601, .. } => Ok(Self::Text(iso8601.replace('T', " "))),
            _ => Err(E::ReadOnlyResult),
        }
    }

    fn input(field: &FieldInfo, text: String) -> Result<Self, E> {
        if text.len() > 24 << 10 {
            return Err(E::LimitReached);
        }
        Ok(match field.input()? {
            InputKind::Integer if field.declared.contains("unsigned") => {
                Self::Unsigned(text.parse().map_err(|_| E::InvalidParameter)?)
            }
            InputKind::Integer => Self::Signed(text.parse().map_err(|_| E::InvalidParameter)?),
            InputKind::Decimal => {
                let digits = text.strip_prefix('-').unwrap_or(&text);
                let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
                let scale = field.scale.unwrap_or(0) as usize;
                let precision = field.precision.unwrap_or(0) as usize;
                if whole.is_empty()
                    || text.ends_with('.')
                    || !whole
                        .bytes()
                        .chain(fraction.bytes())
                        .all(|b| b.is_ascii_digit())
                    || fraction.len() > scale
                    || whole.trim_start_matches('0').len() > precision.saturating_sub(scale)
                {
                    return Err(E::InvalidParameter);
                }
                Self::Text(text)
            }
            InputKind::Text
                if text.len() <= 16 << 10
                    && text.chars().count() as u64 <= field.length.unwrap_or(0) =>
            {
                Self::Text(text)
            }
            InputKind::Binary => {
                let bytes = STANDARD.decode(text).map_err(|_| E::InvalidParameter)?;
                if bytes.len() > 16 << 10 || bytes.len() as u64 > field.length.unwrap_or(0) {
                    return Err(E::LimitReached);
                }
                Self::Binary(bytes)
            }
            InputKind::Date => {
                let date = chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d")
                    .map_err(|_| E::InvalidParameter)?;
                if date.to_string() != text {
                    return Err(E::InvalidParameter);
                }
                Self::Text(text)
            }
            InputKind::DateTime | InputKind::Time => {
                if super::fractional(&text) as u64 > field.date_scale.unwrap_or(0)
                    || text.len() > 26
                {
                    return Err(E::InvalidParameter);
                }
                if field.base == "time" {
                    validate_time(&text)?;
                } else {
                    chrono::NaiveDateTime::parse_from_str(&text, "%Y-%m-%dT%H:%M:%S%.f")
                        .map_err(|_| E::InvalidParameter)?;
                }
                Self::Text(text.replace('T', " "))
            }
            _ => return Err(E::InvalidParameter),
        })
    }
}

fn validate_time(text: &str) -> Result<(), E> {
    let text = text.strip_prefix('-').unwrap_or(text);
    let (clock, fraction) = text
        .split_once('.')
        .map_or((text, None), |(clock, fraction)| (clock, Some(fraction)));
    let mut parts = clock.split(':');
    let hours = parts.next().ok_or(E::InvalidParameter)?;
    let minute = parts.next().ok_or(E::InvalidParameter)?;
    let second = parts.next().ok_or(E::InvalidParameter)?;
    let digits = |text: &str, width: usize, max: u16| {
        text.len() <= width
            && text.bytes().all(|b| b.is_ascii_digit())
            && text.parse::<u16>().is_ok_and(|value| value <= max)
    };
    if parts.next().is_some()
        || !digits(hours, 3, 838)
        || minute.len() != 2
        || !digits(minute, 2, 59)
        || second.len() != 2
        || !digits(second, 2, 59)
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err(E::InvalidParameter);
    }
    Ok(())
}

fn values(row: &MySqlRow) -> Result<Vec<DbValue>, E> {
    (0..row.len())
        .map(|index| match read_cell(row, index)? {
            DbValue::Opaque { .. } | DbValue::Truncated { .. } => Err(E::ReadOnlyResult),
            value => Ok(value),
        })
        .collect()
}

pub(in crate::database) async fn load(
    operation: Operation,
    live: Arc<Live>,
    request: BrowseRequest,
) -> Result<Page, Failure> {
    operation.set_maria_snapshot(None);
    let (_, filter, parameter) = target(&live.database, &request)?;
    let mut guard = live.client.lock().await;
    let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
    let snapshot = tokio::select! {
        biased;
        _ = live.cancel.cancelled() => return Err(E::WrongBinding.into()),
        result = timeout(APPLY_TIMEOUT, async {
            sqlx::query("START TRANSACTION READ ONLY").execute(&mut *client).await?;
            let table = Table::read(client, &live.database, &request.table).await?;
            let order = table.key_columns().collect::<Vec<_>>().join(",");
            let columns = table.columns.join(",");
            let sql = format!("SELECT {columns} FROM {}{filter} ORDER BY {order} LIMIT 101",table.target);
            let mut query = sqlx::query(AssertSqlSafe(sql));
            if let Some(parameter) = parameter { query = query.bind(parameter); }
            let mut stream = query.fetch(&mut *client);
            let mut rows = Vec::new();
            let mut remaining = MAX_BYTES;
            let mut more = false;
            use futures_util::TryStreamExt as _;
            while let Some(row) = stream.try_next().await? {
                if rows.len() == PAGE_ROWS { more = true; continue; }
                if more { continue; }
                let values = values(&row)?;
                let size = collab_database::encoded_size(&values, 256 << 10)?;
                if size > remaining { more = true; continue; }
                remaining -= size;
                rows.push(EditRow { id: uuid::Uuid::new_v4().to_string(), values });
            }
            drop(stream);
            sqlx::query("ROLLBACK").execute(client).await?;
            let page = Page::new(live.database.clone(), table.name.clone(), table.edit_columns()?, rows, more);
            Ok::<_, Failure>(Snapshot { table, page })
        }) => result.map_err(|_| E::Timeout)??,
    };
    let page = snapshot.page.clone();
    operation.set_maria_snapshot(Some(snapshot));
    Ok(page)
}

pub(in crate::database) async fn apply(
    mut operation: Operation,
    live: Arc<Live>,
    request: ApplyRequest,
) -> Result<ApplyResult, Failure> {
    collab_database::encoded_size(&request, MAX_BYTES)?;
    if request.changes.is_empty() || request.changes.len() > 128 {
        return Err(E::LimitReached.into());
    }
    let snapshot = operation
        .take_maria_snapshot()
        .filter(|snapshot| snapshot.page.id == request.snapshot_id)
        .ok_or(E::SchemaConflict)?;
    let mut guard = live.client.lock().await;
    let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
    let staged = timeout(
        APPLY_TIMEOUT,
        stage(client, &live, &snapshot, request.changes),
    )
    .await;
    let failure = match staged {
        Ok(Ok(rows)) => {
            // Do not replay if the COMMIT reply is lost. Closing the connection
            // is safe for any still-open transaction but does not prove rollback.
            match timeout(
                Duration::from_secs(8),
                sqlx::query("COMMIT").execute(client),
            )
            .await
            {
                Ok(Ok(_)) => return Ok(ApplyResult::Committed { rows }),
                result => {
                    operation.mark_unresolved();
                    guard.take();
                    let failure = result
                        .map_or_else(|_| E::Timeout.into(), |result| result.unwrap_err().into());
                    return Ok(ApplyResult::Unknown { failure });
                }
            }
        }
        Ok(Err(failure)) => failure,
        Err(_) => {
            // COMMIT has not been sent. Closing this disposable session
            // abandons its InnoDB transaction without replaying any changes.
            guard.take();
            return Ok(ApplyResult::Rejected {
                failure: E::Timeout.into(),
            });
        }
    };
    if !matches!(
        timeout(
            Duration::from_secs(5),
            sqlx::query("ROLLBACK").execute(client)
        )
        .await,
        Ok(Ok(_))
    ) {
        guard.take();
    }
    Ok(ApplyResult::Rejected { failure })
}

async fn stage(
    client: &mut MySqlConnection,
    live: &Live,
    snapshot: &Snapshot,
    changes: Vec<Change>,
) -> Result<Rows, Failure> {
    sqlx::query("START TRANSACTION")
        .execute(&mut *client)
        .await?;
    let table = Table::read(client, &live.database, &snapshot.table.name)
        .await
        .map_err(|failure| {
            if failure.code == E::ReadOnlyResult || failure.server_code == Some(1146) {
                E::SchemaConflict.into()
            } else {
                failure
            }
        })?;
    if table != snapshot.table {
        return Err(E::SchemaConflict.into());
    }
    let mut rows = Vec::new();
    let mut visited = HashSet::new();
    for (index, change) in changes.into_iter().enumerate() {
        if live.cancel.is_cancelled() {
            return Err(E::WrongBinding.into());
        }
        rows.push(
            mutate(client, &table, snapshot, &mut visited, change)
                .await
                .map_err(|mut failure| {
                    failure.change_index = Some(index);
                    failure
                })?,
        );
    }
    collab_database::encoded_size(&rows, MAX_BYTES)?;
    Ok(rows)
}

fn fields(
    table: &Table,
    inputs: Vec<Field>,
    inserting: bool,
) -> Result<(Vec<String>, Vec<Value>), E> {
    let mut seen = HashSet::new();
    let mut assignments = Vec::new();
    let mut params = Vec::new();
    for input in inputs {
        let index = input.column;
        let field = table.fields.get(index).ok_or(E::InvalidParameter)?;
        if !seen.insert(index)
            || field.generated()
            || field.auto()
            || (!inserting && table.key.contains(&index))
        {
            return Err(E::InvalidParameter);
        }
        let value = match input.value {
            Input::Default if field.default_value.is_some() || field.nullable != 0 => {
                if !inserting {
                    assignments.push(format!("{}=DEFAULT", table.columns[index]));
                }
                continue;
            }
            Input::Null if field.nullable != 0 => Value::Null,
            Input::Value { text } => Value::input(field, text)?,
            _ => return Err(E::InvalidParameter),
        };
        assignments.push(if inserting {
            table.columns[index].clone()
        } else {
            format!("{}=?", table.columns[index])
        });
        params.push(value);
    }
    Ok((assignments, params))
}

fn bind<'a>(mut query: Params<'a>, values: Vec<Value>) -> Params<'a> {
    for value in values {
        query = value.bind(query);
    }
    query
}

fn key_query<'a>(query: Params<'a>, table: &Table, original: &[DbValue]) -> Result<Params<'a>, E> {
    let values = table
        .key
        .iter()
        .map(|&index| Value::original(&table.fields[index], &original[index]))
        .collect::<Result<Vec<_>, E>>()?;
    Ok(bind(query, values))
}

async fn current_row(
    client: &mut MySqlConnection,
    table: &Table,
    original: &[DbValue],
) -> Result<Vec<DbValue>, Failure> {
    let query = sqlx::query(AssertSqlSafe(format!(
        "SELECT {} FROM {} WHERE {} LIMIT 2 FOR UPDATE",
        table.columns.join(","),
        table.target,
        table.key_predicate()
    )));
    let rows = key_query(query, table, original)?.fetch_all(client).await?;
    if rows.len() != 1 {
        return Err(E::RowConflict.into());
    }
    Ok(values(&rows[0])?)
}

async fn mutate(
    client: &mut MySqlConnection,
    table: &Table,
    snapshot: &Snapshot,
    visited: &mut HashSet<String>,
    change: Change,
) -> Result<Option<Vec<DbValue>>, Failure> {
    let (row_id, update) = match change {
        Change::Insert { values: inputs } => {
            let (columns, params) = fields(table, inputs, true)?;
            let markers = vec!["?"; params.len()].join(",");
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({markers}) RETURNING {}",
                table.target,
                columns.join(","),
                table.columns.join(",")
            );
            let rows = bind(sqlx::query(AssertSqlSafe(sql)), params)
                .fetch_all(client)
                .await?;
            if rows.len() != 1 {
                return Err(E::RowConflict.into());
            }
            return Ok(Some(values(&rows[0])?));
        }
        Change::Update { row_id, values } => (row_id, Some(values)),
        Change::Delete { row_id } => (row_id, None),
    };
    let original = snapshot
        .page
        .rows
        .iter()
        .find(|row| row.id == row_id)
        .ok_or(E::RowConflict)?;
    if !visited.insert(row_id) {
        return Err(E::InvalidParameter.into());
    }
    if current_row(client, table, &original.values).await? != original.values {
        return Err(E::RowConflict.into());
    }
    let predicate = table.key_predicate();
    let (sql, parameters, updated) = if let Some(inputs) = update {
        let (assignments, params) = fields(table, inputs, false)?;
        if assignments.is_empty() {
            return Err(E::InvalidParameter.into());
        }
        (
            format!(
                "UPDATE {} SET {} WHERE {predicate}",
                table.target,
                assignments.join(",")
            ),
            params,
            true,
        )
    } else {
        (
            format!("DELETE FROM {} WHERE {predicate}", table.target),
            Vec::new(),
            false,
        )
    };
    let query = bind(sqlx::query(AssertSqlSafe(sql)), parameters);
    if key_query(query, table, &original.values)?
        .execute(&mut *client)
        .await?
        .rows_affected()
        != 1
    {
        return Err(E::RowConflict.into());
    }
    if updated {
        Ok(Some(current_row(client, table, &original.values).await?))
    } else {
        Ok(None)
    }
}
