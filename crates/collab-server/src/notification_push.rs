use crate::{app::AppState, notification_api::PushInvalidation};
use chrono::{Duration as ChronoDuration, Utc};
use collab_net_policy::{
    normalize_http_input, validate_resolved_addresses, validate_target, PUSH_GATEWAY_POLICY,
};
use reqwest::StatusCode;
use serde::Serialize;
use sqlx::Row;
use std::time::Duration;
use tokio::net::lookup_host;
use uuid::Uuid;

const MAX_DELIVERIES_PER_PASS: i64 = 100;
const MAX_ATTEMPTS: i32 = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayRequest<'a> {
    provider: &'a str,
    token: &'a str,
    invalidation: &'a PushInvalidation,
}

pub fn spawn_worker(state: AppState) {
    let Some(_) = state.config.push_gateway_url else {
        tracing::info!(
            "push gateway is not configured; authenticated notification polling remains active"
        );
        return;
    };
    tokio::spawn(async move {
        let interval = Duration::from_secs(state.config.push_dispatch_interval_seconds);
        loop {
            if let Err(error) = dispatch_once(&state).await {
                tracing::warn!(?error, "notification push dispatch failed");
            }
            tokio::time::sleep(interval).await;
        }
    });
}

async fn dispatch_once(state: &AppState) -> Result<(), String> {
    let gateway_url = state
        .config
        .push_gateway_url
        .as_deref()
        .ok_or_else(|| "push gateway is not configured".to_string())?;
    let gateway_url =
        normalize_http_input(gateway_url, false).map_err(|error| error.to_string())?;
    let target =
        validate_target(&gateway_url, PUSH_GATEWAY_POLICY).map_err(|error| error.to_string())?;
    let addresses = lookup_host((target.host.as_str(), target.port))
        .await
        .map_err(|_| "push gateway DNS resolution failed".to_string())?;
    let addresses = validate_resolved_addresses(addresses, PUSH_GATEWAY_POLICY)
        .map_err(|error| error.to_string())?;
    let rows = sqlx::query(
        r#"WITH due AS (
               SELECT delivery.event_id,delivery.device_id
               FROM notification_push_deliveries delivery
               JOIN notification_devices device
                 ON device.id=delivery.device_id AND device.active=TRUE
               JOIN notification_events event
                 ON event.id=delivery.event_id AND event.expires_at>now()
               WHERE (
                   delivery.state IN ('pending','failed')
                   AND delivery.next_attempt_at<=now()
               ) OR (
                   delivery.state='sending'
                   AND delivery.lease_until<=now()
               )
               ORDER BY delivery.next_attempt_at,delivery.event_id
               LIMIT $1
               FOR UPDATE OF delivery SKIP LOCKED
           ),
           claimed AS (
               UPDATE notification_push_deliveries delivery
               SET state='sending',lease_until=now() + INTERVAL '1 minute',updated_at=now()
               FROM due
               WHERE delivery.event_id=due.event_id AND delivery.device_id=due.device_id
               RETURNING delivery.event_id,delivery.device_id,delivery.attempt_count
           )
           SELECT claimed.event_id,claimed.device_id,claimed.attempt_count,
                  device.provider,device.token,device.account_key,
                  event.sequence,event.id AS invalidation_id,event.category,event.created_at
           FROM claimed
           JOIN notification_devices device ON device.id=claimed.device_id
           JOIN notification_events event ON event.id=claimed.event_id"#,
    )
    .bind(MAX_DELIVERIES_PER_PASS)
    .fetch_all(&state.database)
    .await
    .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(PUSH_GATEWAY_POLICY.limits.connect_timeout)
        .timeout(PUSH_GATEWAY_POLICY.limits.request_timeout)
        .resolve_to_addrs(&target.host, &addresses)
        .build()
        .map_err(|error| error.to_string())?;
    for row in rows {
        let event_id: Uuid = row.get("event_id");
        let device_id: Uuid = row.get("device_id");
        let attempt_count: i32 = row.get("attempt_count");
        let provider: String = row.get("provider");
        let token: String = row.get("token");
        let invalidation = PushInvalidation {
            schema_version: 1,
            invalidation_id: row.get::<Uuid, _>("invalidation_id").to_string(),
            account_key: row.get("account_key"),
            category: row.get("category"),
            cursor: row.get::<i64, _>("sequence").to_string(),
            created_at: row
                .get::<chrono::DateTime<Utc>, _>("created_at")
                .to_rfc3339(),
        };
        let mut request = client.post(gateway_url.clone()).json(&GatewayRequest {
            provider: &provider,
            token: &token,
            invalidation: &invalidation,
        });
        if let Some(secret) = state.config.push_gateway_token.as_deref() {
            request = request.bearer_auth(secret);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                sqlx::query(
                    "UPDATE notification_push_deliveries
                     SET state='delivered',attempt_count=attempt_count+1,delivered_at=now(),
                         lease_until=NULL,last_error=NULL,updated_at=now()
                     WHERE event_id=$1 AND device_id=$2",
                )
                .bind(event_id)
                .bind(device_id)
                .execute(&state.database)
                .await
                .map_err(|error| error.to_string())?;
            }
            Ok(response) if response.status() == StatusCode::GONE => {
                disable_device(&state.database, event_id, device_id, "push token rejected").await?;
            }
            result => {
                let message = match result {
                    Ok(response) => format!("gateway HTTP {}", response.status().as_u16()),
                    Err(error) if error.is_timeout() => "gateway timeout".to_string(),
                    Err(_) => "gateway transport failure".to_string(),
                };
                fail_delivery(
                    &state.database,
                    event_id,
                    device_id,
                    attempt_count,
                    &message,
                )
                .await?;
            }
        }
    }
    Ok(())
}

async fn disable_device(
    database: &sqlx::PgPool,
    event_id: Uuid,
    device_id: Uuid,
    message: &str,
) -> Result<(), String> {
    let mut tx = database.begin().await.map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE notification_devices SET active=FALSE,token='',updated_at=now() WHERE id=$1",
    )
    .bind(device_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE notification_push_deliveries
         SET state='cancelled',attempt_count=attempt_count+1,lease_until=NULL,
             last_error=$1,updated_at=now()
         WHERE event_id=$2 AND device_id=$3",
    )
    .bind(message)
    .bind(event_id)
    .bind(device_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())
}

async fn fail_delivery(
    database: &sqlx::PgPool,
    event_id: Uuid,
    device_id: Uuid,
    attempt_count: i32,
    message: &str,
) -> Result<(), String> {
    let next_attempt = attempt_count.saturating_add(1);
    let terminal = next_attempt >= MAX_ATTEMPTS;
    let delay = 2_i64.pow(next_attempt.clamp(1, 8) as u32);
    sqlx::query(
        "UPDATE notification_push_deliveries
         SET state=$1,attempt_count=$2,next_attempt_at=$3,lease_until=NULL,
             last_error=$4,updated_at=now()
         WHERE event_id=$5 AND device_id=$6",
    )
    .bind(if terminal { "cancelled" } else { "failed" })
    .bind(next_attempt)
    .bind(Utc::now() + ChronoDuration::minutes(delay))
    .bind(message)
    .bind(event_id)
    .bind(device_id)
    .execute(database)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}
