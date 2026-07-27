use crate::models::vault::{KnownUser, VaultConfig, VaultMeta};
use crate::state::AppState;
use std::io::Write as IoWrite;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn recents_path() -> Result<std::path::PathBuf, String> {
    // Use platform-appropriate config directory:
    //   Linux/macOS: $HOME/.config/collab
    //   Windows:     %APPDATA%\collab  (falls back to %USERPROFILE%\.config\collab)
    let dir = if let Ok(appdata) = std::env::var("APPDATA") {
        std::path::PathBuf::from(appdata).join("collab")
    } else {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "Cannot determine home directory".to_string())?;
        std::path::Path::new(&home).join(".config").join("collab")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recents.json"))
}

fn read_recents_from_path(path: &std::path::Path) -> Result<Vec<VaultMeta>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_recents_to_path(path: &std::path::Path, recents: &[VaultMeta]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(recents).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn upsert_recent_in_list(recents: &mut Vec<VaultMeta>, meta: &VaultMeta) {
    recents.retain(|r| r.path != meta.path);
    recents.insert(0, meta.clone());
    recents.truncate(20);
}

fn is_flatpak_runtime() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("FLATPAK_ID").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn filter_existing_recents_with_options(
    recents: Vec<VaultMeta>,
    keep_unverified_paths: bool,
) -> Vec<VaultMeta> {
    recents
        .into_iter()
        .filter(|meta| {
            let path = std::path::Path::new(&meta.path);
            match std::fs::metadata(path) {
                Ok(metadata) => metadata.is_dir(),
                Err(_) => keep_unverified_paths,
            }
        })
        .collect()
}

fn filter_existing_recents(recents: Vec<VaultMeta>) -> Vec<VaultMeta> {
    filter_existing_recents_with_options(recents, is_flatpak_runtime())
}

fn read_recents() -> Result<Vec<VaultMeta>, String> {
    let path = recents_path()?;
    read_recents_from_path(&path)
}

fn write_recents(recents: &[VaultMeta]) -> Result<(), String> {
    let path = recents_path()?;
    write_recents_to_path(&path, recents)
}

fn upsert_recent_at_path(recents_path: &std::path::Path, meta: &VaultMeta) -> Result<(), String> {
    let mut recents = read_recents_from_path(recents_path)?;
    upsert_recent_in_list(&mut recents, meta);
    write_recents_to_path(recents_path, &recents)
}

fn collab_dir(vault_path: &str) -> std::path::PathBuf {
    std::path::Path::new(vault_path).join(".collab")
}

fn vault_config_path(vault_path: &str) -> std::path::PathBuf {
    collab_dir(vault_path).join("vault.json")
}

fn read_vault_config(vault_path: &str) -> Result<VaultConfig, String> {
    read_vault_config_pub(vault_path)
}

pub fn read_vault_config_pub(vault_path: &str) -> Result<VaultConfig, String> {
    let config_path = vault_config_path(vault_path);
    if !config_path.exists() {
        return Err("vault.json not found".to_string());
    }
    let data = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_vault_config(vault_path: &str, config: &VaultConfig) -> Result<(), String> {
    write_vault_config_pub(vault_path, config)
}

pub fn write_vault_config_pub(vault_path: &str, config: &VaultConfig) -> Result<(), String> {
    let config_path = vault_config_path(vault_path);
    std::fs::create_dir_all(config_path.parent().unwrap()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, data).map_err(|e| e.to_string())
}

fn ensure_open_vault_meta_with_recents(
    path: &str,
    recents_path: &std::path::Path,
) -> Result<VaultMeta, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot open vault path '{}': {}", path, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let config = if vault_config_path(&canonical_str).exists() {
        read_vault_config(&canonical_str)?
    } else {
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Vault".to_string());
        let config = VaultConfig {
            id: Uuid::new_v4().to_string(),
            name: name.clone(),
            known_users: vec![],
            ..Default::default()
        };
        write_vault_config(&canonical_str, &config)?;
        config
    };

    let meta = VaultMeta {
        kind: Default::default(),
        id: config.id,
        name: config.name,
        path: canonical_str,
        last_opened: now_ms(),
        is_encrypted: config.is_encrypted,
        server_url: None,
        hosted_vault_id: None,
        role: None,
    };

    upsert_recent_at_path(recents_path, &meta)?;
    Ok(meta)
}

