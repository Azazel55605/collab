use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use collab_core::sha256_text;
use collab_protocol::{ServerUser, ServerUserRole, ServerUserStatus};
use rand::Rng;
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub const SESSION_COOKIE: &str = "collab_session";
pub const CSRF_COOKIE: &str = "collab_csrf";

#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user: ServerUser,
    pub session_id: Uuid,
    pub csrf_hash: String,
}

pub fn normalize_username(username: &str) -> Result<String, AuthError> {
    let normalized = username.trim().to_lowercase();
    if normalized.len() < 3
        || normalized.len() > 64
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(AuthError::InvalidUsername);
    }
    Ok(normalized)
}

pub fn validate_password(password: &str) -> Result<(), AuthError> {
    if password.len() < 12 || password.len() > 1024 {
        return Err(AuthError::InvalidPassword);
    }
    Ok(())
}

pub fn hash_password(password: &str) -> Result<String, AuthError> {
    validate_password(password)?;
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::PasswordHash)
}

pub fn verify_password(password: &str, encoded_hash: &str) -> bool {
    PasswordHash::new(encoded_hash)
        .ok()
        .and_then(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .ok()
        })
        .is_some()
}

pub fn generate_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_secret(secret: &str) -> String {
    sha256_text(secret)
}

pub async fn administrator_exists(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE role = 'admin' AND status = 'active')",
    )
    .fetch_one(pool)
    .await
}

pub async fn authenticate_session(
    pool: &PgPool,
    raw_token: &str,
) -> Result<Option<AuthenticatedUser>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT
            u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
            u.created_at, u.last_login_at, u.is_primary_admin, u.preferences,
            (u.avatar_bytes IS NOT NULL) AS has_avatar, u.avatar_updated_at,
            s.id AS session_id, s.csrf_hash,
            (SELECT COUNT(*) FROM sessions active
             WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
             AS active_sessions
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
        "#,
    )
    .bind(hash_secret(raw_token))
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let status = parse_status(row.get::<String, _>("status").as_str());
    if status == ServerUserStatus::Disabled {
        return Ok(None);
    }

    Ok(Some(AuthenticatedUser {
        user: user_from_row(&row),
        session_id: row.get("session_id"),
        csrf_hash: row.get("csrf_hash"),
    }))
}

pub async fn authenticate_native_access_token(
    pool: &PgPool,
    raw_token: &str,
) -> Result<Option<AuthenticatedUser>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT
            u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
            u.created_at, u.last_login_at, u.is_primary_admin, u.preferences,
            (u.avatar_bytes IS NOT NULL) AS has_avatar, u.avatar_updated_at,
            s.id AS session_id, ''::text AS csrf_hash,
            ((SELECT COUNT(*) FROM sessions active
              WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
             + (SELECT COUNT(*) FROM native_sessions active
                WHERE active.user_id = u.id AND active.revoked_at IS NULL
                  AND active.refresh_expires_at > NOW())) AS active_sessions
        FROM native_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.access_token_hash = $1 AND s.revoked_at IS NULL
          AND s.access_expires_at > NOW() AND s.refresh_expires_at > NOW()
        "#,
    )
    .bind(hash_secret(raw_token))
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    if parse_status(row.get::<String, _>("status").as_str()) == ServerUserStatus::Disabled {
        return Ok(None);
    }
    Ok(Some(AuthenticatedUser {
        user: user_from_row(&row),
        session_id: row.get("session_id"),
        csrf_hash: String::new(),
    }))
}

pub fn user_from_row(row: &sqlx::postgres::PgRow) -> ServerUser {
    ServerUser {
        id: row.get::<Uuid, _>("id").to_string(),
        username: row.get("username"),
        display_name: row.get("display_name"),
        role: parse_role(row.get::<String, _>("role").as_str()),
        status: parse_status(row.get::<String, _>("status").as_str()),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        last_login_at: row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_login_at")
            .map(|value| value.to_rfc3339()),
        active_sessions: row.get("active_sessions"),
        is_primary_admin: row.get("is_primary_admin"),
        // Profile columns are only selected by handlers that need them; default
        // gracefully when a query omits them.
        preferences: row
            .try_get::<serde_json::Value, _>("preferences")
            .unwrap_or(serde_json::Value::Null),
        has_avatar: row.try_get::<bool, _>("has_avatar").unwrap_or(false),
        avatar_updated_at: row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("avatar_updated_at")
            .ok()
            .flatten()
            .map(|value| value.to_rfc3339()),
    }
}

fn parse_role(value: &str) -> ServerUserRole {
    if value == "admin" {
        ServerUserRole::Admin
    } else {
        ServerUserRole::Member
    }
}

fn parse_status(value: &str) -> ServerUserStatus {
    if value == "disabled" {
        ServerUserStatus::Disabled
    } else {
        ServerUserStatus::Active
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(
        "username must be 3-64 characters and contain only letters, numbers, '.', '-', or '_'"
    )]
    InvalidUsername,
    #[error("password must be between 12 and 1024 characters")]
    InvalidPassword,
    #[error("failed to hash password")]
    PasswordHash,
}

#[cfg(test)]
mod tests {
    use super::{generate_secret, hash_password, hash_secret, normalize_username, verify_password};

    #[test]
    fn usernames_are_normalized_and_validated() {
        assert_eq!(
            normalize_username("  Alice.Example ").unwrap(),
            "alice.example"
        );
        assert!(normalize_username("../bad").is_err());
        assert!(normalize_username("ab").is_err());
    }

    #[test]
    fn argon2_password_hashes_verify_without_storing_plaintext() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(!hash.contains("correct horse"));
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn verifies_existing_argon2id_phc_hashes() {
        // Independent libargon2 fixture with the parameters used by Argon2 0.5.
        let encoded = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$J86bD7nzhCDfFC4DP3Q5NzLGgPLgJJqEYKz51afxy1E";
        assert!(verify_password("old server password", encoded));
        assert!(!verify_password("wrong password", encoded));
        assert!(!verify_password("old server password", "invalid hash"));
    }

    #[test]
    fn generated_secrets_are_random_and_hash_deterministically() {
        let first = generate_secret();
        let second = generate_secret();
        assert_ne!(first, second);
        assert_eq!(hash_secret(&first), hash_secret(&first));
        assert_ne!(hash_secret(&first), first);
    }
}
