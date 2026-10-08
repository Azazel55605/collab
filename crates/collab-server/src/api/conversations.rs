//! PostgreSQL adapter for server-local personal conversations. All mutations
//! acquire one commit-order lock before membership snapshots and event cursors.
use super::*;
use collab_protocol::{
    conversation::{can_remove_owner, valid_message, valid_reaction},
    ConversationEvent, ConversationEvents, ConversationMember, ConversationMessage,
    ConversationPage, ConversationReaction, ConversationReplyPreview, ConversationSummary,
};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateConversation {
    pub kind: String,
    pub name: Option<String>,
    pub members: Vec<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessage {
    pub id: Uuid,
    pub content: String,
    pub reply_to: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditMessage {
    pub content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReactionChange {
    pub emoji: String,
    pub reacted: bool,
}
#[derive(Deserialize, Default)]
pub struct ChangesQuery {
    pub changes: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadPosition {
    pub sequence: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberChange {
    pub user_id: Uuid,
    pub role: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupUpdate {
    pub name: String,
    pub picture: Option<String>,
}
#[derive(Deserialize, Default)]
pub struct InboxQuery {
    pub conversation: Option<Uuid>,
    pub before: Option<i64>,
    pub limit: Option<i64>,
    /// `true` lists only pinned conversations, `false` only unpinned ones.
    pub pinned: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinChange {
    pub pinned: bool,
}

fn fail(id: &str) -> ApiFailure {
    ApiFailure::server(id.to_owned())
}
fn conflict(message: &str, id: &str) -> ApiFailure {
    ApiFailure::new(
        StatusCode::CONFLICT,
        ErrorCode::OperationConflict,
        message,
        id.to_owned(),
    )
}
fn forbidden(id: &str) -> ApiFailure {
    ApiFailure::new(
        StatusCode::FORBIDDEN,
        ErrorCode::ConversationPermissionDenied,
        "Conversation owner access is required.",
        id.to_owned(),
    )
}
fn name(value: &str, id: &str) -> Result<String, ApiFailure> {
    let value = value.trim();
    if !(1..=100).contains(&value.chars().count()) {
        return Err(ApiFailure::validation(
            "Group names must contain 1 to 100 characters.",
            id.to_owned(),
        ));
    }
    Ok(value.to_owned())
}
fn picture(value: Option<String>, id: &str) -> Result<Option<String>, ApiFailure> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(encoded) = value.strip_prefix("data:image/png;base64,") else {
        return Err(ApiFailure::validation(
            "Group pictures must be PNG images.",
            id.to_owned(),
        ));
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ApiFailure::validation("Invalid group picture.", id.to_owned()))?;
    let dimensions_valid = bytes.len() >= 33
        && &bytes[12..16] == b"IHDR"
        && u32::from_be_bytes(bytes[8..12].try_into().unwrap()) == 13
        && (1..=1024).contains(&u32::from_be_bytes(bytes[16..20].try_into().unwrap()))
        && (1..=1024).contains(&u32::from_be_bytes(bytes[20..24].try_into().unwrap()));
    if bytes.len() > 64 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || !dimensions_valid {
        return Err(ApiFailure::validation(
            "Group pictures must be PNG images of at most 64 KiB and 1024×1024 pixels.",
            id.to_owned(),
        ));
    }
    Ok(Some(value))
}
pub(super) async fn begin(
    pool: &PgPool,
    id: &str,
) -> Result<Transaction<'static, Postgres>, ApiFailure> {
    let mut tx = pool.begin().await.map_err(|_| fail(id))?;
    sqlx::query("SELECT pg_advisory_xact_lock(3602026)")
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(id))?;
    Ok(tx)
}
async fn membership(
    tx: &mut Transaction<'_, Postgres>,
    conversation: Uuid,
    user: Uuid,
    id: &str,
) -> Result<(String, String, i64), ApiFailure> {
    let row=sqlx::query("SELECT c.kind,m.role,m.joined_sequence FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND u.status='active' AND NOT EXISTS(SELECT 1 FROM team_channels ch JOIN teams t ON t.id=ch.team_id WHERE ch.conversation_id=c.id AND (ch.archived OR t.archived OR NOT EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$2)))")
        .bind(conversation).bind(user).fetch_optional(&mut **tx).await.map_err(|_|fail(id))?
        .ok_or_else(||ApiFailure::not_found(id.to_owned()))?;
    Ok((row.get("kind"), row.get("role"), row.get("joined_sequence")))
}
pub(super) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    conversation: Uuid,
    kind: &str,
    recipients: Option<Vec<Uuid>>,
    id: &str,
) -> Result<i64, ApiFailure> {
    let recipients=match recipients { Some(value)=>value, None=>sqlx::query_scalar::<_,Uuid>("SELECT m.user_id FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND u.status='active'")
        .bind(conversation).fetch_all(&mut **tx).await.map_err(|_|fail(id))? };
    let sequence=sqlx::query_scalar::<_,i64>("INSERT INTO conversation_events(conversation_id,kind,recipients) VALUES($1,$2,$3) RETURNING sequence")
        .bind(conversation).bind(kind).bind(recipients).fetch_one(&mut **tx).await.map_err(|_|fail(id))?;
    if kind != "read" {
        sqlx::query("UPDATE conversations SET updated_cursor=$2 WHERE id=$1")
            .bind(conversation)
            .bind(sequence)
            .execute(&mut **tx)
            .await
            .map_err(|_| fail(id))?;
    }
    Ok(sequence)
}

pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<InboxQuery>,
) -> Result<Json<DataResponse<Vec<ConversationSummary>>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) || query.before.is_some_and(|v| v <= 0) {
        return Err(ApiFailure::validation("Invalid inbox cursor or limit.", id));
    }
    let rows=sqlx::query(r#"SELECT c.id,c.kind,c.name,c.head,c.updated_cursor,c.picture,m.role,m.read_sequence,(m.pinned_at IS NOT NULL) AS pinned,
        (SELECT team_id FROM team_channels WHERE conversation_id=c.id) AS team_id,
        (SELECT t.name FROM teams t JOIN team_channels ch ON ch.team_id=t.id WHERE ch.conversation_id=c.id) AS team_name,
        (SELECT other.display_name FROM conversation_members peer JOIN users other ON other.id=peer.user_id
          WHERE peer.conversation_id=c.id AND peer.user_id<>$1 LIMIT 1) AS peer_name,
        (SELECT COUNT(*) FROM conversation_messages msg WHERE msg.conversation_id=c.id
          AND msg.sequence>=m.joined_sequence AND msg.sequence>m.read_sequence AND msg.sender_user_id IS DISTINCT FROM $1) AS unread,
        (SELECT peer.user_id FROM conversation_members peer WHERE c.kind='direct' AND peer.conversation_id=c.id AND peer.user_id<>$1 LIMIT 1) AS peer_user_id,
        last.preview AS last_message,last.created_at AS last_message_at,last.sender_user_id AS last_sender,last.deleted AS last_deleted
        FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
        LEFT JOIN LATERAL (SELECT CASE WHEN msg.deleted_at IS NULL THEN LEFT(msg.content,160) END AS preview,msg.created_at,msg.sender_user_id,(msg.deleted_at IS NOT NULL) AS deleted FROM conversation_messages msg
          WHERE msg.conversation_id=c.id AND msg.sequence>=m.joined_sequence ORDER BY msg.sequence DESC LIMIT 1) last ON true
        WHERE m.user_id=$1 AND NOT EXISTS(SELECT 1 FROM team_channels ch JOIN teams t ON t.id=ch.team_id WHERE ch.conversation_id=c.id AND (ch.archived OR t.archived OR NOT EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$1))) AND ($2::bigint IS NULL OR c.updated_cursor<$2) AND ($4::uuid IS NULL OR c.id=$4)
          AND ($5::boolean IS NULL OR (m.pinned_at IS NOT NULL)=$5)
        ORDER BY c.updated_cursor DESC LIMIT $3"#)
        .bind(user).bind(query.before).bind(limit).bind(query.conversation).bind(query.pinned).fetch_all(&state.database).await.map_err(|_|fail(&id))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|r| ConversationSummary {
                id: r.get::<Uuid, _>("id").to_string(),
                kind: r.get("kind"),
                name: if r.get::<String, _>("kind") == "direct" {
                    r.get::<Option<String>, _>("peer_name")
                        .unwrap_or("Deleted user".into())
                } else {
                    r.get("name")
                },
                role: r.get("role"),
                last_sequence: r.get::<i64, _>("head").to_string(),
                read_sequence: r.get::<i64, _>("read_sequence").to_string(),
                unread: r.get("unread"),
                updated_cursor: r.get::<i64, _>("updated_cursor").to_string(),
                picture: r.get("picture"),
                team_id: r.get::<Option<Uuid>, _>("team_id").map(|v| v.to_string()),
                team_name: r.get("team_name"),
                last_message: r.get("last_message"),
                last_message_at: r
                    .get::<Option<DateTime<Utc>>, _>("last_message_at")
                    .map(|at| at.timestamp_millis().max(0) as u64),
                last_message_own: r.get::<Option<Uuid>, _>("last_sender") == Some(user),
                last_message_deleted: r.get::<Option<bool>, _>("last_deleted").unwrap_or(false),
                peer_user_id: r
                    .get::<Option<Uuid>, _>("peer_user_id")
                    .map(|v| v.to_string()),
                pinned: r.get("pinned"),
            })
            .collect(),
    )))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateConversation>,
) -> Result<Json<DataResponse<String>>, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut members = payload.members.clone();
    members.push(user);
    members.sort();
    members.dedup();
    if !(2..=50).contains(&members.len())
        || (payload.kind == "direct" && members.len() != 2)
        || !matches!(payload.kind.as_str(), "direct" | "group")
    {
        return Err(ApiFailure::validation(
            "Choose one other person for a direct chat or 2 to 50 people for a group.",
            id,
        ));
    }
    let group_name = if payload.kind == "group" {
        name(payload.name.as_deref().unwrap_or(""), &id)?
    } else {
        String::new()
    };
    let mut tx = begin(&state.database, &id).await?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE id=ANY($1) AND status='active'",
    )
    .bind(&members)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    if count != members.len() as i64 {
        return Err(ApiFailure::validation(
            "All participants must be active accounts on this server.",
            id,
        ));
    }
    if payload.kind == "direct" {
        if let Some(existing) = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM conversations WHERE pair_low=$1 AND pair_high=$2",
        )
        .bind(members[0])
        .bind(members[1])
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| fail(&id))?
        {
            tx.commit().await.map_err(|_| fail(&id))?;
            return Ok(Json(DataResponse::new(existing.to_string())));
        }
    }
    let conversation = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO conversations(id,kind,name,pair_low,pair_high) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(conversation)
    .bind(&payload.kind)
    .bind(group_name)
    .bind((payload.kind == "direct").then_some(members[0]))
    .bind((payload.kind == "direct").then_some(members[1]))
    .execute(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    let joined_event = event(&mut tx, conversation, "created", Some(members.clone()), &id).await?;
    for member in members {
        sqlx::query("INSERT INTO conversation_members VALUES($1,$2,$3,1,$4,0)")
            .bind(conversation)
            .bind(member)
            .bind(if payload.kind == "group" && member == user {
                "owner"
            } else {
                "member"
            })
            .bind(joined_event)
            .execute(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
    }
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(conversation.to_string())))
}

