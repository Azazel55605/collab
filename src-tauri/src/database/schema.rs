//! Structured DDL. The renderer supplies identifiers and enum values, and
//! Apply executes a single native-issued preview scoped to the owning tab.
pub(super) mod network;

use super::{edit, sqlite, Network};
use collab_database::{ContractError as E, Engine, Identifier};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct Request {
    pub schema: String,
    pub table: String,
    pub change: Change,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    CreateTable {
        columns: Vec<Column>,
    },
    AddColumn {
        column: Column,
    },
    AddPrimaryKey {
        columns: Vec<String>,
    },
    CreateIndex {
        name: String,
        columns: Vec<String>,
        unique: bool,
    },
    RenameColumn {
        column: String,
        name: String,
    },
    DropColumn {
        column: String,
    },
}

#[derive(Deserialize)]
pub struct Column {
    name: String,
    data_type: DataType,
    nullable: bool,
    primary_key: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DataType {
    Integer,
    BigInteger,
    Decimal,
    Text,
    ShortText,
    Binary,
    DateTime,
}

#[derive(Clone, Serialize)]
pub struct Preview {
    pub(super) id: String,
    pub(super) sql: String,
    warnings: Vec<&'static str>,
    pub(super) destructive: bool,
}

pub(super) struct Pending {
    pub(super) preview: Preview,
    pub(super) request: Request,
    pub(super) stamp: [u8; 32],
}

#[derive(Default)]
pub(super) struct Draft(Mutex<Option<Pending>>);
impl Draft {
    pub(super) fn store(
        &self,
        request: Request,
        sql: String,
        stamp: [u8; 32],
        engine: Engine,
    ) -> Preview {
        let destructive = matches!(request.change, Change::DropColumn { .. });
        let mut warnings = vec![match engine {
            Engine::SqlServer => "SQL Server takes schema locks. Readers and writers may wait while this change runs.",
            Engine::Sqlite => "SQLite holds the database writer lock during this change.",
            Engine::MariaDb => "MariaDB DDL commits implicitly. Collab runs it in a separate session and cannot roll back a completed statement.",
        }];
        if matches!(
            request.change,
            Change::CreateIndex { .. } | Change::AddPrimaryKey { .. }
        ) {
            warnings.push("Building a key or index scans existing rows. Duplicate key values can prevent the change.");
        }
        if destructive {
            warnings.push(
                "This permanently removes the column and its values. SQLite rewrites the table.",
            );
        }
        let preview = Preview {
            id: Uuid::new_v4().to_string(),
            sql,
            warnings,
            destructive,
        };
        *self.0.lock() = Some(Pending {
            preview: preview.clone(),
            request,
            stamp,
        });
        preview
    }
    pub(super) fn take(&self, id: &str, confirm_loss: bool) -> Result<Pending, E> {
        let mut pending = self.0.lock();
        let plan = pending
            .as_ref()
            .filter(|plan| plan.preview.id == id)
            .ok_or(E::SchemaConflict)?;
        if plan.preview.destructive && !confirm_loss {
            return Err(E::InvalidParameter);
        }
        pending.take().ok_or(E::SchemaConflict)
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Outcome {
    Applied,
    Rejected { failure: edit::Failure },
    Unknown { failure: edit::Failure },
}
impl Outcome {
    pub(super) fn rejected(error: impl Into<edit::Failure>) -> Self {
        Self::Rejected {
            failure: error.into(),
        }
    }
    pub(super) fn unknown(error: impl Into<edit::Failure>) -> Self {
        Self::Unknown {
            failure: error.into(),
        }
    }
}

fn quote(name: &str, engine: Engine) -> Result<String, E> {
    if name.trim().is_empty()
        || name.chars().any(char::is_control)
        || (engine == Engine::Sqlite && name.to_ascii_lowercase().starts_with("sqlite_"))
    {
        return Err(E::InvalidIdentifier);
    }
    Identifier::new(name)?.quoted(engine)
}

fn columns(names: &[String], engine: Engine) -> Result<String, E> {
    if names.is_empty() || names.len() > 16 {
        return Err(E::InvalidParameter);
    }
    distinct(names.iter().map(String::as_str))?;
    names
        .iter()
        .map(|name| quote(name, engine))
        .collect::<Result<Vec<_>, _>>()
        .map(|names| names.join(", "))
}

fn distinct<'a>(names: impl Iterator<Item = &'a str>) -> Result<(), E> {
    let mut seen = HashSet::new();
    if names.map(str::to_lowercase).any(|name| !seen.insert(name)) {
        return Err(E::InvalidParameter);
    }
    Ok(())
}

impl Column {
    fn sql(&self, engine: Engine) -> Result<String, E> {
        use DataType::*;
        let data_type = match (engine, self.data_type) {
            (Engine::Sqlite, Integer | BigInteger) => "INTEGER",
            (Engine::Sqlite, Decimal | DateTime) => return Err(E::Unsupported),
            (Engine::Sqlite, Text | ShortText) => "TEXT",
            (Engine::Sqlite, Binary) => "BLOB",
            (_, Integer) => "INT",
            (_, BigInteger) => "BIGINT",
            (_, Decimal) => "DECIMAL(19,4)",
            (Engine::SqlServer, Text) => "NVARCHAR(MAX)",
            (Engine::SqlServer, ShortText) => "NVARCHAR(191)",
            (Engine::SqlServer, Binary) => "VARBINARY(MAX)",
            (Engine::SqlServer, DateTime) => "DATETIME2(6)",
            (Engine::MariaDb, Text) => "TEXT",
            (Engine::MariaDb, ShortText) => "VARCHAR(191)",
            (Engine::MariaDb, Binary) => "BLOB",
            (Engine::MariaDb, DateTime) => "DATETIME(6)",
        };
        let name = quote(&self.name, engine)?;
        let null = if self.nullable && !self.primary_key {
            "NULL"
        } else {
            "NOT NULL"
        };
        Ok(format!("{name} {data_type} {null}"))
    }
}

impl Request {
    pub(super) fn create(&self) -> bool {
        matches!(self.change, Change::CreateTable { .. })
    }

