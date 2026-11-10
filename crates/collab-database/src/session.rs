use serde::{Deserialize, Serialize};

use crate::{ContractError, DbValue};

/// Native registries issue unguessable handles and check profile ownership on
/// every command. A frontend handle is not a connection string or authority grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBinding {
    pub profile_id: String,
    pub connection_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub database: String,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    QueryTab,
    Metadata,
    GridApply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    None,
    Open,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "query", rename_all = "snake_case")]
pub enum SessionPhase {
    Connecting,
    Idle,
    Executing(String),
    Cancelling(String),
    Failed,
    OutcomeUnknown,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryIntent {
    /// Only native-generated metadata/read operations may use this assertion.
    KnownReadOnly,
    /// All raw user SQL, regardless of prefix, uses this conservative intent.
    MayWrite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    Succeeded,
    FailedKnown,
    CancelledAndDrained,
    TransportLost,
}

pub struct Session {
    binding: SessionBinding,
    role: SessionRole,
    phase: SessionPhase,
    transaction: TransactionState,
    active_intent: QueryIntent,
}

impl Session {
    pub fn new(binding: SessionBinding, role: SessionRole) -> Self {
        Self {
            binding,
            role,
            phase: SessionPhase::Connecting,
            transaction: TransactionState::None,
            active_intent: QueryIntent::MayWrite,
        }
    }
    pub fn binding(&self) -> &SessionBinding {
        &self.binding
    }
    pub fn phase(&self) -> &SessionPhase {
        &self.phase
    }
    pub fn transaction(&self) -> TransactionState {
        self.transaction
    }
    pub fn connected(&mut self) -> Result<(), ContractError> {
        if self.phase != SessionPhase::Connecting {
            return Err(ContractError::UnresolvedSession);
        }
        self.phase = SessionPhase::Idle;
        Ok(())
    }
    pub fn start(
        &mut self,
        binding: &SessionBinding,
        query: String,
        intent: QueryIntent,
    ) -> Result<(), ContractError> {
        if binding != &self.binding {
            return Err(ContractError::WrongBinding);
        }
        if self.phase != SessionPhase::Idle {
            return Err(ContractError::Busy);
        }
        if matches!(
            self.transaction,
            TransactionState::Failed | TransactionState::Unknown
        ) {
            return Err(ContractError::UnresolvedSession);
        }
        if query.is_empty() {
            return Err(ContractError::StaleQuery);
        }
        self.active_intent = intent;
        self.phase = SessionPhase::Executing(query);
        Ok(())
    }
    pub fn cancel(&mut self, query: &str) -> Result<(), ContractError> {
        if self.phase != SessionPhase::Executing(query.into()) {
            return Err(ContractError::StaleQuery);
        }
        self.phase = SessionPhase::Cancelling(query.into());
        Ok(())
    }
    pub fn finish(
        &mut self,
        query: &str,
        completion: Completion,
        observed_transaction: TransactionState,
    ) -> Result<(), ContractError> {
        if !matches!(&self.phase, SessionPhase::Executing(active) | SessionPhase::Cancelling(active) if active == query)
        {
            return Err(ContractError::StaleQuery);
        }
        if completion == Completion::TransportLost {
            let unknown = self.active_intent == QueryIntent::MayWrite
                || self.transaction != TransactionState::None;
            self.transaction = if unknown {
                TransactionState::Unknown
            } else {
                TransactionState::None
            };
            self.phase = if unknown {
                SessionPhase::OutcomeUnknown
            } else {
                SessionPhase::Failed
            };
        } else {
            self.transaction = observed_transaction;
            self.phase = SessionPhase::Idle;
        }
        Ok(())
    }
    pub fn ensure_grid_apply_session(&self) -> Result<(), ContractError> {
        if self.role != SessionRole::GridApply
            || self.phase != SessionPhase::Idle
            || self.transaction != TransactionState::None
        {
            return Err(ContractError::UnresolvedSession);
        }
        Ok(())
    }
    pub fn close_clean(&mut self, has_pending_edits: bool) -> Result<(), ContractError> {
        if self.phase != SessionPhase::Idle
            || self.transaction != TransactionState::None
            || has_pending_edits
        {
            return Err(ContractError::UnresolvedSession);
        }
        self.phase = SessionPhase::Closed;
        Ok(())
    }
    /// Called only after an explicit rollback/discard/unknown-outcome acknowledgement.
    /// Never commits a transaction, retries a statement or changes a tab's binding.
    pub fn retire_after_user_resolution(&mut self) {
        self.phase = SessionPhase::Closed;
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryRequest {
    pub binding: SessionBinding,
    pub query_id: String,
    pub sql: String,
    pub parameters: Vec<DbValue>,
}
impl std::fmt::Debug for QueryRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("QueryRequest([SQL and parameters redacted])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> SessionBinding {
        SessionBinding {
            profile_id: "p".into(),
            connection_id: "c".into(),
            session_id: "s".into(),
            tab_id: "t".into(),
            database: "db".into(),
            generation: 1,
        }
    }
    #[test]
    fn tabs_are_pinned_and_stale_cancellation_cannot_touch_a_new_execution() {
        let b = binding();
        let mut session = Session::new(b.clone(), SessionRole::QueryTab);
        session.connected().unwrap();
        let mut other = b.clone();
        other.database = "other".into();
        assert_eq!(
            session.start(&other, "q".into(), QueryIntent::MayWrite),
            Err(ContractError::WrongBinding)
        );
        session
            .start(&b, "q".into(), QueryIntent::MayWrite)
            .unwrap();
        session.cancel("q").unwrap();
        assert!(session
            .start(&b, "second".into(), QueryIntent::MayWrite)
            .is_err());
        session
            .finish("q", Completion::CancelledAndDrained, TransactionState::Open)
            .unwrap();
        assert!(session.close_clean(false).is_err());
        session
            .start(&b, "second".into(), QueryIntent::MayWrite)
            .unwrap();
        assert!(session.cancel("q").is_err());
        assert_eq!(session.phase(), &SessionPhase::Executing("second".into()));
    }
    #[test]
    fn a_lost_write_is_unknown_and_is_never_automatically_replayed() {
        let b = binding();
        let mut session = Session::new(b.clone(), SessionRole::QueryTab);
        session.connected().unwrap();
        session
            .start(&b, "q".into(), QueryIntent::MayWrite)
            .unwrap();
        session
            .finish("q", Completion::TransportLost, TransactionState::None)
            .unwrap();
        assert_eq!(session.phase(), &SessionPhase::OutcomeUnknown);
        assert!(session
            .start(&b, "retry".into(), QueryIntent::MayWrite)
            .is_err());
        assert!(session.close_clean(false).is_err());
        session.retire_after_user_resolution();
        assert_eq!(session.phase(), &SessionPhase::Closed);
    }
    #[test]
    fn grid_apply_cannot_commit_a_query_tabs_manual_transaction() {
        let mut session = Session::new(binding(), SessionRole::QueryTab);
        session.connected().unwrap();
        assert!(session.ensure_grid_apply_session().is_err());
        assert!(session.close_clean(true).is_err());
    }
}
