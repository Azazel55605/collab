//! Desktop native authority. No automatic connection or keystore access at startup.
mod credentials;
pub(crate) mod driver;
pub(crate) mod query;
use collab_database::{ContractError as E, SessionBinding};
use driver::Live;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub label: String,
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub certificate_hostname: Option<String>,
    pub remember_password: bool,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub retired_credentials: Vec<String>,
}
impl SavedConnection {
    fn validate(&self) -> Result<(), E> {
        if self.retired_credentials.len() > 32
            || self
                .retired_credentials
                .iter()
                .any(|id| Uuid::parse_str(id).is_err())
        {
            return Err(E::LimitReached);
        }
        if self
            .credential_id
            .as_ref()
            .is_some_and(|id| Uuid::parse_str(id).is_err())
        {
            return Err(E::InvalidParameter);
        }
        if Uuid::parse_str(&self.id).is_err()
            || self.port == 0
            || self.label.is_empty()
            || self.host.is_empty()
            || self.username.is_empty()
            || self.database.is_empty()
        {
            return Err(E::InvalidParameter);
        }
        for value in [
            &self.label,
            &self.environment,
            &self.host,
            &self.database,
            &self.username,
        ] {
            if value.len() > 512 || value.chars().any(char::is_control) {
                return Err(E::InvalidParameter);
            }
        }
        if self.host.contains([',', ';', '\\', '/', ' ']) || self.host.contains('=') {
            return Err(E::InvalidParameter);
        }
        if let Some(host) = &self.certificate_hostname {
            if host.is_empty() || host.len() > 253 || host.chars().any(char::is_control) {
                return Err(E::InvalidParameter);
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
pub struct Connected {
    pub id: String,
    pub saved_id: String,
    pub label: String,
    pub environment: String,
    pub database: String,
}
#[derive(Serialize)]
pub struct Workspace {
    pub token: String,
    pub profiles: Vec<SavedConnection>,
    pub connections: Vec<Connected>,
    pub tabs: Vec<SessionBinding>,
    pub durable_credentials: bool,
}
struct Connection {
    view: Connected,
    config: SavedConnection,
    secret: Arc<Zeroizing<String>>,
    live: Arc<Live>,
}
struct Tab {
    binding: SessionBinding,
    live: Arc<Live>,
}
#[derive(Default)]
struct Registry {
    revision: u64,
    owner: String,
    token: String,
    cancel: CancellationToken,
    profiles: Vec<SavedConnection>,
    connections: HashMap<String, Connection>,
    tabs: HashMap<String, Tab>,
}
static CURRENT_PROFILE: OnceLock<parking_lot::Mutex<Option<String>>> = OnceLock::new();
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}
pub async fn profile_changed(previous_owner: &str, next_owner: &str) -> Result<(), E> {
    let mut r = registry().lock().await;
    if r.owner == previous_owner && r.tabs.values().any(|t| !t.live.query.clean()) {
        return Err(E::UnresolvedSession);
    }
    {
        let mut current = CURRENT_PROFILE
            .get_or_init(|| parking_lot::Mutex::new(None))
            .lock();
        if current
            .as_deref()
            .is_none_or(|owner| owner == previous_owner)
        {
            *current = Some(next_owner.into());
        }
    }
    if r.owner == previous_owner {
        r.cancel.cancel();
        *r = Registry::default();
    }
    Ok(())
}

fn slots() -> Arc<Semaphore> {
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(8))).clone()
}
fn check(registry: &Registry, token: &str) -> Result<(), E> {
    let current = CURRENT_PROFILE
        .get_or_init(|| parking_lot::Mutex::new(None))
        .lock();
    if current.as_deref() != Some(registry.owner.as_str())
        || registry.token.is_empty()
        || registry.token != token
    {
        Err(E::WrongBinding)
    } else {
        Ok(())
    }
}
fn path(root: &Path, owner: &str) -> PathBuf {
    root.join(format!(
        "database-{}.json",
        hex::encode(Sha256::digest(owner.as_bytes()))
    ))
}
fn load(root: &Path, owner: &str) -> Result<Vec<SavedConnection>, E> {
    let path = path(root, owner);
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(E::ConnectionFailed),
    };
    if file.metadata().map_err(|_| E::ConnectionFailed)?.len() > 256 << 10 {
        return Err(E::LimitReached);
    }
    let profiles: Vec<SavedConnection> =
        serde_json::from_reader(file).map_err(|_| E::InvalidParameter)?;
    if profiles.len() > 32 {
        return Err(E::LimitReached);
    }
    for profile in &profiles {
        profile.validate()?;
    }
    Ok(profiles)
}
fn persist(root: &Path, owner: &str, profiles: &[SavedConnection]) -> Result<(), E> {
    let file = tempfile::NamedTempFile::new_in(root).map_err(|_| E::ConnectionFailed)?;
    serde_json::to_writer(&file, profiles).map_err(|_| E::ConnectionFailed)?;
    file.as_file().sync_all().map_err(|_| E::ConnectionFailed)?;
    file.persist(path(root, owner))
        .map_err(|_| E::ConnectionFailed)?;
    Ok(())
}
pub async fn activate(root: &Path, owner: String) -> Result<Workspace, E> {
    if owner.is_empty() || owner.len() > 128 || owner.chars().any(char::is_control) {
        return Err(E::InvalidParameter);
    }
    let mut r = registry().lock().await;
    {
        let mut current = CURRENT_PROFILE
            .get_or_init(|| parking_lot::Mutex::new(None))
            .lock();
        if current.as_deref().is_some_and(|value| value != owner) {
            return Err(E::WrongBinding);
        }
        *current = Some(owner.clone());
    }
    if r.owner != owner || r.token.is_empty() {
        // Invalidate first; even a profile-file error must not leave old sockets usable.
        r.cancel.cancel();
        *r = Registry::default();
        let profiles = load(root, &owner)?;
        r.owner = owner;
        r.profiles = profiles;
        r.token = Uuid::new_v4().to_string();
    }
    Ok(Workspace {
        token: r.token.clone(),
        profiles: r.profiles.clone(),
        connections: r.connections.values().map(|c| c.view.clone()).collect(),
        tabs: r.tabs.values().map(|t| t.binding.clone()).collect(),
        durable_credentials: std::env::var_os("FLATPAK_ID").is_none(),
    })
}
pub async fn deactivate(token: &str) -> Result<(), E> {
    let mut r = registry().lock().await;
    check(&r, token)?;
    if r.tabs.values().any(|t| !t.live.query.clean()) {
        return Err(E::UnresolvedSession);
    }
    r.cancel.cancel();
    *r = Registry::default();
    Ok(())
}
pub async fn save(
    root: &Path,
    token: &str,
    mut config: SavedConnection,
    password: Option<String>,
) -> Result<SavedConnection, E> {
    let (owner, revision, old) = {
        let r = registry().lock().await;
        check(&r, token)?;
        if config.id.is_empty() {
            config.id = Uuid::new_v4().to_string();
        } else if !r.profiles.iter().any(|p| p.id == config.id) {
            return Err(E::WrongBinding);
        }
        config.validate()?;
        if r.connections.values().any(|c| {
            c.config.id == config.id
                && r.tabs
                    .values()
                    .any(|t| t.binding.connection_id == c.view.id && !t.live.query.clean())
        }) {
            return Err(E::UnresolvedSession);
        }
        if !r.profiles.iter().any(|p| p.id == config.id) && r.profiles.len() >= 32 {
            return Err(E::LimitReached);
        }
        (
            r.owner.clone(),
            r.revision,
            r.profiles.iter().find(|p| p.id == config.id).cloned(),
        )
    };
    let secret = password.map(Zeroizing::new);
    if secret.as_ref().is_some_and(|p| p.len() > 4096) {
        return Err(E::LimitReached);
    }
    let previous = old.as_ref().is_some_and(|p| p.remember_password);
    if config.remember_password
        && secret.is_none()
        && old.as_ref().is_some_and(|p| {
            p.host != config.host
                || p.port != config.port
                || p.username != config.username
                || p.database != config.database
                || p.certificate_hostname != config.certificate_hostname
        })
    {
        return Err(E::AuthenticationFailed);
    }
    let old_credential = old.as_ref().and_then(|p| p.credential_id.clone());
    config.credential_id = if config.remember_password {
        if secret.is_some() {
            Some(Uuid::new_v4().to_string())
        } else {
            old_credential.clone()
        }
    } else {
        None
    };
    if config.remember_password && config.credential_id.is_none() {
        return Err(E::AuthenticationFailed);
    }
    config.retired_credentials = old
        .as_ref()
        .map(|p| p.retired_credentials.clone())
        .unwrap_or_default();
    if let Some(id) = &old_credential {
        if Some(id) != config.credential_id.as_ref() {
            config.retired_credentials.push(id.clone());
        }
    }
    if config.retired_credentials.len() > 32 {
        return Err(E::LimitReached);
    }
    let retired = config.retired_credentials.clone();
    let new_credential = config.credential_id.clone();
    let id = config.credential_id.clone().unwrap_or_default();
    let remember = config.remember_password;
    // Keystore prompts must not hold the registry lock or delay profile teardown.
    if remember {
        let credential_owner = owner.clone();
        tokio::task::spawn_blocking(move || {
            if remember {
                if let Some(secret) = secret {
                    credentials::save(&credential_owner, &id, &secret)
                } else if previous {
                    credentials::read(&credential_owner, &id)
                        .map(Zeroizing::new)
                        .map(|_| ())
                } else {
                    Err(E::AuthenticationFailed)
                }
            } else {
                Ok(())
            }
        })
        .await
        .map_err(|_| E::AuthenticationFailed)??;
    }
    let result = {
        let mut r = registry().lock().await;
        if check(&r, token).is_err() {
            Err(E::WrongBinding)
        } else if r.revision != revision {
            Err(E::SchemaConflict)
        } else if r.connections.values().any(|c| {
            c.config.id == config.id
                && r.tabs
                    .values()
                    .any(|t| t.binding.connection_id == c.view.id && !t.live.query.clean())
        }) {
            Err(E::UnresolvedSession)
        } else {
            let mut profiles = r.profiles.clone();
            profiles.retain(|p| p.id != config.id);
            profiles.push(config.clone());
            match persist(root, &r.owner, &profiles) {
                Err(error) => Err(error),
                Ok(()) => {
                    r.profiles = profiles;
                    r.revision += 1;
                    let ids: Vec<_> = r
                        .connections
                        .values()
                        .filter(|c| c.config.id == config.id)
                        .map(|c| c.view.id.clone())
                        .collect();
                    for id in ids {
                        disconnect_inner(&mut r, &id);
                    }
                    Ok(config)
                }
            }
        }
    };
    // Password revisions have independent UUIDs. Keep retired entry references in
    // metadata until deletion succeeds, so a locked keystore can be retried.
    let cleanup = if result.is_ok() {
        retired
    } else {
        new_credential
            .filter(|id| Some(id) != old_credential.as_ref())
            .into_iter()
            .collect()
    };
    if !cleanup.is_empty() {
        let credential_owner = owner.clone();
        let attempted = cleanup.clone();
        let failed = tokio::task::spawn_blocking(move || {
            attempted
                .into_iter()
                .filter(|id| credentials::delete(&credential_owner, id).is_err())
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|_| E::CredentialCleanupFailed)?;
        let mut r = registry().lock().await;
        if check(&r, token).is_ok() {
            let mut profiles = r.profiles.clone();
            if let Some(profile) = profiles
                .iter_mut()
                .find(|p| p.id == result.as_ref().map(|p| p.id.as_str()).unwrap_or(""))
            {
                profile
                    .retired_credentials
                    .retain(|id| !cleanup.contains(id) || failed.contains(id));
                persist(root, &r.owner, &profiles)?;
                r.profiles = profiles;
                r.revision += 1;
            }
        }
        if !failed.is_empty() {
            return Err(E::CredentialCleanupFailed);
        }
    }
    result
}

pub async fn remove(root: &Path, token: &str, id: &str) -> Result<(), E> {
    let (owner, revision, remember) = {
        let r = registry().lock().await;
        check(&r, token)?;
        let config = r
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or(E::WrongBinding)?;
        if r.connections.values().any(|c| {
            c.config.id == id
                && r.tabs
                    .values()
                    .any(|t| t.binding.connection_id == c.view.id && !t.live.query.clean())
        }) {
            return Err(E::UnresolvedSession);
        }
        (
            r.owner.clone(),
            r.revision,
            config
                .credential_id
                .iter()
                .chain(config.retired_credentials.iter())
                .cloned()
                .collect::<Vec<_>>(),
        )
    };
    if !remember.is_empty() {
        tokio::task::spawn_blocking(move || {
            for id in remember {
                credentials::delete(&owner, &id)?;
            }
            Ok::<_, E>(())
        })
        .await
        .map_err(|_| E::AuthenticationFailed)??;
    }
    let mut r = registry().lock().await;
    check(&r, token)?;
    if r.revision != revision {
        return Err(E::SchemaConflict);
    }
    if r.connections.values().any(|c| {
        c.config.id == id
            && r.tabs
                .values()
                .any(|t| t.binding.connection_id == c.view.id && !t.live.query.clean())
    }) {
        return Err(E::UnresolvedSession);
    }
    let profiles: Vec<_> = r.profiles.iter().filter(|p| p.id != id).cloned().collect();
    persist(root, &r.owner, &profiles)?;
    let ids: Vec<_> = r
        .connections
        .values()
        .filter(|c| c.config.id == id)
        .map(|c| c.view.id.clone())
        .collect();
    for id in ids {
        disconnect_inner(&mut r, &id);
    }
    r.profiles = profiles;
    r.revision += 1;
    Ok(())
}
pub async fn connect(
    token: &str,
    id: &str,
    password: Option<String>,
    test_only: bool,
) -> Result<Connected, E> {
    let (config, owner, cancel, revision) = {
        let r = registry().lock().await;
        check(&r, token)?;
        (
            r.profiles
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or(E::WrongBinding)?,
            r.owner.clone(),
            r.cancel.child_token(),
            r.revision,
        )
    };
    let secret = match password {
        Some(password) if password.len() <= 4096 => Zeroizing::new(password),
        Some(_) => return Err(E::LimitReached),
        None if config.remember_password => {
            let id = config
                .credential_id
                .clone()
                .ok_or(E::AuthenticationFailed)?;
            tokio::task::spawn_blocking(move || credentials::read(&owner, &id).map(Zeroizing::new))
                .await
                .map_err(|_| E::AuthenticationFailed)??
        }
        None => return Err(E::AuthenticationFailed),
    };
    let permit = slots().try_acquire_owned().map_err(|_| E::LimitReached)?;
    let live = Live::connect(&config, &config.database, &secret, cancel, permit).await?;
    let mut r = registry().lock().await;
    check(&r, token)?;
    // An edited/deleted profile must invalidate an in-flight connection attempt.
    if r.revision != revision || !r.profiles.iter().any(|p| p.id == config.id && p == &config) {
        return Err(E::WrongBinding);
    }
    let view = Connected {
        id: Uuid::new_v4().to_string(),
        saved_id: config.id.clone(),
        label: config.label.clone(),
        environment: config.environment.clone(),
        database: config.database.clone(),
    };
    if !test_only {
        r.connections.insert(
            view.id.clone(),
            Connection {
                view: view.clone(),
                config,
                secret: Arc::new(secret),
                live,
            },
        );
    }
    Ok(view)
}
fn disconnect_inner(r: &mut Registry, id: &str) {
    if let Some(connection) = r.connections.remove(id) {
        connection.live.cancel.cancel();
    }
    r.tabs.retain(|_, tab| {
        if tab.binding.connection_id == id {
            tab.live.cancel.cancel();
            false
        } else {
            true
        }
    });
}
pub async fn disconnect(token: &str, id: &str) -> Result<(), E> {
    let mut r = registry().lock().await;
    check(&r, token)?;
    if !r.connections.contains_key(id) {
        return Err(E::WrongBinding);
    }
    if r.tabs
        .values()
        .any(|t| t.binding.connection_id == id && !t.live.query.clean())
    {
        return Err(E::UnresolvedSession);
    }
    disconnect_inner(&mut r, id);
    Ok(())
}
pub async fn open_tab(token: &str, id: &str, database: String) -> Result<SessionBinding, E> {
    if database.is_empty() || database.len() > 512 || database.chars().any(char::is_control) {
        return Err(E::InvalidParameter);
    }
    let (config, secret, cancel, owner) = {
        let r = registry().lock().await;
        check(&r, token)?;
        let c = r.connections.get(id).ok_or(E::WrongBinding)?;
        (
            c.config.clone(),
            c.secret.clone(),
            c.live.cancel.child_token(),
            r.owner.clone(),
        )
    };
    let permit = slots().try_acquire_owned().map_err(|_| E::LimitReached)?;
    let live = Live::connect(&config, &database, &secret, cancel, permit).await?;
    let mut r = registry().lock().await;
    check(&r, token)?;
    if !r.connections.contains_key(id) {
        return Err(E::WrongBinding);
    }
    let binding = SessionBinding {
        profile_id: owner,
        connection_id: id.into(),
        session_id: Uuid::new_v4().to_string(),
        tab_id: Uuid::new_v4().to_string(),
        database,
        generation: 1,
    };
    r.tabs.insert(
        binding.tab_id.clone(),
        Tab {
            binding: binding.clone(),
            live,
        },
    );
    Ok(binding)
}
pub async fn close_tab(token: &str, binding: &SessionBinding, discard: bool) -> Result<(), E> {
    let mut r = registry().lock().await;
    check(&r, token)?;
    let tab = r.tabs.get(&binding.tab_id).ok_or(E::WrongBinding)?;
    if tab.binding != *binding {
        return Err(E::WrongBinding);
    }
    if !discard && !tab.live.query.clean() {
        return Err(E::UnresolvedSession);
    }
    if let Some(tab) = r.tabs.remove(&binding.tab_id) {
        tab.live.cancel.cancel();
    }
    Ok(())
}
pub async fn metadata(
    token: &str,
    connection_id: &str,
    binding: Option<SessionBinding>,
    request: driver::MetadataRequest,
) -> Result<driver::MetadataPage, E> {
    let (live, tab_context) = {
        let r = registry().lock().await;
        check(&r, token)?;
        let connection = r.connections.get(connection_id).ok_or(E::WrongBinding)?;
        if let Some(binding) = binding {
            let tab = r.tabs.get(&binding.tab_id).ok_or(E::WrongBinding)?;
            if tab.binding != binding || binding.connection_id != connection_id {
                return Err(E::WrongBinding);
            }
            (
                connection.live.clone(),
                Some((
                    connection.config.clone(),
                    connection.secret.clone(),
                    binding.database,
                    tab.live.cancel.child_token(),
                )),
            )
        } else {
            (connection.live.clone(), None)
        }
    };
    // Metadata never runs on a query tab's physical session. A bounded short-lived
    // session uses the same login and pinned database, and is dropped afterwards.
    let live = if let Some((config, secret, database, cancel)) = tab_context {
        let permit = slots().try_acquire_owned().map_err(|_| E::LimitReached)?;
        Live::connect(&config, &database, &secret, cancel, permit).await?
    } else {
        live
    };
    let page = live.metadata(&request).await?;
    let r = registry().lock().await;
    check(&r, token)?;
    if live.cancel.is_cancelled() {
        return Err(E::WrongBinding);
    }
    Ok(page)
}

#[cfg(test)]
mod tests;

pub async fn query_live(token: &str, binding: &SessionBinding) -> Result<Arc<Live>, E> {
    let r = registry().lock().await;
    check(&r, token)?;
    let tab = r.tabs.get(&binding.tab_id).ok_or(E::WrongBinding)?;
    if tab.binding != *binding {
        return Err(E::WrongBinding);
    }
    Ok(tab.live.clone())
}
pub async fn can_quit() -> bool {
    let Some(registry) = REGISTRY.get() else {
        return true;
    };
    registry
        .lock()
        .await
        .tabs
        .values()
        .all(|tab| tab.live.query.clean())
}

pub async fn start_query(
    token: &str,
    binding: SessionBinding,
    sql: String,
    selection: Option<collab_database::SourceRange>,
    recovery: bool,
) -> Result<String, E> {
    let r = registry().lock().await;
    check(&r, token)?;
    let tab = r.tabs.get(&binding.tab_id).ok_or(E::WrongBinding)?;
    if tab.binding != binding {
        return Err(E::WrongBinding);
    }
    query::start(tab.live.clone(), binding, sql, selection, recovery)
}

pub async fn browse_query(
    token: &str,
    binding: SessionBinding,
    request: query::BrowseRequest,
) -> Result<String, E> {
    let r = registry().lock().await;
    check(&r, token)?;
    let tab = r.tabs.get(&binding.tab_id).ok_or(E::WrongBinding)?;
    if tab.binding != binding {
        return Err(E::WrongBinding);
    }
    query::browse(tab.live.clone(), binding, request)
}
