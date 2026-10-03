//! Ephemeral, same-account discovery for running presentations.

use collab_protocol::ActivePresentation;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Presenters refresh every five seconds. A generous expiry absorbs a brief
/// network pause while ensuring a crashed presenter disappears promptly.
pub const ACTIVE_PRESENTATION_TTL: Duration = Duration::from_secs(20);
const MAX_ACTIVE_PRESENTATIONS_PER_USER: usize = 8;

#[derive(Clone)]
struct StoredPresentation {
    presentation: ActivePresentation,
    touched_at: Instant,
}

#[derive(Default)]
pub struct ActivePresentationRegistry {
    entries: Mutex<HashMap<(Uuid, String), StoredPresentation>>,
}

impl ActivePresentationRegistry {
    pub async fn upsert(&self, user_id: Uuid, presentation: ActivePresentation) {
        self.upsert_at(user_id, presentation, Instant::now()).await;
    }

    async fn upsert_at(
        &self,
        user_id: Uuid,
        presentation: ActivePresentation,
        touched_at: Instant,
    ) {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| {
            touched_at.duration_since(entry.touched_at) < ACTIVE_PRESENTATION_TTL
        });
        let key = (user_id, presentation.show_id.clone());
        if !entries.contains_key(&key) {
            let mut owned = entries
                .iter()
                .filter(|((owner_id, _), _)| *owner_id == user_id)
                .map(|(key, entry)| (key.clone(), entry.touched_at))
                .collect::<Vec<_>>();
            owned.sort_by_key(|(_, touched_at)| *touched_at);
            let remove_count = owned
                .len()
                .saturating_sub(MAX_ACTIVE_PRESENTATIONS_PER_USER - 1);
            for (oldest, _) in owned.into_iter().take(remove_count) {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            StoredPresentation {
                presentation,
                touched_at,
            },
        );
    }

    pub async fn remove(&self, user_id: Uuid, show_id: &str) {
        self.entries
            .lock()
            .await
            .remove(&(user_id, show_id.to_owned()));
    }

    pub async fn list(&self, user_id: Uuid) -> Vec<ActivePresentation> {
        self.list_at(user_id, Instant::now()).await
    }

    async fn list_at(&self, user_id: Uuid, now: Instant) -> Vec<ActivePresentation> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| now.duration_since(entry.touched_at) < ACTIVE_PRESENTATION_TTL);
        let mut presentations = entries
            .iter()
            .filter(|((owner_id, _), _)| *owner_id == user_id)
            .map(|(_, entry)| entry.presentation.clone())
            .collect::<Vec<_>>();
        presentations.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        presentations
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presentation(show_id: &str, updated_at: &str) -> ActivePresentation {
        ActivePresentation {
            show_id: show_id.into(),
            vault_id: Uuid::now_v7().to_string(),
            file_id: Uuid::now_v7().to_string(),
            relative_path: "Talks/Demo.deck".into(),
            title: "Demo".into(),
            slide_id: Some("slide-1".into()),
            position: 1,
            total: 3,
            remote_enabled: true,
            updated_at: updated_at.into(),
        }
    }

    #[tokio::test]
    async fn isolates_accounts_orders_updates_and_expires_stale_shows() {
        let registry = ActivePresentationRegistry::default();
        let now = Instant::now();
        let ada = Uuid::now_v7();
        let grace = Uuid::now_v7();
        registry
            .upsert_at(ada, presentation("older", "2026-10-03T10:00:00Z"), now)
            .await;
        registry
            .upsert_at(ada, presentation("newer", "2026-10-03T10:00:01Z"), now)
            .await;
        registry
            .upsert_at(grace, presentation("other", "2026-10-03T10:00:02Z"), now)
            .await;

        let shows = registry.list_at(ada, now).await;
        assert_eq!(
            shows
                .iter()
                .map(|show| show.show_id.as_str())
                .collect::<Vec<_>>(),
            ["newer", "older"]
        );

        registry.remove(ada, "newer").await;
        assert_eq!(registry.list_at(ada, now).await.len(), 1);
        assert!(registry
            .list_at(ada, now + ACTIVE_PRESENTATION_TTL)
            .await
            .is_empty());
        assert!(registry
            .list_at(grace, now + ACTIVE_PRESENTATION_TTL)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn bounds_each_accounts_active_shows() {
        let registry = ActivePresentationRegistry::default();
        let user = Uuid::now_v7();
        let now = Instant::now();
        for index in 0..(MAX_ACTIVE_PRESENTATIONS_PER_USER + 2) {
            registry
                .upsert_at(
                    user,
                    presentation(
                        &format!("show-{index}"),
                        &format!("2026-10-03T10:00:{index:02}Z"),
                    ),
                    now + Duration::from_millis(index as u64),
                )
                .await;
        }
        let shows = registry.list_at(user, now + Duration::from_secs(1)).await;
        assert_eq!(shows.len(), MAX_ACTIVE_PRESENTATIONS_PER_USER);
        assert!(!shows.iter().any(|show| show.show_id == "show-0"));
        assert!(!shows.iter().any(|show| show.show_id == "show-1"));
    }
}
