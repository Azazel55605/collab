// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Bulk copy error types for timeout handling.
//!
//! This module provides specialized error types for bulk copy timeout operations
//! that match the error messages and behavior of Microsoft.Data.SqlClient's SqlBulkCopy.
//!
//! # Error Types
//!
//! - `BulkCopyTimeoutError` - Operation timed out
//! - `BulkCopyAttentionTimeoutError` - Attention ACK not received within timeout
//!
//! # Note on Conversion Errors
//!
//! Data type conversion errors (NULL validation, type coercion, truncation) are
//! handled in the PyO3 bindings layer (mssql-py-core) before data reaches the
//! TDS protocol layer. The core mssql-tds library receives pre-validated,
//! pre-converted `ColumnValues` and only needs to handle timeout-related errors.

use std::fmt;

/// Error for bulk copy operation timeout.
///
/// This error is raised when the bulk copy operation exceeds the configured
/// timeout duration.
#[derive(Debug, Clone)]
pub struct BulkCopyTimeoutError {
    /// Number of rows successfully copied before timeout
    pub rows_copied: u64,

    /// Configured timeout in seconds
    pub timeout_seconds: u32,

    /// Additional context message
    pub context: Option<String>,
}

impl BulkCopyTimeoutError {
    /// Create a new timeout error.
    pub fn new(rows_copied: u64, timeout_seconds: u32, context: Option<String>) -> Self {
        Self {
            rows_copied,
            timeout_seconds,
            context,
        }
    }
}

impl fmt::Display for BulkCopyTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(ref ctx) = self.context {
            write!(
                f,
                "Bulk copy operation timed out after {} seconds ({} rows copied). {}",
                self.timeout_seconds, self.rows_copied, ctx
            )
        } else {
            write!(
                f,
                "Bulk copy operation timed out after {} seconds ({} rows copied)",
                self.timeout_seconds, self.rows_copied
            )
        }
    }
}

impl std::error::Error for BulkCopyTimeoutError {}

/// Error for attention acknowledgment timeout.
///
/// This error is raised when the server does not respond to an attention
/// packet within the expected 5-second timeout. When this occurs, the
/// connection should be marked as broken.
#[derive(Debug, Clone)]
pub struct BulkCopyAttentionTimeoutError {
    /// Whether the connection was marked as broken
    pub connection_broken: bool,
}

impl BulkCopyAttentionTimeoutError {
    /// Create a new attention timeout error.
    pub fn new(connection_broken: bool) -> Self {
        Self { connection_broken }
    }
}

impl fmt::Display for BulkCopyAttentionTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.connection_broken {
            write!(
                f,
                "Attention acknowledgment not received within 5 seconds. Connection has been broken."
            )
        } else {
            write!(f, "Attention acknowledgment not received within 5 seconds.")
        }
    }
}

impl std::error::Error for BulkCopyAttentionTimeoutError {}

/// Aggregated error type for bulk copy timeout errors.
///
/// This enum consolidates bulk copy timeout-specific error types into a single
/// type that can be converted to the main `Error` type.
#[derive(Debug)]
pub enum BulkCopyError {
    /// Operation timed out
    Timeout(BulkCopyTimeoutError),

    /// Attention ACK not received within timeout
    AttentionTimeout(BulkCopyAttentionTimeoutError),

    /// Connection is broken and cannot be used
    ConnectionBroken(String),
}

impl fmt::Display for BulkCopyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BulkCopyError::Timeout(e) => write!(f, "{}", e),
            BulkCopyError::AttentionTimeout(e) => write!(f, "{}", e),
            BulkCopyError::ConnectionBroken(msg) => {
                write!(f, "Connection is broken: {}", msg)
            }
        }
    }
}

impl std::error::Error for BulkCopyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            BulkCopyError::Timeout(e) => Some(e),
            BulkCopyError::AttentionTimeout(e) => Some(e),
            BulkCopyError::ConnectionBroken(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as StdError;

    #[test]
    fn test_timeout_error_display() {
        let err = BulkCopyTimeoutError::new(1000, 30, None);
        let msg = err.to_string();
        assert!(msg.contains("30 seconds"));
        assert!(msg.contains("1000 rows"));
    }

    #[test]
    fn test_timeout_error_with_context() {
        let err = BulkCopyTimeoutError::new(500, 60, Some("Network slow".to_string()));
        let msg = err.to_string();
        assert!(msg.contains("60 seconds"));
        assert!(msg.contains("Network slow"));
    }

    #[test]
    fn test_attention_timeout_error_connection_broken() {
        let err = BulkCopyAttentionTimeoutError::new(true);
        let msg = err.to_string();
        assert!(msg.contains("5 seconds"));
        assert!(msg.contains("broken"));
    }

    #[test]
    fn test_attention_timeout_error_not_broken() {
        let err = BulkCopyAttentionTimeoutError::new(false);
        let msg = err.to_string();
        assert!(msg.contains("5 seconds"));
        assert!(!msg.contains("broken"));
    }

    #[test]
    fn test_bulk_copy_error_timeout() {
        let timeout_err = BulkCopyTimeoutError::new(100, 30, None);
        let err = BulkCopyError::Timeout(timeout_err);
        let msg = err.to_string();
        assert!(msg.contains("30 seconds"));
        assert!(msg.contains("100 rows"));
    }

    #[test]
    fn test_bulk_copy_error_attention_timeout() {
        let attn_err = BulkCopyAttentionTimeoutError::new(true);
        let err = BulkCopyError::AttentionTimeout(attn_err);
        let msg = err.to_string();
        assert!(msg.contains("Attention"));
        assert!(msg.contains("5 seconds"));
    }

    #[test]
    fn test_bulk_copy_error_connection_broken() {
        let err = BulkCopyError::ConnectionBroken("timeout".to_string());
        let msg = err.to_string();
        assert!(msg.contains("broken"));
        assert!(msg.contains("timeout"));
    }

    #[test]
    fn test_bulk_copy_error_source_timeout() {
        let timeout_err = BulkCopyTimeoutError::new(50, 15, None);
        let err = BulkCopyError::Timeout(timeout_err);
        assert!(StdError::source(&err).is_some());
    }

    #[test]
    fn test_bulk_copy_error_source_attention() {
        let attn_err = BulkCopyAttentionTimeoutError::new(true);
        let err = BulkCopyError::AttentionTimeout(attn_err);
        assert!(StdError::source(&err).is_some());
    }

    #[test]
    fn test_bulk_copy_error_source_none() {
        let err = BulkCopyError::ConnectionBroken("test".to_string());
        assert!(StdError::source(&err).is_none());
    }
}
