//! Optimistic row editing for explicitly keyed, ordinary SQLite tables.
use super::{
    classify, filter, quoted, result_cell, BrowseRequest, Connection, Session, Value, ValueRef, E,
};
use crate::database::edit::{
    ApplyRequest, ApplyResult, Change, Column, EditRow, Failure, Field, Input, Page, SqliteStorage,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use collab_database::{DbValue, Identifier};
use rusqlite::{params_from_iter, OptionalExtension, TransactionBehavior};
use std::{
    collections::HashSet,
    sync::{atomic::Ordering, Arc},
};
use uuid::Uuid;

struct FieldInfo {
    name: String,
    declared_type: String,
    nullable: bool,
    default: bool,
    pk: i32,
    generated: bool,
}
struct Table {
    target: String,
    fields: Vec<FieldInfo>,
    columns: Vec<String>,
    key: Vec<usize>,
    revision: i64,
    automatic_key: Option<usize>,
}
pub(super) struct Snapshot {
    page: Page,
    table: String,
    revision: i64,
    rows: Vec<Vec<Value>>,
}

impl Table {
    fn read(connection: &Connection, table: &str) -> Result<Self, E> {
        let target = format!("main.{}", quoted(table)?);
        let without_rowid: bool = connection.query_row(
            "SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?1 AND type='table' AND name NOT GLOB 'sqlite_*'",
            [table], |row| row.get(0),
        ).optional().map_err(classify)?.ok_or(E::ReadOnlyResult)?;
        let revision = connection
            .query_row("PRAGMA main.schema_version", [], |row| row.get(0))
            .map_err(classify)?;
        let mut statement = connection.prepare(
            "SELECT name,type,NOT [notnull],dflt_value IS NOT NULL,pk,hidden FROM pragma_table_xinfo(?1,'main') ORDER BY cid LIMIT 33"
        ).map_err(classify)?;
        let mut fields = statement
            .query_map([table], |row| {
                Ok(FieldInfo {
                    name: row.get(0)?,
                    declared_type: row.get(1)?,
                    nullable: row.get(2)?,
                    default: row.get(3)?,
                    pk: row.get(4)?,
                    generated: row.get::<_, i32>(5)? != 0,
                })
            })
            .map_err(classify)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(classify)?;
        if fields.is_empty() || fields.len() > 32 {
            return Err(E::ReadOnlyResult);
        }
        let mut key: Vec<_> = (0..fields.len())
            .filter(|&index| fields[index].pk > 0)
            .collect();
        key.sort_by_key(|&index| fields[index].pk);
        let mut automatic_key = None;
        if !without_rowid
            && key.len() == 1
            && fields[key[0]].declared_type.eq_ignore_ascii_case("INTEGER")
        {
            let indexed: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1,'main') WHERE origin='pk')",
                    [table],
                    |row| row.get(0),
                )
                .map_err(classify)?;
            if !indexed {
                automatic_key = Some(key[0]);
            }
        }
        if without_rowid || automatic_key.is_some() {
            for &index in &key {
                fields[index].nullable = false;
            }
        }
        if key.is_empty()
            || key
                .iter()
                .any(|&index| fields[index].nullable || fields[index].generated)
        {
            key = Self::unique_key(connection, table, &fields)?.ok_or(E::ReadOnlyResult)?;
        }
        let columns = fields
            .iter()
            .map(|field| quoted(&field.name))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            target,
            fields,
            columns,
            key,
            revision,
            automatic_key,
        })
    }
    fn unique_key(
        connection: &Connection,
        table: &str,
        fields: &[FieldInfo],
    ) -> Result<Option<Vec<usize>>, E> {
        let mut statement = connection.prepare(
            "SELECT name FROM pragma_index_list(?1,'main') WHERE [unique] AND NOT partial ORDER BY seq LIMIT 64"
        ).map_err(classify)?;
        let indexes = statement
            .query_map([table], |row| row.get::<_, String>(0))
            .map_err(classify)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(classify)?;
        let mut columns = connection
            .prepare(
                "SELECT cid FROM pragma_index_xinfo(?1,'main') WHERE key ORDER BY seqno LIMIT 33",
            )
            .map_err(classify)?;
        for index in indexes {
            let candidates = columns
                .query_map([index], |row| row.get::<_, i32>(0))
                .map_err(classify)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(classify)?;
            let key = candidates
                .into_iter()
                .map(|cid| {
                    usize::try_from(cid).ok().filter(|&cid| {
                        fields
                            .get(cid)
                            .is_some_and(|field| !field.nullable && !field.generated)
                    })
                })
                .collect::<Option<Vec<_>>>();
            if let Some(key) = key.filter(|key| !key.is_empty() && key.len() <= 32) {
                return Ok(Some(key));
            }
        }
        Ok(None)
    }
    fn columns_sql(&self) -> String {
        self.columns.join(",")
    }
    fn predicate(
        &self,
        indexes: impl IntoIterator<Item = usize>,
        original: &[Value],
        parameters: &mut Vec<Value>,
    ) -> String {
        indexes
            .into_iter()
            .map(|index| {
                let column = &self.columns[index];
                let storage = match &original[index] {
                    Value::Null => "null",
                    Value::Integer(_) => "integer",
                    Value::Real(_) => "real",
                    Value::Text(_) => "text",
                    Value::Blob(_) => "blob",
                };
                parameters.push(original[index].clone());
                format!(
                    "(typeof({column})='{storage}' AND +{column} COLLATE BINARY IS ?{})",
                    parameters.len()
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}
fn read_row(row: &rusqlite::Row<'_>, count: usize) -> Result<(Vec<Value>, Vec<DbValue>), E> {
    let mut originals = Vec::with_capacity(count);
    let mut values = Vec::with_capacity(count);
    for index in 0..count {
        let cell = row.get_ref(index).map_err(classify)?;
        let (display, truncated) = result_cell(cell)?;
        if truncated || matches!(display, DbValue::Opaque { .. }) {
            return Err(E::ReadOnlyResult);
        }
        let native = match cell {
            ValueRef::Text(bytes) => Value::Text(
                std::str::from_utf8(bytes)
                    .map_err(|_| E::DataConversion)?
                    .into(),
            ),
            ValueRef::Null => Value::Null,
            ValueRef::Integer(value) => Value::Integer(value),
            ValueRef::Real(value) => Value::Real(value),
            ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
        };
        originals.push(native);
        values.push(display);
    }
    Ok((originals, values))
}

impl Session {
    pub(in crate::database) fn edit_load(&self, request: BrowseRequest) -> Result<Page, Failure> {
        if self.view.read_only {
            return Err(E::DatabaseReadOnly.into());
        }
        let (where_sql, parameters) = filter(&request)?;
        self.snapshot.lock().take();
        let snapshot = self.inspect(|connection| {
            if !connection.is_autocommit() {
                return Err(E::UnresolvedSession);
            }
            let table = Table::read(connection, &request.table)?;
            let order = table
                .key
                .iter()
                .map(|&index| table.columns[index].as_str())
                .collect::<Vec<_>>()
                .join(",");
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {} FROM {}{where_sql} ORDER BY {order} LIMIT 101",
                    table.columns_sql(),
                    table.target
                ))
                .map_err(classify)?;
            let mut cursor = statement
                .query(params_from_iter(parameters))
                .map_err(classify)?;
            let mut rows = Vec::new();
            let mut originals = Vec::new();
            let mut remaining = 1 << 20;
            let mut more = false;
            while let Some(row) = cursor.next().map_err(classify)? {
                if rows.len() == 100 {
                    more = true;
                    break;
                }
                let (native, values) = read_row(row, table.fields.len())?;
                let size = collab_database::encoded_size(&values, 256 << 10)?;
                if size > remaining {
                    more = true;
                    break;
                }
                remaining -= size;
                originals.push(native);
                rows.push(EditRow {
                    id: Uuid::new_v4().to_string(),
                    values,
                });
            }
            let columns = table
                .fields
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    Ok(Column::sqlite(
                        Identifier::new(&field.name)?,
                        field.declared_type.clone(),
                        field.nullable,
                        field.generated,
                        field.default || table.automatic_key == Some(index),
                        table.key.contains(&index),
                    ))
                })
                .collect::<Result<Vec<_>, E>>()?;
            Ok(Snapshot {
                page: Page::new("main".into(), request.table.clone(), columns, rows, more),
                table: request.table,
                revision: table.revision,
                rows: originals,
            })
        })?;
        let page = snapshot.page.clone();
        *self.snapshot.lock() = Some(Arc::new(snapshot));
        Ok(page)
    }

    pub(in crate::database) fn edit_apply(
        &self,
        request: ApplyRequest,
    ) -> Result<ApplyResult, Failure> {
        if self.view.read_only {
            return Err(E::DatabaseReadOnly.into());
        }
        collab_database::encoded_size(&request, 1 << 20)?;
        if request.changes.is_empty() || request.changes.len() > 128 {
            return Err(E::LimitReached.into());
        }
        let snapshot = self
            .snapshot
            .lock()
            .take()
            .filter(|snapshot| snapshot.page.id == request.snapshot_id)
            .ok_or(E::SchemaConflict)?;
        let outcome = self.inspect(|connection| {
            if !connection.is_autocommit() {
                return Err(E::UnresolvedSession);
            }
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(classify)?;
            let result = (|| {
                let table = Table::read(&transaction, &snapshot.table)?;
                if table.revision != snapshot.revision {
                    return Err(E::SchemaConflict.into());
                }
                let mut visited = HashSet::new();
                let mut rows = Vec::new();
                for (index, change) in request.changes.into_iter().enumerate() {
                    self.check_identity()?;
                    rows.push(
                        mutate(&transaction, &table, &snapshot, &mut visited, change).map_err(
                            |code| Failure {
                                code,
                                change_index: Some(index),
                                server_code: None,
                            },
                        )?,
                    );
                }
                collab_database::encoded_size(&rows, 1 << 20)?;
                Ok(rows)
            })();
            let (failure, uncertain) = match result {
                Ok(rows) => {
                    let commit = self
                        .check_identity()
                        .map_err(|code| (code, false))
                        .and_then(|()| {
                            transaction.execute_batch("COMMIT").map_err(|error| {
                                let uncertain = matches!(
                                    error.sqlite_error_code(),
                                    Some(
                                        rusqlite::ErrorCode::SystemIoFailure
                                            | rusqlite::ErrorCode::DatabaseCorrupt
                                    )
                                );
                                (classify(error), uncertain)
                            })
                        });
                    match commit {
                        Ok(()) => return Ok(ApplyResult::Committed { rows }),
                        Err((code, uncertain)) => (code.into(), uncertain),
                    }
                }
                Err(failure) => (failure, false),
            };
            // SQLITE_BUSY and deferred constraint failures can leave the
            // transaction open. Confirm rollback before making retry possible.
            let rollback_failed = transaction.finish().is_err();
            Ok(if uncertain || rollback_failed {
                self.edit_unknown.store(true, Ordering::Release);
                ApplyResult::Unknown { failure }
            } else {
                ApplyResult::Rejected { failure }
            })
        });
        Ok(match outcome {
            Ok(outcome) => outcome,
            Err(code) => ApplyResult::Rejected {
                failure: code.into(),
            },
        })
    }
}

