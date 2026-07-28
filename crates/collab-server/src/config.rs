use serde::Deserialize;
use std::{
    env, fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ServerConfig {
    pub host: IpAddr,
    pub port: u16,
    pub database_url: String,
    pub blob_dir: PathBuf,
    pub admin_web_dir: PathBuf,
    pub browser_secure_cookies: bool,
    pub session_ttl_hours: i64,
    pub native_access_ttl_minutes: i64,
    pub native_refresh_ttl_days: i64,
    pub ws_ticket_ttl_seconds: i64,
    pub max_file_bytes: usize,
    pub max_import_bytes: usize,
    pub max_import_expanded_bytes: usize,
    pub storage_warning_bytes: u64,
    pub storage_quota_bytes: u64,
    pub calendar_quota_bytes: u64,
    pub calendar_rate_limit_per_minute: u32,
    pub rest_rate_limit_per_minute: u32,
    pub ws_rate_limit_per_minute: u32,
    pub push_gateway_url: Option<String>,
    pub push_gateway_token: Option<String>,
    pub push_dispatch_interval_seconds: u64,
    pub maintenance_interval_seconds: u64,
    pub audit_retention_days: u64,
    pub revision_history_limit: u32,
    pub revision_storage_target_bytes: u64,
    pub backup_dir: PathBuf,
    pub backup_command: Option<String>,
    pub restore_command: Option<String>,
    pub backup_schedule_enabled: bool,
    pub backup_interval_seconds: u64,
    pub backup_retention_days: u64,
    pub backup_export_dir: Option<PathBuf>,
    pub log_filter: String,
    pub log_format: LogFormat,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".parse().expect("default host is valid"),
            port: 8787,
            database_url: "postgres://collab:collab@127.0.0.1:5432/collab".into(),
            blob_dir: PathBuf::from("server-data/blobs"),
            admin_web_dir: PathBuf::from("apps/admin-web/dist"),
            browser_secure_cookies: false,
            session_ttl_hours: 12,
            native_access_ttl_minutes: 15,
            native_refresh_ttl_days: 30,
            ws_ticket_ttl_seconds: 30,
            max_file_bytes: 256 * 1024 * 1024,
            max_import_bytes: 512 * 1024 * 1024,
            max_import_expanded_bytes: 2 * 1024 * 1024 * 1024,
            storage_warning_bytes: 10 * 1024 * 1024 * 1024,
            storage_quota_bytes: 0,
            calendar_quota_bytes: 0,
            calendar_rate_limit_per_minute: 600,
            rest_rate_limit_per_minute: 1200,
            ws_rate_limit_per_minute: 120,
            push_gateway_url: None,
            push_gateway_token: None,
            push_dispatch_interval_seconds: 15,
            maintenance_interval_seconds: 3600,
            audit_retention_days: 0,
            revision_history_limit: 0,
            revision_storage_target_bytes: 0,
            backup_dir: PathBuf::from("server-data/backups"),
            backup_command: None,
            restore_command: None,
            backup_schedule_enabled: false,
            backup_interval_seconds: 24 * 60 * 60,
            backup_retention_days: 14,
            backup_export_dir: None,
            log_filter: "collab_server=info,tower_http=info".into(),
            log_format: LogFormat::Pretty,
        }
    }
}

/// Parses a byte-size value that may be a plain integer (`268435456`) or a
/// human-readable size with a binary unit suffix (`256 MiB`, `12GiB`, `1.5 GB`,
/// `512k`). Suffixes are binary (1024-based) and case-insensitive; both the IEC
/// spellings (`KiB`/`MiB`/`GiB`/`TiB`), the short SI spellings (`KB`/`MB`/`GB`/
/// `TB`), and bare unit letters (`K`/`M`/`G`/`T`) are accepted, matching the
/// 1024-based math the rest of the app uses. A bare number or a `B` suffix is
/// interpreted as bytes.
pub fn parse_byte_size(input: &str) -> Result<u64, ()> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    let split = trimmed.find(|c: char| c.is_ascii_alphabetic());
    let (number_part, unit_part) = match split {
        Some(index) => (trimmed[..index].trim(), trimmed[index..].trim()),
        None => (trimmed, ""),
    };
    let multiplier: u64 = match unit_part.to_ascii_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kb" | "kib" => 1024,
        "m" | "mb" | "mib" => 1024 * 1024,
        "g" | "gb" | "gib" => 1024 * 1024 * 1024,
        "t" | "tb" | "tib" => 1024_u64 * 1024 * 1024 * 1024,
        _ => return Err(()),
    };
    let value: f64 = number_part.parse().map_err(|_| ())?;
    if !value.is_finite() || value < 0.0 {
        return Err(());
    }
    let bytes = value * multiplier as f64;
    if bytes > u64::MAX as f64 {
        return Err(());
    }
    Ok(bytes.round() as u64)
}

