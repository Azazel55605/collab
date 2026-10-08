//! Teams/channel adapter. Membership mutations share the conversation commit lock.
use super::*;
use collab_protocol::team::{may_remove_owner, TeamChannel, TeamMember, TeamSummary};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamCreate {
    pub name: String,
    pub owner_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamUpdate {
    pub name: String,
    pub archived: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberUpdate {
    pub user_id: Uuid,
    pub role: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelCreate {
    pub name: String,
    pub private: bool,
    pub members: Vec<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelUpdate {
    pub name: String,
    pub archived: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryUpdate {
    pub vault_id: Option<Uuid>,
}
#[derive(Deserialize, Default)]
pub struct Page {
    pub after: Option<Uuid>,
}
fn fail(id: &str) -> ApiFailure {
    ApiFailure::server(id.to_owned())
}
fn denied(id: &str) -> ApiFailure {
    ApiFailure::new(
        StatusCode::FORBIDDEN,
        ErrorCode::ConversationPermissionDenied,
        "Team owner access is required.",
        id.to_owned(),
    )
}
fn title(value: &str, id: &str) -> Result<String, ApiFailure> {
    let v = value.trim();
    if !(1..=100).contains(&v.chars().count()) || v.chars().any(char::is_control) {
        return Err(ApiFailure::validation(
            "Names must contain 1 to 100 printable characters.",
            id.to_owned(),
        ));
    }
    Ok(v.to_owned())
}
async fn role(
    tx: &mut Transaction<'_, Postgres>,
    team: Uuid,
    user: Uuid,
    id: &str,
) -> Result<(String, bool), ApiFailure> {
    let row=sqlx::query("SELECT m.role,t.archived FROM team_members m JOIN teams t ON t.id=m.team_id JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.user_id=$2 AND u.status='active'").bind(team).bind(user).fetch_optional(&mut **tx).await.map_err(|_|fail(id))?.ok_or_else(||ApiFailure::not_found(id.to_owned()))?;
    Ok((row.get("role"), row.get("archived")))
}
async fn owner(
    tx: &mut Transaction<'_, Postgres>,
    team: Uuid,
    user: Uuid,
    allow_archived: bool,
    id: &str,
) -> Result<(), ApiFailure> {
    let (role, archived) = role(tx, team, user, id).await?;
    if role != "owner" {
        return Err(denied(id));
    }
    if archived && !allow_archived {
        return Err(ApiFailure::validation(
            "Restore the team first.",
            id.to_owned(),
        ));
    }
    Ok(())
}
async fn log(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    team: Uuid,
    action: &str,
    metadata: Value,
    id: &str,
) -> Result<(), ApiFailure> {
    audit(
        tx,
        Some(&user.to_string()),
        action,
        Some("team"),
        Some(&team.to_string()),
        "success",
        id,
        metadata,
    )
    .await
}
async fn team_admin(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let actor = require_any_user(state, headers, id).await?;
    if actor.user.role != ServerUserRole::Admin {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            ErrorCode::AdminRequired,
            "Server administrator access is required.",
            id.to_owned(),
        ));
    }
    Ok(actor)
}
async fn active_user(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    if !sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND status='active')",
    )
    .bind(user)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| fail(id))?
    {
        return Err(ApiFailure::validation(
            "Choose an active server account.",
            id.to_owned(),
        ));
    }
    Ok(())
}
async fn join(
    tx: &mut Transaction<'_, Postgres>,
    channel: Uuid,
    user: Uuid,
    role: &str,
    id: &str,
) -> Result<(), ApiFailure> {
    let added=sqlx::query("INSERT INTO conversation_members(conversation_id,user_id,role,joined_sequence,joined_event,read_sequence) SELECT id,$2,$3,head+1,0,head FROM conversations WHERE id=$1 ON CONFLICT DO NOTHING").bind(channel).bind(user).bind(role).execute(&mut **tx).await.map_err(|_|fail(id))?.rows_affected();
    if added > 0 {
        let seq = conversations::event(tx, channel, "members", None, id).await?;
        sqlx::query("UPDATE conversation_members SET joined_event=$3 WHERE conversation_id=$1 AND user_id=$2").bind(channel).bind(user).bind(seq).execute(&mut **tx).await.map_err(|_|fail(id))?;
    }
    Ok(())
}
async fn leave(
    tx: &mut Transaction<'_, Postgres>,
    channel: Uuid,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    let count =
        sqlx::query("DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2")
            .bind(channel)
            .bind(user)
            .execute(&mut **tx)
            .await
            .map_err(|_| fail(id))?
            .rows_affected();
    if count > 0 {
        conversations::event(tx, channel, "removed", Some(vec![user]), id).await?;
        conversations::event(tx, channel, "members", None, id).await?;
    }
    Ok(())
}
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> Result<Json<DataResponse<Vec<TeamSummary>>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    let rows=sqlx::query("SELECT t.id,t.name,t.archived,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 AND ($2::uuid IS NULL OR t.id>$2) ORDER BY t.id LIMIT 100").bind(user).bind(page.after).fetch_all(&state.database).await.map_err(|_|fail(&id))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|r| TeamSummary {
                id: r.get::<Uuid, _>("id").to_string(),
                name: r.get("name"),
                role: r.get("role"),
                archived: r.get("archived"),
            })
            .collect(),
    )))
}
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<TeamCreate>,
) -> Result<Json<DataResponse<String>>, ApiFailure> {
    let actor = team_admin(&state, &headers, &id).await?;
    let user = user_uuid(&actor.user);
    let name = title(&payload.name, &id)?;
    let team = Uuid::now_v7();
    let mut tx = conversations::begin(&state.database, &id).await?;
    active_user(&mut tx, payload.owner_id, &id).await?;
    sqlx::query("INSERT INTO teams(id,name) VALUES($1,$2)")
        .bind(team)
        .bind(name)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    sqlx::query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(team)
        .bind(payload.owner_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    log(
        &mut tx,
        user,
        team,
        "team.created",
        json!({"ownerId":payload.owner_id}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(team.to_string())))
}
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
    Json(payload): Json<TeamUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let name = title(&payload.name, &id)?;
    let mut tx = conversations::begin(&state.database, &id).await?;
    owner(&mut tx, team, user, true, &id).await?;
    sqlx::query("UPDATE teams SET name=$2,archived=$3 WHERE id=$1")
        .bind(team)
        .bind(name)
        .bind(payload.archived)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    let channels = sqlx::query_scalar::<_, Uuid>(
        "SELECT conversation_id FROM team_channels WHERE team_id=$1 AND NOT archived",
    )
    .bind(team)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    for ch in channels {
        conversations::event(
            &mut tx,
            ch,
            if payload.archived {
                "removed"
            } else {
                "created"
            },
            None,
            &id,
        )
        .await?;
    }
    log(
        &mut tx,
        user,
        team,
        "team.updated",
        json!({"archived":payload.archived}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn members(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<TeamMember>>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    let mut tx = conversations::begin(&state.database, &id).await?;
    role(&mut tx, team, user, &id).await?;
    let rows=sqlx::query("SELECT m.user_id,m.role,u.display_name,(u.status='active') AS active FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY u.display_name,m.user_id LIMIT 500").bind(team).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|r| TeamMember {
                user_id: r.get::<Uuid, _>("user_id").to_string(),
                role: r.get("role"),
                display_name: r.get("display_name"),
                active: r.get("active"),
            })
            .collect(),
    )))
}
pub async fn put_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
    Json(payload): Json<MemberUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    if !matches!(payload.role.as_str(), "owner" | "member") {
        return Err(ApiFailure::validation("Invalid team role.", id));
    }
    let mut tx = conversations::begin(&state.database, &id).await?;
    owner(&mut tx, team, user, false, &id).await?;
    active_user(&mut tx, payload.user_id, &id).await?;
    protect_owner(&mut tx, team, payload.user_id, payload.role == "owner", &id).await?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM team_members WHERE team_id=$1 AND user_id<>$2",
    )
    .bind(team)
    .bind(payload.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    if count >= 500 {
        return Err(ApiFailure::validation(
            "Teams support up to 500 members.",
            id,
        ));
    }
    sqlx::query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(team_id,user_id) DO UPDATE SET role=EXCLUDED.role").bind(team).bind(payload.user_id).bind(&payload.role).execute(&mut *tx).await.map_err(|_|fail(&id))?;
    let channels = sqlx::query_scalar::<_, Uuid>(
        "SELECT conversation_id FROM team_channels WHERE team_id=$1 AND NOT private",
    )
    .bind(team)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    for ch in channels {
        join(&mut tx, ch, payload.user_id, &payload.role, &id).await?;
    }
    sqlx::query("UPDATE conversation_members SET role=$3 WHERE user_id=$2 AND conversation_id IN (SELECT conversation_id FROM team_channels WHERE team_id=$1)").bind(team).bind(payload.user_id).bind(&payload.role).execute(&mut *tx).await.map_err(|_|fail(&id))?;
    let affected=sqlx::query_scalar::<_,Uuid>("SELECT cm.conversation_id FROM conversation_members cm JOIN team_channels ch ON ch.conversation_id=cm.conversation_id WHERE ch.team_id=$1 AND cm.user_id=$2").bind(team).bind(payload.user_id).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    for channel in affected {
        conversations::event(&mut tx, channel, "members", None, &id).await?;
    }
    log(
        &mut tx,
        user,
        team,
        "team.member.updated",
        json!({"userId":payload.user_id,"role":payload.role}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
async fn protect_owner(
    tx: &mut Transaction<'_, Postgres>,
    team: Uuid,
    user: Uuid,
    keeping_owner: bool,
    id: &str,
) -> Result<(), ApiFailure> {
    if keeping_owner {
        return Ok(());
    }
    protect_private_owner(tx, team, user, None, id).await?;
    let row=sqlx::query("SELECT m.role,(u.status='active') AS active FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.user_id=$2").bind(team).bind(user).fetch_optional(&mut **tx).await.map_err(|_|fail(id))?;
    if let Some(row) = row {
        let count=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.role='owner' AND u.status='active'").bind(team).fetch_one(&mut **tx).await.map_err(|_|fail(id))?;
        if !may_remove_owner(&row.get::<String, _>("role"), row.get("active"), count) {
            return Err(ApiFailure::validation(
                "Transfer team ownership first.",
                id.to_owned(),
            ));
        }
    }
    Ok(())
}
async fn protect_private_owner(
    tx: &mut Transaction<'_, Postgres>,
    team: Uuid,
    user: Uuid,
    channel: Option<Uuid>,
    id: &str,
) -> Result<(), ApiFailure> {
    let blocked = sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_channels ch JOIN conversation_members m ON m.conversation_id=ch.conversation_id JOIN users u ON u.id=m.user_id WHERE ch.team_id=$1 AND ch.private AND ($3::uuid IS NULL OR ch.conversation_id=$3) AND m.user_id=$2 AND m.role='owner' AND u.status='active' AND NOT EXISTS(SELECT 1 FROM conversation_members other JOIN users ou ON ou.id=other.user_id WHERE other.conversation_id=ch.conversation_id AND other.user_id<>$2 AND other.role='owner' AND ou.status='active'))")
        .bind(team).bind(user).bind(channel).fetch_one(&mut **tx).await.map_err(|_|fail(id))?;
    if blocked {
        return Err(ApiFailure::validation(
            "Invite another team owner to each private channel before removing its last owner.",
            id.to_owned(),
        ));
    }
    Ok(())
}
pub async fn remove_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((team, target)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = conversations::begin(&state.database, &id).await?;
    let (r, _) = role(&mut tx, team, user, &id).await?;
    if r != "owner" && target != user {
        return Err(denied(&id));
    }
    protect_owner(&mut tx, team, target, false, &id).await?;
    let channels =
        sqlx::query_scalar::<_, Uuid>("SELECT conversation_id FROM team_channels WHERE team_id=$1")
            .bind(team)
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
    for ch in channels {
        leave(&mut tx, ch, target, &id).await?;
    }
    sqlx::query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2")
        .bind(team)
        .bind(target)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    log(
        &mut tx,
        user,
        team,
        "team.member.removed",
        json!({"userId":target}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn channels(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<TeamChannel>>>, ApiFailure> {
    let user = user_uuid(
        &require_authenticated_user(&state, &headers, &id)
            .await?
            .user,
    );
    let mut tx = conversations::begin(&state.database, &id).await?;
    role(&mut tx, team, user, &id).await?;
    let rows=sqlx::query("SELECT c.id,c.name,ch.private,ch.archived,ch.library_vault_id,(SELECT COUNT(*) FROM conversation_messages msg JOIN conversation_members cm ON cm.conversation_id=msg.conversation_id AND cm.user_id=$2 WHERE msg.conversation_id=c.id AND msg.sequence>=cm.joined_sequence AND msg.sequence>cm.read_sequence AND msg.sender_user_id IS DISTINCT FROM $2) AS unread FROM team_channels ch JOIN conversations c ON c.id=ch.conversation_id WHERE ch.team_id=$1 AND (NOT ch.private OR EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2)) ORDER BY c.name,c.id LIMIT 100").bind(team).bind(user).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|r| TeamChannel {
                id: r.get::<Uuid, _>("id").to_string(),
                name: r.get("name"),
                private: r.get("private"),
                archived: r.get("archived"),
                unread: r.get("unread"),
                library_vault_id: r
                    .get::<Option<Uuid>, _>("library_vault_id")
                    .map(|v| v.to_string()),
            })
            .collect(),
    )))
}
pub async fn create_channel(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
    Json(payload): Json<ChannelCreate>,
) -> Result<Json<DataResponse<String>>, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let name = title(&payload.name, &id)?;
    let mut tx = conversations::begin(&state.database, &id).await?;
    owner(&mut tx, team, user, false, &id).await?;
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM team_channels WHERE team_id=$1")
        .bind(team)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    if count >= 100 {
        return Err(ApiFailure::validation(
            "Teams support up to 100 channels.",
            id,
        ));
    }
    let all=sqlx::query("SELECT m.user_id,m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND u.status='active'").bind(team).fetch_all(&mut *tx).await.map_err(|_|fail(&id))?;
    let mut chosen = payload.members;
    chosen.push(user);
    chosen.sort();
    chosen.dedup();
    if chosen.len() > 500
        || chosen
            .iter()
            .any(|u| !all.iter().any(|r| r.get::<Uuid, _>("user_id") == *u))
    {
        return Err(ApiFailure::validation(
            "Channel members must be active team members.",
            id,
        ));
    }
    let ch = Uuid::now_v7();
    sqlx::query("INSERT INTO conversations(id,kind,name) VALUES($1,'channel',$2)")
        .bind(ch)
        .bind(name)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    sqlx::query("INSERT INTO team_channels(conversation_id,team_id,private) VALUES($1,$2,$3)")
        .bind(ch)
        .bind(team)
        .bind(payload.private)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    for row in all {
        let u: Uuid = row.get("user_id");
        if !payload.private || chosen.contains(&u) {
            join(&mut tx, ch, u, &row.get::<String, _>("role"), &id).await?;
        }
    }
    log(
        &mut tx,
        user,
        team,
        "team.channel.created",
        json!({"channelId":ch,"private":payload.private}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(Json(DataResponse::new(ch.to_string())))
}
async fn channel_owner(
    tx: &mut Transaction<'_, Postgres>,
    team: Uuid,
    ch: Uuid,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    owner(tx, team, user, false, id).await?;
    if !sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_channels ch JOIN conversation_members m ON m.conversation_id=ch.conversation_id WHERE ch.team_id=$1 AND ch.conversation_id=$2 AND m.user_id=$3)").bind(team).bind(ch).bind(user).fetch_one(&mut **tx).await.map_err(|_|fail(id))? {return Err(ApiFailure::not_found(id.to_owned()));}
    Ok(())
}
pub async fn update_channel(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((team, ch)): Path<(Uuid, Uuid)>,
    Json(payload): Json<ChannelUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let name = title(&payload.name, &id)?;
    let mut tx = conversations::begin(&state.database, &id).await?;
    channel_owner(&mut tx, team, ch, user, &id).await?;
    sqlx::query("UPDATE conversations SET name=$2 WHERE id=$1")
        .bind(ch)
        .bind(name)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    sqlx::query("UPDATE team_channels SET archived=$2 WHERE conversation_id=$1")
        .bind(ch)
        .bind(payload.archived)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    conversations::event(
        &mut tx,
        ch,
        if payload.archived {
            "removed"
        } else {
            "created"
        },
        None,
        &id,
    )
    .await?;
    log(
        &mut tx,
        user,
        team,
        "team.channel.updated",
        json!({"channelId":ch,"archived":payload.archived}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn channel_member(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((team, ch)): Path<(Uuid, Uuid)>,
    Json(payload): Json<MemberUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = conversations::begin(&state.database, &id).await?;
    channel_owner(&mut tx, team, ch, user, &id).await?;
    let target_role = role(&mut tx, team, payload.user_id, &id).await?.0;
    active_user(&mut tx, payload.user_id, &id).await?;
    let private =
        sqlx::query_scalar::<_, bool>("SELECT private FROM team_channels WHERE conversation_id=$1")
            .bind(ch)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| fail(&id))?;
    if !private {
        return Err(ApiFailure::validation(
            "Public channel membership follows the team.",
            id,
        ));
    }
    if payload.role == "remove" {
        protect_private_owner(&mut tx, team, payload.user_id, Some(ch), &id).await?;
        leave(&mut tx, ch, payload.user_id, &id).await?;
    } else if payload.role == "member" {
        join(&mut tx, ch, payload.user_id, &target_role, &id).await?;
    } else {
        return Err(ApiFailure::validation("Choose member or remove.", id));
    }
    log(
        &mut tx,
        user,
        team,
        "team.channel.member.updated",
        json!({"channelId":ch,"userId":payload.user_id,"membership":payload.role}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn library(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path((team, ch)): Path<(Uuid, Uuid)>,
    Json(payload): Json<LibraryUpdate>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&require_any_user(&state, &headers, &id).await?.user);
    let mut tx = conversations::begin(&state.database, &id).await?;
    channel_owner(&mut tx, team, ch, user, &id).await?;
    let old = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT library_vault_id FROM team_channels WHERE conversation_id=$1",
    )
    .bind(ch)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    for vault in [old, payload.vault_id].into_iter().flatten() {
        if sqlx::query_scalar::<_,Uuid>("SELECT id FROM hosted_vaults WHERE id=$1 AND owner_user_id=$2 AND status='active' FOR UPDATE").bind(vault).bind(user).fetch_optional(&mut *tx).await.map_err(|_|fail(&id))?.is_none() {return Err(ApiFailure::validation("Only the active vault custodian can link or detach a library. Existing file grants are retained.",id));}
    }
    if let Some(v) = payload.vault_id {
        if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_channels WHERE library_vault_id=$1 AND conversation_id<>$2)").bind(v).bind(ch).fetch_one(&mut *tx).await.map_err(|_|fail(&id))?{return Err(ApiFailure::validation("This library already belongs to another channel.",id));}
    }
    sqlx::query("UPDATE team_channels SET library_vault_id=$2 WHERE conversation_id=$1")
        .bind(ch)
        .bind(payload.vault_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    conversations::event(&mut tx, ch, "updated", None, &id).await?;
    log(
        &mut tx,
        user,
        team,
        "team.library.updated",
        json!({"channelId":ch,"oldVaultId":old,"vaultId":payload.vault_id}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
/// An explicit, audited emergency ownership claim grants public team access;
/// private channel membership remains separate and cannot be claimed here.
pub async fn oversight(
    State(state): State<AppState>,
    Extension(id): Extension<String>,
    headers: HeaderMap,
    Path(team): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let user = user_uuid(&team_admin(&state, &headers, &id).await?.user);
    let mut tx = conversations::begin(&state.database, &id).await?;
    if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM teams WHERE id=$1)")
        .bind(team)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| fail(&id))?
    {
        return Err(ApiFailure::not_found(id));
    }
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM team_members WHERE team_id=$1 AND user_id<>$2",
    )
    .bind(team)
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    if count >= 500 {
        return Err(ApiFailure::validation(
            "Teams support up to 500 members.",
            id,
        ));
    }
    sqlx::query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'").bind(team).bind(user).execute(&mut *tx).await.map_err(|_|fail(&id))?;
    let channels = sqlx::query_scalar::<_, Uuid>(
        "SELECT conversation_id FROM team_channels WHERE team_id=$1 AND NOT private",
    )
    .bind(team)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| fail(&id))?;
    for ch in channels {
        join(&mut tx, ch, user, "owner", &id).await?;
        sqlx::query(
            "UPDATE conversation_members SET role='owner' WHERE conversation_id=$1 AND user_id=$2",
        )
        .bind(ch)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(|_| fail(&id))?;
    }
    log(
        &mut tx,
        user,
        team,
        "team.oversight.claimed",
        json!({"capability":"team.oversight","privateAccess":false}),
        &id,
    )
    .await?;
    tx.commit().await.map_err(|_| fail(&id))?;
    Ok(StatusCode::NO_CONTENT)
}
pub(super) async fn ensure_account_not_last_owner(
    pool: &PgPool,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    let exists=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_members m WHERE m.user_id=$1 AND m.role='owner' AND NOT EXISTS(SELECT 1 FROM team_members other JOIN users u ON u.id=other.user_id WHERE other.team_id=m.team_id AND other.user_id<>$1 AND other.role='owner' AND u.status='active'))").bind(user).fetch_one(pool).await.map_err(|_|fail(id))?;
    let private_owner = sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_channels ch JOIN conversation_members m ON m.conversation_id=ch.conversation_id WHERE ch.private AND m.user_id=$1 AND m.role='owner' AND NOT EXISTS(SELECT 1 FROM conversation_members other JOIN users u ON u.id=other.user_id WHERE other.conversation_id=ch.conversation_id AND other.user_id<>$1 AND other.role='owner' AND u.status='active'))").bind(user).fetch_one(pool).await.map_err(|_|fail(id))?;
    if private_owner {
        return Err(ApiFailure::validation(
            "Transfer private channel ownership before disabling or deleting this account.",
            id.to_owned(),
        ));
    }
    if exists {
        return Err(ApiFailure::validation(
            "Transfer team ownership before disabling or deleting this account.",
            id.to_owned(),
        ));
    }
    Ok(())
}
pub(crate) async fn require_library_membership(
    pool: &PgPool,
    vault: Uuid,
    user: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    let denied=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM team_channels ch JOIN teams t ON t.id=ch.team_id WHERE ch.library_vault_id=$1 AND (ch.archived OR t.archived OR NOT EXISTS(SELECT 1 FROM team_members tm JOIN conversation_members cm ON cm.user_id=tm.user_id AND cm.conversation_id=ch.conversation_id JOIN users u ON u.id=tm.user_id WHERE tm.team_id=t.id AND tm.user_id=$2 AND u.status='active')))").bind(vault).bind(user).fetch_one(pool).await.map_err(|_|fail(id))?;
    if denied {
        return Err(ApiFailure::not_found(id.to_owned()));
    }
    Ok(())
}

/// Serialize library association with the vault lifecycle before soft/force deletion.
pub(super) async fn require_unlinked_library(
    tx: &mut Transaction<'_, Postgres>,
    vault: Uuid,
    id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM hosted_vaults WHERE id=$1 FOR UPDATE")
        .bind(vault)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| fail(id))?
        .ok_or_else(|| ApiFailure::not_found(id.to_owned()))?;
    let linked = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM team_channels WHERE library_vault_id=$1)",
    )
    .bind(vault)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| fail(id))?;
    if linked {
        return Err(ApiFailure::validation(
            "Detach this vault from its channel library before deleting it.",
            id.to_owned(),
        ));
    }
    Ok(())
}
