// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! # SSPI Token Parser
//!
//! Parses SSPI tokens (0xED) which contain security challenge/response data
//! from SQL Server during integrated authentication (Kerberos/NTLM).
//!
//! ## Token Byte Layout
//!
//! ```text
//! ┌──────────────────────────────────────────────────────────────────────┐
//! │                      SSPI Token (variable length)                    │
//! ├──────────────┬───────────────────────────────────────────────────────┤
//! │    Length    │                   SSPI Token Data                     │
//! │  (2 bytes)   │                   (N bytes)                           │
//! │   USHORT     │                   BYTES                               │
//! └──────────────┴───────────────────────────────────────────────────────┘
//!      0-1                           2-(N+1)
//!
//! Fields:
//!   Length    - Length of the SSPI token data in bytes (unsigned 16-bit)
//!   Data      - Raw SSPI token data (Kerberos AP_REQ/AP_REP or NTLM messages)
//! ```
//!
//! ## Token Flow
//!
//! SSPI authentication typically involves multiple round trips:
//!
//! 1. **Client → Server**: Initial SSPI token in Login7 packet
//! 2. **Server → Client**: SSPI challenge token (this parser handles this)
//! 3. **Client → Server**: SSPI response in SSPI message (packet type 0x11)
//! 4. **Server → Client**: Login success (LoginAck) or more SSPI tokens
//!
//! ## Authentication Protocols
//!
//! The SSPI token data format depends on the authentication protocol:
//!
//! - **Kerberos**: Contains GSS-API wrapped AP_REQ/AP_REP tokens
//! - **NTLM**: Contains NTLM_NEGOTIATE, NTLM_CHALLENGE, or NTLM_AUTHENTICATE
//! - **Negotiate (SPNEGO)**: Wraps Kerberos or NTLM in SPNEGO mechanism
//!
//! ## Example
//!
//! ```text
//! // Server sends NTLM challenge during SSPI authentication:
//! // Token Type = 0xED (SSPI)
//! // Length = 172 (0x00AC)
//! // Data = NTLM_CHALLENGE message bytes
//! ```

use async_trait::async_trait;
use tracing::trace;

use super::super::tokens::Tokens;
use super::common::TokenParser;
use crate::io::token_stream::ParserContext;
use crate::token::fed_auth_info::SspiToken;
use crate::{core::TdsResult, io::packet_reader::TdsPacketReader};

/// Parser for SSPI token (0xED) - handles security challenge/response data
#[derive(Default)]
pub(crate) struct SspiTokenParser;

#[async_trait]
impl<T> TokenParser<T> for SspiTokenParser
where
    T: TdsPacketReader + Send + Sync,
{
    async fn parse(&self, reader: &mut T, _context: &ParserContext) -> TdsResult<Tokens> {
        // Read token length (2 bytes, little-endian)
        let length = reader.read_uint16().await?;

        trace!("Parsing SSPI token with length: {}", length);

        // Read token data
        let data = if length > 0 {
            let mut buffer = vec![0u8; length as usize];
            reader.read_bytes(&mut buffer).await?;
            buffer
        } else {
            Vec::new()
        };

        trace!("SSPI token data length: {} bytes", data.len());

        Ok(Tokens::Sspi(SspiToken { data }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::parsers::common::test_utils::MockReader;

    #[tokio::test]
    async fn test_parse_sspi_token_empty() {
        // Empty SSPI token (length = 0)
        let data = vec![0x00, 0x00]; // length = 0
        let mut reader = MockReader::new(data);
        let parser = SspiTokenParser;

        let result = parser.parse(&mut reader, &ParserContext::default()).await;
        assert!(result.is_ok());

        if let Tokens::Sspi(token) = result.unwrap() {
            assert!(token.data.is_empty());
        } else {
            panic!("Expected SSPI token");
        }
    }

    #[tokio::test]
    async fn test_parse_sspi_token_with_data() {
        // SSPI token with some data
        let mut data = vec![0x04, 0x00]; // length = 4
        data.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]); // token data

        let mut reader = MockReader::new(data);
        let parser = SspiTokenParser;

        let result = parser.parse(&mut reader, &ParserContext::default()).await;
        assert!(result.is_ok());

        if let Tokens::Sspi(token) = result.unwrap() {
            assert_eq!(token.data, vec![0xDE, 0xAD, 0xBE, 0xEF]);
        } else {
            panic!("Expected SSPI token");
        }
    }

    #[tokio::test]
    async fn test_parse_sspi_token_ntlm_challenge_size() {
        // Typical NTLM challenge is around 172 bytes
        let length: u16 = 172;
        let mut data = length.to_le_bytes().to_vec();
        data.extend(std::iter::repeat_n(0xAA, length as usize));

        let mut reader = MockReader::new(data);
        let parser = SspiTokenParser;

        let result = parser.parse(&mut reader, &ParserContext::default()).await;
        assert!(result.is_ok());

        if let Tokens::Sspi(token) = result.unwrap() {
            assert_eq!(token.data.len(), 172);
        } else {
            panic!("Expected SSPI token");
        }
    }

    #[tokio::test]
    async fn test_parse_sspi_token_kerberos_size() {
        // Kerberos tokens can be quite large (e.g., 2000+ bytes)
        let length: u16 = 2048;
        let mut data = length.to_le_bytes().to_vec();
        data.extend(std::iter::repeat_n(0xBB, length as usize));

        let mut reader = MockReader::new(data);
        let parser = SspiTokenParser;

        let result = parser.parse(&mut reader, &ParserContext::default()).await;
        assert!(result.is_ok());

        if let Tokens::Sspi(token) = result.unwrap() {
            assert_eq!(token.data.len(), 2048);
        } else {
            panic!("Expected SSPI token");
        }
    }
}