/// Message rows joined with sender and quoted-reply context, followed by the
/// caller's literal WHERE/ORDER clause; `concat!` keeps every query static.
macro_rules! message_select {
    ($tail:literal) => {
        concat!(
            "SELECT msg.*,u.display_name,parent.id AS reply_id,parent.sequence AS reply_sequence,",
            "(parent.deleted_at IS NOT NULL) AS reply_deleted,LEFT(parent.content,140) AS reply_content,",
            "pu.display_name AS reply_name FROM conversation_messages msg ",
            "LEFT JOIN users u ON u.id=msg.sender_user_id ",
            "LEFT JOIN conversation_messages parent ON parent.id=msg.reply_to ",
            "LEFT JOIN users pu ON pu.id=parent.sender_user_id ",
            $tail
        )
    };
}

fn millis(value: DateTime<Utc>) -> u64 {
    value.timestamp_millis().max(0) as u64
}

fn message(row: &sqlx::postgres::PgRow, joined: i64) -> ConversationMessage {
    let deleted = row.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some();
    let reply_to = row
        .get::<Option<Uuid>, _>("reply_id")
        .filter(|_| !deleted)
        .map(|id| {
            // Context from before the reader joined stays private, like history.
            let visible = row.get::<Option<i64>, _>("reply_sequence").unwrap_or(0) >= joined
                && !row.get::<Option<bool>, _>("reply_deleted").unwrap_or(false);
            ConversationReplyPreview {
                id: id.to_string(),
                user_name: row
                    .get::<Option<String>, _>("reply_name")
                    .unwrap_or("Deleted user".into()),
                content: visible
                    .then(|| row.get::<Option<String>, _>("reply_content"))
                    .flatten(),
            }
        });
    ConversationMessage {
        id: row.get::<Uuid, _>("id").to_string(),
        user_id: row
            .get::<Option<Uuid>, _>("sender_user_id")
            .unwrap_or(Uuid::nil())
            .to_string(),
        user_name: row
            .get::<Option<String>, _>("display_name")
            .unwrap_or("Deleted user".into()),
        content: if deleted {
            String::new()
        } else {
            row.get("content")
        },
        timestamp: millis(row.get::<DateTime<Utc>, _>("created_at")),
        sequence: row.get::<i64, _>("sequence").to_string(),
        edited_at: row
            .get::<Option<DateTime<Utc>>, _>("edited_at")
            .filter(|_| !deleted)
            .map(millis),
        deleted,
        reply_to,
        reactions: Vec::new(),
    }
}

