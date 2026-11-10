// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use crate::core::TdsResult;
use crate::io::packet_writer::{PacketWriter, TdsPacketWriter};
use crate::message::headers::write_headers;
use crate::message::messages::{PacketType, Request};
use async_trait::async_trait;

pub(crate) struct AttentionRequest {}

impl AttentionRequest {
    pub fn new() -> Self {
        AttentionRequest {}
    }
}

#[async_trait]
impl Request for AttentionRequest {
    fn packet_type(&self) -> PacketType {
        PacketType::Attention
    }

    async fn serialize<'a, 'b>(&'a self, packet_writer: &'a mut PacketWriter<'b>) -> TdsResult<()>
    where
        'b: 'a,
    {
        write_headers(&Vec::new(), packet_writer).await?;
        packet_writer.finalize().await?;
        Ok(())
    }
}