fn ensure_open_vault_meta(path: &str) -> Result<VaultMeta, String> {
    let recents_path = recents_path()?;
    ensure_open_vault_meta_with_recents(path, &recents_path)
}

fn build_created_vault_config(
    id: &str,
    name: &str,
    owner_user_id: Option<String>,
    owner_user_name: Option<String>,
    owner_user_color: Option<String>,
) -> VaultConfig {
    let known_users = if let Some(ref uid) = owner_user_id {
        let uname = owner_user_name.clone().unwrap_or_else(|| uid.clone());
        let ucolor = owner_user_color
            .clone()
            .unwrap_or_else(|| "#8b5cf6".to_string());
        vec![KnownUser {
            user_id: uid.clone(),
            user_name: uname,
            user_color: ucolor,
            last_seen: now_ms(),
        }]
    } else {
        vec![]
    };

    VaultConfig {
        id: id.to_string(),
        name: name.to_string(),
        known_users,
        ..Default::default()
    }
}

fn create_vault_on_disk_with_recents(
    path: &str,
    name: &str,
    owner_user_id: Option<String>,
    owner_user_name: Option<String>,
    owner_user_color: Option<String>,
    recents_path: &std::path::Path,
) -> Result<VaultMeta, String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;

    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let id = Uuid::new_v4().to_string();

    let config =
        build_created_vault_config(&id, name, owner_user_id, owner_user_name, owner_user_color);

    write_vault_config(&canonical_str, &config)?;
    std::fs::create_dir_all(collab_dir(&canonical_str).join("presence"))
        .map_err(|e| e.to_string())?;

    let meta = VaultMeta {
        kind: Default::default(),
        id,
        name: name.to_string(),
        path: canonical_str,
        last_opened: now_ms(),
        is_encrypted: false,
        server_url: None,
        hosted_vault_id: None,
        role: None,
    };

    upsert_recent_at_path(recents_path, &meta)?;
    Ok(meta)
}

fn create_vault_on_disk(
    path: &str,
    name: &str,
    owner_user_id: Option<String>,
    owner_user_name: Option<String>,
    owner_user_color: Option<String>,
) -> Result<VaultMeta, String> {
    let recents_path = recents_path()?;
    create_vault_on_disk_with_recents(
        path,
        name,
        owner_user_id,
        owner_user_name,
        owner_user_color,
        &recents_path,
    )
}

fn rename_vault_on_disk_with_recents(
    vault_path: &str,
    new_name: &str,
    recents_path: &std::path::Path,
) -> Result<VaultMeta, String> {
    let mut config = read_vault_config(vault_path)?;
    config.name = new_name.to_string();
    write_vault_config(vault_path, &config)?;

    let mut recents = read_recents_from_path(recents_path)?;
    for recent in &mut recents {
        if recent.path == vault_path {
            recent.name = new_name.to_string();
        }
    }
    write_recents_to_path(recents_path, &recents)?;

    recents
        .into_iter()
        .find(|recent| recent.path == vault_path)
        .ok_or_else(|| "Vault not found in recents after rename".to_string())
}

fn rename_vault_on_disk(vault_path: &str, new_name: &str) -> Result<VaultMeta, String> {
    let recents_path = recents_path()?;
    rename_vault_on_disk_with_recents(vault_path, new_name, &recents_path)
}

#[tauri::command]
pub fn open_vault(path: String, state: State<AppState>) -> Result<VaultMeta, String> {
    let meta = ensure_open_vault_meta(&path)?;

    // Update AppState — clear any stale encryption key from the previous vault.
    *state.encryption_key.write() = None;
    *state.active_vault.write() = Some(meta.clone());

    Ok(meta)
}

