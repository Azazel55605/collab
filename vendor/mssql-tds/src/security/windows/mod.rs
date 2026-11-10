// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Windows SSPI (Security Support Provider Interface) implementation.
//!
//! This module provides integrated authentication support on Windows
//! using the SSPI API from `secur32.dll`.
//!
//! # Supported Security Packages
//!
//! - **Negotiate**: Auto-selects between Kerberos and NTLM (recommended)
//! - **Kerberos**: Domain-based authentication with mutual auth
//! - **NTLM**: Fallback for non-domain environments
//!
//! # Requirements
//!
//! - Windows Vista or later
//! - For Kerberos: Domain-joined machine with access to a KDC
//! - For NTLM: Valid local or domain credentials

mod sspi_context;
mod sspi_ffi;

pub use sspi_context::WindowsSspiContext;

/// Checks if SSPI is available on this system.
pub fn is_available() -> bool {
    // SSPI is always available on Windows Vista and later
    true
}

/// Enumerates available security packages.
///
/// # Returns
///
/// A list of available security package names (e.g., "Negotiate", "Kerberos", "NTLM").
pub fn enumerate_packages() -> Result<Vec<String>, super::SecurityError> {
    // TODO: Implement using EnumerateSecurityPackagesW
    Ok(vec![
        "Negotiate".to_string(),
        "Kerberos".to_string(),
        "NTLM".to_string(),
    ])
}
