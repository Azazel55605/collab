// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use crate::token::tokens::{Token, TokenType};

/// Identifies a piece of federated-authentication info from the server.
#[allow(clippy::upper_case_acronyms)]
pub enum FedAuthInfoId {
    SPN,
    STSUrl,
    Unknown(u8),
}

impl FedAuthInfoId {
    /// Returns the wire byte value of this identifier.
    #[allow(dead_code)]
    pub fn as_u8(&self) -> u8 {
        match self {
            FedAuthInfoId::SPN => 0x02,
            FedAuthInfoId::STSUrl => 0x01,
            FedAuthInfoId::Unknown(v) => *v,
        }
    }
}

impl From<u8> for FedAuthInfoId {
    fn from(v: u8) -> Self {
        match v {
            0x02 => FedAuthInfoId::SPN,
            0x01 => FedAuthInfoId::STSUrl,
            _ => {
                tracing::warn!("Unknown FedAuthInfoId: 0x{:02X}", v);
                FedAuthInfoId::Unknown(v)
            }
        }
    }
}

/// Federated-authentication info returned by the server.
#[derive(Debug)]
pub struct FedAuthInfoToken {
    /// Service Principal Name for the target resource.
    pub spn: String,
    /// Security Token Service URL for token acquisition.
    pub sts_url: String,
}

impl Token for FedAuthInfoToken {
    fn token_type(&self) -> TokenType {
        TokenType::FedAuthInfo
    }
}

/// Raw SSPI authentication token received from the server.
#[derive(Debug)]
pub struct SspiToken {
    /// Opaque SSPI blob bytes.
    pub data: Vec<u8>,
}

impl Token for SspiToken {
    fn token_type(&self) -> TokenType {
        TokenType::SSPI
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fed_auth_info_id_as_u8() {
        assert_eq!(FedAuthInfoId::SPN.as_u8(), 0x02);
        assert_eq!(FedAuthInfoId::STSUrl.as_u8(), 0x01);
        assert_eq!(FedAuthInfoId::Unknown(0xFF).as_u8(), 0xFF);
    }

    #[test]
    fn test_fed_auth_info_id_from_u8_spn() {
        let id = FedAuthInfoId::from(0x02);
        assert_eq!(id.as_u8(), 0x02);
    }

    #[test]
    fn test_fed_auth_info_id_from_u8_sts_url() {
        let id = FedAuthInfoId::from(0x01);
        assert_eq!(id.as_u8(), 0x01);
    }

    #[test]
    fn test_fed_auth_info_id_from_u8_unknown() {
        let id = FedAuthInfoId::from(0xFF);
        assert_eq!(id.as_u8(), 0xFF);
    }

    #[test]
    fn test_fed_auth_info_token_creation() {
        let token = FedAuthInfoToken {
            spn: "service/host".to_string(),
            sts_url: "https://sts.example.com".to_string(),
        };
        assert_eq!(token.spn, "service/host");
        assert_eq!(token.sts_url, "https://sts.example.com");
    }

    #[test]
    fn test_fed_auth_info_token_type() {
        let token = FedAuthInfoToken {
            spn: "test".to_string(),
            sts_url: "test".to_string(),
        };
        assert_eq!(token.token_type(), TokenType::FedAuthInfo);
    }

    #[test]
    fn test_sspi_token_creation() {
        let data = vec![1, 2, 3, 4, 5];
        let token = SspiToken { data: data.clone() };
        assert_eq!(token.data, data);
    }

    #[test]
    fn test_sspi_token_type() {
        let token = SspiToken { data: vec![] };
        assert_eq!(token.token_type(), TokenType::SSPI);
    }

    #[test]
    fn test_sspi_token_debug() {
        let token = SspiToken {
            data: vec![1, 2, 3],
        };
        let debug_str = format!("{token:?}");
        assert!(debug_str.contains("SspiToken"));
    }

    #[test]
    fn test_fed_auth_info_token_debug() {
        let token = FedAuthInfoToken {
            spn: "test".to_string(),
            sts_url: "url".to_string(),
        };
        let debug_str = format!("{token:?}");
        assert!(debug_str.contains("FedAuthInfoToken"));
    }
}
