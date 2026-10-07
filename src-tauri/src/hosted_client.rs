use collab_protocol::{DataResponse, ErrorResponse, NativeSession};
use serde_json::Value;
use std::error::Error as _;
use std::sync::LazyLock;
use url::Url;

static SERVER_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .build()
        .map_err(|_| "Could not initialize the Collab server connection.".to_string())
});

static INSECURE_SERVER_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|_| "Could not initialize the Collab server connection.".to_string())
});

// Live-collaboration WebSocket clients are HTTP/1.1-only. `reqwest-websocket`
// only performs the RFC 6455 upgrade over HTTP/1.1 and errors on HTTP/2, but a
// normal reqwest client advertises `h2` via ALPN. Forcing `http1_only` makes the
// upgrade succeed against valid-cert HTTP/2 servers; REST keeps using the
// h2-capable clients above.
static WS_SERVER_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .http1_only()
        .build()
        .map_err(|_| "Could not initialize the Collab server connection.".to_string())
});

static WS_INSECURE_SERVER_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .http1_only()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|_| "Could not initialize the Collab server connection.".to_string())
});

pub fn validate_server_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Enter a valid server URL.".to_string())?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Server URLs cannot contain credentials, queries, or fragments.".into());
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Remote Collab servers must use HTTPS.".into());
    }
    url.set_path("");
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn server_client(allow_invalid_certificates: bool) -> Result<reqwest::Client, String> {
    let client = if allow_invalid_certificates {
        &*INSECURE_SERVER_CLIENT
    } else {
        &*SERVER_CLIENT
    };
    client.clone()
}

/// HTTP/1.1-only client for the live-collaboration WebSocket upgrade. Shares
/// the session's untrusted-certificate choice.
pub fn ws_server_client(allow_invalid_certificates: bool) -> Result<reqwest::Client, String> {
    let client = if allow_invalid_certificates {
        &*WS_INSECURE_SERVER_CLIENT
    } else {
        &*WS_SERVER_CLIENT
    };
    client.clone()
}

pub fn server_request_error(error: reqwest::Error) -> String {
    let mut details = error.to_string().to_ascii_lowercase();
    let mut source = error.source();
    while let Some(cause) = source {
        details.push(' ');
        details.push_str(&cause.to_string().to_ascii_lowercase());
        source = cause.source();
    }
    if details.contains("certificate")
        || details.contains("unknown issuer")
        || details.contains("tls")
    {
        return "The server TLS certificate could not be verified. Trust the server certificate on this device or explicitly allow untrusted certificates in Server Settings.".to_string();
    }
    "Could not reach the Collab server. Check the server URL, DNS, proxy, and network connection."
        .to_string()
}

pub async fn decode_session(response: reqwest::Response) -> Result<NativeSession, String> {
    if !response.status().is_success() {
        return Err("The server rejected the connection or credentials.".into());
    }
    response
        .json::<DataResponse<NativeSession>>()
        .await
        .map(|body| body.data)
        .map_err(|_| "The server returned an invalid authentication response.".into())
}

pub fn hosted_request_method(value: &str) -> Result<reqwest::Method, String> {
    match value.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        _ => Err("Unsupported hosted-vault request method.".into()),
    }
}

pub fn validate_hosted_vault_path(value: &str) -> Result<&str, String> {
    let request_path = value.split('?').next().unwrap_or(value);
    let lower_path = request_path.to_ascii_lowercase();
    if !(value == "/api/v1/vaults"
        || value.starts_with("/api/v1/vaults/")
        || value.starts_with("/api/v1/vaults?")
        || value == "/api/v1/presentations/active"
        || value.starts_with("/api/v1/presentations/active/"))
        || value.starts_with("//")
        || value.contains("://")
        || value.contains('#')
        || request_path.contains("..")
        || request_path.contains('\\')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || lower_path.contains("%5c")
    {
        return Err("Hosted-vault requests must target the connected server vault API.".into());
    }
    Ok(value)
}

pub fn validate_conversation_identity(
    user_id: &str,
    expected_user_id: &str,
    notice_key: Option<&str>,
) -> Result<(), String> {
    if user_id != expected_user_id {
        return Err("The connected conversation account changed. Reopen Chats.".into());
    }
    if notice_key.is_some_and(|key| {
        key != collab_core::sha256_text(&format!("collab-notification-account:{user_id}"))
    }) {
        return Err("This notification belongs to a different server account.".into());
    }
    Ok(())
}

