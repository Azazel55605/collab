// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::vec;

use async_trait::async_trait;

use super::super::tokens::{FeatureExtAckToken, Tokens};
use super::common::{MAX_ALLOWED_FE_DATA_IN_BYTES, TokenParser};
use crate::{core::TdsResult, io::packet_reader::TdsPacketReader};
use crate::{io::token_stream::ParserContext, message::login::FeatureExtension};

#[derive(Default)]
pub(crate) struct FeatureExtAckTokenParser {
    // fields omitted
}

#[async_trait]
impl<T> TokenParser<T> for FeatureExtAckTokenParser
where
    T: TdsPacketReader + Send + Sync,
{
    async fn parse(&self, reader: &mut T, _context: &ParserContext) -> TdsResult<Tokens> {
        let mut features: Vec<(FeatureExtension, Vec<u8>)> = Vec::new();
        loop {
            let feature_identifier = FeatureExtension::from(reader.read_byte().await?);
            if feature_identifier == FeatureExtension::Terminator {
                break;
            }
            let data_length = reader.read_uint32().await?;

            // Validate allocation size to prevent OOM attacks
            if data_length as usize > MAX_ALLOWED_FE_DATA_IN_BYTES {
                return Err(crate::error::Error::ProtocolError(format!(
                    "FeatureExtAck data length too large: {data_length} bytes (max: {MAX_ALLOWED_FE_DATA_IN_BYTES} bytes). Possible DoS attack."
                )));
            }

            let mut feature_data_buffer = vec![0; data_length as usize];

            if data_length > 0 {
                reader.read_bytes(&mut feature_data_buffer[0..]).await?;
                // Store the features somewhere.
            }
            features.push((feature_identifier, feature_data_buffer));
        }
        Ok(Tokens::from(FeatureExtAckToken::new(features)))
    }
}
