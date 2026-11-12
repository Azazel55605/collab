//! Versioned, driver-free database editor contracts. Native adapters own sockets,
//! secrets, selected files and authorization; scripts never grant execution authority.

mod session;
mod sql;
mod stream;
mod values;

pub use session::*;
pub use sql::*;
pub use stream::*;
pub use values::*;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const CONTRACT_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    SqlServer,
    Sqlite,
    MariaDb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authentication {
    SqlLogin,
    WindowsIntegrated,
    EntraToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretRetention {
    SessionOnly,
    OsCredentialStore,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "policy", rename_all = "snake_case")]
pub enum TlsTrust {
    SystemRoots,
    AdditionalCa {
        native_certificate_handle: String,
    },
    /// Issued only by an explicit native per-connection trust confirmation.
    ExplicitException {
        native_authorization_handle: String,
    },
}

/// No password, token, connection string, filesystem path or SQL text belongs here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub owner_profile: String,
    pub label: String,
    pub environment: String,
    pub target: ConnectionTarget,
    pub secret_retention: SecretRetention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "engine", rename_all = "snake_case")]
pub enum ConnectionTarget {
    SqlServer {
        host: String,
        port: u16,
        database: String,
        authentication: Authentication,
        tls: TlsTrust,
    },
    MariaDb {
        host: String,
        port: u16,
        database: String,
        tls: TlsTrust,
    },
    /// Resolved only in a native registry after an explicit picker operation.
    Sqlite {
        selected_file_handle: String,
        read_only: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DdlTransactions {
    SupportedSubset,
    ImplicitCommit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub engine: Engine,
    pub schemas: bool,
    pub ddl_transactions: DdlTransactions,
    pub insert_returning: bool,
    pub update_returning: bool,
    pub delete_returning: bool,
    pub native_version_tokens: bool,
    pub atomic_grid_apply: bool,
}

impl Capabilities {
    /// A dialect baseline, not a claim about a particular server/version/table.
    /// Adapters must intersect it with discovered permissions/version/storage engine.
    pub fn baseline(engine: Engine) -> Self {
        Self {
            engine,
            schemas: engine == Engine::SqlServer,
            ddl_transactions: if engine == Engine::MariaDb {
                DdlTransactions::ImplicitCommit
            } else {
                DdlTransactions::SupportedSubset
            },
            insert_returning: true,
            update_returning: engine != Engine::MariaDb,
            delete_returning: true,
            native_version_tokens: engine == Engine::SqlServer,
            atomic_grid_apply: engine != Engine::MariaDb,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Identifier(String);
impl Identifier {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractError> {
        let value = value.into();
        if value.is_empty() || value.contains('\0') || value.chars().count() > 128 {
            return Err(ContractError::InvalidIdentifier);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn quoted(&self, engine: Engine) -> Result<String, ContractError> {
        // Deserialize is not an authority boundary: revalidate before generating SQL.
        Self::new(self.0.clone())?;
        if engine == Engine::MariaDb && self.0.chars().count() > 64 {
            return Err(ContractError::InvalidIdentifier);
        }
        Ok(match engine {
            Engine::SqlServer => format!("[{}]", self.0.replace(']', "]]")),
            Engine::Sqlite => format!("\"{}\"", self.0.replace('"', "\"\"")),
            Engine::MariaDb => format!("`{}`", self.0.replace('`', "``")),
        })
    }
}

pub fn parameter_marker(engine: Engine, ordinal: usize) -> Result<String, ContractError> {
    if ordinal == 0 {
        return Err(ContractError::InvalidParameter);
    }
    Ok(match engine {
        Engine::SqlServer => format!("@P{ordinal}"),
        Engine::Sqlite => format!("?{ordinal}"),
        Engine::MariaDb => "?".into(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableRef {
    pub catalog: String,
    pub schema: Option<Identifier>,
    pub table: Identifier,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnMetadata {
    pub name: Identifier,
    pub engine_type: String,
    pub nullable: bool,
    pub generated: bool,
    pub version_token: bool,
    pub precision: Option<u16>,
    pub scale: Option<i16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaObject {
    pub table: TableRef,
    pub stamp: String,
    pub columns: Vec<ColumnMetadata>,
    pub unique_non_null_keys: Vec<Vec<Identifier>>,
    pub is_base_table: bool,
    pub transactional: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum InsertValue {
    Default,
    Value(DbValue),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Predicate {
    pub column: Identifier,
    pub original: DbValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "predicates", rename_all = "snake_case")]
pub enum ConcurrencyPredicate {
    VersionToken(Predicate),
    OriginalValues(Vec<Predicate>),
}

/// Native code must reconstruct this from its own loaded row and metadata;
/// frontend-supplied claims of uniqueness/concurrency are never sufficient.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowLocator {
    pub key: Vec<Predicate>,
    pub concurrency: ConcurrencyPredicate,
}

impl RowLocator {
    pub fn validate(&self, schema: &SchemaObject) -> Result<(), ContractError> {
        if !schema.is_base_table || !schema.transactional || self.key.is_empty() {
            return Err(ContractError::ReadOnlyResult);
        }
        let names: Vec<_> = self.key.iter().map(|p| p.column.clone()).collect();
        if !schema.unique_non_null_keys.iter().any(|key| key == &names)
            || names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != names.len()
            || self.key.iter().any(|p| {
                p.original.validate_parameter().is_err()
                    || matches!(p.original, DbValue::Null | DbValue::Truncated { .. })
                    || !schema
                        .columns
                        .iter()
                        .any(|column| column.name == p.column && !column.nullable)
            })
        {
            return Err(ContractError::ReadOnlyResult);
        }
        let predicates = match &self.concurrency {
            ConcurrencyPredicate::VersionToken(predicate) => {
                if matches!(predicate.original, DbValue::Null)
                    || !schema.columns.iter().any(|column| {
                        column.name == predicate.column && column.version_token && !column.nullable
                    })
                {
                    return Err(ContractError::MissingConcurrencyPredicate);
                }
                std::slice::from_ref(predicate)
            }
            ConcurrencyPredicate::OriginalValues(predicates) => predicates.as_slice(),
        };
        if predicates.is_empty()
            || predicates.iter().any(|p| {
                p.original.validate_parameter().is_err()
                    || !schema.columns.iter().any(|column| column.name == p.column)
            })
        {
            return Err(ContractError::MissingConcurrencyPredicate);
        }
        let mut seen = std::collections::BTreeSet::new();
        if predicates.iter().any(|p| !seen.insert(&p.column)) {
            return Err(ContractError::MissingConcurrencyPredicate);
        }
        if matches!(&self.concurrency, ConcurrencyPredicate::OriginalValues(_))
            && schema
                .columns
                .iter()
                .any(|column| !seen.contains(&column.name))
        {
            return Err(ContractError::MissingConcurrencyPredicate);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mutation {
    Insert {
        values: Vec<(Identifier, InsertValue)>,
    },
    Update {
        locator: RowLocator,
        values: Vec<(Identifier, DbValue)>,
    },
    Delete {
        locator: RowLocator,
    },
}

/// Applying this requires a dedicated grid-apply session and one native-owned
/// transaction. Updates/deletes must affect exactly one row or the batch rolls back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationPlan {
    pub table: TableRef,
    pub metadata_stamp: String,
    pub changes: Vec<Mutation>,
}

impl MutationPlan {
    pub fn validate(&self, schema: &SchemaObject) -> Result<(), ContractError> {
        if self.table != schema.table || self.metadata_stamp != schema.stamp {
            return Err(ContractError::SchemaConflict);
        }
        if !schema.is_base_table
            || !schema.transactional
            || self.changes.is_empty()
            || self.changes.len() > 128
        {
            return Err(ContractError::ReadOnlyResult);
        }
        for change in &self.changes {
            match change {
                Mutation::Update { locator, values } => {
                    locator.validate(schema)?;
                    if values.is_empty() {
                        return Err(ContractError::InvalidParameter);
                    }
                    validate_distinct_columns(values.iter().map(|(column, _)| column))?;
                    for (column, value) in values {
                        validate_edit_column(schema, column, Some(value))?;
                    }
                }
                Mutation::Delete { locator } => locator.validate(schema)?,
                Mutation::Insert { values } => {
                    validate_distinct_columns(values.iter().map(|(column, _)| column))?;
                    for (column, value) in values {
                        validate_edit_column(
                            schema,
                            column,
                            match value {
                                InsertValue::Default => None,
                                InsertValue::Value(value) => Some(value),
                            },
                        )?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn validate_distinct_columns<'a>(
    columns: impl Iterator<Item = &'a Identifier>,
) -> Result<(), ContractError> {
    let mut seen = std::collections::BTreeSet::new();
    for column in columns {
        if !seen.insert(column) {
            return Err(ContractError::InvalidParameter);
        }
    }
    Ok(())
}

fn validate_edit_column(
    schema: &SchemaObject,
    column: &Identifier,
    value: Option<&DbValue>,
) -> Result<(), ContractError> {
    let metadata = schema
        .columns
        .iter()
        .find(|metadata| &metadata.name == column)
        .ok_or(ContractError::ReadOnlyResult)?;
    if metadata.generated || (value == Some(&DbValue::Null) && !metadata.nullable) {
        return Err(ContractError::ReadOnlyResult);
    }
    if let Some(value) = value {
        value.validate_parameter()?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRange {
    pub start_utf16: u32,
    pub end_utf16: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionError {
    pub code: ContractError,
    pub source: Option<SourceRange>,
    pub server_code: Option<i32>,
    pub outcome_unknown: bool,
}

/// Stable safe codes, never driver error strings, SQL/parameters or credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractError {
    #[error("The operating system credential store is unavailable")]
    CredentialStoreUnavailable,
    #[error("Credential cleanup needs to be retried")]
    CredentialCleanupFailed,
    #[error("The database connection failed")]
    ConnectionFailed,
    #[error("Database authentication failed")]
    AuthenticationFailed,
    #[error("The database certificate could not be verified")]
    TlsRejected,
    #[error("The database account lacks permission")]
    PermissionDenied,
    #[error("The database statement failed")]
    QueryFailed,
    #[error("The database operation timed out")]
    Timeout,
    #[error("The database operation was cancelled")]
    Cancelled,
    #[error("The database value could not be converted")]
    DataConversion,
    #[error("Invalid database identifier")]
    InvalidIdentifier,
    #[error("Invalid typed parameter")]
    InvalidParameter,
    #[error("Unsupported capability")]
    Unsupported,
    #[error("The SQLite database file moved or was replaced")]
    DatabaseMoved,
    #[error("The SQLite database is read-only")]
    DatabaseReadOnly,
    #[error("Another connection is holding a SQLite lock")]
    DatabaseLocked,
    #[error("The selected file is not a valid SQLite database")]
    InvalidDatabase,
    #[error("The session is busy")]
    Busy,
    #[error("The session binding does not match")]
    WrongBinding,
    #[error("The session has an unresolved transaction or outcome")]
    UnresolvedSession,
    #[error("The query is no longer active")]
    StaleQuery,
    #[error("The stream has no credit")]
    Backpressure,
    #[error("The stream sequence is invalid")]
    InvalidSequence,
    #[error("The result limit was reached")]
    LimitReached,
    #[error("This result cannot be edited safely")]
    ReadOnlyResult,
    #[error("An original value or version predicate is required")]
    MissingConcurrencyPredicate,
    #[error("The source metadata has changed")]
    SchemaConflict,
    #[error("The row changed; the batch was rolled back")]
    RowConflict,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_quoted_per_dialect_not_rewritten_as_sql_fragments() {
        let identifier = Identifier::new("a]; DROP TABLE t;--").unwrap();
        assert_eq!(
            identifier.quoted(Engine::SqlServer).unwrap(),
            "[a]]; DROP TABLE t;--]"
        );
        assert_eq!(
            Identifier::new("a`b")
                .unwrap()
                .quoted(Engine::MariaDb)
                .unwrap(),
            "`a``b`"
        );
        let from_ipc: Identifier = serde_json::from_str("\"\"").unwrap();
        assert!(from_ipc.quoted(Engine::Sqlite).is_err());
        assert_eq!(parameter_marker(Engine::SqlServer, 2).unwrap(), "@P2");
        assert!(parameter_marker(Engine::Sqlite, 0).is_err());
    }
    #[test]
    fn keyless_views_null_keys_and_missing_concurrency_are_read_only() {
        let id = Identifier::new("id").unwrap();
        let mut schema = SchemaObject {
            table: TableRef {
                catalog: "db".into(),
                schema: None,
                table: Identifier::new("t").unwrap(),
            },
            stamp: "v1".into(),
            columns: vec![ColumnMetadata {
                name: id.clone(),
                engine_type: "int".into(),
                nullable: false,
                generated: false,
                version_token: false,
                precision: None,
                scale: None,
            }],
            unique_non_null_keys: vec![vec![id.clone()]],
            is_base_table: true,
            transactional: true,
        };
        let predicate = Predicate {
            column: id.clone(),
            original: DbValue::Integer {
                decimal: "1".into(),
            },
        };
        let mut locator = RowLocator {
            key: vec![predicate.clone()],
            concurrency: ConcurrencyPredicate::OriginalValues(vec![predicate]),
        };
        assert!(locator.validate(&schema).is_ok());
        schema.is_base_table = false;
        assert!(locator.validate(&schema).is_err());
        schema.is_base_table = true;
        locator.key[0].original = DbValue::Null;
        assert!(locator.validate(&schema).is_err());
        locator.key[0].original = DbValue::Integer {
            decimal: "1".into(),
        };
        locator.concurrency = ConcurrencyPredicate::OriginalValues(vec![]);
        assert!(locator.validate(&schema).is_err());
    }
    #[test]
    fn mutation_admission_checks_schema_defaults_nulls_and_duplicate_columns() {
        let id = Identifier::new("id").unwrap();
        let schema = SchemaObject {
            table: TableRef {
                catalog: "db".into(),
                schema: None,
                table: Identifier::new("t").unwrap(),
            },
            stamp: "v2".into(),
            columns: vec![ColumnMetadata {
                name: id.clone(),
                engine_type: "int".into(),
                nullable: false,
                generated: false,
                version_token: false,
                precision: None,
                scale: None,
            }],
            unique_non_null_keys: vec![vec![id.clone()]],
            is_base_table: true,
            transactional: true,
        };
        let mut plan = MutationPlan {
            table: schema.table.clone(),
            metadata_stamp: "v1".into(),
            changes: vec![Mutation::Insert {
                values: vec![(id.clone(), InsertValue::Default)],
            }],
        };
        assert_eq!(plan.validate(&schema), Err(ContractError::SchemaConflict));
        plan.metadata_stamp = schema.stamp.clone();
        assert!(plan.validate(&schema).is_ok());
        plan.changes = vec![Mutation::Insert {
            values: vec![(id.clone(), InsertValue::Value(DbValue::Null))],
        }];
        assert!(plan.validate(&schema).is_err());
        plan.changes = vec![Mutation::Insert {
            values: vec![
                (id.clone(), InsertValue::Default),
                (id, InsertValue::Default),
            ],
        }];
        assert_eq!(plan.validate(&schema), Err(ContractError::InvalidParameter));
    }
}