/// Maps rows and attaches grouped reactions in one extra query.
async fn hydrate(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[sqlx::postgres::PgRow],
    user: Uuid,
    joined: i64,
    id: &str,
) -> Result<Vec<ConversationMessage>, ApiFailure> {
    let mut messages: Vec<_> = rows.iter().map(|row| message(row, joined)).collect();
    let ids: Vec<Uuid> = rows.iter().map(|row| row.get::<Uuid, _>("id")).collect();
    if ids.is_empty() {
        return Ok(messages);
    }
    let reactions = sqlx::query(
        "SELECT message_id,emoji,COUNT(*) AS count,bool_or(user_id=$2) AS mine,MIN(created_at) AS first
         FROM conversation_reactions WHERE message_id=ANY($1) GROUP BY message_id,emoji ORDER BY first",
    )
    .bind(&ids)
    .bind(user)
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| fail(id))?;
    let mut grouped: HashMap<String, Vec<ConversationReaction>> = HashMap::new();
    for row in reactions {
        grouped
            .entry(row.get::<Uuid, _>("message_id").to_string())
            .or_default()
            .push(ConversationReaction {
                emoji: row.get("emoji"),
                count: row.get("count"),
                mine: row.get("mine"),
            });
    }
    for message in &mut messages {
        if !message.deleted {
            message.reactions = grouped.remove(&message.id).unwrap_or_default();
        }
    }
    Ok(messages)
}