fn parameters(
    table: &Table,
    fields: Vec<Field>,
    inserting: bool,
) -> Result<(Vec<String>, Vec<Value>), E> {
    let mut seen = HashSet::new();
    let mut columns = Vec::new();
    let mut values = Vec::new();
    for field in fields {
        let index = field.column;
        let info = table.fields.get(index).ok_or(E::InvalidParameter)?;
        if !seen.insert(index) || info.generated || (!inserting && table.key.contains(&index)) {
            return Err(E::InvalidParameter);
        }
        let value = match field.value {
            Input::Default
                if inserting
                    && (info.default || info.nullable || table.automatic_key == Some(index)) =>
            {
                continue
            }
            Input::Null if info.nullable => Value::Null,
            Input::SqliteValue { storage, text } if text.len() <= 24 << 10 => match storage {
                SqliteStorage::Integer => {
                    Value::Integer(text.parse().map_err(|_| E::InvalidParameter)?)
                }
                SqliteStorage::Real => Value::Real(
                    text.parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite())
                        .ok_or(E::InvalidParameter)?,
                ),
                SqliteStorage::Text if text.len() <= 16 << 10 => Value::Text(text),
                SqliteStorage::Binary => {
                    let data = STANDARD.decode(text).map_err(|_| E::InvalidParameter)?;
                    if data.len() > 16 << 10 {
                        return Err(E::LimitReached);
                    }
                    Value::Blob(data)
                }
                _ => return Err(E::LimitReached),
            },
            _ => return Err(E::InvalidParameter),
        };
        columns.push(table.columns[index].clone());
        values.push(value);
    }
    Ok((columns, values))
}