    pub(super) fn sql(&self, engine: Engine, database: &str) -> Result<String, E> {
        if (engine != Engine::SqlServer && self.schema != database)
            || (engine == Engine::SqlServer && self.table.starts_with('#'))
        {
            return Err(E::InvalidParameter);
        }
        let schema = quote(&self.schema, engine)?;
        let table = quote(&self.table, engine)?;
        let target = format!("{schema}.{table}");
        Ok(match &self.change {
            Change::CreateTable {
                columns: definitions,
            } => {
                if definitions.is_empty() || definitions.len() > 32 {
                    return Err(E::InvalidParameter);
                }
                distinct(definitions.iter().map(|column| column.name.as_str()))?;
                let keys = definitions
                    .iter()
                    .filter(|column| column.primary_key)
                    .map(|column| column.name.clone())
                    .collect::<Vec<_>>();
                let mut definitions = definitions
                    .iter()
                    .map(|column| column.sql(engine))
                    .collect::<Result<Vec<_>, _>>()?;
                if !keys.is_empty() {
                    definitions.push(format!("PRIMARY KEY ({})", columns(&keys, engine)?));
                }
                let suffix = if engine == Engine::MariaDb {
                    " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
                } else {
                    ""
                };
                format!("CREATE TABLE {target} ({}){suffix}", definitions.join(", "))
            }
            Change::AddColumn { column } => {
                if !column.nullable || column.primary_key {
                    return Err(E::Unsupported);
                }
                let keyword = if engine == Engine::SqlServer {
                    "ADD"
                } else {
                    "ADD COLUMN"
                };
                format!("ALTER TABLE {target} {keyword} {}", column.sql(engine)?)
            }
            Change::AddPrimaryKey { columns: key } if engine != Engine::Sqlite => {
                format!(
                    "ALTER TABLE {target} ADD PRIMARY KEY ({})",
                    columns(key, engine)?
                )
            }
            Change::CreateIndex {
                name,
                columns: indexed,
                unique,
            } => {
                let name = quote(name, engine)?;
                let kind = if *unique { "UNIQUE " } else { "" };
                let indexed = columns(indexed, engine)?;
                if engine == Engine::Sqlite {
                    format!("CREATE {kind}INDEX {schema}.{name} ON {table} ({indexed})")
                } else {
                    format!("CREATE {kind}INDEX {name} ON {target} ({indexed})")
                }
            }
            Change::RenameColumn { column, name } if engine == Engine::Sqlite => {
                format!(
                    "ALTER TABLE {target} RENAME COLUMN {} TO {}",
                    quote(column, engine)?,
                    quote(name, engine)?
                )
            }
            Change::DropColumn { column } if engine == Engine::Sqlite => {
                format!(
                    "ALTER TABLE {target} DROP COLUMN {}",
                    quote(column, engine)?
                )
            }
            _ => return Err(E::Unsupported),
        })
    }
}

pub(super) fn stamp(value: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(value).into()
}

pub(super) async fn preview_network(
    live: Network,
    draft: Arc<Draft>,
    request: Request,
    database: &str,
) -> Result<Preview, edit::Failure> {
    network::preview(live, draft, request, database).await
}

pub(super) async fn apply_network(
    live: Network,
    mut operation: edit::Operation,
    pending: Pending,
) -> Outcome {
    let outcome = network::apply(live, pending).await;
    if matches!(outcome, Outcome::Unknown { .. }) {
        operation.mark_unresolved();
    } else if matches!(outcome, Outcome::Applied) {
        operation.invalidate_snapshots();
    }
    outcome
}

pub(super) fn preview_sqlite(
    file: &sqlite::Session,
    request: Request,
) -> Result<Preview, edit::Failure> {
    file.schema_preview(request).map_err(Into::into)
}