async fn one_message(
    tx: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
    user: Uuid,
    joined: i64,
    id: &str,
) -> Result<ConversationMessage, ApiFailure> {
    let rows = sqlx::query(message_select!("WHERE msg.id=$1"))
        .bind(message_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|_| fail(id))?;
    hydrate(tx, &rows, user, joined, id)
        .await?
        .pop()
        .ok_or_else(|| fail(id))
}

pub async fn messages(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Query(query): Query<ChatPageQuery>,
    Query(changes): Query<ChangesQuery>,
) -> Result<Json<DataResponse<ConversationPage>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    query.validate(&id)?;
    if changes.changes.is_some_and(|v| v < 0) {
        return Err(ApiFailure::validation("Invalid change revision.", id));
    }
    // Consistent authorization and content snapshot; removal serializes before
    // or after this request rather than exposing a partially revoked page.
    let mut tx = begin(&state.database, &id).await?;
    let (_, _, joined) = membership(&mut tx, conversation, user, &id).await?;
    let forward = query.after.is_some();
    let limit = query.limit.unwrap_or(50);
    let statement = if forward {
        message_select!("WHERE msg.conversation_id=$1 AND msg.sequence>=$2 AND ($3::bigint IS NULL OR msg.sequence<$3) AND ($4::bigint IS NULL OR msg.sequence>$4) ORDER BY msg.sequence ASC LIMIT $5")
    } else {
        message_select!("WHERE msg.conversation_id=$1 AND msg.sequence>=$2 AND ($3::bigint IS NULL OR msg.sequence<$3) AND ($4::bigint IS NULL OR msg.sequence>$4) ORDER BY msg.sequence DESC LIMIT $5")
    };
    let rows = sqlx::query(statement)
        .bind(conversation)
        .bind(joined)
        .bind(query.before)
        .bind(query.after)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    let has_more = rows.len() > limit as usize;
    let mut messages = hydrate(
        &mut tx,
        &rows[..rows.len().min(limit as usize)],
        user,
        joined,
        &id,
    )
    .await?;
    if !forward {
        messages.reverse();
    }
    let next_before = if !forward && has_more {
        messages.first().map(|v| v.sequence.clone())
    } else {
        None
    };
    let next_after = messages
        .last()
        .map(|v| v.sequence.clone())
        .or_else(|| query.after.map(|v| v.to_string()));
    let mut revision =
        sqlx::query_scalar::<_, i64>("SELECT revision FROM conversations WHERE id=$1")
            .bind(conversation)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
    // Changes are only for messages the client already holds (at or before
    // its `after` cursor); newer ones arrive through the page itself.
    let changed = match (changes.changes, query.after) {
        (Some(since), Some(after)) if since < revision => {
            let rows = sqlx::query(message_select!(
                "WHERE msg.conversation_id=$1 AND msg.sequence>=$2 AND msg.sequence<=$3 AND msg.revision>$4 ORDER BY msg.revision LIMIT 200"
            ))
            .bind(conversation)
            .bind(joined)
            .bind(after)
            .bind(since)
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
            // A capped batch only advances the cursor to its last change.
            if rows.len() == 200 {
                revision = rows[199].get("revision");
            }
            hydrate(&mut tx, &rows, user, joined, &id).await?
        }
        _ => Vec::new(),
    };
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(ConversationPage {
        messages,
        next_before,
        next_after,
        has_more,
        changed,
        revision: Some(revision.to_string()),
    })))
}