fn mutate(
    connection: &Connection,
    table: &Table,
    snapshot: &Snapshot,
    visited: &mut HashSet<String>,
    change: Change,
) -> Result<Option<Vec<DbValue>>, E> {
    let (sql, mut values, deleting) = match change {
        Change::Insert { values } => {
            let (columns, values) = parameters(table, values, true)?;
            let body = if columns.is_empty() {
                "DEFAULT VALUES".into()
            } else {
                let markers = (1..=columns.len())
                    .map(|index| format!("?{index}"))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("({}) VALUES ({markers})", columns.join(","))
            };
            (
                format!("INSERT INTO {} {body}", table.target),
                values,
                false,
            )
        }
        Change::Update { row_id, values } => {
            let original = original(snapshot, visited, row_id)?;
            let (columns, mut values) = parameters(table, values, false)?;
            if columns.is_empty() {
                return Err(E::InvalidParameter);
            }
            let assignments = columns
                .iter()
                .enumerate()
                .map(|(index, column)| format!("{column}=?{}", index + 1))
                .collect::<Vec<_>>()
                .join(",");
            let predicate = table.predicate(0..table.fields.len(), original, &mut values);
            (
                format!(
                    "UPDATE {} SET {assignments} WHERE {predicate}",
                    table.target
                ),
                values,
                false,
            )
        }
        Change::Delete { row_id } => {
            let original = original(snapshot, visited, row_id)?;
            let mut values = Vec::new();
            let predicate = table.predicate(0..table.fields.len(), original, &mut values);
            (
                format!("DELETE FROM {} WHERE {predicate}", table.target),
                values,
                true,
            )
        }
    };
    let (row, _) = single_row(
        connection,
        &format!("{sql} RETURNING {}", table.columns_sql()),
        &values,
        table.fields.len(),
    )?
    .ok_or(E::RowConflict)?;
    values.clear();
    let predicate = table.predicate(table.key.iter().copied(), &row, &mut values);
    let final_row = single_row(
        connection,
        &format!(
            "SELECT {} FROM {} WHERE {predicate} LIMIT 2",
            table.columns_sql(),
            table.target
        ),
        &values,
        table.fields.len(),
    )?;
    match (deleting, final_row) {
        (true, None) => Ok(None),
        (false, Some((_, row))) => Ok(Some(row)),
        _ => Err(E::RowConflict),
    }
}

fn original<'a>(
    snapshot: &'a Snapshot,
    visited: &mut HashSet<String>,
    row_id: String,
) -> Result<&'a [Value], E> {
    let index = snapshot
        .page
        .rows
        .iter()
        .position(|row| row.id == row_id)
        .ok_or(E::RowConflict)?;
    if !visited.insert(row_id) {
        return Err(E::InvalidParameter);
    }
    Ok(&snapshot.rows[index])
}

type Row = (Vec<Value>, Vec<DbValue>);
fn single_row(
    connection: &Connection,
    sql: &str,
    values: &[Value],
    count: usize,
) -> Result<Option<Row>, E> {
    let mut statement = connection.prepare(sql).map_err(classify)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(classify)?;
    let result = rows
        .next()
        .map_err(classify)?
        .map(|row| read_row(row, count))
        .transpose()?;
    if rows.next().map_err(classify)?.is_some() {
        return Err(E::RowConflict);
    }
    Ok(result)
}
