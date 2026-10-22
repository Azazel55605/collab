//! Bounded socket ownership. Durable overflow disconnects and replays via Yjs state vectors.
use parking_lot::Mutex;
use reqwest_websocket::Message;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

pub(super) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024 + 17;
const MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024 + 34;
const MAX_FRAMES: usize = 128;
pub(super) struct QueuedFrame {
    pub message: Message,
    _bytes: OwnedSemaphorePermit,
    awareness: Option<Vec<u8>>,
}
pub(super) struct LiveQueue {
    frames: Mutex<VecDeque<QueuedFrame>>,
    budget: Arc<Semaphore>,
    ready: Notify,
}
impl Default for LiveQueue {
    fn default() -> Self {
        Self {
            frames: Mutex::new(VecDeque::new()),
            budget: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
            ready: Notify::new(),
        }
    }
}
// Coalesce only a single client's replaceable awareness for the same document.
// Multi-client/removal batches are kept in order, never confused with durable updates.
fn awareness_key(message: &Message) -> Option<Vec<u8>> {
    let Message::Binary(bytes) = message else {
        return None;
    };
    if bytes.len() < 19 || bytes[0] != 3 || bytes[17] != 1 {
        return None;
    }
    let mut end = 18;
    for _ in 0..10 {
        let value = *bytes.get(end)?;
        end += 1;
        if value & 128 == 0 {
            let mut key = bytes[1..17].to_vec();
            key.extend_from_slice(&bytes[18..end]);
            return Some(key);
        }
    }
    None
}
impl LiveQueue {
    pub fn push(&self, message: Message) -> Result<(), String> {
        let size = match &message {
            Message::Text(s) => s.len(),
            Message::Binary(b) => b.len(),
            _ => 0,
        };
        if size > MAX_FRAME_BYTES {
            return Err(
                "Live frame exceeds the 16 MiB payload limit; reconnect to synchronize".into(),
            );
        }
        let key = awareness_key(&message);
        let transient = matches!(&message, Message::Binary(b) if b.first() == Some(&3));
        let mut frames = self.frames.lock();
        if let Some(key) = &key {
            if let Some(index) = frames
                .iter()
                .position(|f| f.awareness.as_ref() == Some(key))
            {
                frames.remove(index);
            }
        }
        if frames.len() >= MAX_FRAMES {
            return if transient {
                Ok(())
            } else {
                Err("Live socket backlog is full; reconnect to synchronize".into())
            };
        }
        let Ok(permit) = Arc::clone(&self.budget).try_acquire_many_owned(size as u32) else {
            return if transient {
                Ok(())
            } else {
                Err("Live socket byte budget is full; reconnect to synchronize".into())
            };
        };
        frames.push_back(QueuedFrame {
            message,
            _bytes: permit,
            awareness: key,
        });
        drop(frames);
        self.ready.notify_one();
        Ok(())
    }
    pub async fn next(&self) -> QueuedFrame {
        loop {
            let notified = self.ready.notified();
            if let Some(frame) = self.frames.lock().pop_front() {
                return frame;
            }
            notified.await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounds_durable_backlog_and_keeps_inflight_bytes_reserved() {
        let q = LiveQueue::default();
        q.push(Message::Binary(vec![2; MAX_FRAME_BYTES].into()))
            .unwrap();
        let in_flight = q.next().await;
        q.push(Message::Binary(vec![2; MAX_FRAME_BYTES].into()))
            .unwrap();
        assert!(q.push(Message::Text("durable".into())).is_err());
        drop(in_flight);
        q.push(Message::Text("durable".into())).unwrap();
    }
    #[tokio::test]
    async fn coalesces_one_clients_awareness_without_dropping_durable_updates() {
        let q = LiveQueue::default();
        let frame = |clock| {
            let mut b = vec![3];
            b.extend_from_slice(&[7; 16]);
            b.extend_from_slice(&[1, 42, clock, 2, b'{', b'}']);
            Message::Binary(b.into())
        };
        q.push(frame(1)).unwrap();
        q.push(Message::Text("durable".into())).unwrap();
        q.push(frame(2)).unwrap();
        assert_eq!(q.frames.lock().len(), 2);
        assert!(matches!(q.next().await.message, Message::Text(_)));
        for _ in 0..MAX_FRAMES {
            let _ = q.push(Message::Text("x".into()));
        }
        assert!(q.push(Message::Text("durable".into())).is_err());
    }
}

pub(super) async fn send_with_deadline<S: futures_util::Sink<Message> + Unpin>(
    sink: &mut S,
    message: Message,
    deadline: std::time::Duration,
) -> Result<(), ()> {
    use futures_util::SinkExt;
    match tokio::time::timeout(deadline, sink.send(message)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}
#[cfg(test)]
mod deadline_tests {
    #[tokio::test]
    async fn a_stalled_sink_is_retired_instead_of_holding_a_queue_forever() {
        let mut sink = Box::pin(futures_util::sink::unfold(
            (),
            |(), _: reqwest_websocket::Message| {
                std::future::pending::<Result<(), std::convert::Infallible>>()
            },
        ));
        assert!(super::send_with_deadline(
            &mut sink,
            reqwest_websocket::Message::Text("retained in Y.Doc".into()),
            std::time::Duration::from_millis(5)
        )
        .await
        .is_err());
    }
}