/// Personal conversations cannot reach vault/admin/account routes.
pub fn validate_hosted_conversation_request(method: &str, value: &str) -> Result<(), String> {
    let path = value.split('?').next().unwrap_or(value);
    let Some(suffix) = path.strip_prefix("/api/v1/conversations") else {
        return Err("Unsupported conversation operation.".into());
    };
    if !suffix.is_empty() && !suffix.starts_with('/') {
        return Err("Unsupported conversation operation.".into());
    }
    let parts: Vec<_> = suffix
        .strip_prefix('/')
        .unwrap_or(suffix)
        .split('/')
        .collect();
    let valid = match parts.as_slice() {
        [""] => matches!(method, "GET" | "POST"),
        ["events"] => method == "GET",
        [id] if uuid::Uuid::parse_str(id).is_ok() => method == "PATCH",
        [id, "messages"] if uuid::Uuid::parse_str(id).is_ok() => matches!(method, "GET" | "POST"),
        [id, "read"] if uuid::Uuid::parse_str(id).is_ok() => method == "POST",
        [id, "members"] if uuid::Uuid::parse_str(id).is_ok() => matches!(method, "GET" | "POST"),
        [id, "members", user]
            if uuid::Uuid::parse_str(id).is_ok() && uuid::Uuid::parse_str(user).is_ok() =>
        {
            matches!(method, "PATCH" | "DELETE")
        }
        _ => false,
    };
    if !valid
        || value.contains('#')
        || value.contains("://")
        || (method != "GET" && value.contains('?'))
    {
        return Err("Unsupported conversation operation.".into());
    }
    Ok(())
}

/// Self-service mutations and authenticated user-avatar reads only.
pub fn validate_hosted_account_request(method: &str, path: &str) -> Result<(), String> {
    if method == "GET" && user_avatar_id(path).is_some() {
        return Ok(());
    }
    match (method, path) {
        ("GET" | "PATCH", "/api/v1/users/me")
        | ("POST", "/api/v1/users/me/password")
        | ("GET" | "PUT" | "DELETE", "/api/v1/users/me/avatar") => Ok(()),
        _ => Err("Account requests must target a supported self-service operation.".into()),
    }
}

pub fn user_avatar_id(path: &str) -> Option<uuid::Uuid> {
    let id = path
        .strip_prefix("/api/v1/users/")?
        .strip_suffix("/avatar")?;
    uuid::Uuid::parse_str(id).ok()
}

pub fn validate_hosted_calendar_path(value: &str) -> Result<&str, String> {
    let request_path = value.split('?').next().unwrap_or(value);
    let lower_path = request_path.to_ascii_lowercase();
    if !(value == "/api/v1/calendars"
        || value.starts_with("/api/v1/calendars/")
        || value.starts_with("/api/v1/calendars?"))
        || value.starts_with("//")
        || value.contains("://")
        || value.contains('#')
        || request_path.contains("..")
        || request_path.contains('\\')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || lower_path.contains("%5c")
    {
        return Err(
            "Hosted-calendar requests must target the connected server calendar API.".into(),
        );
    }
    Ok(value)
}

pub fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Hosted-vault identifiers are invalid.".into());
    }
    Ok(())
}

pub async fn decode_hosted_json_response(response: reqwest::Response) -> Result<Value, String> {
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(decode_hosted_error(response).await);
    }
    response
        .json::<DataResponse<Value>>()
        .await
        .map(|body| body.data)
        .map_err(|_| "The server returned an invalid hosted-vault response.".into())
}

pub async fn decode_hosted_error(response: reqwest::Response) -> String {
    response
        .json::<ErrorResponse>()
        .await
        .map(|body| body.error.message)
        .unwrap_or_else(|_| "The hosted-vault request failed.".into())
}

#[cfg(test)]
mod tests {
    use super::{
        hosted_request_method, server_request_error, validate_hosted_account_request,
        validate_hosted_calendar_path, validate_hosted_vault_path, validate_identifier,
        validate_server_url,
    };

    #[test]
    fn personal_notification_identity_is_bound_to_the_current_account() {
        use super::validate_conversation_identity as validate;
        let key = collab_core::sha256_text("collab-notification-account:account-a");
        assert!(validate("account-a", "account-a", Some(&key)).is_ok());
        assert!(validate("account-b", "account-b", Some(&key)).is_err());
        assert!(validate("account-b", "account-a", None).is_err());
        assert!(validate("account-a", "account-a", None).is_ok());
    }