#[tauri::command]
pub fn create_vault(
    path: String,
    name: String,
    owner_user_id: Option<String>,
    owner_user_name: Option<String>,
    owner_user_color: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<VaultMeta, String> {
    let meta = create_vault_on_disk(
        &path,
        &name,
        owner_user_id,
        owner_user_name,
        owner_user_color,
    )?;
    let _ = app.emit("collab:config-changed", serde_json::json!({}));

    *state.encryption_key.write() = None;
    *state.active_vault.write() = Some(meta.clone());

    Ok(meta)
}

#[tauri::command]
pub fn get_recent_vaults() -> Result<Vec<VaultMeta>, String> {
    let recents = read_recents()?;
    let original_len = recents.len();
    let filtered = filter_existing_recents(recents);

    if filtered.len() != original_len {
        write_recents(&filtered)?;
    }

    Ok(filtered)
}

#[tauri::command]
pub fn remove_recent_vault(path: String) -> Result<(), String> {
    let mut recents = read_recents()?;
    recents.retain(|r| r.path != path);
    write_recents(&recents)
}

#[tauri::command]
pub fn rename_vault(
    vault_path: String,
    new_name: String,
    state: State<AppState>,
) -> Result<VaultMeta, String> {
    let updated = rename_vault_on_disk(&vault_path, &new_name)?;

    // Keep active vault name in sync
    let mut av = state.active_vault.write();
    if let Some(ref mut meta) = *av {
        if meta.path == vault_path {
            meta.name = new_name.clone();
        }
    }
    drop(av);
    Ok(updated)
}

#[tauri::command]
pub async fn export_vault(vault_path: String, dest_path: String) -> Result<(), String> {
    use collab_archive::{plan_export, ArchiveLimits, ArchivePathPolicy, ExportSource};
    use collab_vault_domain::EntryKind;
    use walkdir::WalkDir;

    let vault = std::path::Path::new(&vault_path);
    let mut sources = Vec::new();
    for entry in WalkDir::new(vault).min_depth(1) {
        let entry = entry.map_err(|e| e.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(vault)
            .map_err(|e| e.to_string())?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        if relative_str.starts_with(".collab/presence") {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err("Vault exports do not support symbolic links".into());
        }
        let kind = if entry.file_type().is_dir() {
            EntryKind::Folder
        } else if entry.file_type().is_file() {
            EntryKind::File
        } else {
            return Err("Vault export contains an unsupported filesystem entry".into());
        };
        sources.push(ExportSource {
            source_id: relative_str.clone(),
            relative_path: relative_str,
            kind,
            size_bytes: entry.metadata().map_err(|e| e.to_string())?.len(),
        });
    }
    let plan = plan_export(
        &sources,
        None,
        ArchiveLimits::default(),
        &ArchivePathPolicy {
            allowed_reserved_roots: vec![".collab".into()],
            ..ArchivePathPolicy::default()
        },
    )
    .map_err(|error| error.to_string())?;

    let file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in plan.entries {
        let path = vault.join(&entry.source_id);
        if entry.kind == EntryKind::File {
            zip.start_file(&entry.archive_path, options)
                .map_err(|e| e.to_string())?;
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        } else {
            zip.add_directory(format!("{}/", entry.archive_path), options)
                .map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn show_save_dialog(
    app: AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("Export Vault as ZIP")
        .add_filter("ZIP Archive", &["zip"])
        .set_file_name(&default_name)
        .blocking_save_file();

    match result {
        Some(file_path) => {
            let path_str = file_path
                .into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn show_open_vault_dialog(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(None);
    }

    #[cfg(not(mobile))]
    {
        use tauri_plugin_dialog::DialogExt;

        let result = app
            .dialog()
            .file()
            .set_title("Open Vault")
            .blocking_pick_folder();

        match result {
            Some(file_path) => {
                // FilePath implements ToString / Into<PathBuf> on desktop
                let path_str = file_path
                    .into_path()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                Ok(Some(path_str))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_created_vault_config, create_vault_on_disk_with_recents,
        ensure_open_vault_meta_with_recents, export_vault, filter_existing_recents_with_options,
        read_recents_from_path, read_vault_config_pub, rename_vault_on_disk_with_recents,
        upsert_recent_in_list, write_recents_to_path, write_vault_config_pub,
    };
    use crate::{
        models::vault::{KnownUser, MemberRole, VaultConfig, VaultMember, VaultMeta},
        test_support::TempVault,
    };
    use std::io::Read;

    fn sample_meta(path: String, index: u64) -> VaultMeta {
        VaultMeta {
            kind: Default::default(),
            id: format!("vault-{index}"),
            name: format!("Vault {index}"),
            path,
            last_opened: index,
            is_encrypted: false,
            server_url: None,
            hosted_vault_id: None,
            role: None,
        }
    }

    #[test]
    fn vault_config_roundtrip_creates_collab_directory() {
        let vault = TempVault::new().expect("temp vault should exist");
        let config = VaultConfig {
            id: "vault-1".into(),
            name: "Project".into(),
            owner: Some("owner-1".into()),
            members: vec![VaultMember {
                user_id: "owner-1".into(),
                user_name: "Owner".into(),
                role: MemberRole::Admin,
            }],
            known_users: vec![KnownUser {
                user_id: "owner-1".into(),
                user_name: "Owner".into(),
                user_color: "#123456".into(),
                last_seen: 42,
            }],
            is_encrypted: false,
        };

        write_vault_config_pub(&vault.path_string(), &config).expect("vault config should write");
        let roundtrip =
            read_vault_config_pub(&vault.path_string()).expect("vault config should read");

        assert_eq!(roundtrip.id, "vault-1");
        assert_eq!(roundtrip.name, "Project");
        assert_eq!(roundtrip.owner.as_deref(), Some("owner-1"));
        assert_eq!(roundtrip.members.len(), 1);
        assert!(vault.exists(".collab/vault.json"));
    }

    #[tokio::test]
    async fn vault_export_uses_portable_paths_and_skips_presence_runtime_files() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault
            .write_text("Notes/example.md", "# Example")
            .expect("note should write");
        vault
            .write_text(".collab/vault.json", "{}")
            .expect("vault metadata should write");
        vault
            .write_text(".collab/presence/runtime.json", "{}")
            .expect("presence runtime should write");
        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("vault.zip");

        export_vault(vault.path_string(), output.to_string_lossy().into_owned())
            .await
            .expect("vault should export");

        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(output).unwrap()).expect("zip should open");
        let mut note = String::new();
        archive
            .by_name("Notes/example.md")
            .unwrap()
            .read_to_string(&mut note)
            .unwrap();
        assert_eq!(note, "# Example");
        assert!(archive.by_name(".collab/vault.json").is_ok());
        assert!(archive.by_name(".collab/presence/runtime.json").is_err());
    }

    #[test]
    fn upsert_recent_in_list_deduplicates_reorders_and_truncates() {
        let mut recents: Vec<VaultMeta> = (0..20)
            .map(|index| sample_meta(format!("/vault/{index}"), index))
            .collect();
        let updated = VaultMeta {
            name: "Updated Vault".into(),
            ..sample_meta("/vault/10".into(), 99)
        };

        upsert_recent_in_list(&mut recents, &updated);

        assert_eq!(recents.len(), 20);
        assert_eq!(recents[0].path, "/vault/10");
        assert_eq!(recents[0].name, "Updated Vault");
        assert_eq!(
            recents
                .iter()
                .filter(|meta| meta.path == "/vault/10")
                .count(),
            1
        );
        assert_eq!(
            recents.last().map(|meta| meta.path.as_str()),
            Some("/vault/19")
        );
    }

    #[test]
    fn read_and_write_recents_roundtrip() {
        let vault = TempVault::new().expect("temp vault should exist");
        let recents_file = vault.resolve("config/recents.json");
        let recents = vec![
            sample_meta("/vault/one".into(), 1),
            sample_meta("/vault/two".into(), 2),
        ];

        write_recents_to_path(&recents_file, &recents).expect("recents should write");
        let roundtrip = read_recents_from_path(&recents_file).expect("recents should read");

        assert_eq!(roundtrip.len(), 2);
        assert_eq!(roundtrip[0].path, "/vault/one");
        assert_eq!(roundtrip[1].path, "/vault/two");
    }

    #[test]
    fn filter_existing_recents_prunes_missing_or_non_directory_paths() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault
            .create_dir("existing-vault")
            .expect("existing vault dir should be created");
        vault
            .write_text("plain-file.txt", "x")
            .expect("plain file should exist");

        let filtered = filter_existing_recents_with_options(
            vec![
                sample_meta(
                    vault
                        .resolve("existing-vault")
                        .to_string_lossy()
                        .to_string(),
                    1,
                ),
                sample_meta(
                    vault.resolve("missing-vault").to_string_lossy().to_string(),
                    2,
                ),
                sample_meta(
                    vault
                        .resolve("plain-file.txt")
                        .to_string_lossy()
                        .to_string(),
                    3,
                ),
            ],
            false,
        );

        assert_eq!(filtered.len(), 1);
        assert!(filtered[0].path.ends_with("existing-vault"));
    }

    #[test]
    fn filter_existing_recents_keeps_unverified_paths_when_requested() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault
            .create_dir("existing-vault")
            .expect("existing vault dir should be created");
        vault
            .write_text("plain-file.txt", "x")
            .expect("plain file should exist");

        let filtered = filter_existing_recents_with_options(
            vec![
                sample_meta(
                    vault
                        .resolve("existing-vault")
                        .to_string_lossy()
                        .to_string(),
                    1,
                ),
                sample_meta(
                    vault.resolve("missing-vault").to_string_lossy().to_string(),
                    2,
                ),
                sample_meta(
                    vault
                        .resolve("plain-file.txt")
                        .to_string_lossy()
                        .to_string(),
                    3,
                ),
            ],
            true,
        );

        assert_eq!(filtered.len(), 2);
        assert!(filtered
            .iter()
            .any(|meta| meta.path.ends_with("existing-vault")));
        assert!(filtered
            .iter()
            .any(|meta| meta.path.ends_with("missing-vault")));
        assert!(!filtered
            .iter()
            .any(|meta| meta.path.ends_with("plain-file.txt")));
    }

    #[test]
    fn build_created_vault_config_registers_identity_without_local_permissions() {
        let config = build_created_vault_config(
            "vault-1",
            "Project",
            Some("owner-1".into()),
            Some("Owner".into()),
            Some("#123456".into()),
        );

        assert_eq!(config.id, "vault-1");
        assert_eq!(config.name, "Project");
        assert_eq!(config.owner, None);
        assert!(config.members.is_empty());
        assert_eq!(config.known_users.len(), 1);
        assert_eq!(config.known_users[0].user_color, "#123456");
    }

    #[test]
    fn create_vault_on_disk_bootstraps_config_presence_and_recents() {
        let vault = TempVault::new().expect("temp vault should exist");
        let recents_path = vault.resolve("config/recents.json");
        let meta = create_vault_on_disk_with_recents(
            &vault.resolve("ProjectVault").to_string_lossy(),
            "Project Vault",
            Some("owner-1".into()),
            Some("Owner".into()),
            Some("#123456".into()),
            &recents_path,
        )
        .expect("create_vault_on_disk flow should succeed");

        let config = read_vault_config_pub(&meta.path).expect("config should read");
        let recents = read_recents_from_path(&recents_path).expect("recents should read");

        assert_eq!(config.name, "Project Vault");
        assert_eq!(config.owner, None);
        assert!(config.members.is_empty());
        assert!(std::path::Path::new(&meta.path)
            .join(".collab/presence")
            .is_dir());
        assert_eq!(
            recents.first().map(|recent| recent.path.as_str()),
            Some(meta.path.as_str())
        );
    }

    #[test]
    fn ensure_open_vault_meta_creates_missing_config_and_updates_recents() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault
            .create_dir("ExistingVault")
            .expect("vault dir should exist");
        let recents_path = vault.resolve("config/recents.json");
        let meta = ensure_open_vault_meta_with_recents(
            &vault.resolve("ExistingVault").to_string_lossy(),
            &recents_path,
        )
        .expect("ensure_open_vault_meta flow should succeed");
        let config = read_vault_config_pub(&meta.path).expect("config should read");
        let recents = read_recents_from_path(&recents_path).expect("recents should read");

        assert_eq!(config.name, "ExistingVault");
        assert_eq!(meta.name, "ExistingVault");
        assert_eq!(
            recents.first().map(|recent| recent.path.as_str()),
            Some(meta.path.as_str())
        );
    }

    #[test]
    fn rename_vault_on_disk_updates_config_and_recents() {
        let vault = TempVault::new().expect("temp vault should exist");
        let recents_path = vault.resolve("config/recents.json");
        let created = create_vault_on_disk_with_recents(
            &vault.resolve("ProjectVault").to_string_lossy(),
            "Project Vault",
            None,
            None,
            None,
            &recents_path,
        )
        .expect("vault should create");
        let updated =
            rename_vault_on_disk_with_recents(&created.path, "Renamed Vault", &recents_path)
                .expect("rename_vault_on_disk flow should succeed");
        let config = read_vault_config_pub(&created.path).expect("config should read");
        let recents = read_recents_from_path(&recents_path).expect("recents should read");

        assert_eq!(updated.name, "Renamed Vault");
        assert_eq!(config.name, "Renamed Vault");
        assert_eq!(
            recents.first().map(|recent| recent.name.as_str()),
            Some("Renamed Vault")
        );
    }
}
