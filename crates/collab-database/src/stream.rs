use std::{collections::VecDeque, io};

use serde::{Deserialize, Serialize};

use crate::{ContractError, DbValue, QueryRequest, SessionBinding};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    pub connections: usize,
    pub query_bytes: usize,
    pub parameter_bytes: usize,
    pub columns: usize,
    pub cell_bytes: usize,
    pub batch_rows: usize,
    pub batch_bytes: usize,
    pub queued_batches: usize,
    pub result_rows: usize,
    pub result_bytes: usize,
    pub metadata_bytes: usize,
    pub history_entries: usize,
    pub history_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 8,
            query_bytes: 1 << 20,
            parameter_bytes: 1 << 20,
            columns: 256,
            cell_bytes: 64 << 10,
            batch_rows: 128,
            batch_bytes: 256 << 10,
            queued_batches: 2,
            result_rows: 100_000,
            result_bytes: 8 << 20,
            metadata_bytes: 4 << 20,
            history_entries: 100,
            history_bytes: 1 << 20,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.connections == 0
            || self.batch_rows == 0
            || self.batch_bytes == 0
            || self.cell_bytes == 0
            || self.queued_batches == 0
            || self.columns == 0
            || self.result_rows == 0
            || self.cell_bytes > self.batch_bytes
            || self.batch_bytes > self.result_bytes
            || self.batch_bytes.checked_mul(self.queued_batches).is_none()
        {
            return Err(ContractError::LimitReached);
        }
        Ok(())
    }
    pub fn admit_query(&self, request: &QueryRequest) -> Result<(), ContractError> {
        if request.sql.len() > self.query_bytes || request.parameters.len() > 1024 {
            return Err(ContractError::LimitReached);
        }
        for value in &request.parameters {
            value.validate_parameter()?;
        }
        encoded_size(&request.parameters, self.parameter_bytes)?;
        Ok(())
    }
}