    #[test]
    fn personal_gateway_cannot_escape_its_resource_or_method() {
        use super::validate_hosted_conversation_request as validate;
        let id = "10000000-0000-4000-8000-000000000001";
        assert!(validate("GET", "/api/v1/conversations/events?after=9007199254740993").is_ok());
        assert!(validate("POST", &format!("/api/v1/conversations/{id}/messages")).is_ok());
        for path in [
            "/api/v1/admin/users",
            "/api/v1/conversations-evil",
            "/api/v1/conversations/../admin",
            "/api/v1/conversations/%2e%2e/messages",
            "/api/v1/conversations/events#other",
        ] {
            assert!(validate("GET", path).is_err(), "{path}");
        }
        assert!(validate("DELETE", &format!("/api/v1/conversations/{id}/messages")).is_err());
        assert!(validate("POST", "/api/v1/conversations/events").is_err());
        assert!(validate("PATCH", &format!("/api/v1/conversations/{id}?ignored=1")).is_err());
    }

    #[test]
    fn account_avatar_read_is_strictly_get_and_uuid_scoped() {
        let path = "/api/v1/users/10000000-0000-4000-8000-000000000001/avatar";
        assert!(validate_hosted_account_request("GET", path).is_ok());
        assert!(validate_hosted_account_request("DELETE", path).is_err());
        assert!(validate_hosted_account_request("GET", "/api/v1/users/../avatar").is_err());
        assert!(validate_hosted_account_request("GET", &format!("{path}?other=1")).is_err());
    }

    #[test]
    fn validates_server_urls() {
        assert_eq!(
            validate_server_url("http://localhost:8788/").unwrap(),
            "http://localhost:8788"
        );
        assert!(validate_server_url("http://example.com").is_err());
        assert!(validate_server_url("https://user:pass@example.com").is_err());
        assert_eq!(
            validate_server_url("https://collab.example.com/admin").unwrap(),
            "https://collab.example.com"
        );
    }

    #[test]
    fn validates_hosted_vault_proxy_paths_and_identifiers() {
        assert!(validate_hosted_vault_path("/api/v1/vaults/vault-1/files?state=active").is_ok());
        assert!(validate_hosted_vault_path("/api/v1/admin/users").is_err());
        assert!(validate_hosted_vault_path("/api/v1/presentations/active").is_ok());
        assert!(validate_hosted_vault_path("/api/v1/presentations/active/show-1").is_ok());
        assert!(validate_hosted_vault_path("/api/v1/presentations/active-evil").is_err());
        assert!(validate_hosted_vault_path("/api/v1/vaults-evil").is_err());
        assert!(validate_hosted_vault_path("//example.com/api/v1/vaults").is_err());
        assert!(validate_hosted_vault_path("/api/v1/vaults/../admin").is_err());
        assert!(validate_hosted_vault_path("/api/v1/vaults/%2e%2e/admin").is_err());
        assert!(
            validate_hosted_vault_path("/api/v1/vaults/vault-1/search?q=hello%20world").is_ok()
        );
        assert!(hosted_request_method("GET").is_ok());
        assert!(hosted_request_method("PUT").is_ok());
        assert!(hosted_request_method("TRACE").is_err());
        assert!(validate_identifier("019eb16e-2a85-7070-bbe7-8cf09911c2c1").is_ok());
        assert!(validate_identifier("../vault").is_err());
    }

    #[test]
    fn validates_hosted_calendar_proxy_paths() {
        assert!(validate_hosted_calendar_path("/api/v1/calendars").is_ok());
        assert!(
            validate_hosted_calendar_path("/api/v1/calendars/changes?cursor=42&limit=100").is_ok()
        );
        assert!(validate_hosted_calendar_path("/api/v1/calendars/query?from=x&to=y").is_ok());
        assert!(validate_hosted_calendar_path("/api/v1/users/me").is_err());
        assert!(validate_hosted_calendar_path("/api/v1/calendars-evil").is_err());
        assert!(validate_hosted_calendar_path("/api/v1/calendars/../admin").is_err());
        assert!(validate_hosted_calendar_path("/api/v1/calendars/%2e%2e/admin").is_err());
    }

    #[test]
    fn request_error_classification_mentions_connectivity() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime should build");
        let error = runtime
            .block_on(reqwest::Client::new().get("http://127.0.0.1:9").send())
            .err()
            .unwrap();
        assert!(server_request_error(error).contains("DNS, proxy, and network"));
    }
}

#[cfg(test)]
mod account_tests {
    #[test]
    fn account_bridge_is_scoped_to_supported_self_service_routes() {
        use super::validate_hosted_account_request as validate;
        assert!(validate("GET", "/api/v1/users/me").is_ok());
        assert!(validate("PATCH", "/api/v1/users/me").is_ok());
        assert!(validate("POST", "/api/v1/users/me/password").is_ok());
        for path in [
            "/api/v1/admin/users",
            "/api/v1/users/other",
            "/api/v1/users/me/../admin",
            "/api/v1/users/me?role=admin",
            "https://other/users/me",
        ] {
            assert!(validate("GET", path).is_err());
        }
        assert!(validate("DELETE", "/api/v1/users/me").is_err());
    }
}
