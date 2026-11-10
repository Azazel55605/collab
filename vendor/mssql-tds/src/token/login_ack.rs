// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use crate::core::Version;
use crate::message::login_options::TdsVersion;
use crate::token::tokens::{Token, TokenType};

/// SQL interface type reported in the `LOGINACK` token.
#[repr(u8)]
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum SqlInterfaceType {
    Default = 0,
    TSql = 1,
    Unknown(u8),
}

impl TryFrom<u8> for SqlInterfaceType {
    type Error = crate::error::Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Ok(match value {
            0 => SqlInterfaceType::Default,
            1 => SqlInterfaceType::TSql,
            unknown => SqlInterfaceType::Unknown(unknown),
        })
    }
}

impl SqlInterfaceType {
    #[allow(dead_code)]
    pub(crate) fn as_u8(&self) -> u8 {
        match self {
            SqlInterfaceType::Default => 0,
            SqlInterfaceType::TSql => 1,
            SqlInterfaceType::Unknown(val) => *val,
        }
    }
}

/// Server acknowledgment of a successful login, including negotiated TDS version.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct LoginAckToken {
    pub(crate) interface_type: SqlInterfaceType,
    pub(crate) tds_version: TdsVersion,
    pub(crate) prog_name: String,
    pub(crate) prog_version: Version,
}

impl Token for LoginAckToken {
    fn token_type(&self) -> TokenType {
        TokenType::LoginAck
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sql_interface_type_try_from() {
        // Test valid values
        assert!(matches!(
            SqlInterfaceType::try_from(0).unwrap(),
            SqlInterfaceType::Default
        ));
        assert!(matches!(
            SqlInterfaceType::try_from(1).unwrap(),
            SqlInterfaceType::TSql
        ));

        // Test invalid values (should not panic, should return Unknown)
        assert!(matches!(
            SqlInterfaceType::try_from(173).unwrap(),
            SqlInterfaceType::Unknown(173)
        ));
        assert!(matches!(
            SqlInterfaceType::try_from(255).unwrap(),
            SqlInterfaceType::Unknown(255)
        ));
    }

    #[test]
    fn test_sql_interface_type_as_u8() {
        assert_eq!(SqlInterfaceType::Default.as_u8(), 0);
        assert_eq!(SqlInterfaceType::TSql.as_u8(), 1);
        assert_eq!(SqlInterfaceType::Unknown(173).as_u8(), 173);
    }
}