impl ServerConfig {
    pub fn max_json_body_bytes(&self) -> usize {
        // Binary uploads and ZIP imports are currently base64-encoded in JSON.
        self.max_file_bytes
            .max(self.max_import_bytes)
            .saturating_mul(4)
            .div_ceil(3)
            .saturating_add(1024 * 1024)
    }

    pub fn load() -> Result<Self, ConfigError> {
        let mut config = if let Ok(path) = env::var("COLLAB_CONFIG_FILE") {
            let raw = fs::read_to_string(&path).map_err(|source| ConfigError::ReadFile {
                path: path.clone(),
                source,
            })?;
            serde_json::from_str(&raw).map_err(|source| ConfigError::ParseFile { path, source })?
        } else {
            Self::default()
        };

        config.apply_env()?;
        config.validate()?;
        Ok(config)
    }

    pub fn bind_address(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }

    fn apply_env(&mut self) -> Result<(), ConfigError> {
        if let Ok(value) = env::var("COLLAB_HOST") {
            self.host = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_HOST"))?;
        }
        if let Ok(value) = env::var("COLLAB_PORT") {
            self.port = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_PORT"))?;
        }
        if let Ok(value) = env::var("COLLAB_DATABASE_URL") {
            self.database_url = value;
        }
        if let Ok(value) = env::var("COLLAB_BLOB_DIR") {
            self.blob_dir = value.into();
        }
        if let Ok(value) = env::var("COLLAB_ADMIN_WEB_DIR") {
            self.admin_web_dir = value.into();
        }
        if let Ok(value) = env::var("COLLAB_BROWSER_SECURE_COOKIES") {
            self.browser_secure_cookies = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_BROWSER_SECURE_COOKIES"))?;
        }
        if let Ok(value) = env::var("COLLAB_SESSION_TTL_HOURS") {
            self.session_ttl_hours = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_SESSION_TTL_HOURS"))?;
        }
        if let Ok(value) = env::var("COLLAB_NATIVE_ACCESS_TTL_MINUTES") {
            self.native_access_ttl_minutes = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_NATIVE_ACCESS_TTL_MINUTES"))?;
        }
        if let Ok(value) = env::var("COLLAB_NATIVE_REFRESH_TTL_DAYS") {
            self.native_refresh_ttl_days = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_NATIVE_REFRESH_TTL_DAYS"))?;
        }
        if let Ok(value) = env::var("COLLAB_WS_TICKET_TTL_SECONDS") {
            self.ws_ticket_ttl_seconds = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_WS_TICKET_TTL_SECONDS"))?;
        }
        if let Ok(value) = env::var("COLLAB_MAX_FILE_BYTES") {
            self.max_file_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_MAX_FILE_BYTES"))?
                as usize;
        }
        if let Ok(value) = env::var("COLLAB_MAX_IMPORT_BYTES") {
            self.max_import_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_MAX_IMPORT_BYTES"))?
                as usize;
        }
        if let Ok(value) = env::var("COLLAB_MAX_IMPORT_EXPANDED_BYTES") {
            self.max_import_expanded_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_MAX_IMPORT_EXPANDED_BYTES"))?
                as usize;
        }
        if let Ok(value) = env::var("COLLAB_STORAGE_WARNING_BYTES") {
            self.storage_warning_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_STORAGE_WARNING_BYTES"))?;
        }
        if let Ok(value) = env::var("COLLAB_STORAGE_QUOTA_BYTES") {
            self.storage_quota_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_STORAGE_QUOTA_BYTES"))?;
        }
        if let Ok(value) = env::var("COLLAB_CALENDAR_QUOTA_BYTES") {
            self.calendar_quota_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_CALENDAR_QUOTA_BYTES"))?;
        }
        if let Ok(value) = env::var("COLLAB_CALENDAR_RATE_LIMIT_PER_MINUTE") {
            self.calendar_rate_limit_per_minute = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_CALENDAR_RATE_LIMIT_PER_MINUTE"))?;
        }
        if let Ok(value) = env::var("COLLAB_REST_RATE_LIMIT_PER_MINUTE") {
            self.rest_rate_limit_per_minute = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_REST_RATE_LIMIT_PER_MINUTE"))?;
        }
        if let Ok(value) = env::var("COLLAB_WS_RATE_LIMIT_PER_MINUTE") {
            self.ws_rate_limit_per_minute = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_WS_RATE_LIMIT_PER_MINUTE"))?;
        }
        if let Ok(value) = env::var("COLLAB_PUSH_GATEWAY_URL") {
            self.push_gateway_url = (!value.trim().is_empty()).then(|| value.trim().to_string());
        }
        if let Ok(value) = env::var("COLLAB_PUSH_GATEWAY_TOKEN") {
            self.push_gateway_token = (!value.trim().is_empty()).then(|| value.trim().to_string());
        }
        if let Ok(value) = env::var("COLLAB_PUSH_DISPATCH_INTERVAL_SECONDS") {
            self.push_dispatch_interval_seconds = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_PUSH_DISPATCH_INTERVAL_SECONDS"))?;
        }
        if let Ok(value) = env::var("COLLAB_MAINTENANCE_INTERVAL_SECONDS") {
            self.maintenance_interval_seconds = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_MAINTENANCE_INTERVAL_SECONDS"))?;
        }
        if let Ok(value) = env::var("COLLAB_AUDIT_RETENTION_DAYS") {
            self.audit_retention_days = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_AUDIT_RETENTION_DAYS"))?;
        }
        if let Ok(value) = env::var("COLLAB_REVISION_HISTORY_LIMIT") {
            self.revision_history_limit = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_REVISION_HISTORY_LIMIT"))?;
        }
        if let Ok(value) = env::var("COLLAB_REVISION_STORAGE_TARGET_BYTES") {
            self.revision_storage_target_bytes = parse_byte_size(&value)
                .map_err(|_| ConfigError::Invalid("COLLAB_REVISION_STORAGE_TARGET_BYTES"))?;
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_DIR") {
            self.backup_dir = value.into();
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_COMMAND") {
            let trimmed = value.trim();
            self.backup_command = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        }
        if let Ok(value) = env::var("COLLAB_RESTORE_COMMAND") {
            let trimmed = value.trim();
            self.restore_command = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_SCHEDULE_ENABLED") {
            self.backup_schedule_enabled = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_BACKUP_SCHEDULE_ENABLED"))?;
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_INTERVAL_SECONDS") {
            self.backup_interval_seconds = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_BACKUP_INTERVAL_SECONDS"))?;
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_RETENTION_DAYS") {
            self.backup_retention_days = value
                .parse()
                .map_err(|_| ConfigError::Invalid("COLLAB_BACKUP_RETENTION_DAYS"))?;
        }
        if let Ok(value) = env::var("COLLAB_BACKUP_EXPORT_DIR") {
            let trimmed = value.trim();
            self.backup_export_dir = (!trimmed.is_empty()).then(|| PathBuf::from(trimmed));
        }
        if let Ok(value) = env::var("COLLAB_LOG") {
            self.log_filter = value;
        }
        if let Ok(value) = env::var("COLLAB_LOG_FORMAT") {
            self.log_format = match value.as_str() {
                "pretty" => LogFormat::Pretty,
                "json" => LogFormat::Json,
                _ => return Err(ConfigError::Invalid("COLLAB_LOG_FORMAT")),
            };
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.port == 0 {
            return Err(ConfigError::Invalid("COLLAB_PORT"));
        }
        if !self.database_url.starts_with("postgres://")
            && !self.database_url.starts_with("postgresql://")
        {
            return Err(ConfigError::Invalid("COLLAB_DATABASE_URL"));
        }
        if self.blob_dir.as_os_str().is_empty() {
            return Err(ConfigError::Invalid("COLLAB_BLOB_DIR"));
        }
        if self.admin_web_dir.as_os_str().is_empty() {
            return Err(ConfigError::Invalid("COLLAB_ADMIN_WEB_DIR"));
        }
        if self.backup_dir.as_os_str().is_empty() {
            return Err(ConfigError::Invalid("COLLAB_BACKUP_DIR"));
        }
        if self.backup_schedule_enabled && self.backup_interval_seconds == 0 {
            return Err(ConfigError::Invalid("COLLAB_BACKUP_INTERVAL_SECONDS"));
        }
        if self.session_ttl_hours <= 0 || self.session_ttl_hours > 24 * 30 {
            return Err(ConfigError::Invalid("COLLAB_SESSION_TTL_HOURS"));
        }
        if self.native_access_ttl_minutes <= 0 || self.native_access_ttl_minutes > 24 * 60 {
            return Err(ConfigError::Invalid("COLLAB_NATIVE_ACCESS_TTL_MINUTES"));
        }
        if self.native_refresh_ttl_days <= 0 || self.native_refresh_ttl_days > 365 {
            return Err(ConfigError::Invalid("COLLAB_NATIVE_REFRESH_TTL_DAYS"));
        }
        if self.ws_ticket_ttl_seconds <= 0 || self.ws_ticket_ttl_seconds > 600 {
            return Err(ConfigError::Invalid("COLLAB_WS_TICKET_TTL_SECONDS"));
        }
        if self.max_file_bytes == 0 || self.max_file_bytes > 8 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_MAX_FILE_BYTES"));
        }
        if self.max_import_bytes == 0 || self.max_import_bytes > 8 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_MAX_IMPORT_BYTES"));
        }
        if self.max_import_expanded_bytes < self.max_import_bytes
            || self.max_import_expanded_bytes > 32 * 1024 * 1024 * 1024
        {
            return Err(ConfigError::Invalid("COLLAB_MAX_IMPORT_EXPANDED_BYTES"));
        }
        if self.storage_warning_bytes > 1024 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_STORAGE_WARNING_BYTES"));
        }
        // `0` means unlimited; otherwise cap at 64 TiB to catch obvious misconfiguration.
        if self.storage_quota_bytes > 64 * 1024 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_STORAGE_QUOTA_BYTES"));
        }
        if self.calendar_quota_bytes > 64 * 1024 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_CALENDAR_QUOTA_BYTES"));
        }
        if self.calendar_rate_limit_per_minute > 1_000_000 {
            return Err(ConfigError::Invalid(
                "COLLAB_CALENDAR_RATE_LIMIT_PER_MINUTE",
            ));
        }
        // `0` disables the limit; otherwise cap to catch obvious misconfiguration.
        if self.rest_rate_limit_per_minute > 1_000_000 {
            return Err(ConfigError::Invalid("COLLAB_REST_RATE_LIMIT_PER_MINUTE"));
        }
        if self.ws_rate_limit_per_minute > 1_000_000 {
            return Err(ConfigError::Invalid("COLLAB_WS_RATE_LIMIT_PER_MINUTE"));
        }
        if let Some(value) = self.push_gateway_url.as_deref() {
            let url = collab_net_policy::normalize_http_input(value, false)
                .map_err(|_| ConfigError::Invalid("COLLAB_PUSH_GATEWAY_URL"))?;
            collab_net_policy::validate_target(&url, collab_net_policy::PUSH_GATEWAY_POLICY)
                .map_err(|_| ConfigError::Invalid("COLLAB_PUSH_GATEWAY_URL"))?;
        }
        if self
            .push_gateway_token
            .as_ref()
            .is_some_and(|value| value.len() > 4_096)
        {
            return Err(ConfigError::Invalid("COLLAB_PUSH_GATEWAY_TOKEN"));
        }
        if !(5..=3_600).contains(&self.push_dispatch_interval_seconds) {
            return Err(ConfigError::Invalid(
                "COLLAB_PUSH_DISPATCH_INTERVAL_SECONDS",
            ));
        }
        if self.maintenance_interval_seconds == 0 {
            return Err(ConfigError::Invalid("COLLAB_MAINTENANCE_INTERVAL_SECONDS"));
        }
        // `0` disables the policy; otherwise bound to catch obvious misconfiguration.
        if self.audit_retention_days > 100_000 {
            return Err(ConfigError::Invalid("COLLAB_AUDIT_RETENTION_DAYS"));
        }
        if self.revision_history_limit > 1_000_000 {
            return Err(ConfigError::Invalid("COLLAB_REVISION_HISTORY_LIMIT"));
        }
        if self.revision_storage_target_bytes > 64 * 1024 * 1024 * 1024 * 1024 {
            return Err(ConfigError::Invalid("COLLAB_REVISION_STORAGE_TARGET_BYTES"));
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid configuration value for {0}")]
    Invalid(&'static str),
    #[error("failed to read configuration file {path}: {source}")]
    ReadFile {
        path: String,
        source: std::io::Error,
    },
    #[error("failed to parse configuration file {path}: {source}")]
    ParseFile {
        path: String,
        source: serde_json::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::{parse_byte_size, LogFormat, ServerConfig};
    use std::path::PathBuf;

    #[test]
    fn parse_byte_size_accepts_plain_integers_and_binary_suffixes() {
        assert_eq!(parse_byte_size("1024"), Ok(1024));
        assert_eq!(parse_byte_size("0"), Ok(0));
        assert_eq!(parse_byte_size("512 B"), Ok(512));
        assert_eq!(parse_byte_size("4 MiB"), Ok(4 * 1024 * 1024));
        assert_eq!(parse_byte_size("12GiB"), Ok(12 * 1024 * 1024 * 1024));
        // SI spellings and bare letters are accepted as binary aliases.
        assert_eq!(parse_byte_size("256mb"), Ok(256 * 1024 * 1024));
        assert_eq!(parse_byte_size("512k"), Ok(512 * 1024));
        assert_eq!(parse_byte_size("2 T"), Ok(2 * 1024_u64.pow(4)));
        // Decimal values round to whole bytes.
        assert_eq!(
            parse_byte_size("1.5 GiB"),
            Ok(1024 * 1024 * 1024 + 512 * 1024 * 1024)
        );
    }

    #[test]
    fn parse_byte_size_rejects_garbage_and_negatives() {
        assert!(parse_byte_size("").is_err());
        assert!(parse_byte_size("   ").is_err());
        assert!(parse_byte_size("abc").is_err());
        assert!(parse_byte_size("12 PB").is_err());
        assert!(parse_byte_size("-4 MiB").is_err());
        assert!(parse_byte_size("4 MiB extra").is_err());
    }

    #[test]
    fn default_configuration_is_safe_for_local_development() {
        let config = ServerConfig::default();
        assert_eq!(config.bind_address().to_string(), "127.0.0.1:8787");
        assert_eq!(config.blob_dir, PathBuf::from("server-data/blobs"));
        assert_eq!(config.max_file_bytes, 256 * 1024 * 1024);
        assert_eq!(config.max_import_bytes, 512 * 1024 * 1024);
        assert_eq!(config.max_import_expanded_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(config.storage_warning_bytes, 10 * 1024 * 1024 * 1024);
        assert_eq!(config.storage_quota_bytes, 0);
        assert_eq!(config.calendar_quota_bytes, 0);
        assert_eq!(config.calendar_rate_limit_per_minute, 600);
        assert_eq!(config.rest_rate_limit_per_minute, 1200);
        assert_eq!(config.ws_rate_limit_per_minute, 120);
        assert_eq!(config.maintenance_interval_seconds, 3600);
        assert_eq!(config.audit_retention_days, 0);
        assert_eq!(config.revision_history_limit, 0);
        assert_eq!(config.push_gateway_url, None);
        assert_eq!(config.push_gateway_token, None);
        assert_eq!(config.push_dispatch_interval_seconds, 15);
        assert_eq!(config.backup_dir, PathBuf::from("server-data/backups"));
        assert_eq!(config.backup_command, None);
        assert_eq!(config.restore_command, None);
        assert_eq!(config.backup_schedule_enabled, false);
        assert_eq!(config.backup_interval_seconds, 24 * 60 * 60);
        assert_eq!(config.backup_retention_days, 14);
        assert_eq!(config.backup_export_dir, None);
        assert_eq!(config.log_format, LogFormat::Pretty);
        config.validate().unwrap();
    }

    #[test]
    fn validation_rejects_non_postgres_database_urls() {
        let config = ServerConfig {
            database_url: "sqlite://collab.db".into(),
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn bind_address_supports_ipv6_hosts() {
        let config = ServerConfig {
            host: "::1".parse().unwrap(),
            ..ServerConfig::default()
        };
        assert_eq!(config.bind_address().to_string(), "[::1]:8787");
    }

    #[test]
    fn validation_rejects_invalid_file_size_limits() {
        let config = ServerConfig {
            max_file_bytes: 0,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            calendar_quota_bytes: 64 * 1024 * 1024 * 1024 * 1024 + 1,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            calendar_rate_limit_per_minute: 1_000_001,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            max_file_bytes: 8 * 1024 * 1024 * 1024 + 1,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            max_import_expanded_bytes: 128 * 1024 * 1024,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validation_rejects_unsafe_push_gateway_configuration() {
        let config = ServerConfig {
            push_gateway_url: Some("file:///tmp/push".to_string()),
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            push_gateway_url: Some("https://user@example.com/push".to_string()),
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());

        let config = ServerConfig {
            push_dispatch_interval_seconds: 4,
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validation_accepts_unlimited_quota_and_rejects_oversized_quota() {
        let unlimited = ServerConfig {
            storage_quota_bytes: 0,
            ..ServerConfig::default()
        };
        unlimited.validate().unwrap();

        let oversized = ServerConfig {
            storage_quota_bytes: 64 * 1024 * 1024 * 1024 * 1024 + 1,
            ..ServerConfig::default()
        };
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn json_body_limit_includes_base64_and_envelope_overhead() {
        let config = ServerConfig {
            max_file_bytes: 256 * 1024 * 1024,
            max_import_bytes: 512 * 1024 * 1024,
            ..ServerConfig::default()
        };

        assert!(config.max_json_body_bytes() > 683 * 1024 * 1024);
    }
}
