use super::SavedConnection;
use collab_database::ContractError as E;
use mssql_tds::{
    connection::{
        client_context::ClientContext,
        tds_client::{ExecuteOptions, ResultSet, StatementResult, TdsClient},
    },
    connection_provider::tds_connection_provider::TdsConnectionProvider,
    core::EncryptionSetting,
    datatypes::column_values::ColumnValues,
    error::Error,
};
use mssql_tds::{
    datatypes::{sql_string::SqlString, sqltypes::SqlType},
    message::parameters::rpc_parameters::{RpcParameter, StatusFlags},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, OwnedSemaphorePermit};
use tokio_util::sync::CancellationToken;

pub fn classify(error: Error) -> E {
    match error {
        Error::TlsError(_) | Error::TlsHandshakeError { .. } => E::TlsRejected,
        Error::TimeoutError(_) => E::Timeout,
        Error::OperationCancelledError(_) => E::Cancelled,
        Error::EncodedValueTooLong { .. } => E::LimitReached,
        Error::SqlServerError { diagnostics } => {
            if diagnostics
                .errors
                .iter()
                .any(|e| matches!(e.number, 18456 | 18452))
            {
                E::AuthenticationFailed
            } else if diagnostics
                .errors
                .iter()
                .any(|e| matches!(e.number, 229 | 230 | 262 | 916 | 4060))
            {
                E::PermissionDenied
            } else {
                E::QueryFailed
            }
        }
        _ => E::ConnectionFailed,
    }
}

