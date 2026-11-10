// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use async_trait::async_trait;
use tracing::event;

use super::super::tokens::Tokens;
use super::common::TokenParser;
use crate::{core::TdsResult, io::packet_reader::TdsPacketReader};
use crate::{
    core::Version,
    io::token_stream::ParserContext,
    message::login_options::TdsVersion,
    token::{
        login_ack::{LoginAckToken, SqlInterfaceType},
        tokens::TokenType,
    },
};

#[derive(Default)]
pub(crate) struct LoginAckTokenParser {
    // fields omitted
}

#[async_trait]
impl<T> TokenParser<T> for LoginAckTokenParser
where
    T: TdsPacketReader + Send + Sync,
{
    async fn parse(&self, reader: &mut T, _context: &ParserContext) -> TdsResult<Tokens> {
        event!(
            tracing::Level::DEBUG,
            "Parsing LoginAck token with type: 0x{:02X}",
            TokenType::LoginAck as u8
        );
        let _length = reader.read_uint16().await?;
        let interface_type = reader.read_byte().await?;
        let interface: SqlInterfaceType = interface_type.try_into()?;

        let tds_version = reader.read_int32_big_endian().await?;

        let tds_version = TdsVersion::from(tds_version);

        let prog_name = reader.read_varchar_u8_length().await?;
        let major = reader.read_byte().await?;
        let minor = reader.read_byte().await?;
        let build_hi = reader.read_byte().await?;
        let build_low = reader.read_byte().await?;

        let prog_version =
            Version::new(major, minor, ((build_hi as u16) << 8) | build_low as u16, 0);
        Ok(Tokens::from(LoginAckToken {
            interface_type: interface,
            tds_version,
            prog_name,
            prog_version,
        }))
    }
}