pub async fn send(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Json(payload): Json<SendMessage>,
) -> Result<(StatusCode, Json<DataResponse<ConversationMessage>>), ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let content = payload.content.trim();
    if !valid_message(content) {
        return Err(ApiFailure::validation(
            "Messages must contain 1 to 4000 characters.",
            id,
        ));
    }
    let mut tx = begin(&state.database, &id).await?;
    let (kind, _, joined) = membership(&mut tx, conversation, user, &id).await?;
    if kind == "direct" {
        let active=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND u.status='active'")
            .bind(conversation).fetch_one(&mut *tx).await.map_err(|_|fail(&id))?;
        if active != 2 {
            return Err(conflict("The other account is unavailable.", &id));
        }
    }
    if let Some(row) = sqlx::query("SELECT * FROM conversation_messages WHERE id=$1")
        .bind(payload.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| fail(&id))?
    {
        // An edited or deleted original no longer matches, so compare the
        // first-sent identity only: same conversation, sender and position.
        let original = row.get::<Option<DateTime<Utc>>, _>("edited_at").is_some()
            || row.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some()
            || row.get::<String, _>("content") == content;
        if row.get::<Uuid, _>("conversation_id") != conversation
            || row.get::<Option<Uuid>, _>("sender_user_id") != Some(user)
            || !original
            || row.get::<i64, _>("sequence") < joined
        {
            return Err(conflict("That message ID has already been used.", &id));
        }
        let value = one_message(&mut tx, payload.id, user, joined, &id).await?;
        tx.commit().await.map_err(|_| fail(&id))?;
        return Ok((StatusCode::OK, Json(DataResponse::new(value))));
    }
    if let Some(parent) = payload.reply_to {
        let visible = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_messages WHERE id=$1 AND conversation_id=$2 AND sequence>=$3 AND deleted_at IS NULL",
        )
        .bind(parent)
        .bind(conversation)
        .bind(joined)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
        if visible == 0 {
            return Err(ApiFailure::validation(
                "The message you are replying to is no longer available.",
                id,
            ));
        }
    }
    let sequence = sqlx::query_scalar::<_, i64>(
        "UPDATE conversations SET head=head+1 WHERE id=$1 RETURNING head",
    )
    .bind(conversation)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    sqlx::query("INSERT INTO conversation_messages(id,conversation_id,sender_user_id,content,sequence,reply_to) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(payload.id).bind(conversation).bind(user).bind(content).bind(sequence).bind(payload.reply_to).execute(&mut *tx).await.map_err(|_|fail(&id))?;
    let sent = one_message(&mut tx, payload.id, user, joined, &id).await?;
    let recipients=sqlx::query_scalar::<_,Uuid>("SELECT m.user_id FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.user_id<>$2 AND u.status='active'")
        .bind(conversation).bind(user).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    let team_id =
        sqlx::query_scalar::<_, Uuid>("SELECT team_id FROM team_channels WHERE conversation_id=$1")
            .bind(conversation)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
    let mut destination = json!({"kind":"conversation","conversationId":conversation});
    if let Some(team) = team_id {
        destination["teamId"] = json!(team);
    }
    for recipient in recipients {
        let account_key = crate::notification_api::account_key(recipient);
        let source = payload.id.to_string();
        let delivery = format!("conversation-{conversation}");
        // Generic content stays safe after revocation and on lock screens.
        // Opening the destination always revalidates current membership.
        let envelope = json!({
            "schemaVersion":1,"id":crate::notification_api::envelope_id("collaboration.message",&account_key,&source,&delivery),
            "category":"collaboration.message","kind":"collaboration.message","channel":"collaboration",
            "accountKey":account_key,"sourceId":source,"deliveryKey":delivery,"createdAt":Utc::now().to_rfc3339(),
            "expiresAt":crate::notification_api::expires_at(30),"title":"New chat message","body":"Open Collab to read it.",
            "privacy":"title-only","priority":"normal","destination":destination,
            "actions":[{"kind":"open"},{"kind":"dismiss"}],"requiresInbox":true
        });
        crate::notification_api::insert_event(
            &mut tx,
            recipient,
            "collaboration.message",
            &format!("conversation-message:{}:{recipient}", payload.id),
            &envelope,
        )
        .await
        .map_err(|_| fail(&id))?;
    }
    event(&mut tx, conversation, "message", None, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok((StatusCode::CREATED, Json(DataResponse::new(sent))))
}

/// Locks a visible, undeleted message for a change and returns its sender.
async fn changeable(
    tx: &mut Transaction<'_, Postgres>,
    conversation: Uuid,
    message_id: Uuid,
    joined: i64,
    id: &str,
) -> Result<Option<Uuid>, ApiFailure> {
    let row = sqlx::query(
        "SELECT sender_user_id FROM conversation_messages WHERE id=$1 AND conversation_id=$2 AND sequence>=$3 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(message_id)
    .bind(conversation)
    .bind(joined)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| fail(id))?
    .ok_or_else(|| ApiFailure::not_found(id.to_owned()))?;
    Ok(row.get("sender_user_id"))
}
async fn bump_revision(
    tx: &mut Transaction<'_, Postgres>,
    conversation: Uuid,
    message_id: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    let revision = sqlx::query_scalar::<_, i64>(
        "UPDATE conversations SET revision=revision+1 WHERE id=$1 RETURNING revision",
    )
    .bind(conversation)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| fail(id))?;
    sqlx::query("UPDATE conversation_messages SET revision=$2 WHERE id=$1")
        .bind(message_id)
        .bind(revision)
        .execute(&mut **tx)
        .await
        .map_err(|_| fail(id))?;
    Ok(())
}
fn sender_only(id: &str) -> ApiFailure {
    ApiFailure::new(
        StatusCode::FORBIDDEN,
        ErrorCode::ConversationPermissionDenied,
        "Only the sender can change this message.",
        id.to_owned(),
    )
}

