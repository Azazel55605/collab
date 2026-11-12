//! Native snapshots and transactions for SQL Server base-table edits.
use super::{
    driver::{classify, Live},
    query::{browse_filter, read_cell, BrowseRequest},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use collab_database::{ContractError as E, DbValue, Engine, Identifier};
use mssql_tds::{
    connection::tds_client::{ExecuteOptions, ResultSet, StatementResult, TdsClient},
    datatypes::{sql_string::SqlString, sqltypes::SqlType},
    message::parameters::rpc_parameters::{RpcParameter, StatusFlags},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc, time::Duration};
use uuid::Uuid;

const PAGE_ROWS: usize = 100;
const MAX_COLUMNS: usize = 32;
const MAX_BYTES: usize = 1 << 20;
const MAX_CHANGES: usize = 128;

#[derive(Default)]
pub(super) struct Runtime {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    busy: bool,
    unknown: bool,
    snapshot: Option<Arc<Snapshot>>,
}
pub(super) struct Operation {
    runtime: Arc<Runtime>,
    unresolved: bool,
}
impl Runtime {
    pub(super) fn clean(&self) -> bool {
        let state = self.state.lock();
        !state.busy && !state.unknown
    }
    pub(super) fn busy(&self) -> bool {
        self.state.lock().busy
    }
    pub(super) fn reserve(self: &Arc<Self>) -> Result<Operation, E> {
        let mut state = self.state.lock();
        if state.busy {
            return Err(E::Busy);
        }
        if state.unknown {
            return Err(E::UnresolvedSession);
        }
        state.busy = true;
        Ok(Operation {
            runtime: self.clone(),
            unresolved: false,
        })
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let mut state = self.runtime.state.lock();
        state.busy = false;
        if self.unresolved {
            state.unknown = true;
            state.snapshot = None;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum InputKind {
    Integer,
    Decimal,
    Boolean,
    Text,
    Binary,
    Uuid,
    Date,
    Time,
    DateTime,
    DateTimeOffset,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Column {
    name: Identifier,
    engine_type: String,
    input: InputKind,
    nullable: bool,
    generated: bool,
    has_default: bool,
    key: bool,
    #[serde(skip)]
    base: String,
    #[serde(skip)]
    length: i32,
    #[serde(skip)]
    precision: u16,
    #[serde(skip)]
    scale: u16,
    #[serde(skip)]
    version: bool,
    #[serde(skip)]
    default_id: i32,
}
#[derive(Debug, PartialEq, Eq)]
struct Metadata {
    object_id: i32,
    revision: String,
    key_index: i32,
    columns: Vec<Column>,
    key: Vec<usize>,
    version: Option<usize>,
}
#[derive(Clone, Serialize)]
pub struct EditRow {
    pub(super) id: String,
    pub(super) values: Vec<DbValue>,
}
#[derive(Clone, Serialize)]
pub struct Page {
    pub(super) id: String,
    schema: String,
    table: String,
    columns: Vec<Column>,
    pub(super) rows: Vec<EditRow>,
    more: bool,
}
struct Snapshot {
    page: Page,
    metadata: Metadata,
    originals: Vec<Vec<DbValue>>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Input {
    Default,
    Null,
    Value { text: String },
}
#[derive(Deserialize, Serialize)]
pub struct Field {
    pub(super) column: usize,
    pub(super) value: Input,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Insert { values: Vec<Field> },
    Update { row_id: String, values: Vec<Field> },
    Delete { row_id: String },
}
#[derive(Deserialize, Serialize)]
pub struct ApplyRequest {
    pub(super) snapshot_id: String,
    pub(super) changes: Vec<Change>,
}
#[derive(Debug, Serialize)]
pub struct Failure {
    pub(super) code: E,
    pub(super) server_code: Option<i32>,
    pub(super) change_index: Option<usize>,
}
impl From<E> for Failure {
    fn from(code: E) -> Self {
        Self {
            code,
            server_code: None,
            change_index: None,
        }
    }
}
impl From<mssql_tds::error::Error> for Failure {
    fn from(error: mssql_tds::error::Error) -> Self {
        let server_code = if let mssql_tds::error::Error::SqlServerError { diagnostics } = &error {
            diagnostics
                .errors
                .first()
                .and_then(|item| i32::try_from(item.number).ok())
        } else {
            None
        };
        Self {
            code: classify(error),
            server_code,
            change_index: None,
        }
    }
}
#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyResult {
    Committed { rows: Vec<Option<Vec<DbValue>>> },
    Rejected { failure: Failure },
    Unknown { failure: Failure },
}

type Rows = Vec<Vec<DbValue>>;
type Parameters = Vec<RpcParameter>;

fn quote(name: &Identifier) -> Result<String, E> {
    name.quoted(Engine::SqlServer)
}
fn target(schema: &str, table: &str) -> Result<String, E> {
    Ok(format!(
        "{}.{}",
        quote(&Identifier::new(schema)?)?,
        quote(&Identifier::new(table)?)?
    ))
}
fn bind(parameters: &mut Parameters, value: SqlType) -> String {
    let marker = format!("@P{}", parameters.len() + 1);
    parameters.push(RpcParameter::new(
        Some(marker.clone()),
        StatusFlags::NONE,
        value,
    ));
    marker
}
fn unicode(value: &str) -> SqlType {
    SqlType::NVarcharMax(Some(SqlString::from_utf8_string(value.to_owned())))
}
fn binary(value: &DbValue) -> Result<SqlType, E> {
    match value {
        DbValue::Binary { base64 } => Ok(SqlType::VarBinaryMax(Some(
            STANDARD.decode(base64).map_err(|_| E::DataConversion)?,
        ))),
        _ => Err(E::DataConversion),
    }
}

async fn read(
    client: &mut TdsClient,
    sql: String,
    parameters: Parameters,
    max_rows: usize,
    max_sets: usize,
) -> Result<Vec<Rows>, Failure> {
    let options = ExecuteOptions::new().timeout_secs(5);
    let mut result = if parameters.is_empty() {
        client.execute(sql, options).await?
    } else {
        client
            .execute_sp_executesql(sql, parameters, options)
            .await?
    };
    let mut sets = Vec::new();
    let mut bytes = 0usize;
    let mut count = 0usize;
    loop {
        match result {
            StatementResult::Rows => {
                let columns = client.get_metadata().clone();
                if sets.len() >= max_sets || columns.len() > MAX_COLUMNS * 2 {
                    return Err(E::LimitReached.into());
                }
                // These types do not provide the bounded PLP cursor used below.
                if columns.iter().any(|c| {
                    use mssql_tds::datatypes::sqldatatypes::TdsDataType::*;
                    matches!(c.data_type, Text | NText | Image)
                }) {
                    return Err(E::ReadOnlyResult.into());
                }
                let mut rows = Vec::new();
                while client.next_row_cursor().await? {
                    count += 1;
                    if count > max_rows {
                        return Err(E::LimitReached.into());
                    }
                    let mut row = Vec::with_capacity(columns.len());
                    for (index, column) in columns.iter().enumerate() {
                        let (value, truncated) = read_cell(client, index, column).await?;
                        if truncated {
                            return Err(E::LimitReached.into());
                        }
                        bytes += collab_database::encoded_size(&value, MAX_BYTES)?;
                        if bytes > MAX_BYTES {
                            return Err(E::LimitReached.into());
                        }
                        row.push(value);
                    }
                    rows.push(row);
                }
                sets.push(rows);
            }
            StatementResult::End => break,
            _ => {}
        }
        result = client.advance().await?;
    }
    client.close_query().await?;
    if client.take_info_messages_truncated() {
        return Err(E::LimitReached.into());
    }
    Ok(sets)
}
pub(super) async fn command(client: &mut TdsClient, sql: String) -> Result<(), Failure> {
    read(client, sql, vec![], 0, 0).await?;
    Ok(())
}

fn integer(value: &DbValue) -> Result<i32, E> {
    if let DbValue::Integer { decimal } = value {
        decimal.parse().map_err(|_| E::DataConversion)
    } else {
        Err(E::DataConversion)
    }
}
fn text(value: &DbValue) -> Result<&str, E> {
    if let DbValue::Text { value } = value {
        Ok(value)
    } else {
        Err(E::DataConversion)
    }
}

async fn metadata(client: &mut TdsClient, schema: &str, table: &str) -> Result<Metadata, Failure> {
    let sql = "
DECLARE @object int = (
    SELECT t.object_id FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
    WHERE s.name=@P1 AND t.name=@P2 AND t.is_ms_shipped=0 AND t.is_memory_optimized=0
      AND t.temporal_type<>1
      AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+N'.'+QUOTENAME(t.name),N'OBJECT',N'VIEW DEFINITION')=1
      AND NOT EXISTS (SELECT 1 FROM sys.triggers tr WHERE tr.parent_id=t.object_id
        AND tr.is_instead_of_trigger=1 AND tr.is_disabled=0));
DECLARE @key int = (
    SELECT TOP (1) i.index_id FROM sys.indexes i
    WHERE i.object_id=@object AND i.is_unique=1 AND i.is_disabled=0 AND i.is_hypothetical=0
      AND i.has_filter=0 AND i.type IN (1,2)
      AND EXISTS (SELECT 1 FROM sys.index_columns k WHERE k.object_id=i.object_id
        AND k.index_id=i.index_id AND k.key_ordinal>0)
      AND NOT EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c
        ON c.object_id=k.object_id AND c.column_id=k.column_id WHERE k.object_id=i.object_id
        AND k.index_id=i.index_id AND k.key_ordinal>0 AND (c.is_nullable=1 OR c.is_computed=1))
    ORDER BY i.is_primary_key DESC,i.index_id);
SELECT TOP (33) o.object_id, CONVERT(nvarchar(32),o.modify_date,126), @key, c.name,
  CAST(TYPE_NAME(c.system_type_id) AS nvarchar(128)), CAST(c.max_length AS int),
  CAST(c.precision AS int), CAST(c.scale AS int), CAST(c.is_nullable AS int),
  CASE WHEN c.is_identity=1 OR c.is_computed=1 OR c.generated_always_type<>0 OR c.system_type_id=189 THEN 1 ELSE 0 END,
  c.default_object_id,
  CAST(COALESCE(k.key_ordinal,0) AS int),
  CASE WHEN c.user_type_id<>c.system_type_id OR c.is_hidden=1 OR c.is_masked=1
    OR c.encryption_type IS NOT NULL OR c.is_column_set=1 THEN 1 ELSE 0 END
FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id
LEFT JOIN sys.index_columns k ON k.object_id=c.object_id AND k.column_id=c.column_id
  AND k.index_id=@key AND k.key_ordinal>0
WHERE c.object_id=@object AND @key IS NOT NULL ORDER BY c.column_id";
    let mut parameters = Vec::new();
    bind(&mut parameters, unicode(schema));
    bind(&mut parameters, unicode(table));
    let mut sets = read(client, sql.into(), parameters, MAX_COLUMNS + 1, 1).await?;
    let rows = sets.pop().ok_or(E::ReadOnlyResult)?;
    let first = rows.first().ok_or(E::ReadOnlyResult)?;
    if rows.len() > MAX_COLUMNS || first.len() != 13 {
        return Err(E::ReadOnlyResult.into());
    }
    let mut result = Metadata {
        object_id: integer(&first[0])?,
        revision: text(&first[1])?.into(),
        key_index: integer(&first[2])?,
        columns: Vec::new(),
        key: Vec::new(),
        version: None,
    };
    let mut key = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        if row.len() != 13 || integer(&row[12])? != 0 {
            return Err(E::ReadOnlyResult.into());
        }
        let base = text(&row[4])?;
        let length = integer(&row[5])?;
        let precision = u16::try_from(integer(&row[6])?).map_err(|_| E::DataConversion)?;
        let scale = u16::try_from(integer(&row[7])?).map_err(|_| E::DataConversion)?;
        let (input, engine_type) = column_type(base, length, precision, scale)?;
        let ordinal = integer(&row[11])?;
        if ordinal > 0 {
            key.push((ordinal, index));
        }
        let version = base == "timestamp";
        if version {
            result.version = Some(index);
        }
        result.columns.push(Column {
            name: Identifier::new(text(&row[3])?)?,
            engine_type,
            input,
            nullable: integer(&row[8])? != 0,
            generated: integer(&row[9])? != 0,
            default_id: integer(&row[10])?,
            has_default: integer(&row[10])? != 0,
            key: ordinal > 0,
            base: base.into(),
            length,
            precision,
            scale,
            version,
        });
    }
    key.sort_unstable();
    result.key = key.into_iter().map(|(_, index)| index).collect();
    if result.key.is_empty()
        || result
            .key
            .iter()
            .any(|&index| result.columns[index].nullable)
    {
        return Err(E::ReadOnlyResult.into());
    }
    Ok(result)
}

fn column_type(
    base: &str,
    length: i32,
    precision: u16,
    scale: u16,
) -> Result<(InputKind, String), E> {
    use InputKind::*;
    let (input, declaration) = match base {
        "tinyint" | "smallint" | "int" | "bigint" => (Integer, base.into()),
        "bit" => (Boolean, base.into()),
        "decimal" | "numeric" if (1..=38).contains(&precision) && scale <= precision => {
            (Decimal, format!("{base}({precision},{scale})"))
        }
        "nvarchar" | "nchar" if (2..=2048).contains(&length) && length % 2 == 0 => {
            (Text, format!("{base}({})", length / 2))
        }
        "varchar" | "char" if (1..=2048).contains(&length) => (Text, format!("{base}({length})")),
        "binary" | "varbinary" if (1..=2048).contains(&length) => {
            (Binary, format!("{base}({length})"))
        }
        "timestamp" => (Binary, base.into()),
        "uniqueidentifier" => (Uuid, base.into()),
        "date" => (Date, base.into()),
        "time" if scale <= 7 => (Time, format!("{base}({scale})")),
        "datetime2" if scale <= 7 => (DateTime, format!("{base}({scale})")),
        "datetimeoffset" if scale <= 7 => (DateTimeOffset, format!("{base}({scale})")),
        _ => return Err(E::ReadOnlyResult),
    };
    Ok((input, declaration))
}

fn quoted_columns(metadata: &Metadata) -> Result<Vec<String>, E> {
    metadata
        .columns
        .iter()
        .map(|column| quote(&column.name))
        .collect()
}
fn raw(column: &str) -> String {
    format!("CONVERT(varbinary(2048),{column})")
}

pub(super) async fn load(
    operation: Operation,
    live: Arc<Live>,
    request: BrowseRequest,
) -> Result<Page, Failure> {
    let target = target(&request.schema, &request.table)?;
    let mut guard = live.client.lock().await;
    let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
    let snapshot = tokio::time::timeout(Duration::from_secs(12), async {
        let metadata = metadata(client, &request.schema, &request.table).await?;
        let columns = quoted_columns(&metadata)?;
        let raw_columns = columns.iter().map(|column| raw(column)).collect::<Vec<_>>();
        let order = metadata
            .key
            .iter()
            .map(|&i| columns[i].as_str())
            .collect::<Vec<_>>()
            .join(",");
        let (filter, parameters) = browse_filter(&request)?;
        let sql = format!(
            "SELECT TOP ({}) {},{} FROM {target}{filter} ORDER BY {order}",
            PAGE_ROWS + 1,
            columns.join(","),
            raw_columns.join(",")
        );
        let mut sets = read(client, sql, parameters, PAGE_ROWS + 1, 1).await?;
        let rows = sets.pop().ok_or(E::ReadOnlyResult)?;
        let more = rows.len() > PAGE_ROWS;
        let mut original_rows = Vec::new();
        let mut view_rows = Vec::new();
        for mut row in rows.into_iter().take(PAGE_ROWS) {
            if row.len() != columns.len() * 2 {
                return Err(E::SchemaConflict.into());
            }
            original_rows.push(row.split_off(columns.len()));
            if row.iter().any(|value| value.validate_parameter().is_err()) {
                return Err(E::ReadOnlyResult.into());
            }
            view_rows.push(EditRow {
                id: Uuid::new_v4().to_string(),
                values: row,
            });
        }
        Ok::<_, Failure>(Snapshot {
            page: Page {
                id: Uuid::new_v4().to_string(),
                schema: request.schema,
                table: request.table,
                columns: metadata.columns.clone(),
                rows: view_rows,
                more,
            },
            metadata,
            originals: original_rows,
        })
    })
    .await
    .map_err(|_| E::Timeout)??;
    let page = snapshot.page.clone();
    operation.runtime.state.lock().snapshot = Some(Arc::new(snapshot));
    Ok(page)
}

fn validate_temporal(input: &InputKind, value: &str, scale: u16) -> bool {
    use InputKind::*;
    // chrono handles up to nanoseconds. SQL Server supports 100 ns ticks.
    let fraction = value.split_once('.').map_or(0, |(_, after)| {
        after.bytes().take_while(u8::is_ascii_digit).count()
    });
    if fraction > usize::from(scale) {
        return false;
    }
    match input {
        Date => value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        Time => chrono::NaiveTime::parse_from_str(value, "%H:%M:%S%.f").is_ok(),
        DateTime => chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").is_ok(),
        DateTimeOffset => chrono::DateTime::parse_from_rfc3339(value).is_ok(),
        _ => false,
    }
}
fn input_value(column: &Column, value: Input, parameters: &mut Parameters) -> Result<String, E> {
    let Input::Value { text } = value else {
        return match value {
            Input::Default if column.has_default || column.nullable => Ok("DEFAULT".into()),
            Input::Null if column.nullable => Ok("NULL".into()),
            _ => Err(E::InvalidParameter),
        };
    };
    if text.len() > 8192 {
        return Err(E::LimitReached);
    }
    use InputKind::*;
    let parameter = match column.input {
        Integer => {
            let number = text.parse::<i64>().map_err(|_| E::InvalidParameter)?;
            let fits = match column.base.as_str() {
                "tinyint" => u8::try_from(number).is_ok(),
                "smallint" => i16::try_from(number).is_ok(),
                "int" => i32::try_from(number).is_ok(),
                _ => true,
            };
            if !fits {
                return Err(E::InvalidParameter);
            }
            SqlType::BigInt(Some(number))
        }
        Decimal => {
            let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
            if fraction.len() > usize::from(column.scale) {
                return Err(E::InvalidParameter);
            }
            let normalized = if column.scale == 0 {
                if text.contains('.') {
                    return Err(E::InvalidParameter);
                }
                whole.to_owned()
            } else {
                format!(
                    "{whole}.{fraction:0<width$}",
                    width = usize::from(column.scale)
                )
            };
            DbValue::Decimal {
                decimal: normalized.clone(),
                precision: column.precision,
                scale: column.scale,
            }
            .validate_parameter()?;
            unicode(&normalized)
        }
        Boolean => match text.as_str() {
            "true" => SqlType::Bit(Some(true)),
            "false" => SqlType::Bit(Some(false)),
            _ => return Err(E::InvalidParameter),
        },
        Text => {
            let units = if column.base.starts_with('n') {
                text.encode_utf16().count() * 2
            } else {
                // ASCII is representable without loss in supported SQL Server code pages.
                if !text.is_ascii() {
                    return Err(E::InvalidParameter);
                }
                text.len()
            };
            if units > column.length as usize || text.contains('\0') {
                return Err(E::InvalidParameter);
            }
            unicode(&text)
        }
        Binary => {
            let bytes = STANDARD.decode(&text).map_err(|_| E::InvalidParameter)?;
            if bytes.len() > column.length as usize {
                return Err(E::InvalidParameter);
            }
            SqlType::VarBinaryMax(Some(bytes))
        }
        Uuid => unicode(
            &uuid::Uuid::parse_str(&text)
                .map_err(|_| E::InvalidParameter)?
                .to_string(),
        ),
        Date | Time | DateTime | DateTimeOffset => {
            if !validate_temporal(&column.input, &text, column.scale) {
                return Err(E::InvalidParameter);
            }
            unicode(&text)
        }
    };
    let marker = bind(parameters, parameter);
    Ok(format!("CONVERT({}, {marker})", column.engine_type))
}

struct Statement {
    sql: String,
    parameters: Parameters,
    returns_row: bool,
}

fn fields(
    metadata: &Metadata,
    fields: Vec<Field>,
    inserting: bool,
    parameters: &mut Parameters,
) -> Result<Vec<(usize, String)>, E> {
    if fields.len() > metadata.columns.len() {
        return Err(E::InvalidParameter);
    }
    let mut used = HashSet::new();
    let mut values = Vec::new();
    for field in fields {
        let column = metadata
            .columns
            .get(field.column)
            .ok_or(E::InvalidParameter)?;
        if column.generated || (!inserting && column.key) || !used.insert(field.column) {
            return Err(E::ReadOnlyResult);
        }
        if inserting && matches!(field.value, Input::Default) {
            if !column.has_default && !column.nullable {
                return Err(E::InvalidParameter);
            }
            continue;
        }
        values.push((field.column, input_value(column, field.value, parameters)?));
    }
    if inserting
        && metadata.columns.iter().enumerate().any(|(index, column)| {
            !column.generated && !column.nullable && !column.has_default && !used.contains(&index)
        })
    {
        return Err(E::InvalidParameter);
    }
    Ok(values)
}

fn exact(left: &str, right: &str) -> String {
    format!("({left}={right} AND DATALENGTH({left})=DATALENGTH({right}))")
}
fn locate(
    snapshot: &Snapshot,
    row_id: &str,
    columns: &[String],
    parameters: &mut Parameters,
    used: &mut HashSet<String>,
) -> Result<String, E> {
    if !used.insert(row_id.to_owned()) {
        return Err(E::InvalidParameter);
    }
    let index = snapshot
        .page
        .rows
        .iter()
        .position(|row| row.id == row_id)
        .ok_or(E::WrongBinding)?;
    let metadata = &snapshot.metadata;
    let originals = &snapshot.originals[index];
    let predicates: Vec<usize> = if let Some(version) = metadata.version {
        metadata
            .key
            .iter()
            .copied()
            .chain(std::iter::once(version))
            .collect()
    } else {
        (0..columns.len()).collect()
    };
    predicates
        .into_iter()
        .map(|index| {
            let column = format!("t.{}", columns[index]);
            if originals[index] == DbValue::Null {
                Ok(format!("{column} IS NULL"))
            } else {
                let marker = bind(parameters, binary(&originals[index])?);
                Ok(exact(&raw(&column), &marker))
            }
        })
        .collect::<Result<Vec<_>, E>>()
        .map(|parts| parts.join(" AND "))
}

fn statements(snapshot: &Snapshot, changes: Vec<Change>) -> Result<Vec<Statement>, Failure> {
    if changes.is_empty() || changes.len() > MAX_CHANGES {
        return Err(E::LimitReached.into());
    }
    let target = target(&snapshot.page.schema, &snapshot.page.table)?;
    let metadata = &snapshot.metadata;
    let columns = quoted_columns(metadata)?;
    let keys = metadata
        .key
        .iter()
        .enumerate()
        .map(|(position, &index)| (format!("k{position}"), &columns[index]))
        .collect::<Vec<_>>();
    let declaration = keys
        .iter()
        .map(|(name, _)| format!("{name} varbinary(2048) NOT NULL"))
        .collect::<Vec<_>>()
        .join(",");
    let output = |prefix: &str| {
        keys.iter()
            .map(|(_, column)| raw(&format!("{prefix}.{column}")))
            .collect::<Vec<_>>()
            .join(",")
    };
    let join = keys
        .iter()
        .map(|(name, column)| exact(&raw(&format!("t.{column}")), &format!("k.{name}")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let selected = columns
        .iter()
        .map(|column| format!("t.{column}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut used = HashSet::new();
    changes.into_iter().enumerate().map(|(index, change)| {
        let build = || -> Result<Statement, E> {
            let mut parameters = Vec::new();
            let (dml, returns_row) = match change {
                Change::Insert { values } => {
                    let values = fields(metadata, values, true, &mut parameters)?;
                    let keys = output("inserted");
                    if values.is_empty() {
                        (format!("INSERT INTO {target} OUTPUT {keys} INTO @changed DEFAULT VALUES"), true)
                    } else {
                        let names = values.iter().map(|(column, _)| columns[*column].as_str()).collect::<Vec<_>>().join(",");
                        let values = values.iter().map(|(_, value)| value.as_str()).collect::<Vec<_>>().join(",");
                        (format!("INSERT INTO {target} ({names}) OUTPUT {keys} INTO @changed VALUES ({values})"), true)
                    }
                }
                Change::Update { row_id, values } => {
                    let values = fields(metadata, values, false, &mut parameters)?;
                    if values.is_empty() { return Err(E::InvalidParameter); }
                    let set = values.iter().map(|(column, value)| format!("{}={value}", columns[*column])).collect::<Vec<_>>().join(",");
                    let predicate = locate(snapshot, &row_id, &columns, &mut parameters, &mut used)?;
                    let keys = output("inserted");
                    (format!("UPDATE t SET {set} OUTPUT {keys} INTO @changed FROM {target} t WHERE {predicate}"), true)
                }
                Change::Delete { row_id } => {
                    let predicate = locate(snapshot, &row_id, &columns, &mut parameters, &mut used)?;
                    let keys = output("deleted");
                    (format!("DELETE t OUTPUT {keys} INTO @changed FROM {target} t WHERE {predicate}"), false)
                }
            };
            let result = if returns_row {
                format!("SELECT TOP (2) {selected} FROM {target} t JOIN @changed k ON {join}")
            } else {
                format!("SELECT CAST(COUNT_BIG(*) AS int) FROM {target} t JOIN @changed k ON {join}")
            };
            Ok(Statement {
                sql: format!("DECLARE @changed table ({declaration}); {dml}; \
                    IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 THROW 51043,N'Unexpected transaction state',1; \
                    SELECT CAST(COUNT_BIG(*) AS int) FROM @changed; {result};"),
                parameters,
                returns_row,
            })
        };
        build().map_err(|code| Failure { code, server_code: None, change_index: Some(index) })
    }).collect()
}

async fn mutate(
    operation: &mut Operation,
    client: &mut TdsClient,
    snapshot: &Snapshot,
    statements: Vec<Statement>,
) -> Result<Vec<Option<Vec<DbValue>>>, Failure> {
    command(
        client,
        "SET LOCK_TIMEOUT 3000; SET XACT_ABORT ON; SET NOCOUNT ON; BEGIN TRANSACTION;".into(),
    )
    .await?;
    let table = target(&snapshot.page.schema, &snapshot.page.table)?;
    // Serialize the short Apply transaction and hold object identity stable from
    // catalog validation through the last mutation. An empty table is locked too.
    read(
        client,
        format!("SELECT TOP (1) 1 FROM {table} WITH (TABLOCKX,HOLDLOCK)"),
        vec![],
        1,
        1,
    )
    .await?;
    let current = metadata(client, &snapshot.page.schema, &snapshot.page.table)
        .await
        .map_err(|failure| {
            if failure.code == E::ReadOnlyResult {
                E::SchemaConflict.into()
            } else {
                failure
            }
        })?;
    if current != snapshot.metadata {
        return Err(E::SchemaConflict.into());
    }
    let mut rows = Vec::with_capacity(statements.len());
    let mut bytes = 0;
    for (index, statement) in statements.into_iter().enumerate() {
        operation.unresolved = true;
        let result = async {
            let sets = read(client, statement.sql, statement.parameters, 3, 2).await?;
            let [count, returned] = sets.as_slice() else {
                return Err(E::RowConflict.into());
            };
            if count.len() != 1 || count[0].len() != 1 || integer(&count[0][0])? != 1 {
                return Err(E::RowConflict.into());
            }
            if returned.len() != 1 {
                return Err(E::RowConflict.into());
            }
            if statement.returns_row {
                if returned[0].len() != current.columns.len() {
                    return Err(E::RowConflict.into());
                }
                bytes += collab_database::encoded_size(&returned[0], MAX_BYTES)?;
                if bytes > MAX_BYTES {
                    return Err(E::LimitReached.into());
                }
                Ok(Some(returned[0].clone()))
            } else {
                if returned[0].len() != 1 || integer(&returned[0][0])? != 0 {
                    return Err(E::RowConflict.into());
                }
                Ok(None)
            }
        }
        .await;
        rows.push(result.map_err(|mut failure: Failure| {
            failure.change_index = Some(index);
            failure
        })?);
    }
    Ok(rows)
}

pub(super) async fn apply(
    operation: Operation,
    live: Arc<Live>,
    request: ApplyRequest,
) -> Result<ApplyResult, Failure> {
    apply_inner(operation, live, request, false).await
}

#[cfg(test)]
pub(super) async fn apply_with_lost_ack(
    operation: Operation,
    live: Arc<Live>,
    request: ApplyRequest,
) -> Result<ApplyResult, Failure> {
    apply_inner(operation, live, request, true).await
}

async fn apply_inner(
    mut operation: Operation,
    live: Arc<Live>,
    request: ApplyRequest,
    lose_ack: bool,
) -> Result<ApplyResult, Failure> {
    collab_database::encoded_size(&request, MAX_BYTES)?;
    let snapshot = operation
        .runtime
        .state
        .lock()
        .snapshot
        .clone()
        .filter(|snapshot| snapshot.page.id == request.snapshot_id)
        .ok_or(E::WrongBinding)?;
    let statements = statements(&snapshot, request.changes)?;
    let mut guard = live.client.lock().await;
    let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        mutate(&mut operation, client, &snapshot, statements),
    )
    .await
    .unwrap_or_else(|_| Err(E::Timeout.into()));
    let response = match result {
        Ok(rows) => {
            // A timed-out or lost COMMIT acknowledgement cannot be retried.
            let commit = tokio::time::timeout(Duration::from_secs(6), command(client,
                "IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 THROW 51043,N'Unexpected transaction state',1; COMMIT TRANSACTION;".into()
            )).await.unwrap_or_else(|_| Err(E::Timeout.into()));
            match commit {
                Ok(()) if lose_ack => ApplyResult::Unknown {
                    failure: E::ConnectionFailed.into(),
                },
                Ok(()) => {
                    operation.unresolved = false;
                    operation.runtime.state.lock().snapshot = None;
                    ApplyResult::Committed { rows }
                }
                Err(failure) => ApplyResult::Unknown { failure },
            }
        }
        Err(failure) => {
            // Some driver errors leave a response in flight. Drain before attempting
            // rollback. The dedicated socket is dropped even if settlement fails.
            let rollback = tokio::time::timeout(Duration::from_secs(6), async {
                client.cancel_query(2).await?;
                command(client, "IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;".into()).await
            })
            .await
            .is_ok_and(|result| result.is_ok());
            if operation.unresolved
                && (!rollback || matches!(failure.server_code, Some(266 | 3609 | 51043)))
            {
                ApplyResult::Unknown { failure }
            } else {
                operation.unresolved = false;
                if matches!(failure.code, E::RowConflict | E::SchemaConflict) {
                    operation.runtime.state.lock().snapshot = None;
                }
                ApplyResult::Rejected { failure }
            }
        }
    };
    // Drop the transport before releasing the operation's disposal guard.
    guard.take();
    Ok(response)
}