pub struct Live {
    pub(super) client: Mutex<Option<TdsClient>>,
    pub query: super::query::Runtime,
    pub cancel: CancellationToken,
    _permit: OwnedSemaphorePermit,
}
impl Live {
    pub async fn connect(
        config: &SavedConnection,
        database: &str,
        password: &str,
        cancel: CancellationToken,
        permit: OwnedSemaphorePermit,
    ) -> Result<Arc<Self>, E> {
        let mut context = ClientContext::default();
        context.user_name = config.username.clone();
        context.password = password.into();
        context.database = database.into();
        context.application_name = "CollabDatabase".into();
        context.connect_retry_count = 0;
        context.connect_timeout = 10;
        context.encryption_options.mode = EncryptionSetting::Required;
        context.encryption_options.trust_server_certificate = false;
        context.encryption_options.host_name_in_cert = Some(
            config
                .certificate_hostname
                .clone()
                .unwrap_or_else(|| config.host.clone()),
        );
        let provider = TdsConnectionProvider::new();
        let endpoint = format!("tcp:{},{}", config.host, config.port);
        let mut client = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(E::WrongBinding),
            result = tokio::time::timeout(Duration::from_secs(12), provider.create_client(context, &endpoint, None)) => result.map_err(|_| E::Timeout)?.map_err(classify)?,
        };
        client.set_info_message_limits(256, 64 << 10);
        // Establish the application's explicit new-session baseline. User SQL can
        // still open transactions/change options; execution probes expose that.
        tokio::select! {biased;_ = cancel.cancelled()=>return Err(E::WrongBinding),result=tokio::time::timeout(Duration::from_secs(3),async {
            let mut result=client.execute("SET IMPLICIT_TRANSACTIONS OFF;".into(),ExecuteOptions::new().timeout_secs(2)).await.map_err(classify)?;
            while !matches!(result,StatementResult::End){result=client.advance().await.map_err(classify)?;}
            client.close_query().await.map_err(classify)
        })=>result.map_err(|_|E::Timeout)??};
        Ok(Arc::new(Self {
            client: Mutex::new(Some(client)),
            query: Default::default(),
            cancel,
            _permit: permit,
        }))
    }
    pub async fn metadata(&self, request: &MetadataRequest) -> Result<MetadataPage, E> {
        let mut guard = self.client.lock().await;
        let client = guard.as_mut().ok_or(E::ConnectionFailed)?;
        let (sql, parameters) = request.sql()?;
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(E::WrongBinding),
            result = tokio::time::timeout(Duration::from_secs(12), read_metadata(client, sql, parameters)) => result.unwrap_or(Err(E::Timeout)),
        };
        // A failed/dropped metadata response is never returned to the registry as
        // an apparently healthy socket. No reconnect/replay occurs implicitly.
        if result.is_err() {
            guard.take();
        }
        result
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetadataRequest {
    Completion { after: String },
    Databases { after: String },
    Schemas { after: i32 },
    Objects { schema_id: i32, after: i32 },
    Columns { object_id: i32, after: i32 },
    Indexes { object_id: i32, after: i32 },
}
impl MetadataRequest {
    fn sql(&self) -> Result<(String, Vec<RpcParameter>), E> {
        let (sql, values) = match self {
            Self::Completion{after}=>{let (object,column)=after.split_once(':').ok_or(E::InvalidParameter)?;let object=nonnegative(object.parse().map_err(|_|E::InvalidParameter)?)?;let column=nonnegative(column.parse().map_err(|_|E::InvalidParameter)?)?;
            ("SELECT TOP(101) CAST(CONCAT(o.object_id,':',c.column_id) AS nvarchar(40)), CAST(c.name AS nvarchar(128)), CAST(o.name AS nvarchar(128)), CAST(s.name AS nvarchar(128)) FROM sys.objects o JOIN sys.schemas s ON o.schema_id=s.schema_id JOIN sys.columns c ON c.object_id=o.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 AND (o.object_id>@P1 OR (o.object_id=@P1 AND c.column_id>@P2)) ORDER BY o.object_id,c.column_id",vec![SqlType::Int(Some(object)),SqlType::Int(Some(column))])},
            Self::Databases { after } => {
                if after.len()>512 || after.contains('\0') {return Err(E::InvalidParameter);}
                ("SELECT TOP(101) CAST(name AS nvarchar(128)), CAST(name AS nvarchar(128)), N'database', N'' FROM sys.databases WHERE HAS_DBACCESS(name)=1 AND state=0 AND name > @P1 ORDER BY name",vec![SqlType::NVarchar(Some(SqlString::from_utf8_string(after.clone())),512)])
            },
            Self::Schemas {after} => ("SELECT TOP(101) CAST(schema_id AS nvarchar(20)), CAST(name AS nvarchar(128)), N'schema', N'' FROM sys.schemas WHERE schema_id>@P1 ORDER BY schema_id",vec![SqlType::Int(Some(nonnegative(*after)?))]),
            Self::Objects {schema_id,after} => ("SELECT TOP(101) CAST(object_id AS nvarchar(20)), CAST(name AS nvarchar(128)), CAST(type_desc AS nvarchar(60)), N'' FROM sys.objects WHERE schema_id=@P1 AND object_id>@P2 AND type IN ('U','V') AND is_ms_shipped=0 ORDER BY object_id",vec![SqlType::Int(Some(nonnegative(*schema_id)?)),SqlType::Int(Some(nonnegative(*after)?))]),
            Self::Columns {object_id,after} => ("SELECT TOP(101) CAST(c.column_id AS nvarchar(20)), CAST(c.name AS nvarchar(128)), CAST(t.name AS nvarchar(128)), CAST(CONCAT('length=',c.max_length,' precision=',c.precision,' scale=',c.scale,' nullable=',c.is_nullable,' generated=',c.is_computed) AS nvarchar(256)) FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id WHERE c.object_id=@P1 AND c.column_id>@P2 ORDER BY c.column_id",vec![SqlType::Int(Some(nonnegative(*object_id)?)),SqlType::Int(Some(nonnegative(*after)?))]),
            Self::Indexes {object_id,after} => ("SELECT TOP(101) CAST(index_id AS nvarchar(20)), CAST(COALESCE(name,N'(heap)') AS nvarchar(128)), CAST(type_desc AS nvarchar(60)), CAST(CONCAT('unique=',is_unique,' primary=',is_primary_key) AS nvarchar(256)) FROM sys.indexes WHERE object_id=@P1 AND index_id>@P2 ORDER BY index_id",vec![SqlType::Int(Some(nonnegative(*object_id)?)),SqlType::Int(Some(nonnegative(*after)?))]),
        };
        let parameters = values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                RpcParameter::new(Some(format!("@P{}", index + 1)), StatusFlags::NONE, value)
            })
            .collect();
        Ok((sql.into(), parameters))
    }
}
fn nonnegative(value: i32) -> Result<i32, E> {
    if value < 0 {
        Err(E::InvalidParameter)
    } else {
        Ok(value)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MetadataItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub detail: String,
}
#[derive(Serialize)]
pub struct MetadataPage {
    pub items: Vec<MetadataItem>,
    pub next: Option<String>,
}
async fn read_metadata(
    client: &mut TdsClient,
    sql: String,
    parameters: Vec<RpcParameter>,
) -> Result<MetadataPage, E> {
    let mut result = client
        .execute_sp_executesql(sql, parameters, ExecuteOptions::new().timeout_secs(10))
        .await
        .map_err(classify)?;
    let mut items = vec![];
    loop {
        match result {
            StatementResult::Rows => {
                while let Some(row) = client.next_row().await.map_err(classify)? {
                    if items.len() >= 101 || row.len() != 4 {
                        return Err(E::LimitReached);
                    }
                    let mut fields = Vec::new();
                    for value in row {
                        let ColumnValues::String(value) = value else {
                            return Err(E::DataConversion);
                        };
                        let value = value.to_string();
                        if value.len() > 2048 {
                            return Err(E::LimitReached);
                        }
                        fields.push(value);
                    }
                    items.push(MetadataItem {
                        id: fields[0].clone(),
                        name: fields[1].clone(),
                        kind: fields[2].clone(),
                        detail: fields[3].clone(),
                    });
                }
            }
            StatementResult::End => break,
            _ => {}
        }
        client.take_info_messages();
        result = client.advance().await.map_err(classify)?;
    }
    client.take_info_messages();
    client.close_query().await.map_err(classify)?;
    let next = if items.len() > 100 {
        items.truncate(100);
        items.last().map(|item| item.id.clone())
    } else {
        None
    };
    Ok(MetadataPage { items, next })
}
