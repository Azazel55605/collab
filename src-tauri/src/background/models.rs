use serde::{Deserialize, Serialize};

pub const BACKGROUND_LEDGER_SCHEMA_VERSION: u32 = 1;
pub const BACKGROUND_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundJobKind {
    ReplicaSync,
    CalendarSync,
    Maintenance,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundJobTrigger {
    Foreground,
    Periodic,
    PushInvalidation,
    Retry,
    UserInitiated,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundJobStatus {
    Queued,
    Running,
    Succeeded,
    Partial,
    Deferred,
    AuthenticationRequired,
    PermissionDenied,
    Conflict,
    Cancelled,
    Failed,
}

impl BackgroundJobStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobProgress {
    pub completed: u64,
    pub total: Option<u64>,
    pub detail: Option<String>,
}

impl Default for BackgroundJobProgress {
    fn default() -> Self {
        Self {
            completed: 0,
            total: None,
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobRequest {
    pub idempotency_key: String,
    pub kind: BackgroundJobKind,
    pub server_url: Option<String>,
    pub profile_id: Option<String>,
    pub vault_id: Option<String>,
    pub trigger: BackgroundJobTrigger,
    pub runtime_budget_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobRecord {
    pub id: String,
    pub idempotency_key: String,
    pub kind: BackgroundJobKind,
    pub server_url: Option<String>,
    pub profile_id: Option<String>,
    pub vault_id: Option<String>,
    pub trigger: BackgroundJobTrigger,
    pub status: BackgroundJobStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub progress: BackgroundJobProgress,
    pub summary: Option<String>,
    pub error_category: Option<String>,
    pub error_message: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobAggregate {
    pub queued: u64,
    pub running: u64,
    pub succeeded: u64,
    pub attention_required: u64,
    pub latest_finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundServerRegistration {
    pub server_url: String,
    pub allow_invalid_certificates: bool,
    pub persist_across_reboots: bool,
    #[serde(default = "default_enabled")]
    pub background_sync_enabled: bool,
    pub updated_at: String,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundLedger {
    pub schema_version: u32,
    pub jobs: Vec<BackgroundJobRecord>,
}

impl Default for BackgroundLedger {
    fn default() -> Self {
        Self {
            schema_version: BACKGROUND_LEDGER_SCHEMA_VERSION,
            jobs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundRegistry {
    pub schema_version: u32,
    pub servers: Vec<BackgroundServerRegistration>,
}

impl Default for BackgroundRegistry {
    fn default() -> Self {
        Self {
            schema_version: BACKGROUND_REGISTRY_SCHEMA_VERSION,
            servers: Vec::new(),
        }
    }
}