struct Counter {
    count: usize,
    limit: usize,
}
impl io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.count = self
            .count
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("limit"))?;
        if self.count > self.limit {
            return Err(io::Error::other("limit"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Count serialization without first allocating an unbounded JSON buffer.
pub fn encoded_size(value: &impl Serialize, limit: usize) -> Result<usize, ContractError> {
    let mut counter = Counter { count: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| ContractError::LimitReached)?;
    Ok(counter.count)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultFrame {
    pub binding: SessionBinding,
    pub query_id: String,
    pub sequence: u64,
    pub event: ResultEvent,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ResultEvent {
    Columns {
        result_set: u32,
        columns: Vec<crate::ColumnMetadata>,
    },
    Rows {
        result_set: u32,
        rows: Vec<Vec<DbValue>>,
    },
    Message {
        severity: u8,
        safe_text: String,
    },
    AffectedRows {
        result_set: u32,
        exact_count: String,
    },
    Finished {
        reason: FinishReason,
    },
    Failed {
        error: crate::ExecutionError,
    },
}

impl std::fmt::Debug for ResultEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ResultEvent([payload redacted])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Complete,
    Cancelled,
    RowLimit,
    ByteLimit,
    CellLimit,
}

/// Native senders stop polling their driver when the credit window is full.
/// Credit is restored by ordered acknowledgement, not by queueing another IPC event.
pub struct StreamWindow {
    binding: SessionBinding,
    query: String,
    limits: Limits,
    next_sequence: u64,
    pending: VecDeque<(u64, usize)>,
    retained_bytes: usize,
    rows: usize,
    total_bytes: usize,
    terminal: bool,
}
impl StreamWindow {
    pub fn new(
        binding: SessionBinding,
        query: String,
        limits: Limits,
    ) -> Result<Self, ContractError> {
        limits.validate()?;
        Ok(Self {
            binding,
            query,
            limits,
            next_sequence: 0,
            pending: VecDeque::new(),
            retained_bytes: 0,
            rows: 0,
            total_bytes: 0,
            terminal: false,
        })
    }
    pub fn has_credit(&self) -> bool {
        !self.terminal && self.pending.len() < self.limits.queued_batches
    }
    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }
    pub fn total_rows(&self) -> usize {
        self.rows
    }
    pub fn admit(&mut self, batch: &ResultFrame) -> Result<usize, ContractError> {
        if self.terminal || batch.binding != self.binding || batch.query_id != self.query {
            return Err(ContractError::StaleQuery);
        }
        if batch.sequence != self.next_sequence {
            return Err(ContractError::InvalidSequence);
        }
        if !self.has_credit() {
            return Err(ContractError::Backpressure);
        }
        let row_count = match &batch.event {
            ResultEvent::Rows { rows, .. } => {
                if rows.is_empty() || rows.len() > self.limits.batch_rows {
                    return Err(ContractError::LimitReached);
                }
                for row in rows {
                    if row.len() > self.limits.columns {
                        return Err(ContractError::LimitReached);
                    }
                    for cell in row {
                        encoded_size(cell, self.limits.cell_bytes)?;
                    }
                }
                rows.len()
            }
            ResultEvent::Columns { columns, .. } => {
                if columns.len() > self.limits.columns {
                    return Err(ContractError::LimitReached);
                }
                0
            }
            ResultEvent::Message { safe_text, .. } => {
                if safe_text.len() > 4096 {
                    return Err(ContractError::LimitReached);
                }
                0
            }
            ResultEvent::AffectedRows { exact_count, .. } => {
                exact_count
                    .parse::<u64>()
                    .map_err(|_| ContractError::InvalidParameter)?;
                0
            }
            _ => 0,
        };
        let size = encoded_size(batch, self.limits.batch_bytes)?;
        let rows = self
            .rows
            .checked_add(row_count)
            .ok_or(ContractError::LimitReached)?;
        let bytes = self
            .total_bytes
            .checked_add(size)
            .ok_or(ContractError::LimitReached)?;
        let terminal = matches!(
            batch.event,
            ResultEvent::Finished { .. } | ResultEvent::Failed { .. }
        );
        // Keep space for one explicit completion/error after data admission stops.
        let byte_limit = if terminal {
            self.limits.result_bytes
        } else {
            self.limits
                .result_bytes
                .saturating_sub(self.limits.batch_bytes.min(4096))
        };
        if rows > self.limits.result_rows || bytes > byte_limit {
            return Err(ContractError::LimitReached);
        }
        self.rows = rows;
        self.total_bytes = bytes;
        self.retained_bytes += size;
        self.pending.push_back((batch.sequence, size));
        self.next_sequence += 1;
        if matches!(
            batch.event,
            ResultEvent::Finished { .. } | ResultEvent::Failed { .. }
        ) {
            self.terminal = true;
        }
        Ok(size)
    }
    pub fn acknowledge(
        &mut self,
        binding: &SessionBinding,
        query: &str,
        sequence: u64,
    ) -> Result<(), ContractError> {
        if binding != &self.binding || query != self.query {
            return Err(ContractError::StaleQuery);
        }
        if self.pending.front().map(|item| item.0) != Some(sequence) {
            return Err(ContractError::InvalidSequence);
        }
        self.retained_bytes -= self.pending.pop_front().unwrap().1;
        Ok(())
    }
    pub fn finish(&mut self) {
        self.terminal = true;
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
    fn batch(sequence: u64) -> ResultFrame {
        ResultFrame {
            binding: binding(),
            query_id: "q".into(),
            sequence,
            event: ResultEvent::Rows {
                result_set: 0,
                rows: vec![vec![DbValue::Integer {
                    decimal: "9223372036854775807".into(),
                }]],
            },
        }
    }
    #[test]
    fn a_slow_ipc_consumer_bounds_memory_and_cannot_ack_another_tabs_query() {
        let mut window = StreamWindow::new(binding(), "q".into(), Limits::default()).unwrap();
        window.admit(&batch(0)).unwrap();
        window.admit(&batch(1)).unwrap();
        assert_eq!(window.admit(&batch(2)), Err(ContractError::Backpressure));
        assert!(window.retained_bytes() <= 2 * Limits::default().batch_bytes);
        assert!(window.acknowledge(&binding(), "other", 0).is_err());
        assert!(window.acknowledge(&binding(), "q", 1).is_err());
        window.acknowledge(&binding(), "q", 0).unwrap();
        window.admit(&batch(2)).unwrap();
        window.finish();
        assert_eq!(window.admit(&batch(3)), Err(ContractError::StaleQuery));
    }
    #[test]
    fn query_limits_count_encoded_bytes_including_escaping_and_do_not_mutate_on_failure() {
        assert_eq!(encoded_size(&"\"\"\"", 6), Err(ContractError::LimitReached));
        let limits = Limits {
            result_rows: 1,
            ..Limits::default()
        };
        let mut window = StreamWindow::new(binding(), "q".into(), limits).unwrap();
        window.admit(&batch(0)).unwrap();
        window.acknowledge(&binding(), "q", 0).unwrap();
        assert_eq!(window.admit(&batch(1)), Err(ContractError::LimitReached));
        assert_eq!(window.total_rows(), 1);
        assert_eq!(window.retained_bytes(), 0);
    }
    #[test]
    fn messages_metadata_and_terminal_frames_share_the_same_ordered_credit_window() {
        let mut window = StreamWindow::new(binding(), "q".into(), Limits::default()).unwrap();
        let mut frame = batch(0);
        frame.event = ResultEvent::Columns {
            result_set: 0,
            columns: vec![],
        };
        window.admit(&frame).unwrap();
        frame.sequence = 1;
        frame.event = ResultEvent::Message {
            severity: 0,
            safe_text: "fixture message".into(),
        };
        window.admit(&frame).unwrap();
        frame.sequence = 2;
        frame.event = ResultEvent::Finished {
            reason: FinishReason::Complete,
        };
        assert_eq!(window.admit(&frame), Err(ContractError::Backpressure));
        window.acknowledge(&binding(), "q", 0).unwrap();
        window.admit(&frame).unwrap();
        window.acknowledge(&binding(), "q", 1).unwrap();
        window.acknowledge(&binding(), "q", 2).unwrap();
        assert!(!window.has_credit());
        assert_eq!(window.retained_bytes(), 0);
    }
}