pub async fn edit_message(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((conversation, message_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<EditMessage>,
) -> Result<Json<DataResponse<ConversationMessage>>, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let content = payload.content.trim();
    if !valid_message(content) {
        return Err(ApiFailure::validation(
            "Messages must contain 1 to 4000 characters.",
            id,
        ));
    }
    let mut tx = begin(&state.database, &id).await?;
    let (_, _, joined) = membership(&mut tx, conversation, user, &id).await?;
    if changeable(&mut tx, conversation, message_id, joined, &id).await? != Some(user) {
        return Err(sender_only(&id));
    }
    let changed = sqlx::query(
        "UPDATE conversation_messages SET content=$2,edited_at=NOW() WHERE id=$1 AND content<>$2",
    )
    .bind(message_id)
    .bind(content)
    .execute(&mut *tx)
    .await
    .map_err(|_| fail(&id))?
    .rows_affected()
        > 0;
    if changed {
        bump_revision(&mut tx, conversation, message_id, &id).await?;
    }
    let value = one_message(&mut tx, message_id, user, joined, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(value)))
}

pub async fn delete_message(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((conversation, message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = begin(&state.database, &id).await?;
    let (_, _, joined) = membership(&mut tx, conversation, user, &id).await?;
    if changeable(&mut tx, conversation, message_id, joined, &id).await? != Some(user) {
        return Err(sender_only(&id));
    }
    // The row stays so sequences, read positions and replies remain stable;
    // its text and reactions are removed.
    sqlx::query("UPDATE conversation_messages SET content='',deleted_at=NOW() WHERE id=$1")
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    sqlx::query("DELETE FROM conversation_reactions WHERE message_id=$1")
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    bump_revision(&mut tx, conversation, message_id, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn react(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((conversation, message_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<ReactionChange>,
) -> Result<Json<DataResponse<ConversationMessage>>, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    if !valid_reaction(&payload.emoji) {
        return Err(ApiFailure::validation("Reactions must be one emoji.", id));
    }
    let mut tx = begin(&state.database, &id).await?;
    let (_, _, joined) = membership(&mut tx, conversation, user, &id).await?;
    changeable(&mut tx, conversation, message_id, joined, &id).await?;
    let changed = if payload.reacted {
        let mine = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_reactions WHERE message_id=$1 AND user_id=$2",
        )
        .bind(message_id)
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
        if mine >= 20 {
            return Err(ApiFailure::validation(
                "You can add at most 20 reactions to one message.",
                id,
            ));
        }
        sqlx::query("INSERT INTO conversation_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
    } else {
        sqlx::query(
            "DELETE FROM conversation_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
        )
    }
    .bind(message_id)
    .bind(user)
    .bind(&payload.emoji)
    .execute(&mut *tx)
    .await
    .map_err(|_| fail(&id))?
    .rows_affected()
        > 0;
    if changed {
        bump_revision(&mut tx, conversation, message_id, &id).await?;
    }
    let value = one_message(&mut tx, message_id, user, joined, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(value)))
}

pub async fn pin(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Json(payload): Json<PinChange>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = begin(&state.database, &id).await?;
    membership(&mut tx, conversation, user, &id).await?;
    if payload.pinned {
        let pins = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_members WHERE user_id=$1 AND pinned_at IS NOT NULL AND conversation_id<>$2",
        )
        .bind(user)
        .bind(conversation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
        if pins >= collab_protocol::conversation::MAX_PINS {
            return Err(ApiFailure::validation(
                "You can pin at most 20 chats. Unpin one first.",
                id,
            ));
        }
    }
    sqlx::query(
        "UPDATE conversation_members SET pinned_at=CASE WHEN $3 THEN COALESCE(pinned_at,NOW()) END WHERE conversation_id=$1 AND user_id=$2",
    )
    .bind(conversation)
    .bind(user)
    .bind(payload.pinned)
    .execute(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn read(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Json(payload): Json<ReadPosition>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let sequence = payload
        .sequence
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= 0)
        .ok_or_else(|| ApiFailure::validation("Invalid read position.", id.clone()))?;
    let mut tx = begin(&state.database, &id).await?;
    membership(&mut tx, conversation, user, &id).await?;
    let head = sqlx::query_scalar::<_, i64>("SELECT head FROM conversations WHERE id=$1")
        .bind(conversation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    if sequence > head {
        return Err(ApiFailure::validation(
            "Read position exceeds message history.",
            id,
        ));
    }
    let changed=sqlx::query("UPDATE conversation_members SET read_sequence=$3 WHERE conversation_id=$1 AND user_id=$2 AND read_sequence<$3")
        .bind(conversation).bind(user).bind(sequence).execute(&mut *tx).await.map_err(|_|fail(&id))?.rows_affected()>0;
    if changed {
        event(&mut tx, conversation, "read", Some(vec![user]), &id).await?;
    }
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn members(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<ConversationMember>>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    let mut tx = begin(&state.database, &id).await?;
    membership(&mut tx, conversation, user, &id).await?;
    let rows=sqlx::query("SELECT m.user_id,m.role,u.display_name,(u.status='active') AS active FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 ORDER BY u.display_name")
        .bind(conversation).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|r| ConversationMember {
                user_id: r.get::<Uuid, _>("user_id").to_string(),
                role: r.get("role"),
                display_name: r.get("display_name"),
                active: r.get("active"),
            })
            .collect(),
    )))
}

pub async fn add_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Json(payload): Json<MemberChange>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    if payload.role.as_deref().is_some_and(|v| v != "member") {
        return Err(ApiFailure::validation(
            "Invite first, then promote an existing member.",
            id,
        ));
    }
    let mut tx = begin(&state.database, &id).await?;
    let (kind, role, _) = membership(&mut tx, conversation, user, &id).await?;
    if kind != "group" || role != "owner" {
        return Err(forbidden(&id));
    }
    let active = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND status='active')",
    )
    .bind(payload.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM conversation_members WHERE conversation_id=$1",
    )
    .bind(conversation)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    if !active || count >= 50 {
        return Err(ApiFailure::validation(
            "Choose an active account; groups support at most 50 members.",
            id,
        ));
    }
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2)",
    )
    .bind(conversation)
    .bind(payload.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    if exists {
        return Err(conflict("This account is already a participant.", &id));
    }
    let head = sqlx::query_scalar::<_, i64>("SELECT head FROM conversations WHERE id=$1")
        .bind(conversation)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    let cursor = event(
        &mut tx,
        conversation,
        "members",
        Some(vec![payload.user_id]),
        &id,
    )
    .await?;
    sqlx::query("INSERT INTO conversation_members VALUES($1,$2,'member',$3,$4,$5)")
        .bind(conversation)
        .bind(payload.user_id)
        .bind(head + 1)
        .bind(cursor)
        .bind(head)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    event(&mut tx, conversation, "members", None, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn change_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((conversation, target)): Path<(Uuid, Uuid)>,
    Json(payload): Json<MemberChange>,
) -> Result<StatusCode, ApiFailure> {
    if payload.user_id != target || !matches!(payload.role.as_deref(), Some("owner" | "member")) {
        return Err(ApiFailure::validation(
            "Choose owner or member for this participant.",
            id,
        ));
    }
    mutate_member(state, id, headers, conversation, target, payload.role).await
}
pub async fn remove_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((conversation, target)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    mutate_member(state, id, headers, conversation, target, None).await
}
async fn mutate_member(
    state: AppState,
    id: String,
    headers: HeaderMap,
    conversation: Uuid,
    target: Uuid,
    new_role: Option<String>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = begin(&state.database, &id).await?;
    let (kind, role, _) = membership(&mut tx, conversation, user, &id).await?;
    if kind != "group" || (role != "owner" && !(target == user && new_role.is_none())) {
        return Err(forbidden(&id));
    }
    let target_row=sqlx::query("SELECT m.role,(u.status='active') AS active FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.user_id=$2")
        .bind(conversation).bind(target).fetch_optional(&mut *tx).await.map_err(|_|fail(&id))?.ok_or_else(||ApiFailure::not_found(id.clone()))?;
    let owners=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversation_members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.role='owner' AND u.status='active'")
        .bind(conversation).fetch_one(&mut *tx).await.map_err(|_|fail(&id))?;
    let removes_owner = target_row.get::<String, _>("role") == "owner"
        && target_row.get::<bool, _>("active")
        && new_role.as_deref() != Some("owner");
    if !can_remove_owner(removes_owner, owners) {
        return Err(conflict(
            "Promote another active owner before leaving or demoting the last owner.",
            &id,
        ));
    }
    if new_role.as_deref() == Some("owner") && !target_row.get::<bool, _>("active") {
        return Err(ApiFailure::validation(
            "Only active participants can become owners.",
            id,
        ));
    }
    if let Some(role) = new_role {
        sqlx::query(
            "UPDATE conversation_members SET role=$3 WHERE conversation_id=$1 AND user_id=$2",
        )
        .bind(conversation)
        .bind(target)
        .bind(role)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    } else {
        sqlx::query("DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2")
            .bind(conversation)
            .bind(target)
            .execute(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
        event(&mut tx, conversation, "removed", Some(vec![target]), &id).await?;
    }
    event(&mut tx, conversation, "members", None, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(conversation): Path<Uuid>,
    Json(payload): Json<GroupUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let name = name(&payload.name, &id)?;
    let picture = picture(payload.picture, &id)?;
    let mut tx = begin(&state.database, &id).await?;
    let (kind, role, _) = membership(&mut tx, conversation, user, &id).await?;
    if kind != "group" || role != "owner" {
        return Err(forbidden(&id));
    }
    sqlx::query("UPDATE conversations SET name=$2,picture=$3 WHERE id=$1")
        .bind(conversation)
        .bind(name)
        .bind(picture)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    event(&mut tx, conversation, "updated", None, &id).await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn events(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<ChatPageQuery>,
) -> Result<Json<DataResponse<ConversationEvents>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    query.validate(&id)?;
    if query.before.is_some() {
        return Err(ApiFailure::validation("Events use an after cursor.", id));
    }
    let after = query.after.unwrap_or(0);
    let limit = query.limit.unwrap_or(100);
    let rows = sqlx::query(
        r#"SELECT e.sequence,e.conversation_id,e.kind FROM conversation_events e
        LEFT JOIN conversation_members m ON m.conversation_id=e.conversation_id AND m.user_id=$1
        WHERE e.recipients @> ARRAY[$1]::uuid[] AND e.sequence>$2
          AND (e.kind='removed' OR NOT EXISTS(SELECT 1 FROM team_channels ch JOIN teams t ON t.id=ch.team_id WHERE ch.conversation_id=e.conversation_id AND (ch.archived OR t.archived OR NOT EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$1))))
          AND ((e.kind='removed' AND m.user_id IS NULL) OR (m.user_id IS NOT NULL AND e.sequence>=m.joined_event))
        ORDER BY e.sequence LIMIT $3"#,
    )
    .bind(user)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&state.database)
    .await
    .map_err(|_| fail(&id))?;
    let has_more = rows.len() > limit as usize;
    let events = rows
        .iter()
        .take(limit as usize)
        .map(|r| ConversationEvent {
            sequence: r.get::<i64, _>("sequence").to_string(),
            conversation_id: r.get::<Uuid, _>("conversation_id").to_string(),
            kind: r.get("kind"),
        })
        .collect::<Vec<_>>();
    let next_after = events
        .last()
        .map(|e| e.sequence.clone())
        .unwrap_or_else(|| after.to_string());
    Ok(Json(DataResponse::new(ConversationEvents {
        events,
        next_after,
        has_more,
    })))
}

pub async fn ensure_account_not_last_owner(
    pool: &PgPool,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    let exists=sqlx::query_scalar::<_,bool>(r#"SELECT EXISTS(SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id=$1 AND m.role='owner' AND c.kind='group'
        AND NOT EXISTS(SELECT 1 FROM conversation_members other JOIN users u ON u.id=other.user_id WHERE other.conversation_id=m.conversation_id AND other.user_id<>$1 AND other.role='owner' AND u.status='active'))"#)
        .bind(user).fetch_one(pool).await.map_err(|_|fail(id))?;
    super::teams::ensure_account_not_last_owner(pool, user, id).await?;
    if exists {
        return Err(ApiFailure::validation(
            "Transfer group conversation ownership before disabling or deleting this account.",
            id.to_owned(),
        ));
    }
    Ok(())
}
